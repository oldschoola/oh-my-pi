/**
 * MissionControl worktree helpers — pure path + parsing subset.
 *
 * Ported from `taskplane/extensions/taskplane/worktree.ts` (2505 LOC).
 * This module carries only the deterministic helpers downstream modules
 * need (path math, branch naming, `git worktree list --porcelain` parsing,
 * cross-platform path normalization). The mutating I/O surface
 * (`createWorktree`, `removeWorktree`, `ensureLaneWorktrees`,
 * `removeAllWorktrees`, `safeResetWorktree`, `forceCleanupWorktree`,
 * `savePartialProgress`, `preserveFailedLaneProgress`, `runPreflight`,
 * `ensureBranchDeleted`) lands with the full engine + merge port.
 *
 * Rename map:
 *   `taskplane-wt` → default prefix becomes `mission-wt` (via
 *    DEFAULT_ORCHESTRATOR_CONFIG). Callers still pass an explicit prefix
 *    so this helper stays agnostic.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { runGit } from "./git";
import { DEFAULT_ORCHESTRATOR_CONFIG, type OrchestratorConfig } from "./types";

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
