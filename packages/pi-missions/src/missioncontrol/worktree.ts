/**
 * MissionControl worktree helpers — pure path + parsing subset plus
 * the mutating git-worktree operations the merge + cleanup paths need.
 *
 * Ported from `taskplane/extensions/taskplane/worktree.ts` (2505 LOC).
 * Includes both the deterministic helpers downstream modules read
 * (path math, branch naming, `git worktree list --porcelain` parsing,
 * cross-platform path normalization) and the mutating I/O surface
 * (`createWorktree`, `removeWorktree`, `ensureLaneWorktrees`,
 * `removeAllWorktrees`, `safeResetWorktree`, `forceCleanupWorktree`,
 * `savePartialProgress`, `preserveFailedLaneProgress`, `runPreflight`,
 * `ensureBranchDeleted`). The MVP engine does not yet invoke the
 * partial-progress pair from a cleanup hook; callers driving lane
 * decomposition (merge, resume) wire them in on their own schedule.
 *
 * Rename map:
 *   `taskplane-wt` → default prefix becomes `mission-wt` (via
 *    DEFAULT_ORCHESTRATOR_CONFIG). Callers still pass an explicit prefix
 *    so this helper stays agnostic.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";

import { runGit } from "./git";
import { execLog } from "./log";
import { resolveOperatorId } from "./naming";
import {
	type AllocatedLane,
	type BulkWorktreeError,
	type CreateLaneWorktreesResult,
	type CreateWorktreeOptions,
	DEFAULT_ORCHESTRATOR_CONFIG,
	type EnsureBranchDeletedResult,
	type LaneTaskOutcome,
	type OrchestratorConfig,
	type PreflightCheck,
	type PreflightResult,
	type PreserveBranchErrorCode,
	type PreserveBranchResult,
	type RemoveAllWorktreesResult,
	type RemoveWorktreeOutcome,
	type RemoveWorktreeResult,
	WorktreeError,
	type WorktreeInfo,
} from "./types";

// ── Branch naming ────────────────────────────────────────────────────

/**
 * Build a lane branch name: `task/{opId}-lane-{N}-{batchId}`.
 *
 * Includes the operator identifier for collision resistance across
 * concurrent operators in the same repository.
 */
export function generateBranchName(laneNumber: number, batchId: string, opId: string): string {
	return `task/${opId}-lane-${laneNumber}-${batchId}`;
}

/**
 * Saved-branch namespace for any preserved lane branch.
 * `"task/lane-1-…" → "saved/task/lane-1-…"`.
 */
export function computeSavedBranchName(originalBranch: string): string {
	return `saved/${originalBranch}`;
}

/**
 * Saved branch name for partial-progress preservation on failed tasks.
 *
 * Workspace-mode includes the `repoId` to disambiguate per-repo commits
 * from a single task that spanned multiple repos.
 */
export function computePartialProgressBranchName(
	opId: string,
	taskId: string,
	batchId: string,
	repoId?: string,
): string {
	if (repoId) {
		return `saved/${opId}-${repoId}-${taskId}-${batchId}`;
	}
	return `saved/${opId}-${taskId}-${batchId}`;
}

// ── Worktree path math ───────────────────────────────────────────────

/**
 * Resolve the base directory where worktrees are created.
 *
 * - `sibling`      → `<repoRoot>/..`           (sits next to the repo)
 * - `subdirectory` → `<repoRoot>/.worktrees`   (gitignored, default)
 */
export function resolveWorktreeBasePath(repoRoot: string, config: OrchestratorConfig): string {
	const location = config.orchestrator.worktree_location;
	if (location === "sibling") {
		return resolve(repoRoot, "..");
	}
	return resolve(repoRoot, ".worktrees");
}

/** Container name: `{opId}-{batchId}` — e.g. `henrylach-20260308T111750`. */
export function generateBatchContainerName(opId: string, batchId: string): string {
	return `${opId}-${batchId}`;
}

/**
 * Absolute path to the batch container directory.
 * Respects `worktree_location`; defaults to `subdirectory` when `config`
 * is omitted.
 */
export function generateBatchContainerPath(
	opId: string,
	batchId: string,
	repoRoot: string,
	config?: OrchestratorConfig,
): string {
	const effectiveConfig = config ?? DEFAULT_ORCHESTRATOR_CONFIG;
	const basePath = resolveWorktreeBasePath(repoRoot, effectiveConfig);
	return resolve(basePath, generateBatchContainerName(opId, batchId));
}

/**
 * Absolute path to a lane worktree.
 *
 * - With `batchId`: batch-scoped container layout
 *   `{basePath}/{opId}-{batchId}/lane-{N}`
 * - Without `batchId`: legacy flat layout
 *   `{basePath}/{prefix}-{opId}-{N}` (kept for backward compatibility)
 */
export function generateWorktreePath(
	prefix: string,
	laneNumber: number,
	repoRoot: string,
	opId: string,
	config?: OrchestratorConfig,
	batchId?: string,
): string {
	if (batchId) {
		const containerPath = generateBatchContainerPath(opId, batchId, repoRoot, config);
		return resolve(containerPath, `lane-${laneNumber}`);
	}
	const effectiveConfig = config ?? DEFAULT_ORCHESTRATOR_CONFIG;
	const basePath = resolveWorktreeBasePath(repoRoot, effectiveConfig);
	return resolve(basePath, `${prefix}-${opId}-${laneNumber}`);
}

/**
 * Absolute path to the merge worktree inside a batch container.
 * Format: `{basePath}/{opId}-{batchId}/merge`.
 */
export function generateMergeWorktreePath(
	repoRoot: string,
	opId: string,
	batchId: string,
	config?: OrchestratorConfig,
): string {
	const containerPath = generateBatchContainerPath(opId, batchId, repoRoot, config);
	return resolve(containerPath, "merge");
}

// ── Batch container I/O ──────────────────────────────────────────────

/**
 * Ensure the batch container directory exists, creating it (recursively)
 * if not. No-op when already present.
 */
export function ensureBatchContainerDir(containerPath: string): void {
	if (!existsSync(containerPath)) {
		mkdirSync(containerPath, { recursive: true });
	}
}

/**
 * Remove a batch container directory if it exists and is empty.
 *
 * Safety rules (matching taskplane's partial-failure contract):
 *   - No-op when the directory is already gone.
 *   - Never force-remove a non-empty container — an orphan worktree or
 *     user artifact survives unexamined rather than being nuked.
 *   - Any filesystem error during read/remove is swallowed (returns
 *     `false`) so cleanup paths never bubble I/O noise up to the engine.
 *
 * Called after per-worktree removals in `removeAllWorktrees()` and
 * `forceCleanupWorktree()` to tidy the container when empty.
 *
 * @returns `true` if the container was removed, `false` otherwise.
 */
export function removeBatchContainerIfEmpty(containerPath: string): boolean {
	if (!existsSync(containerPath)) return false;
	try {
		const entries = readdirSync(containerPath);
		if (entries.length > 0) return false;
		rmdirSync(containerPath);
		return true;
	} catch {
		return false;
	}
}

// ── Worktree list parsing ────────────────────────────────────────────

/** One entry from `git worktree list --porcelain`. */
export interface ParsedWorktreeEntry {
	path: string;
	head: string;
	/** `null` for detached HEAD. */
	branch: string | null;
	bare: boolean;
}

/**
 * Parse `git worktree list --porcelain` output.
 *
 * Porcelain output format (one block per worktree, blank-line separated):
 *   worktree /absolute/path
 *   HEAD <sha>
 *   branch refs/heads/<name>
 *   [detached]
 *   [bare]
 */
export function parseWorktreeList(cwd: string): ParsedWorktreeEntry[] {
	const result = runGit(["worktree", "list", "--porcelain"], cwd);
	if (!result.ok) return [];

	const entries: ParsedWorktreeEntry[] = [];
	const blocks = result.stdout.split(/\n\n+/);

	for (const block of blocks) {
		if (!block.trim()) continue;

		const lines = block.trim().split("\n");
		let path = "";
		let head = "";
		let branch: string | null = null;
		let bare = false;

		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				path = line.slice("worktree ".length).trim();
			} else if (line.startsWith("HEAD ")) {
				head = line.slice("HEAD ".length).trim();
			} else if (line.startsWith("branch ")) {
				const ref = line.slice("branch ".length).trim();
				branch = ref.replace(/^refs\/heads\//, "");
			} else if (line.trim() === "bare") {
				bare = true;
			}
		}

		if (path) {
			entries.push({ path, head, branch, bare });
		}
	}

	return entries;
}

// ── Path normalization ───────────────────────────────────────────────

/**
 * Normalize a filesystem path for cross-platform comparison.
 *
 * On Windows, paths may contain 8.3 short names (e.g. `HENRYL~1` instead
 * of `HenryLach`). Node's `resolve()` does NOT expand these, but git
 * always reports full long names, so raw comparisons fail. Uses
 * `realpathSync.native()` to expand short names when the path exists,
 * falling back to `resolve()` for yet-to-be-created paths.
 *
 * Output is lowercased + slash-normalized for case-insensitive matching.
 */
export function normalizePath(p: string): string {
	let expanded: string;
	try {
		expanded = realpathSync.native(resolve(p));
	} catch {
		expanded = resolve(p);
	}
	return expanded.replace(/\\/g, "/").toLowerCase();
}

/** Check whether `targetPath` is registered as a git worktree under `cwd`. */
export function isRegisteredWorktree(targetPath: string, cwd: string): boolean {
	const entries = parseWorktreeList(cwd);
	const normalized = normalizePath(targetPath);
	return entries.some(e => normalizePath(e.path) === normalized);
}

// ── Misc helpers ─────────────────────────────────────────────────────

/** Escape regex metacharacters for safe use in a `RegExp` constructor. */
export function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * List mission-owned worktrees under `repoRoot` keyed by `opId`.
 *
 * Match paths (in order):
 *   1. Nested batch-scoped: basename `lane-{N}` with parent directory
 *      matching `{opId}-{batchId}` when `batchId` is supplied, or
 *      `{opId}-*` when omitted (any batch for this operator).
 *   2. Legacy flat primary: basename `{prefix}-{opId}-{N}` — skipped
 *      when `batchId` is supplied (caller wants this batch only).
 *   3. Legacy plain fallback: basename `{prefix}-{N}` — only active
 *      when `opId === "op"`, the legacy default identifier.
 *
 * Rejects entries with NaN or sub-1 lane numbers. Sorts ascending by
 * `laneNumber` for deterministic output.
 */
export function listWorktrees(prefix: string, repoRoot: string, opId: string, batchId?: string): WorktreeInfo[] {
	const entries = parseWorktreeList(repoRoot);
	const results: WorktreeInfo[] = [];

	const primaryPattern = new RegExp(`^${escapeRegex(prefix)}-${escapeRegex(opId)}-(\\d+)$`);
	const legacyPattern = opId === "op" ? new RegExp(`^${escapeRegex(prefix)}-(\\d+)$`) : null;

	const nestedLanePattern = /^lane-(\d+)$/;
	const containerPattern = batchId
		? new RegExp(`^${escapeRegex(generateBatchContainerName(opId, batchId))}$`)
		: new RegExp(`^${escapeRegex(opId)}-\\S+$`);

	for (const entry of entries) {
		if (!entry.path) continue;

		const resolvedPath = resolve(entry.path);
		const entryBasename = basename(resolvedPath);

		const nestedMatch = entryBasename.match(nestedLanePattern);
		if (nestedMatch) {
			const parentDir = basename(resolve(resolvedPath, ".."));
			if (containerPattern.test(parentDir)) {
				const laneNumber = Number.parseInt(nestedMatch[1], 10);
				if (!Number.isNaN(laneNumber) && laneNumber >= 1) {
					results.push({
						path: resolvedPath,
						branch: entry.branch || "",
						laneNumber,
					});
					continue;
				}
			}
		}

		if (!batchId) {
			let match = entryBasename.match(primaryPattern);
			if (!match && legacyPattern) {
				match = entryBasename.match(legacyPattern);
			}
			if (match) {
				const laneNumber = Number.parseInt(match[1], 10);
				if (!Number.isNaN(laneNumber) && laneNumber >= 1) {
					results.push({
						path: resolvedPath,
						branch: entry.branch || "",
						laneNumber,
					});
				}
			}
		}
	}

	results.sort((a, b) => a.laneNumber - b.laneNumber);
	return results;
}

// ── Worktree CRUD ───────────────────────────────────────────────────

/**
 * Create a new git worktree for a lane.
 *
 * Runs `git worktree add -b {branch} {path} {baseBranch}` from the repo
 * root. The generated branch + path follow the
 * `task/{opId}-lane-{N}-{batchId}` + `{opId}-{batchId}/lane-{N}` naming
 * convention.
 *
 * Pre-checks (fail-fast — no partial state left behind):
 * 1. Base branch resolves via `rev-parse --verify refs/heads/{base}`.
 * 2. Target path is not already a registered worktree.
 * 3. Target path does not exist, or exists but is empty.
 * 4. Lane branch does not already exist.
 *
 * Post-creation verification:
 * - Correct branch is checked out in the new worktree.
 * - Worktree HEAD equals base branch HEAD commit.
 *
 * Throws `WorktreeError` with a stable `WorktreeErrorCode` on any
 * failure. The batch container directory is created AFTER pre-checks
 * so a validation failure never leaves an empty container behind.
 */
export function createWorktree(opts: CreateWorktreeOptions, repoRoot: string): WorktreeInfo {
	const { laneNumber, batchId, baseBranch, prefix, opId, config } = opts;

	const branch = generateBranchName(laneNumber, batchId, opId);
	const worktreePath = generateWorktreePath(prefix, laneNumber, repoRoot, opId, config, batchId);

	const baseBranchCheck = runGit(["rev-parse", "--verify", `refs/heads/${baseBranch}`], repoRoot);
	if (!baseBranchCheck.ok) {
		throw new WorktreeError(
			"WORKTREE_INVALID_BASE",
			`Base branch "${baseBranch}" does not exist locally. Verify the branch exists: git branch --list ${baseBranch}`,
		);
	}
	const baseBranchHead = baseBranchCheck.stdout.trim();

	if (isRegisteredWorktree(worktreePath, repoRoot)) {
		throw new WorktreeError(
			"WORKTREE_PATH_IS_WORKTREE",
			`Path "${worktreePath}" is already registered as a git worktree. Remove it first: git worktree remove "${worktreePath}"`,
		);
	}

	if (existsSync(worktreePath)) {
		try {
			const entries = readdirSync(worktreePath);
			if (entries.length > 0) {
				throw new WorktreeError(
					"WORKTREE_PATH_NOT_EMPTY",
					`Path "${worktreePath}" exists and is not empty. It is not a registered git worktree. Remove or rename it before creating a worktree here.`,
				);
			}
		} catch (err) {
			if (err instanceof WorktreeError) throw err;
			throw new WorktreeError(
				"WORKTREE_PATH_NOT_EMPTY",
				`Path "${worktreePath}" exists but cannot be read as a directory.`,
			);
		}
	}

	const branchCheck = runGit(["rev-parse", "--verify", `refs/heads/${branch}`], repoRoot);
	if (branchCheck.ok) {
		throw new WorktreeError(
			"WORKTREE_BRANCH_EXISTS",
			`Branch "${branch}" already exists. This may indicate a stale worktree from a previous batch. Delete it: git branch -D ${branch}`,
		);
	}

	const containerDir = resolve(worktreePath, "..");
	ensureBatchContainerDir(containerDir);

	const createResult = runGit(["worktree", "add", "-b", branch, worktreePath, baseBranch], repoRoot);
	if (!createResult.ok) {
		throw new WorktreeError(
			"WORKTREE_GIT_ERROR",
			`Failed to create worktree at "${worktreePath}" on branch "${branch}" from "${baseBranch}": ${createResult.stderr}`,
		);
	}

	const headBranchResult = runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
	if (!headBranchResult.ok || headBranchResult.stdout !== branch) {
		throw new WorktreeError(
			"WORKTREE_VERIFY_FAILED",
			`Verification failed: expected branch "${branch}" checked out in worktree, but got "${headBranchResult.stdout || "(unknown)"}".`,
		);
	}

	const headCommitResult = runGit(["rev-parse", "HEAD"], worktreePath);
	if (!headCommitResult.ok || headCommitResult.stdout !== baseBranchHead) {
		throw new WorktreeError(
			"WORKTREE_VERIFY_FAILED",
			`Verification failed: worktree HEAD (${headCommitResult.stdout?.slice(0, 8) || "?"}) does not match baseBranch "${baseBranch}" HEAD (${baseBranchHead.slice(0, 8)}).`,
		);
	}

	return {
		path: resolve(worktreePath),
		branch,
		laneNumber,
	};
}

/**
 * Reset an existing worktree to point at a new target branch/commit.
 *
 * Used after a wave merge to update a lane's worktree to the latest
 * base HEAD. Strategy: `git checkout -B {laneBranch} {targetBranch}`
 * inside the worktree — the lane branch name is preserved, only its
 * target commit changes.
 *
 * Pre-checks:
 * 1. Worktree path exists on disk.
 * 2. Path is a registered git worktree.
 * 3. Target branch resolves.
 * 4. Working tree is clean (`git status --porcelain` empty).
 *
 * Post-reset verification:
 * - Current branch equals `worktree.branch`.
 * - Worktree HEAD equals target branch commit.
 *
 * Idempotent: resetting to the current commit succeeds as a semantic
 * no-op.
 */
export function resetWorktree(worktree: WorktreeInfo, targetBranch: string, repoRoot: string): WorktreeInfo {
	const { path: worktreePath, branch, laneNumber } = worktree;

	if (!existsSync(worktreePath)) {
		throw new WorktreeError(
			"WORKTREE_NOT_FOUND",
			`Worktree path "${worktreePath}" does not exist on disk. It may have been removed externally.`,
		);
	}

	if (!isRegisteredWorktree(worktreePath, repoRoot)) {
		throw new WorktreeError(
			"WORKTREE_NOT_REGISTERED",
			`Path "${worktreePath}" exists but is not a registered git worktree. It may have been removed from git tracking. Check: git worktree list`,
		);
	}

	const targetCheck = runGit(["rev-parse", "--verify", `refs/heads/${targetBranch}`], repoRoot);
	if (!targetCheck.ok) {
		throw new WorktreeError(
			"WORKTREE_INVALID_BASE",
			`Target branch "${targetBranch}" does not exist locally. Verify the branch exists: git branch --list ${targetBranch}`,
		);
	}
	const targetCommit = targetCheck.stdout.trim();

	const statusCheck = runGit(["status", "--porcelain"], worktreePath);
	if (!statusCheck.ok) {
		throw new WorktreeError(
			"WORKTREE_GIT_ERROR",
			`Failed to check working tree status in "${worktreePath}": ${statusCheck.stderr}`,
		);
	}
	if (statusCheck.stdout.length > 0) {
		throw new WorktreeError(
			"WORKTREE_DIRTY",
			`Worktree at "${worktreePath}" has uncommitted changes. Workers must commit or discard all changes before a reset can proceed. Dirty files:\n${statusCheck.stdout}`,
		);
	}

	const resetResult = runGit(["checkout", "-B", branch, targetBranch], worktreePath);
	if (!resetResult.ok) {
		throw new WorktreeError(
			"WORKTREE_RESET_FAILED",
			`Failed to reset worktree at "${worktreePath}" (branch "${branch}" → "${targetBranch}"): ${resetResult.stderr}`,
		);
	}

	const headBranchResult = runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
	if (!headBranchResult.ok || headBranchResult.stdout !== branch) {
		throw new WorktreeError(
			"WORKTREE_VERIFY_FAILED",
			`Post-reset verification failed: expected branch "${branch}" checked out, but got "${headBranchResult.stdout || "(unknown)"}".`,
		);
	}

	const headCommitResult = runGit(["rev-parse", "HEAD"], worktreePath);
	if (!headCommitResult.ok || headCommitResult.stdout !== targetCommit) {
		throw new WorktreeError(
			"WORKTREE_VERIFY_FAILED",
			`Post-reset verification failed: worktree HEAD (${headCommitResult.stdout?.slice(0, 8) || "?"}) does not match target "${targetBranch}" commit (${targetCommit.slice(0, 8)}).`,
		);
	}

	return {
		path: resolve(worktreePath),
		branch,
		laneNumber,
	};
}

/**
 * Remove a git worktree and clean up its associated branch.
 *
 * Runs `git worktree remove --force {path}` from the repo root, then
 * delegates branch cleanup to `ensureBranchDeleted`. Branch behavior
 * depends on `targetBranch`:
 * - If provided and branch has unmerged commits → preserved as `saved/…`.
 * - If provided and fully merged → deleted.
 * - If omitted → deleted unconditionally (backward-compat path).
 *
 * Idempotent:
 * - If path is already missing AND branch is gone → no-op success.
 * - If path is missing BUT branch has unmerged commits → preserve anyway.
 * - If path is missing but still registered in git → prune first, then
 *   proceed with branch cleanup.
 *
 * Retry policy (Windows file-locking mitigation):
 * - Up to 5 retries with exponential backoff (1s, 2s, 4s, 8s, 16s).
 * - Only retriable errors trigger retry; terminal git errors fail fast.
 * - Branch deletion is not retried (single attempt, fail loud).
 *
 * Throws `WorktreeError` with `WORKTREE_REMOVE_RETRY_EXHAUSTED` if all
 * retries fail, `WORKTREE_REMOVE_FAILED` for terminal git errors, or
 * `WORKTREE_BRANCH_DELETE_FAILED` if branch cleanup fails.
 */
export function removeWorktree(worktree: WorktreeInfo, repoRoot: string, targetBranch?: string): RemoveWorktreeResult {
	const { path: worktreePath, branch } = worktree;

	const pathExists = existsSync(worktreePath);
	const isRegistered = isRegisteredWorktree(worktreePath, repoRoot);

	if (!pathExists && !isRegistered) {
		const branchResult = ensureBranchDeleted(branch, repoRoot, worktreePath, targetBranch);
		return {
			removed: false,
			alreadyRemoved: true,
			branchDeleted: branchResult.deleted,
			branchPreserved: branchResult.preserved,
			savedBranch: branchResult.savedBranch,
			unmergedCount: branchResult.unmergedCount,
		};
	}

	if (!pathExists && isRegistered) {
		runGit(["worktree", "prune"], repoRoot);
		const branchResult = ensureBranchDeleted(branch, repoRoot, worktreePath, targetBranch);
		return {
			removed: false,
			alreadyRemoved: true,
			branchDeleted: branchResult.deleted,
			branchPreserved: branchResult.preserved,
			savedBranch: branchResult.savedBranch,
			unmergedCount: branchResult.unmergedCount,
		};
	}

	const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
	const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

	let lastError = "";

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const removeResult = runGit(["worktree", "remove", "--force", worktreePath], repoRoot);

		if (removeResult.ok) {
			break;
		}

		lastError = removeResult.stderr;

		if (!isRetriableRemoveError(lastError)) {
			throw new WorktreeError(
				"WORKTREE_REMOVE_FAILED",
				`Failed to remove worktree at "${worktreePath}" (terminal error, not retried): ${lastError}`,
			);
		}

		if (attempt >= MAX_ATTEMPTS) {
			throw new WorktreeError(
				"WORKTREE_REMOVE_RETRY_EXHAUSTED",
				`Failed to remove worktree at "${worktreePath}" after ${MAX_ATTEMPTS} attempts. Last error: ${lastError}. This is likely a Windows file locking issue. Close any programs accessing "${worktreePath}" and try again.`,
			);
		}

		const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? 1000;
		sleepSync(delayMs);
	}

	if (existsSync(worktreePath)) {
		throw new WorktreeError(
			"WORKTREE_VERIFY_FAILED",
			`Post-removal verification failed: path "${worktreePath}" still exists on disk after successful git worktree remove.`,
		);
	}

	if (isRegisteredWorktree(worktreePath, repoRoot)) {
		runGit(["worktree", "prune"], repoRoot);
		if (isRegisteredWorktree(worktreePath, repoRoot)) {
			throw new WorktreeError(
				"WORKTREE_VERIFY_FAILED",
				`Post-removal verification failed: path "${worktreePath}" is still registered as a git worktree after removal and prune.`,
			);
		}
	}

	const branchResult = ensureBranchDeleted(branch, repoRoot, worktreePath, targetBranch);

	return {
		removed: true,
		alreadyRemoved: false,
		branchDeleted: branchResult.deleted,
		branchPreserved: branchResult.preserved,
		savedBranch: branchResult.savedBranch,
		unmergedCount: branchResult.unmergedCount,
	};
}

/**
 * Ensure a lane branch is deleted — or preserved if it has unmerged
 * commits vs `targetBranch`.
 *
 * When `targetBranch` is provided:
 * - If `preserveBranch` reports `preserved` or `already-preserved`,
 *   the saved ref is in place; delete the original lane branch to
 *   implement rename semantics (`saved/…` + no lane branch).
 * - If `fully-merged` or `no-branch`, delete normally.
 * - If `error` (e.g., missing target branch), skip deletion as the
 *   safe default — callers cannot distinguish safe vs unsafe at that
 *   point.
 *
 * When `targetBranch` is omitted, behaves as an unconditional
 * fail-loud delete (caller has already established safety upstream).
 *
 * Throws `WorktreeError` with `WORKTREE_BRANCH_DELETE_FAILED` when the
 * unconditional delete path fails — callers cannot silently proceed
 * with stale lane branches.
 */
export function ensureBranchDeleted(
	branch: string,
	repoRoot: string,
	worktreePath: string,
	targetBranch?: string,
): EnsureBranchDeletedResult {
	if (targetBranch) {
		const preserveResult = preserveBranch(branch, targetBranch, repoRoot);

		switch (preserveResult.action) {
			case "preserved":
			case "already-preserved": {
				const sourceDeleted = deleteBranchBestEffort(branch, repoRoot);
				return {
					deleted: sourceDeleted,
					preserved: true,
					savedBranch: preserveResult.savedBranch,
					unmergedCount: preserveResult.unmergedCount,
				};
			}

			case "fully-merged":
			case "no-branch":
				break;

			case "error":
				return {
					deleted: false,
					preserved: false,
				};
		}
	}

	const branchDeleted = deleteBranchBestEffort(branch, repoRoot);
	if (!branchDeleted) {
		throw new WorktreeError(
			"WORKTREE_BRANCH_DELETE_FAILED",
			`Worktree "${worktreePath}" was removed, but failed to delete lane branch "${branch}". Delete it manually: git branch -D ${branch}`,
		);
	}
	return { deleted: true, preserved: false };
}

// ── Bulk worktree operations ────────────────────────────────────────

/**
 * Create `count` lane worktrees sequentially (lanes 1..count).
 *
 * Git worktree operations share a repo-level lock, so parallel creation
 * is unsafe — sequential is the correct approach.
 *
 * Partial failure rollback:
 * - If lane K fails after lanes 1..(K-1) succeeded, ALL previously
 *   created worktrees are rolled back via `removeWorktree`.
 * - Rollback is best-effort: per-lane rollback failures are collected
 *   in `rollbackErrors` but do not block subsequent rollbacks.
 * - On successful rollback, `worktrees` is empty (clean slate).
 * - `rolledBack === true` means rollback completed without per-lane
 *   issues (equivalent to `rollbackErrors.length === 0`).
 */
export function createLaneWorktrees(
	count: number,
	batchId: string,
	config: OrchestratorConfig,
	repoRoot: string,
	baseBranch: string,
): CreateLaneWorktreesResult {
	const prefix = config.orchestrator.worktree_prefix;
	const opId = resolveOperatorId(config.orchestrator.operator_id);
	const created: WorktreeInfo[] = [];
	const errors: BulkWorktreeError[] = [];

	for (let lane = 1; lane <= count; lane++) {
		try {
			const wt = createWorktree({ laneNumber: lane, batchId, baseBranch, prefix, opId, config }, repoRoot);
			created.push(wt);
		} catch (err: unknown) {
			const wtErr = err instanceof WorktreeError ? err : null;
			errors.push({
				laneNumber: lane,
				code: wtErr?.code || "UNKNOWN",
				message: wtErr?.message || String(err),
			});

			const rollbackErrors: BulkWorktreeError[] = [];
			for (const wt of created) {
				try {
					removeWorktree(wt, repoRoot);
				} catch (rbErr: unknown) {
					const rbWtErr = rbErr instanceof WorktreeError ? rbErr : null;
					rollbackErrors.push({
						laneNumber: wt.laneNumber,
						code: rbWtErr?.code || "UNKNOWN",
						message: rbWtErr?.message || String(rbErr),
					});
				}
			}

			return {
				success: false,
				worktrees: [],
				errors,
				rolledBack: rollbackErrors.length === 0,
				rollbackErrors,
			};
		}
	}

	created.sort((a, b) => a.laneNumber - b.laneNumber);

	return {
		success: true,
		worktrees: created,
		errors: [],
		rolledBack: false,
		rollbackErrors: [],
	};
}

/**
 * Ensure the specified `laneNumbers` have worktrees ready for a wave.
 *
 * Reuses existing worktrees via `safeResetWorktree` (resets to
 * `baseBranch` HEAD) and creates any missing ones. Prevents wave 2+
 * allocation from tripping over `WORKTREE_PATH_IS_WORKTREE` while
 * still supporting wave growth (e.g., 1 lane in wave 1, 3 in wave 2).
 *
 * Reuse strategy per lane:
 * - Existing + safeReset succeeds → reuse.
 * - Existing + safeReset fails → best-effort remove, then create.
 * - Missing → create.
 *
 * Only lanes created in this call (`createdNow`) are rolled back on
 * subsequent failure; existing reused worktrees are left intact.
 */
export function ensureLaneWorktrees(
	laneNumbers: number[],
	batchId: string,
	config: OrchestratorConfig,
	repoRoot: string,
	baseBranch: string,
): CreateLaneWorktreesResult {
	const prefix = config.orchestrator.worktree_prefix;
	const opId = resolveOperatorId(config.orchestrator.operator_id);

	const existing = listWorktrees(prefix, repoRoot, opId, batchId);
	const existingByLane = new Map<number, WorktreeInfo>();
	for (const wt of existing) {
		existingByLane.set(wt.laneNumber, wt);
	}

	const needed = [...new Set(laneNumbers)].sort((a, b) => a - b);
	const selected: WorktreeInfo[] = [];
	const createdNow: WorktreeInfo[] = [];
	const errors: BulkWorktreeError[] = [];

	for (const lane of needed) {
		const reused = existingByLane.get(lane);
		if (reused) {
			const resetResult = safeResetWorktree(reused, baseBranch, repoRoot);
			if (resetResult.success) {
				selected.push(reused);
				continue;
			}

			try {
				removeWorktree(reused, repoRoot);
			} catch {
				/* best-effort — creation below will surface a clearer error if it re-fails */
			}
		}

		try {
			const wt = createWorktree({ laneNumber: lane, batchId, baseBranch, prefix, opId, config }, repoRoot);
			createdNow.push(wt);
			selected.push(wt);
		} catch (err: unknown) {
			const wtErr = err instanceof WorktreeError ? err : null;
			errors.push({
				laneNumber: lane,
				code: wtErr?.code || "UNKNOWN",
				message: wtErr?.message || String(err),
			});

			const rollbackErrors: BulkWorktreeError[] = [];
			for (const wt of createdNow) {
				try {
					removeWorktree(wt, repoRoot);
				} catch (rbErr: unknown) {
					const rbWtErr = rbErr instanceof WorktreeError ? rbErr : null;
					rollbackErrors.push({
						laneNumber: wt.laneNumber,
						code: rbWtErr?.code || "UNKNOWN",
						message: rbWtErr?.message || String(rbErr),
					});
				}
			}

			return {
				success: false,
				worktrees: [],
				errors,
				rolledBack: rollbackErrors.length === 0,
				rollbackErrors,
			};
		}
	}

	selected.sort((a, b) => a.laneNumber - b.laneNumber);
	return {
		success: true,
		worktrees: selected,
		errors: [],
		rolledBack: false,
		rollbackErrors: [],
	};
}

/**
 * Remove all mission worktrees matching `prefix` + operator scope.
 *
 * Discovers matching worktrees via `listWorktrees` (operator-scoped,
 * optionally batch-scoped), then removes each via `removeWorktree`.
 * Best-effort: continues on per-worktree errors rather than failing fast.
 *
 * When `targetBranch` is provided, branches with unmerged commits are
 * preserved as `saved/…` refs instead of being force-deleted.
 *
 * Batch-scoped cleanup: when `batchId` is provided, only removes
 * worktrees inside the specific batch container `{opId}-{batchId}/`,
 * and attempts to remove the empty container directory afterward.
 * Without `batchId`, removes all operator worktrees (all batches,
 * including legacy flat-layout).
 *
 * Container cleanup: each touched container is removed if empty.
 * Non-empty containers (from partial failures, active worktrees,
 * or stray user files) are left intact.
 *
 * Base-directory cleanup: in subdirectory mode, the empty
 * `.worktrees/` base is removed too. Sibling mode never touches the
 * repo's parent directory.
 */
export function removeAllWorktrees(
	prefix: string,
	repoRoot: string,
	opId: string,
	targetBranch?: string,
	batchId?: string,
	config?: OrchestratorConfig,
): RemoveAllWorktreesResult {
	const worktrees = listWorktrees(prefix, repoRoot, opId, batchId);
	const outcomes: RemoveWorktreeOutcome[] = [];
	const removed: WorktreeInfo[] = [];
	const failed: RemoveWorktreeOutcome[] = [];
	const preserved: Array<{ branch: string; savedBranch: string; laneNumber: number; unmergedCount?: number }> = [];

	for (const wt of worktrees) {
		try {
			const result = removeWorktree(wt, repoRoot, targetBranch);
			const outcome: RemoveWorktreeOutcome = { worktree: wt, result, error: null };
			outcomes.push(outcome);
			removed.push(wt);

			if (result.branchPreserved && result.savedBranch) {
				preserved.push({
					branch: wt.branch,
					savedBranch: result.savedBranch,
					laneNumber: wt.laneNumber,
					unmergedCount: result.unmergedCount,
				});
			}
		} catch (err: unknown) {
			const wtErr = err instanceof WorktreeError ? err : null;
			const bulkErr: BulkWorktreeError = {
				laneNumber: wt.laneNumber,
				code: wtErr?.code || "UNKNOWN",
				message: wtErr?.message || String(err),
			};
			const outcome: RemoveWorktreeOutcome = { worktree: wt, result: null, error: bulkErr };
			outcomes.push(outcome);
			failed.push(outcome);
		}
	}

	const containerPaths = new Set<string>();
	for (const wt of removed) {
		const parentDir = resolve(wt.path, "..");
		const parentName = basename(parentDir);
		if (parentName.startsWith(`${opId}-`)) {
			containerPaths.add(parentDir);
		}
	}
	if (batchId && config) {
		const expectedContainer = generateBatchContainerPath(opId, batchId, repoRoot, config);
		containerPaths.add(expectedContainer);
	}
	for (const containerPath of containerPaths) {
		removeBatchContainerIfEmpty(containerPath);
	}

	if (config && config.orchestrator.worktree_location !== "sibling") {
		const basePath = resolveWorktreeBasePath(repoRoot, config);
		try {
			if (existsSync(basePath)) {
				const entries = readdirSync(basePath);
				if (entries.length === 0) {
					rmdirSync(basePath);
				}
			}
		} catch {
			/* safe default — leave the base dir alone */
		}
	}

	return {
		totalAttempted: worktrees.length,
		removed,
		failed,
		outcomes,
		preserved,
	};
}

/**
 * Reset a worktree to `targetBranch`, recovering from a dirty tree.
 *
 * First tries `resetWorktree`. If that fails with `WORKTREE_DIRTY`
 * (e.g., failed/stalled task left uncommitted changes), force-discards
 * local changes via `git checkout -- .` + `git clean -fd`, then retries.
 *
 * Clean tolerance: `git clean -fd` may warn on Windows reserved names
 * (`nul`, `con`, `aux`) it cannot delete. Treat that as non-fatal when
 * `git status --porcelain` afterward shows only untracked entries —
 * reset can still succeed because tracked content is already clean.
 *
 * Returns structured `{ success, error? }` rather than throwing so the
 * caller (`ensureLaneWorktrees`) can route to create-or-recreate.
 */
export function safeResetWorktree(
	worktree: WorktreeInfo,
	targetBranch: string,
	repoRoot: string,
): { success: boolean; error?: string } {
	try {
		resetWorktree(worktree, targetBranch, repoRoot);
		return { success: true };
	} catch (err: unknown) {
		if (err instanceof WorktreeError && err.code === "WORKTREE_DIRTY") {
			execLog("reset", `lane-${worktree.laneNumber}`, "worktree dirty — force cleaning", {
				path: worktree.path,
			});

			const checkoutResult = runGit(["checkout", "--", "."], worktree.path);
			if (!checkoutResult.ok) {
				return {
					success: false,
					error: `git checkout -- . failed: ${checkoutResult.stderr}`,
				};
			}

			const cleanResult = runGit(["clean", "-fd"], worktree.path);
			if (!cleanResult.ok) {
				execLog("reset", `lane-${worktree.laneNumber}`, "git clean -fd returned non-zero (may be partial)", {
					stderr: cleanResult.stderr.slice(0, 200),
				});
			}

			const statusCheck = runGit(["status", "--porcelain"], worktree.path);
			if (statusCheck.ok && statusCheck.stdout.length > 0) {
				const lines = statusCheck.stdout.split("\n").filter(l => l.trim());
				const onlyUntracked = lines.every(l => l.startsWith("??"));
				if (!onlyUntracked) {
					return {
						success: false,
						error: `Worktree still dirty after clean: ${statusCheck.stdout.slice(0, 200)}`,
					};
				}
				execLog("reset", `lane-${worktree.laneNumber}`, "untracked files remain after clean (non-blocking)", {
					files: lines.map(l => l.slice(3)).join(", "),
				});
			}

			try {
				resetWorktree(worktree, targetBranch, repoRoot);
				return { success: true };
			} catch (retryErr: unknown) {
				return {
					success: false,
					error: `Reset failed after clean: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
				};
			}
		}

		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Last-resort worktree cleanup: force-remove the directory and prune
 * git state.
 *
 * Used when both `safeResetWorktree` and `removeWorktree` have failed —
 * typically because undeletable files (Windows reserved names like
 * `nul`, `con`, `aux`) block `git clean` and `git worktree remove`,
 * leaving git in an inconsistent state.
 *
 * Recovery steps (all best-effort, logged via `execLog`):
 * 1. Force-remove the worktree directory via `rmSync`, falling back to
 *    OS-level (`rd /s /q` on Windows, `rm -rf` elsewhere) when Node's
 *    rm fails on stubborn files.
 * 2. Prune stale git worktree references (`git worktree prune`).
 * 3. Delete the lane branch (`git branch -D`) when still present.
 * 4. Remove the empty batch container directory when applicable.
 *
 * Never throws — the next wave should be free to recreate from scratch.
 */
export function forceCleanupWorktree(worktree: WorktreeInfo, repoRoot: string, _batchId: string): void {
	const { path: worktreePath, branch, laneNumber } = worktree;

	if (existsSync(worktreePath)) {
		try {
			rmSync(worktreePath, { recursive: true, force: true });
			execLog("cleanup", `lane-${laneNumber}`, "force-removed worktree directory", { path: worktreePath });
		} catch (rmErr: unknown) {
			const rmMsg = rmErr instanceof Error ? rmErr.message : String(rmErr);
			execLog("cleanup", `lane-${laneNumber}`, "rmSync failed, trying OS-level removal", { error: rmMsg });

			try {
				if (process.platform === "win32") {
					execSync(`rd /s /q "${worktreePath}"`, { stdio: "pipe", timeout: 30_000 });
				} else {
					execSync(`rm -rf "${worktreePath}"`, { stdio: "pipe", timeout: 30_000 });
				}
				execLog("cleanup", `lane-${laneNumber}`, "OS-level removal succeeded", { path: worktreePath });
			} catch (osErr: unknown) {
				const osMsg = osErr instanceof Error ? osErr.message : String(osErr);
				execLog("cleanup", `lane-${laneNumber}`, "OS-level removal also failed — manual cleanup needed", {
					path: worktreePath,
					error: osMsg,
				});
			}
		}
	}

	runGit(["worktree", "prune"], repoRoot);
	execLog("cleanup", `lane-${laneNumber}`, "pruned stale worktree references");

	const branchCheck = runGit(["rev-parse", "--verify", `refs/heads/${branch}`], repoRoot);
	if (branchCheck.ok) {
		const deleteResult = runGit(["branch", "-D", branch], repoRoot);
		if (deleteResult.ok) {
			execLog("cleanup", `lane-${laneNumber}`, "deleted stale lane branch", { branch });
		} else {
			execLog("cleanup", `lane-${laneNumber}`, "could not delete lane branch", {
				branch,
				error: deleteResult.stderr,
			});
		}
	}

	const containerDir = resolve(worktreePath, "..");
	const containerName = basename(containerDir);
	if (containerName.includes("-")) {
		const containerRemoved = removeBatchContainerIfEmpty(containerDir);
		if (containerRemoved) {
			execLog("cleanup", `lane-${laneNumber}`, "removed empty batch container", { path: containerDir });
		}
	}
}

// ── Branch deletion ──────────────────────────────────────────────────

/**
 * Result of stale-branch cleanup after `/mission-integrate`.
 */
export interface StaleBranchCleanupResult {
	/** `task/*` lane branches that were deleted. */
	deletedTaskBranches: string[];
	/** `saved/task/*` + `saved/{opId}-*-{batchId}` branches that were deleted. */
	deletedSavedBranches: string[];
	/** Branches still present after delete attempts (best-effort). */
	failedDeletes: string[];
}

/**
 * Delete a branch with best-effort semantics.
 *
 * - Missing branch is treated as idempotent success.
 * - Uses `git branch -D` since lane branches are ephemeral and often
 *   unmerged into any long-lived ref.
 * - A failed delete that leaves the branch actually gone (race) is still
 *   reported as success.
 */
export function deleteBranchBestEffort(branch: string, repoRoot: string): boolean {
	const branchCheck = runGit(["rev-parse", "--verify", `refs/heads/${branch}`], repoRoot);
	if (!branchCheck.ok) return true;

	const deleteResult = runGit(["branch", "-D", branch], repoRoot);
	if (deleteResult.ok) return true;

	const recheckResult = runGit(["rev-parse", "--verify", `refs/heads/${branch}`], repoRoot);
	if (!recheckResult.ok) return true;

	return false;
}

/**
 * Delete stale `task/*` and `saved/*` branches after integration.
 *
 * After `/mission-integrate` merges or creates a PR, the lane branches
 * (`task/{opId}-lane-{N}-{batchId}`) and their saved counterparts are
 * no longer needed — this function cleans them up across three scopes:
 *
 *   1. `task/{opId}-lane-*`               — lane branches (any batch).
 *   2. `saved/task/{opId}-lane-*`         — preserved lane refs.
 *   3. `saved/{opId}-*-{batchId}`         — partial-progress refs for
 *      the current batch only (suffix-matched) so prior-batch refs that
 *      the operator may still want to consult survive.
 *
 * Uses `deleteBranchBestEffort` for each match, aggregating failures
 * rather than aborting. Logs a summary line via `execLog` when anything
 * was deleted.
 */
export function deleteStaleBranches(repoRoot: string, opId: string, batchId: string): StaleBranchCleanupResult {
	const deletedTaskBranches: string[] = [];
	const deletedSavedBranches: string[] = [];
	const failedDeletes: string[] = [];

	const taskBranchResult = runGit(["branch", "--list", `task/${opId}-lane-*`], repoRoot);
	if (taskBranchResult.ok && taskBranchResult.stdout.trim()) {
		const branches = taskBranchResult.stdout
			.split("\n")
			.map(b => b.replace(/^\*?\s+/, "").trim())
			.filter(Boolean);
		for (const branch of branches) {
			if (deleteBranchBestEffort(branch, repoRoot)) {
				deletedTaskBranches.push(branch);
			} else {
				failedDeletes.push(branch);
			}
		}
	}

	const savedTaskResult = runGit(["branch", "--list", `saved/task/${opId}-lane-*`], repoRoot);
	if (savedTaskResult.ok && savedTaskResult.stdout.trim()) {
		const branches = savedTaskResult.stdout
			.split("\n")
			.map(b => b.replace(/^\*?\s+/, "").trim())
			.filter(Boolean);
		for (const branch of branches) {
			if (deleteBranchBestEffort(branch, repoRoot)) {
				deletedSavedBranches.push(branch);
			} else {
				failedDeletes.push(branch);
			}
		}
	}

	const savedProgressResult = runGit(["branch", "--list", `saved/${opId}-*`], repoRoot);
	if (savedProgressResult.ok && savedProgressResult.stdout.trim()) {
		const branches = savedProgressResult.stdout
			.split("\n")
			.map(b => b.replace(/^\*?\s+/, "").trim())
			.filter(Boolean);
		const batchSuffix = `-${batchId}`;
		for (const branch of branches) {
			if (branch.startsWith("saved/task/")) continue;
			if (!branch.endsWith(batchSuffix)) continue;
			if (deleteBranchBestEffort(branch, repoRoot)) {
				deletedSavedBranches.push(branch);
			} else {
				failedDeletes.push(branch);
			}
		}
	}

	const totalDeleted = deletedTaskBranches.length + deletedSavedBranches.length;
	if (totalDeleted > 0) {
		execLog("cleanup", "branches", `deleted ${totalDeleted} stale branch(es) for batch ${batchId}`, {
			taskBranches: deletedTaskBranches.length,
			savedBranches: deletedSavedBranches.length,
			failed: failedDeletes.length,
		});
	}

	return { deletedTaskBranches, deletedSavedBranches, failedDeletes };
}

/**
 * Synchronous sleep — blocks the thread via a subprocess busy-wait
 * (Windows `ping`, Unix `sleep`). Used by the synchronous worktree
 * remove/retry backoff where switching to an async loop would require
 * bubbling async up through a sync API surface. Bounded retry waits
 * (max 16s) keep the blocking safe outside hot paths.
 *
 * Any subprocess error is swallowed — we only need the delay.
 */
export function sleepSync(ms: number): void {
	const seconds = Math.ceil(ms / 1000);
	try {
		if (process.platform === "win32") {
			execSync(`ping -n ${seconds + 1} 127.0.0.1 > nul`, { stdio: "ignore", timeout: ms + 5000 });
		} else {
			execSync(`sleep ${seconds}`, { stdio: "ignore", timeout: ms + 5000 });
		}
	} catch {
		/* timeout or error — acceptable, we only needed a delay */
	}
}

/**
 * Async sleep — yields the event loop so supervisor heartbeats, user
 * input, and dashboard updates can proceed while waiting. Use in the
 * async cleanup/retry paths (merge polling, worktree removal backoff).
 */
export function sleepAsync(ms: number): Promise<void> {
	return new Promise(resolveFn => setTimeout(resolveFn, ms));
}

// ── Retry classification ─────────────────────────────────────────────

/**
 * Decide if a `git worktree remove` failure is worth retrying.
 *
 * Retriable: filesystem-lock / permission / busy patterns — usually
 * Windows antivirus, IDE, or Explorer holding a transient handle.
 * Non-retriable: git usage errors ("not a valid worktree", etc.) that
 * will stay broken no matter how many times we back off.
 */
export function isRetriableRemoveError(stderr: string): boolean {
	const lower = stderr.toLowerCase();
	if (lower.includes("cannot lock") || lower.includes("unable to access")) return true;
	if (lower.includes("permission denied")) return true;
	if (lower.includes("device or resource busy")) return true;
	if (lower.includes("the process cannot access")) return true;
	if (lower.includes("used by another process")) return true;
	if (lower.includes("directory not empty")) return true;
	if (lower.includes("failed to remove")) return true;
	if (lower.includes("i/o error")) return true;
	if (lower.includes("input/output error")) return true;
	return false;
}

// ── Subprocess probe ─────────────────────────────────────────────────

/**
 * Run a shell command synchronously and return a thin `{ ok, stdout }`
 * pair. Any non-zero exit, missing binary, or timeout collapses to
 * `ok:false` — used by preflight probes where the detail beyond pass/fail
 * is uninteresting.
 */
export function execCheck(command: string, cwd?: string): { ok: boolean; stdout: string } {
	try {
		const stdout = execSync(command, {
			encoding: "utf-8",
			timeout: 10_000,
			stdio: ["pipe", "pipe", "pipe"],
			...(cwd ? { cwd } : {}),
		}).trim();
		return { ok: true, stdout };
	} catch {
		return { ok: false, stdout: "" };
	}
}

// ── Version helpers ──────────────────────────────────────────────────

/**
 * Extract a `[major, minor]` tuple from a version banner.
 *
 * Handles common shapes like `"git version 2.43.0.windows.1"` and
 * `"tmux 3.3a"`. Returns `[0, 0]` when no `\d+\.\d+` pair is present so
 * downstream {@link meetsMinVersion} comparisons fail safe.
 */
export function parseVersion(raw: string): [number, number] {
	const match = raw.match(/(\d+)\.(\d+)/);
	if (!match) return [0, 0];
	return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)];
}

/** Compare two `[major, minor]` tuples — true when `actual >= minimum`. */
export function meetsMinVersion(actual: [number, number], minimum: [number, number]): boolean {
	if (actual[0] > minimum[0]) return true;
	if (actual[0] === minimum[0] && actual[1] >= minimum[1]) return true;
	return false;
}

// ── Preflight checks ─────────────────────────────────────────────────

/**
 * Run preflight checks for the MissionControl engine's mandatory
 * dependencies.
 *
 * Required (any failure blocks execution):
 *   - git ≥ 2.15 on PATH
 *   - git worktree subcommand works in the target repo
 *   - Bun on PATH (the oh-my-pi runtime executes Bun directly; the
 *     taskplane original probed `pi --version` which does not apply
 *     here — pi-missions runs inside the `omp` CLI process)
 *
 * Compatibility: emits an informational pass line noting the configured
 * Runtime V2 spawn mode so operators can see the active backend.
 */
export function runPreflight(config: OrchestratorConfig, repoRoot?: string): PreflightResult {
	const checks: PreflightCheck[] = [];

	const gitResult = execCheck("git --version");
	if (gitResult.ok) {
		const version = parseVersion(gitResult.stdout);
		const versionStr = `${version[0]}.${version[1]}`;
		if (meetsMinVersion(version, [2, 15])) {
			checks.push({ name: "git", status: "pass", message: `Git ${versionStr} available` });
		} else {
			checks.push({
				name: "git",
				status: "fail",
				message: `Git ${versionStr} found, but 2.15+ required for worktree support`,
				hint: "Upgrade Git: https://git-scm.com/downloads",
			});
		}
	} else {
		checks.push({
			name: "git",
			status: "fail",
			message: "Git not found",
			hint: "Install Git: https://git-scm.com/downloads",
		});
	}

	const worktreeResult = execCheck("git worktree list", repoRoot);
	checks.push({
		name: "git-worktree",
		status: worktreeResult.ok ? "pass" : "fail",
		message: worktreeResult.ok ? "Worktree support available" : "Git worktree not available",
		hint: worktreeResult.ok
			? undefined
			: repoRoot
				? "Upgrade Git to 2.15+"
				: "Workspace root is not a git repo. Check workspace config repo paths.",
	});

	checks.push({
		name: "runtime-backend",
		status: "pass",
		message: `Runtime V2 subprocess backend active (configured spawn_mode: ${config.orchestrator.spawn_mode})`,
	});

	const bunResult = execCheck("bun --version");
	if (bunResult.ok) {
		checks.push({ name: "bun", status: "pass", message: `Bun ${bunResult.stdout || "available"}` });
	} else {
		checks.push({
			name: "bun",
			status: "fail",
			message: "Bun not found",
			hint: "Install Bun: https://bun.sh",
		});
	}

	return { passed: checks.every(c => c.status !== "fail"), checks };
}

// ── Preflight formatting ─────────────────────────────────────────────

/**
 * Pretty-print a {@link PreflightResult} for console / slash-command
 * output. Uses icon columns (✅ / ⚠️ / ❌), a padded name column, and
 * indented hint lines. The final footer differs by pass/fail so
 * callers can print the string verbatim without re-checking the flag.
 */
export function formatPreflightResults(result: PreflightResult): string {
	const lines: string[] = ["Preflight Check:"];

	for (const check of result.checks) {
		const icon = check.status === "pass" ? "✅" : check.status === "warn" ? "⚠️ " : "❌";
		const nameCol = check.name.padEnd(18);
		lines.push(`  ${icon} ${nameCol} ${check.message}`);
		if (check.hint && check.status !== "pass") {
			for (const hintLine of check.hint.split("\n")) {
				lines.push(`      ${" ".repeat(18)} ${hintLine}`);
			}
		}
	}

	lines.push("");
	if (result.passed) {
		lines.push("All required checks passed.");
	} else {
		const failedNames = result.checks
			.filter(c => c.status === "fail")
			.map(c => c.name)
			.join(", ");
		lines.push(`❌ Preflight FAILED: ${failedNames}`);
		lines.push("Fix the issues above before running the orchestrator.");
	}

	return lines.join("\n");
}

// ── Unmerged commit count (git query) ───────────────────────────────────────

export type UnmergedCommitsErrorCode =
	| "BRANCH_NOT_FOUND"
	| "TARGET_BRANCH_MISSING"
	| "UNMERGED_COUNT_FAILED"
	| "UNMERGED_COUNT_PARSE_FAILED";

/** Result of checking whether a branch has commits not reachable from a target. */
export interface UnmergedCommitsResult {
	ok: boolean;
	count: number;
	code?: UnmergedCommitsErrorCode;
	error?: string;
}

/**
 * Count commits on `branch` not reachable from `targetBranch`.
 *
 * Uses `git rev-list --count <targetBranch>..<branch>` (no shell pipes —
 * Windows-safe). Verifies both branches exist before counting so callers
 * get a typed error code instead of an opaque git failure.
 */
export function hasUnmergedCommits(branch: string, targetBranch: string, repoRoot: string): UnmergedCommitsResult {
	const branchCheck = runGit(["rev-parse", "--verify", `refs/heads/${branch}`], repoRoot);
	if (!branchCheck.ok) {
		return { ok: false, count: 0, code: "BRANCH_NOT_FOUND", error: `Branch "${branch}" does not exist` };
	}

	const targetCheck = runGit(["rev-parse", "--verify", `refs/heads/${targetBranch}`], repoRoot);
	if (!targetCheck.ok) {
		return {
			ok: false,
			count: 0,
			code: "TARGET_BRANCH_MISSING",
			error: `Target branch "${targetBranch}" does not exist`,
		};
	}

	const countResult = runGit(["rev-list", "--count", `${targetBranch}..${branch}`], repoRoot);
	if (!countResult.ok) {
		return {
			ok: false,
			count: 0,
			code: "UNMERGED_COUNT_FAILED",
			error: `Failed to count unmerged commits: ${countResult.stderr}`,
		};
	}

	const count = Number.parseInt(countResult.stdout.trim(), 10);
	if (Number.isNaN(count)) {
		return {
			ok: false,
			count: 0,
			code: "UNMERGED_COUNT_PARSE_FAILED",
			error: `Failed to parse commit count: "${countResult.stdout}"`,
		};
	}

	return { ok: true, count };
}

// ── Saved-branch collision resolution (pure) ────────────────────────────────

/** Outcome of resolving a saved-branch name collision. */
export interface SavedBranchResolution {
	action: "create" | "keep-existing" | "create-suffixed";
	savedName: string;
}

/**
 * Decide what to do when a saved branch name may already exist.
 *
 * Decision table:
 * - saved ref absent              → `"create"`, use `savedName`
 * - saved ref exists, same SHA    → `"keep-existing"` (idempotent no-op)
 * - saved ref exists, different SHA → `"create-suffixed"` (timestamp appended)
 *
 * Pure function — all git state is passed in. `timestamp` is injectable
 * for deterministic tests.
 */
export function resolveSavedBranchCollision(
	savedName: string,
	existingSHA: string,
	newSHA: string,
	timestamp?: string,
): SavedBranchResolution {
	if (!existingSHA) {
		return { action: "create", savedName };
	}
	if (existingSHA === newSHA) {
		return { action: "keep-existing", savedName };
	}
	const ts = timestamp || new Date().toISOString().replace(/[:.]/g, "-");
	return { action: "create-suffixed", savedName: `${savedName}-${ts}` };
}

/**
 * Preserve a branch by creating a `saved/…` ref if it has unmerged
 * commits vs `targetBranch`.
 *
 * Orchestrates `hasUnmergedCommits` → `computeSavedBranchName` →
 * `resolveSavedBranchCollision` → `git branch` creation. Idempotent:
 * if the saved ref already exists at the same SHA, the call is a
 * no-op. If the target branch is missing or git errors out, returns
 * `{ok:false, action:"error"}` rather than throwing — the caller
 * decides whether to proceed with the branch still in place.
 */
export function preserveBranch(branch: string, targetBranch: string, repoRoot: string): PreserveBranchResult {
	const branchCheck = runGit(["rev-parse", "--verify", `refs/heads/${branch}`], repoRoot);
	if (!branchCheck.ok) {
		return { ok: true, action: "no-branch" };
	}
	const branchSHA = branchCheck.stdout.trim();

	const unmergedResult = hasUnmergedCommits(branch, targetBranch, repoRoot);
	if (!unmergedResult.ok) {
		const preserveCode: PreserveBranchErrorCode =
			unmergedResult.code === "TARGET_BRANCH_MISSING" ? "TARGET_BRANCH_MISSING" : "UNMERGED_COUNT_FAILED";
		return {
			ok: false,
			action: "error",
			code: preserveCode,
			error: unmergedResult.error,
		};
	}

	if (unmergedResult.count === 0) {
		return { ok: true, action: "fully-merged", unmergedCount: 0 };
	}

	const savedName = computeSavedBranchName(branch);

	const existingCheck = runGit(["rev-parse", "--verify", `refs/heads/${savedName}`], repoRoot);
	const existingSHA = existingCheck.ok ? existingCheck.stdout.trim() : "";

	const resolution = resolveSavedBranchCollision(savedName, existingSHA, branchSHA);

	switch (resolution.action) {
		case "keep-existing":
			return {
				ok: true,
				action: "already-preserved",
				savedBranch: resolution.savedName,
				unmergedCount: unmergedResult.count,
			};

		case "create":
		case "create-suffixed": {
			const createResult = runGit(["branch", resolution.savedName, branchSHA], repoRoot);
			if (!createResult.ok) {
				return {
					ok: false,
					action: "error",
					code: "SAVED_BRANCH_CREATE_FAILED",
					error: `Failed to create saved branch "${resolution.savedName}": ${createResult.stderr}`,
					unmergedCount: unmergedResult.count,
				};
			}
			return {
				ok: true,
				action: "preserved",
				savedBranch: resolution.savedName,
				unmergedCount: unmergedResult.count,
			};
		}

		default:
			return { ok: false, action: "error", code: "UNKNOWN_RESOLUTION", error: "Unknown resolution action" };
	}
}

// ── Partial progress preservation types ─────────────────────────────────────

/**
 * Result of saving partial progress for a single failed task.
 *
 * Produced by `savePartialProgress()` and consumed by
 * `applyPartialProgressToOutcomes()` to backfill branch + commit metadata
 * onto persisted `LaneTaskOutcome` records.
 */
export interface SavePartialProgressResult {
	/** Whether partial progress was saved (branch created or already existed). */
	saved: boolean;
	/** The saved branch name, if saved. */
	savedBranch?: string;
	/** Number of commits ahead of the target branch. */
	commitCount: number;
	/** Task ID this progress belongs to. */
	taskId: string;
	/** Error message if save failed. */
	error?: string;
}

/**
 * Result of preserving partial progress across all failed tasks in a wave.
 *
 * `preservedBranches` lists every saved ref that was successfully created so
 * cleanup can delete the original lane branches without losing reachability.
 * `unsafeBranches` lists lane branches where preservation FAILED despite having
 * commits — these must not be reset or deleted, because doing so would lose
 * those commits entirely.
 */
export interface PreserveFailedLaneProgressResult {
	/** Per-task results for each failed task that was checked. */
	results: SavePartialProgressResult[];
	/**
	 * Set of saved branch names that were created (e.g.,
	 * `saved/{opId}-{taskId}-{batchId}`). Independently preserve commits —
	 * lane branches can still be safely deleted during cleanup.
	 */
	preservedBranches: Set<string>;
	/**
	 * Set of lane branch names where preservation FAILED but commits existed.
	 * Unsafe to reset/delete — callers must skip worktree reset and branch
	 * deletion for these branches to prevent data loss.
	 */
	unsafeBranches: Set<string>;
}

// ── Partial progress preservation (mutating) ────────────────────────────────

/**
 * Save partial progress from a failed task's lane branch.
 *
 * Checks the lane branch for commits ahead of the target branch and, when
 * any exist, creates a `saved/*` branch that independently preserves them.
 * Handles collisions idempotently via `resolveSavedBranchCollision`:
 *
 * - same SHA  → keep existing (`saved = true`, no-op)
 * - different → create with timestamp suffix
 *
 * Returns a `SavePartialProgressResult` describing the outcome — this is
 * best-effort and always returns a result (never throws), so callers can
 * accumulate across many lanes without stopping on the first failure.
 *
 * @param laneBranch   Lane branch that may carry partial commits
 * @param targetBranch Base/target branch to compare against
 * @param opId         Operator identifier (namespacing the saved branch)
 * @param taskId       Task identifier
 * @param batchId      Batch ID
 * @param repoRoot     Repository root for git operations
 * @param repoId       Repo identifier (workspace mode only)
 */
export function savePartialProgress(
	laneBranch: string,
	targetBranch: string,
	opId: string,
	taskId: string,
	batchId: string,
	repoRoot: string,
	repoId?: string,
): SavePartialProgressResult {
	const branchCheck = runGit(["rev-parse", "--verify", `refs/heads/${laneBranch}`], repoRoot);
	if (!branchCheck.ok) {
		return { saved: false, commitCount: 0, taskId, error: `Lane branch "${laneBranch}" not found` };
	}
	const branchSHA = branchCheck.stdout.trim();

	const unmergedResult = hasUnmergedCommits(laneBranch, targetBranch, repoRoot);
	if (!unmergedResult.ok) {
		return {
			saved: false,
			commitCount: 0,
			taskId,
			error: `Failed to count commits: ${unmergedResult.error}`,
		};
	}

	if (unmergedResult.count === 0) {
		return { saved: false, commitCount: 0, taskId };
	}

	const savedName = computePartialProgressBranchName(opId, taskId, batchId, repoId);

	const existingCheck = runGit(["rev-parse", "--verify", `refs/heads/${savedName}`], repoRoot);
	const existingSHA = existingCheck.ok ? existingCheck.stdout.trim() : "";

	const resolution = resolveSavedBranchCollision(savedName, existingSHA, branchSHA);

	switch (resolution.action) {
		case "keep-existing":
			return {
				saved: true,
				savedBranch: resolution.savedName,
				commitCount: unmergedResult.count,
				taskId,
			};

		case "create":
		case "create-suffixed": {
			const createResult = runGit(["branch", resolution.savedName, branchSHA], repoRoot);
			if (!createResult.ok) {
				return {
					saved: false,
					commitCount: unmergedResult.count,
					taskId,
					error: `Failed to create saved branch "${resolution.savedName}": ${createResult.stderr}`,
				};
			}
			return {
				saved: true,
				savedBranch: resolution.savedName,
				commitCount: unmergedResult.count,
				taskId,
			};
		}

		default:
			return {
				saved: false,
				commitCount: unmergedResult.count,
				taskId,
				error: "Unknown collision resolution action",
			};
	}
}

/**
 * Per-repo resolver: given a `repoId` (or `undefined` in repo mode), return
 * the `repoRoot` and `targetBranch` to use for that repo.
 *
 * Injected as a callback to keep worktree.ts free of circular dependencies
 * on waves.ts / workspace.ts.
 */
export type ResolveRepoContext = (repoId: string | undefined) => {
	repoRoot: string;
	targetBranch: string;
};

/**
 * Shared body for `preserveFailedLaneProgress` + `preserveSkippedLaneProgress`.
 *
 * The two public functions differ only in which `LaneTaskOutcome.status`
 * values they filter on. Everything else — lane→branch map, dedup,
 * per-repo resolution, logging — is identical.
 */
function preserveLaneProgressByStatus(
	allocatedLanes: AllocatedLane[],
	taskOutcomes: LaneTaskOutcome[],
	opId: string,
	batchId: string,
	resolveRepo: ResolveRepoContext,
	statusFilter: (outcome: LaneTaskOutcome) => boolean,
	logKind: "failed" | "skipped",
): PreserveFailedLaneProgressResult {
	const results: SavePartialProgressResult[] = [];
	const preservedBranches = new Set<string>();
	const unsafeBranches = new Set<string>();

	const taskToLane = new Map<string, { branch: string; repoId?: string }>();
	for (const lane of allocatedLanes) {
		for (const allocatedTask of lane.tasks) {
			taskToLane.set(allocatedTask.taskId, {
				branch: lane.branch,
				repoId: lane.repoId,
			});
		}
	}

	const filtered = taskOutcomes.filter(statusFilter);
	const processedBranches = new Set<string>();

	for (const outcome of filtered) {
		const laneInfo = taskToLane.get(outcome.taskId);
		if (!laneInfo) {
			results.push({
				saved: false,
				commitCount: 0,
				taskId: outcome.taskId,
				error: "Task not found in allocated lanes",
			});
			continue;
		}

		if (processedBranches.has(laneInfo.branch)) {
			continue;
		}
		processedBranches.add(laneInfo.branch);

		const { repoRoot: perRepoRoot, targetBranch } = resolveRepo(laneInfo.repoId);

		const result = savePartialProgress(
			laneInfo.branch,
			targetBranch,
			opId,
			outcome.taskId,
			batchId,
			perRepoRoot,
			laneInfo.repoId,
		);

		results.push(result);

		if (result.saved && result.savedBranch) {
			preservedBranches.add(result.savedBranch);

			const verb = logKind === "failed" ? "failed but has" : "was skipped but has";
			execLog(
				"partial-progress",
				outcome.taskId,
				`Task ${outcome.taskId} ${verb} ${result.commitCount} commit(s) of partial progress on branch ${result.savedBranch}`,
				{
					laneBranch: laneInfo.branch,
					savedBranch: result.savedBranch,
					commitCount: result.commitCount,
					repoId: laneInfo.repoId ?? "(default)",
				},
			);
		} else if (result.commitCount > 0 || result.error) {
			unsafeBranches.add(laneInfo.branch);

			const noun = logKind === "failed" ? "task" : "skipped task";
			execLog(
				"partial-progress",
				outcome.taskId,
				`WARNING: Failed to preserve partial progress for ${noun} ${outcome.taskId} (${result.commitCount} commit(s) at risk on branch "${laneInfo.branch}")`,
				{
					laneBranch: laneInfo.branch,
					commitCount: result.commitCount,
					error: result.error ?? "unknown",
					repoId: laneInfo.repoId ?? "(default)",
				},
			);
		}
	}

	return { results, preservedBranches, unsafeBranches };
}

/**
 * Preserve partial progress for all failed/stalled tasks before cleanup.
 *
 * Walks failed + stalled outcomes, maps each to its lane branch via the
 * current wave's allocation, and calls `savePartialProgress` per lane
 * (deduped by branch since one lane can host multiple tasks).
 *
 * Returns both the successfully preserved saved-branch names AND the set
 * of lane branches where preservation FAILED despite having commits —
 * callers must refuse to reset or delete those lane branches to avoid
 * losing commits that were not successfully saved.
 */
export function preserveFailedLaneProgress(
	allocatedLanes: AllocatedLane[],
	taskOutcomes: LaneTaskOutcome[],
	opId: string,
	batchId: string,
	resolveRepo: ResolveRepoContext,
): PreserveFailedLaneProgressResult {
	return preserveLaneProgressByStatus(
		allocatedLanes,
		taskOutcomes,
		opId,
		batchId,
		resolveRepo,
		o => o.status === "failed" || o.status === "stalled",
		"failed",
	);
}

/**
 * Preserve partial progress for skipped tasks (TP-147).
 *
 * Skipped tasks may still carry worker-authored commits (STATUS.md, partial
 * code) — unlike failed tasks they are NOT merged, only archived as saved
 * branches for manual recovery. Otherwise mirrors `preserveFailedLaneProgress`.
 */
export function preserveSkippedLaneProgress(
	allocatedLanes: AllocatedLane[],
	taskOutcomes: LaneTaskOutcome[],
	opId: string,
	batchId: string,
	resolveRepo: ResolveRepoContext,
): PreserveFailedLaneProgressResult {
	return preserveLaneProgressByStatus(
		allocatedLanes,
		taskOutcomes,
		opId,
		batchId,
		resolveRepo,
		o => o.status === "skipped",
		"skipped",
	);
}
