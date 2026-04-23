/**
 * Supervisor — pure helpers ported from taskplane
 * `extensions/taskplane/supervisor.ts`.
 *
 * Scope: classification, audit trail, branch-protection probe, integration
 * planning + formatters, lockfile I/O, event tailer primitives (offset
 * reader + JSONL parser + notification formatters + digest buffer),
 * batch summary collection + formatter, and the pure supervisor config
 * and state constructors.
 *
 * Deferred (need `pi.sendMessage`, ModelRegistry, templates, or the full
 * engine surface): `activateSupervisor`, `deactivateSupervisor`,
 * `transitionToRoutingMode`, `startHeartbeat`, `startEventTailer`,
 * `stopEventTailer`, `triggerSupervisorIntegration`, `handlePrLifecycle`,
 * `pollPrCiStatus`, `mergePr`, `buildSupervisorSystemPrompt`,
 * `buildRoutingSystemPrompt`, `loadSupervisorTemplate`,
 * `generateBatchSummary`, `presentBatchSummary`, `resolveModelFromString`,
 * `checkSupervisorLockOnStartup`, `buildTakeoverSummary`.
 */

import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	open as fsOpen,
	readFile as fsReadFile,
	rename as fsRename,
	stat as fsStat,
	writeFile as fsWriteFile,
} from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "@oh-my-pi/pi-utils";

import { missionBatchPath, projectDir, supervisorEventsPath } from "./adapter";
import { parseAgentFile } from "./agent-def";
import { runGit } from "./git";
import type {
	AuditTrailEntry,
	BatchSummaryData,
	BranchProtectionStatus,
	CiDeps,
	EngineEvent,
	EngineEventType,
	EventTailerState,
	IntegrationPlan,
	MissionBatchRuntimeState,
	OrchestratorConfig,
	ParsedSupervisorEvent,
	PersistedBatchState,
	RecoveryActionClassification,
	SupervisorAutonomyLevel,
	SupervisorConfig,
	SupervisorLockfile,
	SupervisorRoutingContext,
	SupervisorState,
	TaskDigestBuffer,
	Tier0EventSummary,
	UnifiedEventType,
} from "./types";
import {
	DEFAULT_SUPERVISOR_CONFIG,
	DIGEST_SUPERVISOR_EVENT_TYPES,
	SIGNIFICANT_SUPERVISOR_EVENT_TYPES,
	STALE_LOCK_THRESHOLD_MS,
	TERMINAL_BATCH_PHASES,
} from "./types";

// ── Recovery Action Classification ───────────────────────────────────

/**
 * Whether operator confirmation is required for a given classification at
 * the given autonomy level.
 *
 * | Classification | interactive | supervised | autonomous |
 * |----------------|-------------|------------|------------|
 * | diagnostic     | auto        | auto       | auto       |
 * | tier0_known    | ask         | auto       | auto       |
 * | destructive    | ask         | ask        | auto       |
 */
export function requiresConfirmation(
	classification: RecoveryActionClassification,
	autonomy: SupervisorAutonomyLevel,
): boolean {
	if (classification === "diagnostic") return false;
	if (autonomy === "autonomous") return false;
	if (autonomy === "interactive") return true;
	return classification === "destructive";
}

/**
 * Concrete examples for each classification category — surfaced by the
 * system prompt so the supervisor can classify its own actions.
 */
export const ACTION_CLASSIFICATION_EXAMPLES: Readonly<Record<RecoveryActionClassification, readonly string[]>> = {
	diagnostic: [
		"Reading batch-state.json, STATUS.md, events.jsonl, merge results",
		"Running git status, git log, git diff",
		"Running non-mutating tests and typecheck scripts",
		"Inspecting active agents and lane status",
		"Checking worktree health (git worktree list)",
		"Reading any file for diagnostics",
	],
	tier0_known: [
		"Triggering graceful wrap-up/retry for a stalled worker lane",
		"Cleaning up stale worktrees for retry",
		"Retrying a timed-out merge",
		"Resetting a session name collision",
		"Clearing a git lock file (.git/index.lock)",
	],
	destructive: [
		"Forcing lane/batch termination (for example orch_abort(hard=true))",
		"Editing mission-batch.json fields",
		"Running git reset, git merge, git checkout -B",
		"Removing worktrees (git worktree remove)",
		"Modifying STATUS.md or .DONE files",
		"Deleting git branches (git branch -D)",
		"Skipping tasks or waves",
	],
};

// ── Audit Trail ──────────────────────────────────────────────────────

/**
 * Audit-trail file path (`<cwd>/.omp/supervisor/actions.jsonl`).
 */
export function auditTrailPath(stateRoot: string): string {
	return path.join(projectDir(stateRoot), "supervisor", "actions.jsonl");
}

/**
 * Append a single audit entry. Best-effort — creates the directory if
 * missing and swallows write failures so logging never crashes recovery.
 */
export function appendAuditEntry(stateRoot: string, entry: AuditTrailEntry): void {
	try {
		const dir = path.dirname(auditTrailPath(stateRoot));
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		appendFileSync(auditTrailPath(stateRoot), `${JSON.stringify(entry)}\n`, "utf-8");
	} catch {
		/* best-effort */
	}
}

/**
 * Log a recovery action (fills in ts + batchId automatically).
 *
 * For destructive actions, call BEFORE execution with `result: "pending"`,
 * then call again AFTER with the actual result.
 */
export function logRecoveryAction(
	stateRoot: string,
	batchId: string,
	fields: Omit<AuditTrailEntry, "ts" | "batchId">,
): void {
	appendAuditEntry(stateRoot, {
		ts: new Date().toISOString(),
		batchId,
		...fields,
	});
}

/**
 * Read audit entries — returns empty array on any error. Supports tail
 * limit and batchId filter.
 */
export function readAuditTrail(stateRoot: string, options?: { limit?: number; batchId?: string }): AuditTrailEntry[] {
	const file = auditTrailPath(stateRoot);
	if (!existsSync(file)) return [];

	let raw: string;
	try {
		raw = readFileSync(file, "utf-8").trim();
	} catch {
		return [];
	}
	if (!raw) return [];

	const entries: AuditTrailEntry[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as AuditTrailEntry;
			if (typeof parsed.ts !== "string" || typeof parsed.action !== "string") continue;
			if (options?.batchId && parsed.batchId !== options.batchId) continue;
			entries.push(parsed);
		} catch {
			/* skip malformed */
		}
	}

	if (options?.limit && entries.length > options.limit) {
		return entries.slice(-options.limit);
	}
	return entries;
}

// ── Branch Protection ────────────────────────────────────────────────

/**
 * Check whether the git repo has any remotes configured. Used by
 * integration planning to decide whether PR mode is even possible.
 */
export function hasGitRemotes(cwd: string): boolean {
	const result = runGit(["remote"], cwd);
	if (!result.ok) return false;
	return result.stdout.trim().length > 0;
}

/**
 * Detect whether a branch has protection rules on GitHub via `gh api`.
 *
 * Returns `"protected"`, `"unprotected"`, or `"unknown"` (gh unavailable,
 * auth issues, no remote, network error, etc.).
 */
export function detectBranchProtection(branch: string, cwd: string): BranchProtectionStatus {
	let repoInfo: string;
	try {
		const proc = Bun.spawnSync({
			cmd: ["gh", "repo", "view", "--json", "owner,name", "--jq", '.owner.login + "/" + .name'],
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode !== 0) return "unknown";
		repoInfo = proc.stdout.toString("utf-8").trim();
	} catch {
		return "unknown";
	}
	if (!repoInfo?.includes("/")) return "unknown";

	try {
		const proc = Bun.spawnSync({
			cmd: ["gh", "api", `repos/${repoInfo}/branches/${branch}/protection`, "--silent"],
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode === 0) return "protected";
		const stderr = proc.stderr.toString("utf-8");
		if (stderr.includes("HTTP 404") || stderr.includes("Not Found")) {
			return "unprotected";
		}
		return "unknown";
	} catch {
		return "unknown";
	}
}

// ── Integration Plan ─────────────────────────────────────────────────

/**
 * Build an integration plan from runtime batch state + repo inspection.
 *
 * 1. Require `orchBranch` + `baseBranch` + at least one succeeded task.
 * 2. Try fast-forward (`git merge-base --is-ancestor baseBranch orchBranch`).
 * 3. On divergence — PR mode if base is protected AND remotes exist,
 *    otherwise merge-commit mode.
 *
 * `protectionOverride` is for tests.
 */
export function buildIntegrationPlan(
	batchState: MissionBatchRuntimeState,
	cwd: string,
	protectionOverride?: BranchProtectionStatus,
): IntegrationPlan | null {
	if (!batchState.orchBranch || !batchState.baseBranch) return null;
	if (batchState.succeededTasks === 0) return null;

	const { orchBranch, baseBranch, batchId, succeededTasks, failedTasks } = batchState;
	const remotes = hasGitRemotes(cwd);
	const protection = protectionOverride ?? (remotes ? detectBranchProtection(baseBranch, cwd) : "unprotected");

	const ffProbe = runGit(["merge-base", "--is-ancestor", baseBranch, orchBranch], cwd);
	if (ffProbe.ok) {
		return {
			mode: "ff",
			orchBranch,
			baseBranch,
			batchId,
			branchProtection: protection,
			rationale: "Branches are linear — fast-forward merge (cleanest history).",
			succeededTasks,
			failedTasks,
		};
	}

	if (protection === "protected" && remotes) {
		return {
			mode: "pr",
			orchBranch,
			baseBranch,
			batchId,
			branchProtection: protection,
			rationale: `Branches diverged and \`${baseBranch}\` is protected — creating a pull request.`,
			succeededTasks,
			failedTasks,
		};
	}

	return {
		mode: "merge",
		orchBranch,
		baseBranch,
		batchId,
		branchProtection: protection,
		rationale: "Branches have diverged — creating a merge commit.",
		succeededTasks,
		failedTasks,
	};
}

/** Human-readable notification for an integration plan. */
export function formatIntegrationPlan(plan: IntegrationPlan): string {
	const modeLabels: Record<IntegrationPlan["mode"], string> = {
		ff: "fast-forward merge",
		merge: "merge commit",
		pr: "pull request",
	};

	const lines = [
		`🔀 **Integration Plan**`,
		``,
		`- **Mode:** ${modeLabels[plan.mode]}`,
		`- **From:** \`${plan.orchBranch}\` → \`${plan.baseBranch}\``,
		`- **Tasks:** ${plan.succeededTasks} succeeded${plan.failedTasks > 0 ? `, ${plan.failedTasks} failed` : ""}`,
		`- **Rationale:** ${plan.rationale}`,
	];
	if (plan.branchProtection === "protected") {
		lines.push(`- **Note:** Branch protection detected — PR mode is required.`);
	}
	return lines.join("\n");
}

/** Human-readable outcome notification for an integration attempt. */
export function formatIntegrationOutcome(plan: IntegrationPlan, success: boolean, detail: string): string {
	if (success) {
		const modeLabel = plan.mode === "ff" ? "Fast-forwarded" : plan.mode === "merge" ? "Merged" : "Created PR for";
		return `✅ **Integration complete!** ${modeLabel} \`${plan.orchBranch}\` → \`${plan.baseBranch}\`.\n${detail}`;
	}
	return `❌ **Integration failed** (\`${plan.orchBranch}\` → \`${plan.baseBranch}\`).\n${detail}`;
}

// ── PR Lifecycle ─────────────────────────────────────────────────────

/**
 * Poll `gh pr checks` for CI completion on `orchBranch`. Returns the final
 * status + human-readable detail. Ported from taskplane `supervisor.ts:625`.
 *
 * Retries on first-attempt failures (PR may still be creating), treats
 * `no checks`/`no status checks` stderr as a `no-checks` success, and times
 * out after `maxAttempts` poll iterations.
 */
export async function pollPrCiStatus(
	orchBranch: string,
	deps: CiDeps,
	maxAttempts: number = 30,
	delayMs: number = 10_000,
): Promise<{ status: "pass" | "fail" | "timeout" | "no-checks"; detail: string }> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (attempt > 1) {
			await new Promise(resolve => setTimeout(resolve, delayMs));
		}

		const result = deps.runCommand("gh", ["pr", "checks", orchBranch, "--json", "name,state,conclusion"]);

		if (!result.ok) {
			if (result.stderr.includes("no checks") || result.stderr.includes("no status checks")) {
				return { status: "no-checks", detail: "No CI checks are configured for this repository." };
			}
			if (attempt === 1) continue;
			return { status: "fail", detail: `Failed to query PR checks: ${result.stderr}` };
		}

		let checks: Array<{ name: string; state: string; conclusion: string }>;
		try {
			checks = JSON.parse(result.stdout);
		} catch {
			continue;
		}

		if (checks.length === 0) {
			return { status: "no-checks", detail: "No CI checks are configured for this repository." };
		}

		const allComplete = checks.every(c => c.state === "COMPLETED" || c.state === "completed");
		if (!allComplete) continue;

		const allPassing = checks.every(
			c =>
				c.conclusion === "SUCCESS" ||
				c.conclusion === "success" ||
				c.conclusion === "NEUTRAL" ||
				c.conclusion === "neutral" ||
				c.conclusion === "SKIPPED" ||
				c.conclusion === "skipped",
		);

		if (allPassing) {
			return { status: "pass", detail: `All ${checks.length} CI check(s) passed.` };
		}

		const failed = checks.filter(
			c =>
				c.conclusion !== "SUCCESS" &&
				c.conclusion !== "success" &&
				c.conclusion !== "NEUTRAL" &&
				c.conclusion !== "neutral" &&
				c.conclusion !== "SKIPPED" &&
				c.conclusion !== "skipped",
		);
		const failedNames = failed.map(c => `${c.name}: ${c.conclusion}`).join(", ");
		return { status: "fail", detail: `CI check(s) failed: ${failedNames}` };
	}

	return { status: "timeout", detail: `CI checks did not complete within ${maxAttempts} polling attempts.` };
}

/**
 * Merge a PR via `gh pr merge`. Tries regular merge first (preserves per-commit
 * history from orch branches), falls back to squash if the repo disallows merge
 * commits. Ported from taskplane `supervisor.ts:709`. Regular merge is preferred
 * because squash collapses the branch and loses per-task attribution.
 */
export function mergePr(orchBranch: string, deps: CiDeps): { success: boolean; detail: string } {
	const mergeResult = deps.runCommand("gh", ["pr", "merge", orchBranch, "--merge", "--delete-branch"]);
	if (mergeResult.ok) {
		return { success: true, detail: "PR merged and remote branch deleted." };
	}

	const squashResult = deps.runCommand("gh", ["pr", "merge", orchBranch, "--squash", "--delete-branch"]);
	if (squashResult.ok) {
		return { success: true, detail: "PR merged (squash) and remote branch deleted." };
	}

	return {
		success: false,
		detail: `PR merge failed: ${squashResult.stderr || mergeResult.stderr}`,
	};
}

// ── Lockfile ─────────────────────────────────────────────────────────

/** Path to the supervisor lockfile. */
export function lockfilePath(stateRoot: string): string {
	return path.join(projectDir(stateRoot), "supervisor", "lock.json");
}

/**
 * Read the supervisor lockfile. Returns null when missing, corrupt, or
 * missing required fields (callers treat as stale/absent).
 */
export function readLockfile(stateRoot: string): SupervisorLockfile | null {
	const file = lockfilePath(stateRoot);
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
		if (!hasLockfileShape(parsed)) return null;
		return parsed as unknown as SupervisorLockfile;
	} catch {
		return null;
	}
}

/**
 * Write the supervisor lockfile atomically (tmp + rename). Creates the
 * parent directory when missing.
 */
export function writeLockfile(stateRoot: string, lock: SupervisorLockfile): void {
	const dir = path.dirname(lockfilePath(stateRoot));
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const finalPath = lockfilePath(stateRoot);
	const tmpPath = `${finalPath}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(lock, null, 2)}\n`, "utf-8");
	renameSync(tmpPath, finalPath);
}

/** Async variant of `readLockfile`. */
export async function readLockfileAsync(stateRoot: string): Promise<SupervisorLockfile | null> {
	try {
		const raw = await fsReadFile(lockfilePath(stateRoot), "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (!hasLockfileShape(parsed)) return null;
		return parsed as unknown as SupervisorLockfile;
	} catch {
		return null;
	}
}

/** Async variant of `writeLockfile`. */
export async function writeLockfileAsync(stateRoot: string, lock: SupervisorLockfile): Promise<void> {
	const dir = path.dirname(lockfilePath(stateRoot));
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const finalPath = lockfilePath(stateRoot);
	const tmpPath = `${finalPath}.tmp`;
	await fsWriteFile(tmpPath, `${JSON.stringify(lock, null, 2)}\n`, "utf-8");
	await fsRename(tmpPath, finalPath);
}

/** Remove the lockfile if present. Best-effort. */
export function removeLockfile(stateRoot: string): void {
	const file = lockfilePath(stateRoot);
	try {
		if (existsSync(file)) unlinkSync(file);
	} catch {
		/* best-effort */
	}
}

/**
 * Probe whether a PID is alive via signal 0. Returns false on any error
 * (ESRCH from missing process, EPERM from permission loss, etc.).
 */
export function isSupervisorProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * A lockfile heartbeat is stale when it's older than
 * `STALE_LOCK_THRESHOLD_MS` (90s — 3 missed 30s heartbeats) or when the
 * heartbeat timestamp is unparseable.
 */
export function isLockStale(lock: SupervisorLockfile): boolean {
	const hb = new Date(lock.heartbeat).getTime();
	if (Number.isNaN(hb)) return true;
	return Date.now() - hb > STALE_LOCK_THRESHOLD_MS;
}

/**
 * Live handle for an active supervisor. Created by
 * {@link activateSupervisor}; released by {@link deactivateSupervisor}.
 *
 * The handle owns the heartbeat interval and the lockfile it wrote.
 * Stopping the handle stops the heartbeat without touching the lockfile;
 * {@link deactivateSupervisor} additionally removes the lockfile so the
 * dashboard reports "inactive" immediately.
 */
export interface SupervisorHandle {
	readonly batchId: string;
	readonly sessionId: string;
	readonly stateRoot: string;
	/** Stop the heartbeat interval. Idempotent. */
	stop(): void;
}

/**
 * Heartbeat cadence for an active supervisor. 30 s is three times the
 * 90 s `STALE_LOCK_THRESHOLD_MS` tolerance, which means the lockfile
 * survives two missed beats before the dashboard considers it stale.
 */
const SUPERVISOR_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Mark this process as the active supervisor for `batchId`:
 * write the lockfile, start a heartbeat timer that refreshes the
 * `heartbeat` field at {@link SUPERVISOR_HEARTBEAT_INTERVAL_MS}, and
 * return a handle the caller can stop on teardown.
 *
 * The heartbeat timer is `unref`'d so it never blocks process exit; a
 * hard crash leaves a lockfile that {@link isLockStale} flips to `stale`
 * on the next read.
 *
 * Safe to call when a stale or foreign lockfile already exists —
 * {@link writeLockfile} replaces it atomically.
 */
export function activateSupervisor(stateRoot: string, batchId: string): SupervisorHandle {
	const sessionId = `supervisor-${Date.now()}-${process.pid}`;
	const startedAt = new Date().toISOString();
	const lock: SupervisorLockfile = {
		pid: process.pid,
		sessionId,
		batchId,
		startedAt,
		heartbeat: startedAt,
	};
	writeLockfile(stateRoot, lock);

	const timer = setInterval(() => {
		try {
			writeLockfile(stateRoot, { ...lock, heartbeat: new Date().toISOString() });
		} catch (err) {
			logger.warn("[missioncontrol] supervisor heartbeat failed", {
				batchId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}, SUPERVISOR_HEARTBEAT_INTERVAL_MS);
	if (typeof timer.unref === "function") timer.unref();

	let stopped = false;
	return {
		batchId,
		sessionId,
		stateRoot,
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
		},
	};
}

/**
 * Stop the supervisor heartbeat and remove the lockfile.
 *
 * Tolerates `handle === null` (no-op) so callers can call it
 * unconditionally during teardown. Lockfile removal is best-effort —
 * failure leaves the lockfile in place but still stops the heartbeat.
 */
export function deactivateSupervisor(handle: SupervisorHandle | null, stateRoot: string): void {
	if (handle) handle.stop();
	try {
		const file = lockfilePath(stateRoot);
		if (existsSync(file)) unlinkSync(file);
	} catch (err) {
		logger.warn("[missioncontrol] supervisor deactivate failed to remove lockfile", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/** Check whether a batch phase indicates the batch is no longer active. */
export function isBatchTerminal(phase: string): boolean {
	return TERMINAL_BATCH_PHASES.has(phase);
}

function hasLockfileShape(parsed: Record<string, unknown>): boolean {
	return (
		typeof parsed.pid === "number" &&
		typeof parsed.sessionId === "string" &&
		typeof parsed.batchId === "string" &&
		typeof parsed.startedAt === "string" &&
		typeof parsed.heartbeat === "string"
	);
}

// ── Supervisor Config + State ────────────────────────────────────────

/**
 * Resolve a supervisor config from optional project-config overrides,
 * falling back to `DEFAULT_SUPERVISOR_CONFIG` field by field.
 */
export function resolveSupervisorConfig(supervisorSection?: Partial<SupervisorConfig>): SupervisorConfig {
	if (!supervisorSection) return { ...DEFAULT_SUPERVISOR_CONFIG };
	return {
		model: supervisorSection.model ?? DEFAULT_SUPERVISOR_CONFIG.model,
		autonomy: supervisorSection.autonomy ?? DEFAULT_SUPERVISOR_CONFIG.autonomy,
	};
}

/** Create a fresh (stopped) event tailer state. */
export function freshEventTailerState(): EventTailerState {
	return {
		running: false,
		byteOffset: 0,
		partialLine: "",
		batchId: "",
		digestBuffer: freshDigestBuffer(),
		pollTimer: null,
		digestTimer: null,
	};
}

/** Create an empty task digest buffer. */
export function freshDigestBuffer(): TaskDigestBuffer {
	return {
		completed: [],
		failed: [],
		recoveryAttempts: 0,
		recoverySuccesses: 0,
		recoveryExhausted: 0,
	};
}

/** Check whether a digest buffer has anything worth flushing. */
export function isDigestEmpty(buf: TaskDigestBuffer): boolean {
	return (
		buf.completed.length === 0 &&
		buf.failed.length === 0 &&
		buf.recoveryAttempts === 0 &&
		buf.recoverySuccesses === 0 &&
		buf.recoveryExhausted === 0
	);
}

/** Create a fresh (inactive) supervisor state. */
export function freshSupervisorState(): SupervisorState {
	return {
		active: false,
		batchId: "",
		config: { ...DEFAULT_SUPERVISOR_CONFIG },
		batchStateRef: null,
		orchConfigRef: null,
		stateRoot: "",
		previousModel: null,
		didSwitchModel: false,
		lockSessionId: "",
		heartbeatTimer: null,
		eventTailer: freshEventTailerState(),
		routingContext: null,
		pendingSummaryDeps: null,
	};
}

// ── Event Tailer Primitives ──────────────────────────────────────────

/**
 * Read newly-appended bytes from a JSONL file starting at `byteOffset`.
 * Returns `[newData, updatedOffset]`. Empty string when nothing changed
 * or the file is unreadable.
 */
export function readNewBytes(eventsPath: string, byteOffset: number): [string, number] {
	if (!existsSync(eventsPath)) return ["", byteOffset];

	let fileSize: number;
	try {
		fileSize = statSync(eventsPath).size;
	} catch {
		return ["", byteOffset];
	}
	if (fileSize <= byteOffset) return ["", byteOffset];

	const bytesToRead = fileSize - byteOffset;
	const buffer = Buffer.alloc(bytesToRead);

	let fd: number | null = null;
	try {
		fd = openSync(eventsPath, "r");
		readSync(fd, buffer, 0, bytesToRead, byteOffset);
	} catch {
		return ["", byteOffset];
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				/* best-effort */
			}
		}
	}

	return [buffer.toString("utf-8"), fileSize];
}

/** Async variant of `readNewBytes`. */
export async function readNewBytesAsync(eventsPath: string, byteOffset: number): Promise<[string, number]> {
	try {
		const stats = await fsStat(eventsPath);
		const fileSize = stats.size;
		if (fileSize <= byteOffset) return ["", byteOffset];

		const bytesToRead = fileSize - byteOffset;
		const buffer = Buffer.alloc(bytesToRead);

		const fh = await fsOpen(eventsPath, "r");
		try {
			await fh.read(buffer, 0, bytesToRead, byteOffset);
		} finally {
			await fh.close();
		}

		return [buffer.toString("utf-8"), fileSize];
	} catch {
		return ["", byteOffset];
	}
}

/**
 * Parse JSONL lines from a chunk of raw data. Returns `[events, remaining]`
 * — `remaining` is the trailing partial line (preserved for the next read).
 * Malformed lines are skipped.
 */
export function parseJsonlLines(data: string, partialLine: string): [ParsedSupervisorEvent[], string] {
	const combined = partialLine + data;
	const lines = combined.split("\n");
	const remaining = lines.pop() ?? "";

	const events: ParsedSupervisorEvent[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			if (
				typeof parsed.timestamp === "string" &&
				typeof parsed.type === "string" &&
				typeof parsed.batchId === "string"
			) {
				events.push(parsed as unknown as ParsedSupervisorEvent);
			}
		} catch {
			/* skip malformed */
		}
	}

	return [events, remaining];
}

/**
 * Format a significant event into an operator-facing notification.
 * Autonomy tunes verbosity for merge failures, pauses, and escalations.
 */
export function formatEventNotification(event: ParsedSupervisorEvent, autonomy: SupervisorAutonomyLevel): string {
	const waveNum = event.waveIndex >= 0 ? event.waveIndex + 1 : "?";
	switch (event.type) {
		case "wave_start": {
			const taskCount = event.taskIds?.length ?? 0;
			const laneInfo = event.laneCount ? ` across ${event.laneCount} lanes` : "";
			return `🌊 **Wave ${waveNum} starting** with ${taskCount} task(s)${laneInfo}.`;
		}
		case "merge_start":
			return `🔀 Wave ${waveNum} merge starting...`;
		case "merge_success": {
			const waveProg = event.totalWaves ? ` (${waveNum}/${event.totalWaves})` : "";
			const testInfo = event.testCount ? ` Tests pass (${event.testCount}).` : " Tests pass.";
			return `✅ **Wave ${waveNum} merged successfully**${waveProg}.${testInfo}`;
		}
		case "merge_failed": {
			const reason = event.reason || event.error || "unknown reason";
			const laneInfo = event.laneNumber !== undefined ? ` (lane ${event.laneNumber})` : "";
			if (autonomy === "autonomous") {
				return `⚠️ Wave ${waveNum} merge failed${laneInfo}: ${reason}. Attempting recovery...`;
			}
			return `⚠️ **Wave ${waveNum} merge failed**${laneInfo}: ${reason}.\n   Recovery may be needed. Check the merge logs for details.`;
		}
		case "merge_health_warning": {
			const lane = event.laneNumber !== undefined ? event.laneNumber : "?";
			const mins = event.stalledMinutes ?? "?";
			return `⚠️ Merge agent on lane ${lane} may be stalled (no output for ${mins} min)`;
		}
		case "merge_health_dead": {
			const lane = event.laneNumber !== undefined ? event.laneNumber : "?";
			return `💀 Merge agent on lane ${lane} session died — triggering early retry`;
		}
		case "merge_health_stuck": {
			const lane = event.laneNumber !== undefined ? event.laneNumber : "?";
			const mins = event.stalledMinutes ?? "?";
			return `🔒 Merge agent on lane ${lane} appears stuck (no output for ${mins} min). Consider killing and retrying.`;
		}
		case "batch_complete": {
			const parts: string[] = [];
			if (event.succeededTasks !== undefined) parts.push(`${event.succeededTasks} succeeded`);
			if (event.failedTasks !== undefined && event.failedTasks > 0) {
				parts.push(`${event.failedTasks} failed`);
			}
			if (event.skippedTasks !== undefined && event.skippedTasks > 0) {
				parts.push(`${event.skippedTasks} skipped`);
			}
			if (event.blockedTasks !== undefined && event.blockedTasks > 0) {
				parts.push(`${event.blockedTasks} blocked`);
			}
			const summary = parts.length > 0 ? parts.join(", ") : "all tasks processed";
			const duration = event.batchDurationMs ? ` in ${formatDurationMs(event.batchDurationMs)}` : "";
			return `🏁 **Batch complete!** ${summary}${duration}.`;
		}
		case "batch_paused": {
			const reason = event.reason || "unknown reason";
			if (autonomy === "interactive") {
				return `⏸️ **Batch paused:** ${reason}\n   What would you like to do? Options: fix the issue, skip the task, or abort.`;
			}
			return `⏸️ **Batch paused:** ${reason}`;
		}
		case "tier0_escalation": {
			const pattern = event.pattern || "unknown";
			const suggestion = event.suggestion || "Manual intervention needed.";
			if (autonomy === "autonomous") {
				return `⚡ **Tier 0 escalation** (${pattern}): Investigating automatically. ${suggestion}`;
			}
			if (autonomy === "interactive") {
				return `❌ **Tier 0 escalation** (${pattern}): ${suggestion}\n   Need your input on how to proceed.`;
			}
			return `⚡ **Tier 0 escalation** (${pattern}): ${suggestion}\n   Diagnosing — will ask if novel recovery is needed.`;
		}
		default:
			return `📌 Event: ${event.type} (wave ${waveNum})`;
	}
}

/**
 * Format a task digest buffer. Returns null when the buffer is empty.
 *
 * Autonomy controls whether completed-task IDs are listed inline.
 */
export function formatTaskDigest(buf: TaskDigestBuffer, autonomy: SupervisorAutonomyLevel): string | null {
	if (isDigestEmpty(buf)) return null;

	const parts: string[] = [];
	if (buf.completed.length > 0) {
		parts.push(
			autonomy === "interactive"
				? `✓ ${buf.completed.length} task(s) completed: ${buf.completed.join(", ")}`
				: `✓ ${buf.completed.length} task(s) completed`,
		);
	}
	if (buf.failed.length > 0) {
		parts.push(`✗ ${buf.failed.length} task(s) failed: ${buf.failed.join(", ")}`);
	}
	if (buf.recoveryAttempts > 0 && autonomy !== "autonomous") {
		const successRate = buf.recoverySuccesses > 0 ? ` (${buf.recoverySuccesses} succeeded)` : "";
		parts.push(`🔄 ${buf.recoveryAttempts} recovery attempt(s)${successRate}`);
	}
	if (buf.recoveryExhausted > 0) {
		parts.push(`⚠️ ${buf.recoveryExhausted} recovery budget(s) exhausted`);
	}
	if (parts.length === 0) return null;
	return `📊 **Progress update:**\n   ${parts.join("\n   ")}`;
}

/**
 * Decide whether a given event type should be surfaced at this autonomy
 * level. Terminal/failure events always notify; autonomous mode filters
 * out routine progress.
 */
export function shouldNotify(eventType: UnifiedEventType, autonomy: SupervisorAutonomyLevel): boolean {
	if (
		eventType === "batch_complete" ||
		eventType === "batch_paused" ||
		eventType === "merge_failed" ||
		eventType === "merge_health_dead" ||
		eventType === "merge_health_stuck" ||
		eventType === "tier0_escalation"
	) {
		return true;
	}
	if (autonomy === "autonomous") return false;
	return SIGNIFICANT_SUPERVISOR_EVENT_TYPES.has(eventType);
}

/**
 * Buffer a digest-class event into a digest buffer. Silently ignores
 * non-digest event types.
 */
export function bufferDigestEvent(event: ParsedSupervisorEvent, buf: TaskDigestBuffer): void {
	switch (event.type) {
		case "task_complete":
			if (event.taskId) buf.completed.push(event.taskId);
			break;
		case "task_failed":
			if (event.taskId) buf.failed.push(event.taskId);
			break;
		case "tier0_recovery_attempt":
			buf.recoveryAttempts++;
			break;
		case "tier0_recovery_success":
			buf.recoverySuccesses++;
			break;
		case "tier0_recovery_exhausted":
			buf.recoveryExhausted++;
			break;
	}
}

/**
 * Process a batch of parsed events — filter to the active batch, classify
 * significant vs digest, and dispatch notifications via the supplied
 * callback. Events from other batches are dropped; when the tailer has
 * not yet captured a batchId (pre-planning), the first event's batchId
 * is adopted.
 */
export function processEvents(
	events: ParsedSupervisorEvent[],
	tailer: EventTailerState,
	autonomy: SupervisorAutonomyLevel,
	notify: (text: string) => void,
	onBatchComplete?: (event: ParsedSupervisorEvent) => void,
): void {
	for (const event of events) {
		if (tailer.batchId && event.batchId && event.batchId !== tailer.batchId) {
			continue;
		}
		if (!tailer.batchId && event.batchId) {
			tailer.batchId = event.batchId;
		}

		if (event.type === "batch_complete" && onBatchComplete) {
			onBatchComplete(event);
		}

		if (DIGEST_SUPERVISOR_EVENT_TYPES.has(event.type)) {
			bufferDigestEvent(event, tailer.digestBuffer);
		} else if (shouldNotify(event.type, autonomy)) {
			notify(formatEventNotification(event, autonomy));
		}
	}
}

// ── Batch Summary ────────────────────────────────────────────────────

const TIER0_SUMMARY_TYPES = new Set([
	"tier0_recovery_attempt",
	"tier0_recovery_success",
	"tier0_recovery_exhausted",
	"tier0_escalation",
]);

/**
 * Read Tier 0 events from `.omp/supervisor/events.jsonl`, filtered by
 * batchId. Best-effort — returns empty array when the file is missing
 * or unreadable.
 */
export function readTier0EventsForBatch(stateRoot: string, batchId: string): Tier0EventSummary[] {
	const eventsPath = supervisorEventsPath(stateRoot);
	if (!existsSync(eventsPath)) return [];

	let raw: string;
	try {
		raw = readFileSync(eventsPath, "utf-8").trim();
	} catch {
		return [];
	}
	if (!raw) return [];

	const results: Tier0EventSummary[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			if (parsed.batchId !== batchId) continue;
			if (typeof parsed.type !== "string" || !TIER0_SUMMARY_TYPES.has(parsed.type)) continue;

			const entry: Tier0EventSummary = {
				timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
				type: parsed.type,
				pattern: typeof parsed.pattern === "string" ? parsed.pattern : "unknown",
				attempt: typeof parsed.attempt === "number" ? parsed.attempt : 0,
				maxAttempts: typeof parsed.maxAttempts === "number" ? parsed.maxAttempts : 0,
			};
			if (typeof parsed.taskId === "string") entry.taskId = parsed.taskId;
			if (typeof parsed.resolution === "string") entry.resolution = parsed.resolution;
			if (typeof parsed.error === "string") entry.error = parsed.error;
			if (typeof parsed.suggestion === "string") entry.suggestion = parsed.suggestion;
			if (Array.isArray(parsed.affectedTaskIds) && parsed.affectedTaskIds.length > 0) {
				entry.affectedTaskIds = parsed.affectedTaskIds as string[];
			}
			results.push(entry);
		} catch {
			/* skip malformed */
		}
	}
	return results;
}

const ENGINE_EVENT_TYPES: ReadonlySet<EngineEventType> = new Set<EngineEventType>([
	"wave_start",
	"task_complete",
	"task_failed",
	"merge_start",
	"merge_success",
	"merge_failed",
	"merge_health_warning",
	"merge_health_dead",
	"merge_health_stuck",
	"batch_complete",
	"batch_paused",
	"milestone_started",
	"milestone_validating",
	"milestone_passed",
	"milestone_failed",
	"validator_started",
	"validator_completed",
	"fix_feature_generated",
]);

/**
 * Minimal projection of {@link EngineEvent} fields the supervisor timeline
 * renders. Mirrors {@link Tier0EventSummary} shape — enough to decide the
 * row label, outcome, and optional detail without forcing consumers to
 * understand every engine-event field.
 */
export interface EngineEventSummary {
	timestamp: string;
	type: EngineEventType;
	waveIndex: number;
	phase: string;
	taskId?: string;
	laneNumber?: number;
	durationMs?: number;
	reason?: string;
	error?: string;
	succeededTasks?: number;
	failedTasks?: number;
	skippedTasks?: number;
	blockedTasks?: number;
}

/**
 * Read engine lifecycle events from `.omp/supervisor/events.jsonl`, filtered
 * by batchId. Shares the file with Tier 0 events — the type-set filter
 * separates the two streams. Returns empty array when the file is missing,
 * unreadable, or has no matching entries.
 */
export function readEngineEventsForBatch(stateRoot: string, batchId: string): EngineEventSummary[] {
	const eventsPath = supervisorEventsPath(stateRoot);
	if (!existsSync(eventsPath)) return [];

	let raw: string;
	try {
		raw = readFileSync(eventsPath, "utf-8").trim();
	} catch {
		return [];
	}
	if (!raw) return [];

	const results: EngineEventSummary[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (parsed.batchId !== batchId) continue;
		if (typeof parsed.type !== "string" || !ENGINE_EVENT_TYPES.has(parsed.type as EngineEventType)) continue;

		const entry: EngineEventSummary = {
			timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
			type: parsed.type as EngineEventType,
			waveIndex: typeof parsed.waveIndex === "number" ? parsed.waveIndex : 0,
			phase: typeof parsed.phase === "string" ? parsed.phase : "",
		};
		if (typeof parsed.taskId === "string") entry.taskId = parsed.taskId;
		if (typeof parsed.laneNumber === "number") entry.laneNumber = parsed.laneNumber;
		if (typeof parsed.durationMs === "number") entry.durationMs = parsed.durationMs;
		if (typeof parsed.reason === "string") entry.reason = parsed.reason;
		if (typeof parsed.error === "string") entry.error = parsed.error;
		if (typeof parsed.succeededTasks === "number") entry.succeededTasks = parsed.succeededTasks;
		if (typeof parsed.failedTasks === "number") entry.failedTasks = parsed.failedTasks;
		if (typeof parsed.skippedTasks === "number") entry.skippedTasks = parsed.skippedTasks;
		if (typeof parsed.blockedTasks === "number") entry.blockedTasks = parsed.blockedTasks;
		results.push(entry);
	}
	return results;
}

/** Format a duration in ms into a human-readable short form. */
export function formatDurationMs(ms: number): string {
	const safe = ms < 0 ? 0 : ms;
	const totalSecs = Math.floor(safe / 1000);
	if (totalSecs < 60) return `${totalSecs}s`;
	const mins = Math.floor(totalSecs / 60);
	const secs = totalSecs % 60;
	if (mins < 60) return `${mins}m${secs > 0 ? ` ${secs}s` : ""}`;
	const hours = Math.floor(mins / 60);
	const remainMins = mins % 60;
	return `${hours}h${remainMins > 0 ? ` ${remainMins}m` : ""}`;
}

function computeV2BatchCost(stateRoot: string, batchId: string): number {
	try {
		const lanesDir = path.join(projectDir(stateRoot), "runtime", batchId, "lanes");
		if (!existsSync(lanesDir)) return 0;
		const files = readdirSync(lanesDir).filter(f => f.startsWith("lane-") && f.endsWith(".json"));
		let total = 0;
		for (const f of files) {
			try {
				const snap = JSON.parse(readFileSync(path.join(lanesDir, f), "utf-8")) as {
					worker?: { costUsd?: number };
					reviewer?: { costUsd?: number };
				};
				total += snap.worker?.costUsd ?? 0;
				total += snap.reviewer?.costUsd ?? 0;
			} catch {
				/* skip */
			}
		}
		return total;
	} catch {
		return 0;
	}
}

/**
 * Collect batch summary data from runtime state + audit trail + Tier 0
 * events. Reads the filesystem; `formatBatchSummary` is the pure
 * rendering companion.
 */
export function collectBatchSummaryData(
	batchState: MissionBatchRuntimeState,
	stateRoot: string,
	diagnostics?: {
		taskExits: Record<string, { classification: string; cost: number; durationSec: number }>;
		batchCost: number;
	} | null,
	mergeResults?: Array<{
		waveIndex: number;
		status: string;
		failedLane: number | null;
		failureReason: string | null;
	}>,
): BatchSummaryData {
	const auditEntries = readAuditTrail(stateRoot, { batchId: batchState.batchId });
	const tier0Events = readTier0EventsForBatch(stateRoot, batchState.batchId);

	const waveResults = (batchState.waveResults || []).map(wr => ({
		waveIndex: wr.waveIndex,
		startedAt: wr.startedAt,
		endedAt: wr.endedAt,
		succeededTaskIds: wr.succeededTaskIds || [],
		failedTaskIds: wr.failedTaskIds || [],
		skippedTaskIds: wr.skippedTaskIds || [],
		overallStatus: wr.overallStatus || "unknown",
	}));

	type SegmentLike = { taskId: string; status: string };
	const isSegmentLike = (value: unknown): value is SegmentLike =>
		typeof value === "object" &&
		value !== null &&
		typeof (value as { taskId?: unknown }).taskId === "string" &&
		typeof (value as { status?: unknown }).status === "string";
	const segmentRecords: SegmentLike[] = (batchState.segments || []).filter(isSegmentLike);
	let segmentOutcomes: BatchSummaryData["segmentOutcomes"] = null;
	if (segmentRecords.length > 0) {
		const byTaskId = new Map<string, SegmentLike[]>();
		for (const segment of segmentRecords) {
			const existing = byTaskId.get(segment.taskId) || [];
			existing.push(segment);
			byTaskId.set(segment.taskId, existing);
		}

		const multiSegmentTasks: NonNullable<BatchSummaryData["segmentOutcomes"]>["multiSegmentTasks"] = [];
		for (const [taskId, taskSegments] of [...byTaskId.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			if (taskSegments.length <= 1) continue;
			const succeeded = taskSegments.filter(s => s.status === "succeeded").length;
			const failed = taskSegments.filter(s => s.status === "failed").length;
			const stalled = taskSegments.filter(s => s.status === "stalled").length;
			const skipped = taskSegments.filter(s => s.status === "skipped").length;
			const running = taskSegments.filter(s => s.status === "running").length;
			const pending = taskSegments.filter(s => s.status === "pending").length;
			multiSegmentTasks.push({
				taskId,
				totalSegments: taskSegments.length,
				terminalSegments: succeeded + failed + stalled + skipped,
				succeeded,
				failed,
				stalled,
				skipped,
				running,
				pending,
			});
		}

		segmentOutcomes = {
			totalSegments: segmentRecords.length,
			succeeded: segmentRecords.filter(s => s.status === "succeeded").length,
			failed: segmentRecords.filter(s => s.status === "failed").length,
			stalled: segmentRecords.filter(s => s.status === "stalled").length,
			skipped: segmentRecords.filter(s => s.status === "skipped").length,
			running: segmentRecords.filter(s => s.status === "running").length,
			pending: segmentRecords.filter(s => s.status === "pending").length,
			multiSegmentTasks,
		};
	}

	const providedCost = diagnostics?.batchCost ?? 0;
	const batchCost = providedCost > 0 ? providedCost : computeV2BatchCost(stateRoot, batchState.batchId);

	return {
		batchId: batchState.batchId,
		phase: batchState.phase,
		startedAt: batchState.startedAt,
		endedAt: batchState.endedAt,
		totalTasks: batchState.totalTasks,
		succeededTasks: batchState.succeededTasks,
		failedTasks: batchState.failedTasks,
		skippedTasks: batchState.skippedTasks,
		blockedTasks: batchState.blockedTasks,
		batchCost,
		wavePlan: [],
		waveResults,
		taskExits: diagnostics?.taskExits ?? {},
		mergeResults: mergeResults ?? [],
		segmentOutcomes,
		auditEntries,
		tier0Events,
		errors: batchState.errors || [],
	};
}

/**
 * Format a batch summary as markdown. Pure — no I/O, no side effects.
 *
 * Sections: header (duration/cost/result/phase), wave timeline, segment
 * outcomes, incidents (Tier 0 + supervisor actions + errors), and
 * recommendations.
 */
export function formatBatchSummary(data: BatchSummaryData): string {
	const lines: string[] = [];

	lines.push(`# Batch Summary: ${data.batchId}`, "");

	const duration = data.endedAt && data.startedAt ? formatDurationMs(data.endedAt - data.startedAt) : "In progress";
	lines.push(`**Duration:** ${duration}`);

	lines.push(data.batchCost > 0 ? `**Cost:** $${data.batchCost.toFixed(2)}` : `**Cost:** Not available`);

	const resultParts: string[] = [`${data.succeededTasks}/${data.totalTasks} tasks succeeded`];
	if (data.failedTasks > 0) resultParts.push(`${data.failedTasks} failed`);
	if (data.skippedTasks > 0) resultParts.push(`${data.skippedTasks} skipped`);
	if (data.blockedTasks > 0) resultParts.push(`${data.blockedTasks} blocked`);
	lines.push(`**Result:** ${resultParts.join(", ")}`);
	lines.push(`**Phase:** ${data.phase}`, "");

	lines.push("## Wave Timeline", "");
	if (data.waveResults.length === 0) {
		lines.push("No wave data available.");
	} else {
		for (const wave of data.waveResults) {
			const waveNum = wave.waveIndex + 1;
			const taskCount = wave.succeededTaskIds.length + wave.failedTaskIds.length + wave.skippedTaskIds.length;
			const waveDuration = formatDurationMs(wave.endedAt - wave.startedAt);

			const mergeResult = data.mergeResults.find(mr => mr.waveIndex === wave.waveIndex);
			let mergeInfo = "";
			if (mergeResult) {
				if (mergeResult.status === "succeeded") mergeInfo = " ✅";
				else if (mergeResult.status === "failed") {
					mergeInfo = ` ❌ (merge failed: ${mergeResult.failureReason || "unknown"})`;
				} else if (mergeResult.status === "partial") mergeInfo = ` ⚠️ (partial merge)`;
			}

			const statusIcon =
				wave.overallStatus === "succeeded"
					? "✅"
					: wave.overallStatus === "failed"
						? "❌"
						: wave.overallStatus === "partial"
							? "⚠️"
							: wave.overallStatus === "aborted"
								? "🛑"
								: "❓";

			lines.push(`- Wave ${waveNum} (${taskCount} tasks): ${waveDuration} ${statusIcon}${mergeInfo}`);
			if (wave.failedTaskIds.length > 0) {
				lines.push(`  - Failed: ${wave.failedTaskIds.join(", ")}`);
			}
		}
	}
	lines.push("");

	lines.push("## Segment Outcomes", "");
	if (!data.segmentOutcomes) {
		lines.push("Segment data not available.");
	} else if (data.segmentOutcomes.multiSegmentTasks.length === 0) {
		lines.push(
			`No multi-segment task outcomes recorded (${data.segmentOutcomes.totalSegments} segment record(s) total).`,
		);
	} else {
		const statusParts = [`${data.segmentOutcomes.succeeded} succeeded`, `${data.segmentOutcomes.failed} failed`];
		if (data.segmentOutcomes.running > 0) statusParts.push(`${data.segmentOutcomes.running} running`);
		if (data.segmentOutcomes.pending > 0) statusParts.push(`${data.segmentOutcomes.pending} pending`);
		if (data.segmentOutcomes.skipped > 0) statusParts.push(`${data.segmentOutcomes.skipped} skipped`);
		if (data.segmentOutcomes.stalled > 0) statusParts.push(`${data.segmentOutcomes.stalled} stalled`);
		lines.push(`- **Tracked segments:** ${data.segmentOutcomes.totalSegments}`);
		lines.push(`- **Status mix:** ${statusParts.join(", ")}`);
		lines.push(`- **Multi-segment tasks:** ${data.segmentOutcomes.multiSegmentTasks.length}`);
		for (const task of data.segmentOutcomes.multiSegmentTasks) {
			const taskParts = [`${task.succeeded}✓`, `${task.failed}✗`];
			if (task.running > 0) taskParts.push(`${task.running} running`);
			if (task.pending > 0) taskParts.push(`${task.pending} pending`);
			if (task.skipped > 0) taskParts.push(`${task.skipped} skipped`);
			if (task.stalled > 0) taskParts.push(`${task.stalled} stalled`);
			lines.push(
				`  - ${task.taskId}: ${task.terminalSegments}/${task.totalSegments} terminal (${taskParts.join(", ")})`,
			);
		}
	}
	lines.push("");

	lines.push("## Incidents", "");
	const incidents = data.auditEntries.filter(e => e.classification !== "diagnostic" && e.result !== "pending");
	const hasTier0Events = data.tier0Events.length > 0;
	const hasAuditIncidents = incidents.length > 0;
	const hasErrors = data.errors.length > 0;

	if (!hasAuditIncidents && !hasTier0Events && !hasErrors) {
		lines.push("No incidents recorded.");
	} else {
		if (hasTier0Events) {
			lines.push("### Tier 0 Recoveries", "");
			const byPattern = new Map<string, typeof data.tier0Events>();
			for (const evt of data.tier0Events) {
				const list = byPattern.get(evt.pattern) ?? [];
				list.push(evt);
				byPattern.set(evt.pattern, list);
			}
			for (const [pattern, events] of byPattern) {
				const attempts = events.filter(e => e.type === "tier0_recovery_attempt").length;
				const successes = events.filter(e => e.type === "tier0_recovery_success").length;
				const exhausted = events.filter(e => e.type === "tier0_recovery_exhausted").length;
				const escalations = events.filter(e => e.type === "tier0_escalation").length;

				const statusIcon = exhausted > 0 || escalations > 0 ? "❌" : successes > 0 ? "✅" : "⏳";
				lines.push(
					`- **${pattern}** ${statusIcon} — ${attempts} attempt(s), ${successes} success(es), ${exhausted} exhausted`,
				);

				const taskIds = new Set<string>();
				for (const evt of events) {
					if (evt.taskId) taskIds.add(evt.taskId);
					if (evt.affectedTaskIds) {
						for (const tid of evt.affectedTaskIds) taskIds.add(tid);
					}
				}
				if (taskIds.size > 0) lines.push(`  - Affected tasks: ${[...taskIds].join(", ")}`);

				for (const evt of events.filter(e => e.type === "tier0_escalation")) {
					if (evt.suggestion) lines.push(`  - Escalation: ${evt.suggestion}`);
				}
				for (const evt of events.filter(e => e.type === "tier0_recovery_success")) {
					if (evt.resolution) lines.push(`  - Resolution: ${evt.resolution}`);
				}
				for (const evt of events.filter(e => e.type === "tier0_recovery_exhausted")) {
					if (evt.error) lines.push(`  - Error: ${evt.error}`);
				}
			}
			lines.push("");
		}

		if (hasAuditIncidents) {
			if (hasTier0Events) lines.push("### Supervisor Actions", "");
			let incidentNum = 0;
			for (const entry of incidents) {
				incidentNum++;
				const resultIcon =
					entry.result === "success"
						? "✅"
						: entry.result === "failure"
							? "❌"
							: entry.result === "skipped"
								? "⏭️"
								: "❓";
				lines.push(`${incidentNum}. **${entry.action}** (${entry.classification}) ${resultIcon}`);
				lines.push(`   ${entry.context}`);
				if (entry.detail && entry.detail !== entry.context) {
					lines.push(`   Result: ${entry.detail}`);
				}
				if (entry.durationMs !== undefined) {
					lines.push(`   Duration: ${formatDurationMs(entry.durationMs)}`);
				}
			}
			lines.push("");
		}

		if (hasErrors) {
			lines.push("### Errors");
			for (const error of data.errors) {
				lines.push(`- ${error}`);
			}
		}
	}
	lines.push("");

	lines.push("## Recommendations", "");
	const recommendations: string[] = [];

	const mergeFailures = data.mergeResults.filter(mr => mr.status === "failed");
	if (mergeFailures.length > 0) {
		recommendations.push(
			"- Consider increasing `merge.timeoutMinutes` — merge failures were detected during this batch.",
		);
	}

	if (data.totalTasks > 0 && data.failedTasks > 0) {
		const failureRate = data.failedTasks / data.totalTasks;
		if (failureRate > 0.3) {
			recommendations.push(
				`- High failure rate (${Math.round(failureRate * 100)}%) — consider reducing task scope or adding more context to PROMPT.md files.`,
			);
		}
	}

	const longTasks = Object.entries(data.taskExits).filter(([, exit]) => exit.durationSec > 3600);
	if (longTasks.length > 0) {
		const names = longTasks.map(([id]) => id).join(", ");
		recommendations.push(
			`- Long-running tasks detected (${names}): ${longTasks.length} task(s) exceeded 1 hour — consider splitting into smaller tasks.`,
		);
	}

	const recoveryExhaustedAudit = data.auditEntries.filter(
		e => e.action === "tier0_recovery_exhausted" || (e.classification === "tier0_known" && e.result === "failure"),
	);
	const recoveryExhaustedTier0 = data.tier0Events.filter(e => e.type === "tier0_recovery_exhausted");
	const escalationsTier0 = data.tier0Events.filter(e => e.type === "tier0_escalation");
	if (recoveryExhaustedAudit.length > 0 || recoveryExhaustedTier0.length > 0) {
		recommendations.push(
			"- Recovery budget was exhausted for some issues — review recurring failures and consider addressing root causes.",
		);
	}
	if (escalationsTier0.length > 0) {
		const uniqueSuggestions = [...new Set(escalationsTier0.map(e => e.suggestion).filter(Boolean) as string[])];
		for (const suggestion of uniqueSuggestions) {
			recommendations.push(`- Escalation suggestion: ${suggestion}`);
		}
	}

	if (recommendations.length === 0) {
		lines.push("No recommendations — batch looks healthy.");
	} else {
		for (const r of recommendations) lines.push(r);
	}

	return lines.join("\n");
}

/**
 * Generate a batch summary markdown + write to `<stateRoot>/.omp/supervisor/<opId>-<batchId>-summary.md`.
 * Ported from taskplane `supervisor.ts:1779`. File write is best-effort —
 * failures never throw; the markdown is always returned to the caller.
 */
export function generateBatchSummary(
	batchState: MissionBatchRuntimeState,
	stateRoot: string,
	opId: string,
	diagnostics?: {
		taskExits: Record<string, { classification: string; cost: number; durationSec: number }>;
		batchCost: number;
	} | null,
	mergeResults?: Array<{
		waveIndex: number;
		status: string;
		failedLane: number | null;
		failureReason: string | null;
	}>,
): string {
	const data = collectBatchSummaryData(batchState, stateRoot, diagnostics, mergeResults);
	const markdown = formatBatchSummary(data);

	try {
		const dir = path.join(projectDir(stateRoot), "supervisor");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const filename = `${opId}-${batchState.batchId}-summary.md`;
		writeFileSync(path.join(dir, filename), markdown, "utf-8");
	} catch {
		/* best-effort: file write failure must not block summary presentation */
	}

	return markdown;
}

// ── Supervisor Templates (TP-058) ───────────────────────────────────

/**
 * Resolve the absolute path to a base supervisor template shipped with
 * the package. Templates live at `<package-root>/templates/agents/`.
 * Current file lives at `<package-root>/src/missioncontrol/supervisor.ts`,
 * hence `..`/`..`/`..`/`templates/agents`.
 */
export function resolveBaseTemplatePath(name: string): string {
	const thisDir = path.dirname(fileURLToPath(import.meta.url));
	return path.join(thisDir, "..", "..", "templates", "agents", `${name}.md`);
}

/**
 * Parse a simple frontmatter + body markdown file.
 * Returns null if the file doesn't exist or has no frontmatter.
 */
export function parseSupervisorTemplate(filePath: string): { fm: Record<string, string>; body: string } | null {
	if (!existsSync(filePath)) return null;
	const raw = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
	const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return null;
	const fm: Record<string, string> = {};
	const fmBlock = match[1] ?? "";
	for (const line of fmBlock.split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			if (!key.startsWith("#")) {
				fm[key] = line.slice(idx + 1).trim();
			}
		}
	}
	return { fm, body: (match[2] ?? "").trim() };
}

/**
 * Load a supervisor template: base (from package) + local override (from project).
 *
 * - Base template: `<package-root>/templates/agents/{name}.md`
 * - Local override: `<stateRoot>/.omp/agents/{localName}.md`
 * - If local has `standalone: true`, use it exclusively
 * - Otherwise compose base + local with a separator
 */
export function loadSupervisorTemplate(name: string, stateRoot: string, localName?: string): string | null {
	const basePath = resolveBaseTemplatePath(name);
	const baseDef = parseSupervisorTemplate(basePath);

	const effectiveLocalName = localName || name;
	const localPath = stateRoot ? path.join(projectDir(stateRoot), "agents", `${effectiveLocalName}.md`) : "";
	const localDef = localPath ? parseAgentFile(localPath) : null;

	if (!baseDef && !localDef) return null;
	if (localDef?.fm.standalone === "true") return localDef.body;

	const baseBody = baseDef?.body ?? "";
	const localBody = localDef?.body ?? "";
	if (localBody) {
		return `${baseBody}\n\n---\n\n## Project-Specific Guidance\n\n${localBody}`;
	}
	return baseBody;
}

/**
 * Replace `{{variable}}` placeholders in a template string.
 * Unknown keys are left intact.
 */
export function replaceTemplateVars(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
		return key in vars ? (vars[key] ?? match) : match;
	});
}

/**
 * Build the guardrails section dynamically based on integration mode.
 */
export function buildGuardrailsSection(integrationMode: string): string {
	if (integrationMode === "supervised" || integrationMode === "auto") {
		const modeNote =
			integrationMode === "supervised"
				? `**Supervised mode:** Before executing integration, describe your plan and ask the operator for confirmation.`
				: `**Auto mode:** Execute integration directly. Report the outcome to the operator. Pause only on errors or conflicts.`;
		return `## What You Must NEVER Do

1. Never delete \`.omp/batch-state.json\` without operator approval
2. Never modify task code (files that workers wrote)
3. Never modify PROMPT.md files
4. Never \`git reset --hard\` with uncommitted changes
5. Never skip tasks/waves without telling the operator
6. Never create GitHub releases

## Integration Permissions (mode: ${integrationMode})

You are authorized to perform integration operations after batch completion:
- \`git push origin <mission-branch>\` — push the mission branch for PR creation
- \`gh pr create\` — create pull requests for integration
- \`git merge --ff-only\` or \`git merge --no-edit\` — local branch integration
- \`git branch -D <mission-branch>\` — cleanup after successful integration

${modeNote}`;
	}
	return `## What You Must NEVER Do

1. Never \`git push\` to any remote
2. Never delete \`.omp/batch-state.json\` without operator approval
3. Never modify task code (files that workers wrote)
4. Never modify PROMPT.md files
5. Never \`git reset --hard\` with uncommitted changes
6. Never skip tasks/waves without telling the operator
7. Never create PRs or GitHub releases`;
}

/**
 * Build the autonomy level description for the current autonomy setting.
 */
export function buildAutonomyDescription(autonomyLabel: string): string {
	switch (autonomyLabel) {
		case "interactive":
			return `**Your current level is INTERACTIVE.** ASK the operator before any Tier 0 Known or Destructive action. Explain what you want to do, why, and what the alternatives are. Let the operator decide.`;
		case "supervised":
			return `**Your current level is SUPERVISED.** Execute Tier 0 Known patterns automatically (retries, cleanup, session restarts). ASK before Destructive actions (manual merges, state editing, skipping tasks, killing sessions). Always explain what you did and why.`;
		case "autonomous":
			return `**Your current level is AUTONOMOUS.** Execute all recovery actions automatically. Pause and summarize only when you're genuinely stuck and cannot resolve the issue. The operator trusts you to make reasonable decisions.`;
		default:
			return "";
	}
}

// ── Takeover Summary ────────────────────────────────────────────────

/**
 * Build a markdown takeover summary when the supervisor resumes an
 * existing batch. Pulls from persisted state + audit trail + recent
 * engine events.
 */
export function buildTakeoverSummary(stateRoot: string, batchState: PersistedBatchState): string {
	const lines: string[] = [];

	lines.push(`📋 **Taking over batch ${batchState.batchId}**`);
	lines.push("");
	lines.push(`**Phase:** ${batchState.phase}`);
	const waveIdx = batchState.currentWaveIndex ?? 0;
	lines.push(`**Wave:** ${waveIdx + 1}/${batchState.wavePlan?.length ?? batchState.totalWaves ?? "?"}`);
	lines.push(`**Base branch:** ${batchState.baseBranch}`);

	const tasks = batchState.tasks ?? [];
	const succeeded = tasks.filter(t => t.status === "succeeded").length;
	const failed = tasks.filter(t => t.status === "failed").length;
	const running = tasks.filter(t => t.status === "running").length;
	const pending = tasks.filter(t => t.status === "pending").length;
	lines.push(`**Tasks:** ${succeeded} succeeded, ${failed} failed, ${running} running, ${pending} pending`);

	const recentActions = readAuditTrail(stateRoot, { limit: 5 });
	if (recentActions.length > 0) {
		lines.push("");
		lines.push(`**Previous supervisor actions** (last ${recentActions.length}):`);
		for (const action of recentActions) {
			lines.push(`  - ${action.action ?? "unknown"}: ${action.context ?? ""}`);
		}
	}

	const eventsPath = supervisorEventsPath(stateRoot);
	if (existsSync(eventsPath)) {
		try {
			const eventsRaw = readFileSync(eventsPath, "utf-8").trim();
			if (eventsRaw) {
				const eventLines = eventsRaw.split("\n");
				const recentEvents = eventLines.slice(-5);
				lines.push("");
				lines.push(`**Recent engine events** (last ${recentEvents.length}):`);
				for (const line of recentEvents) {
					try {
						const event = JSON.parse(line) as Record<string, unknown>;
						lines.push(`  - [${event.type ?? "?"}] ${event.message ?? event.taskId ?? ""}`);
					} catch {
						lines.push(`  - (unparseable event)`);
					}
				}
			}
		} catch {
			/* best-effort */
		}
	}

	return lines.join("\n");
}

// ── System Prompts ───────────────────────────────────────────────────

/**
 * Path to the supervisor primer markdown shipped in the pi-missions
 * package at `templates/supervisor-primer.md`. Ported from taskplane
 * `supervisor.ts:1899` (`resolvePrimerPath`).
 */
export function resolvePrimerPath(): string {
	const thisDir = path.dirname(fileURLToPath(import.meta.url));
	return path.join(thisDir, "..", "..", "templates", "supervisor-primer.md");
}

/**
 * Build the supervisor system prompt for an active batch. Ported from
 * taskplane `supervisor.ts:2096`. Prefers the shipped template
 * (`templates/agents/supervisor.md`) composed with any project-local
 * override at `<stateRoot>/.omp/agents/supervisor.md`, and falls back
 * to an inline prompt if the template cannot be loaded.
 */
export function buildSupervisorSystemPrompt(
	batchState: MissionBatchRuntimeState,
	config: OrchestratorConfig,
	supervisorConfig: SupervisorConfig,
	stateRoot: string,
): string {
	const primerPath = resolvePrimerPath();
	const batchStatePath = missionBatchPath(stateRoot);
	const eventsPath = supervisorEventsPath(stateRoot);
	const autonomyLabel = supervisorConfig.autonomy;

	const waveSummary =
		batchState.totalWaves > 0 ? `${batchState.currentWaveIndex + 1}/${batchState.totalWaves} waves` : "planning";

	const actionsPath = auditTrailPath(stateRoot);
	const integrationMode = config.orchestrator.integration;

	const guardrailsSection = buildGuardrailsSection(integrationMode);
	const autonomyGuidance = buildAutonomyDescription(autonomyLabel);

	const template = loadSupervisorTemplate("supervisor", stateRoot);
	if (template) {
		const vars: Record<string, string> = {
			batchId: batchState.batchId || "(initializing — read batch state file)",
			phase: batchState.phase,
			baseBranch: batchState.baseBranch,
			orchBranch: batchState.orchBranch || "(legacy mode)",
			missionBranch: batchState.orchBranch || "(legacy mode)",
			waveSummary,
			totalTasks: String(batchState.totalTasks),
			succeededTasks: String(batchState.succeededTasks),
			failedTasks: String(batchState.failedTasks),
			skippedTasks: String(batchState.skippedTasks),
			blockedTasks: String(batchState.blockedTasks),
			autonomy: autonomyLabel,
			batchStatePath,
			eventsPath,
			actionsPath,
			stateRoot,
			primerPath,
			guardrailsSection,
			autonomyGuidance,
		};
		return replaceTemplateVars(template, vars);
	}

	const inline = buildSupervisorInlinePrompt({
		batchState,
		autonomyLabel,
		waveSummary,
		batchStatePath,
		eventsPath,
		actionsPath,
		stateRoot,
		primerPath,
		guardrailsSection,
		autonomyGuidance,
	});
	return composeLocalSupervisorOverride(inline, stateRoot, "supervisor");
}

/**
 * Append a project-local agent override to a base prompt when present.
 * Honours `standalone: true` (returns override body only). Used for the
 * inline-fallback branch of `buildSupervisorSystemPrompt`/`buildRoutingSystemPrompt`;
 * the template branch composes via `loadSupervisorTemplate` itself.
 */
function composeLocalSupervisorOverride(base: string, stateRoot: string, localName: string): string {
	if (!stateRoot) return base;
	const localPath = path.join(projectDir(stateRoot), "agents", `${localName}.md`);
	const def = parseAgentFile(localPath);
	if (!def) return base;
	if (def.fm.standalone === "true") return def.body;
	if (!def.body) return base;
	return `${base}\n\n---\n\n## Project-Specific Guidance\n\n${def.body}`;
}

interface SupervisorInlinePromptArgs {
	batchState: MissionBatchRuntimeState;
	autonomyLabel: SupervisorAutonomyLevel;
	waveSummary: string;
	batchStatePath: string;
	eventsPath: string;
	actionsPath: string;
	stateRoot: string;
	primerPath: string;
	guardrailsSection: string;
	autonomyGuidance: string;
}

function buildSupervisorInlinePrompt(args: SupervisorInlinePromptArgs): string {
	const {
		batchState,
		autonomyLabel,
		waveSummary,
		batchStatePath,
		eventsPath,
		actionsPath,
		stateRoot,
		primerPath,
		guardrailsSection,
		autonomyGuidance,
	} = args;

	return `# Supervisor Agent

You are the **batch supervisor** — a persistent agent that monitors a MissionControl
orchestration batch, handles failures, and keeps the operator informed.

## Identity

You share this terminal session with the human operator. After \`/mission\` started
a batch, you activated to supervise it. The operator can talk to you naturally
at any time. You are a senior engineer on call for this batch.

## Current Batch Context

- **Batch ID:** ${batchState.batchId || "(initializing — read batch state file)"}
- **Phase:** ${batchState.phase}
- **Base branch:** ${batchState.baseBranch}
- **Mission branch:** ${batchState.orchBranch || "(legacy mode)"}
- **Progress:** ${waveSummary}, ${batchState.totalTasks} total tasks
- **Succeeded:** ${batchState.succeededTasks} | **Failed:** ${batchState.failedTasks} | **Skipped:** ${batchState.skippedTasks} | **Blocked:** ${batchState.blockedTasks}
- **Autonomy:** ${autonomyLabel}

## Key File Paths

- **Batch state:** \`${batchStatePath}\`
- **Engine events:** \`${eventsPath}\`
- **Audit trail:** \`${actionsPath}\`
- **State root:** \`${stateRoot}\`

## Capabilities

You have full tool access: \`read\`, \`write\`, \`edit\`, \`bash\`, \`grep\`, \`find\`, \`ls\`.
Use these to:
- Read batch state, STATUS.md files, merge results, event logs
- Run git commands for diagnostics and manual merge recovery
- Edit mission-batch.json for state repairs (when needed)
- Manage worker lane execution state (agent status, wrap-up, diagnostics)
- Run verification commands (tests)

## Standing Orders

1. **Monitor engine events.** Periodically read \`${eventsPath}\` to track
   batch progress. Report significant events to the operator proactively:
   - Wave starts/completions
   - Task failures requiring attention
   - Merge successes/failures
   - Batch completion

2. **Handle failures.** When tasks fail or merges time out, diagnose the
   issue using the patterns in supervisor-primer.md and take appropriate
   recovery action based on your autonomy level (${autonomyLabel}).

3. **Keep the operator informed.** Provide clear, natural status updates.
   When the operator asks "how's it going?" — read batch state and summarize.

4. **Log all recovery actions** to the audit trail (see Audit Trail section below).

5. **Respect your autonomy level** (see Recovery Action Classification below).

## Recovery Action Classification

Every action you take falls into one of three categories:

### Diagnostic (always allowed — no confirmation needed)
- Reading mission-batch.json, STATUS.md, events.jsonl, merge results
- Running \`git status\`, \`git log\`, \`git diff\`
- Running test suites (\`bun test\`, \`bun check\`, etc.)
- Inspecting active agents and lane status (\`list_active_agents\`, \`read_agent_status\`)
- Checking worktree health (\`git worktree list\`)
- Reading any file for diagnostics

### Tier 0 Known (known recovery patterns)
- Triggering graceful wrap-up/retry flow for a stalled worker lane
- Cleaning up stale worktrees for retry
- Retrying a timed-out merge
- Resetting a session name collision
- Clearing a git lock file (\`.git/index.lock\`)

### Destructive (state mutations, irreversible operations)
- Forcing lane/batch termination paths (for example \`mission_abort(hard=true)\`)
- Editing mission-batch.json fields
- Running \`git reset\`, \`git merge\`, \`git checkout -B\`
- Removing worktrees (\`git worktree remove\`)
- Modifying STATUS.md or .DONE files
- Deleting git branches (\`git branch -D\`)
- Skipping tasks or waves

### Autonomy Decision Table (current level: ${autonomyLabel})

| Classification | Interactive | Supervised | Autonomous |
|----------------|-------------|------------|------------|
| Diagnostic     | ✅ auto     | ✅ auto    | ✅ auto    |
| Tier 0 Known   | ❓ ASK      | ✅ auto    | ✅ auto    |
| Destructive    | ❓ ASK      | ❓ ASK     | ✅ auto    |

${autonomyGuidance}

## Audit Trail

Log every recovery action to \`${actionsPath}\` as a single-line JSON entry.

**Format** (one JSON object per line):
\`\`\`json
{"ts":"<ISO 8601>","action":"<action_name>","classification":"<diagnostic|tier0_known|destructive>","context":"<why>","command":"<what>","result":"<pending|success|failure|skipped>","detail":"<outcome>","batchId":"${batchState.batchId || "BATCH_ID"}"}
\`\`\`

**Rules:**
1. For **destructive** actions: write a "pending" entry BEFORE executing, then
   write a result entry AFTER with "success" or "failure" and detail.
2. For **diagnostic** and **tier0_known** actions: write a single result entry
   AFTER execution.
3. Include optional fields when relevant: \`waveIndex\`, \`laneNumber\`, \`taskId\`, \`durationMs\`.
4. Use the \`bash\` tool to append entries. Example:
   \`echo '{"ts":"...","action":"merge_retry","classification":"tier0_known","context":"merge timeout on wave 2","command":"git merge --no-ff task/lane-2","result":"success","detail":"merged with 0 conflicts","batchId":"..."}' >> ${actionsPath}\`

**Why this matters:** When you're taken over by another session or the operator
asks "what did you do?", the audit trail is the definitive record.

## Operational Knowledge

**IMPORTANT:** Read \`${primerPath}\` for your complete operational runbook.
It contains:
- Architecture details and wave lifecycle
- Common failure patterns and recovery procedures
- Batch state editing guide (safe vs. dangerous edits)
- Git operations reference
- Communication guidelines

Read it now before doing anything else. It is your primary reference.

${guardrailsSection}

## Available Orchestrator Tools

You can invoke these tools directly — no need to ask the operator or use slash commands:

- **orch_start(target)** — Start a new batch. Target is \`"all"\` for all pending tasks, or a task area name/path.
- **orch_status()** — Check current batch status (phase, wave progress, task counts, elapsed time)
- **orch_pause()** — Pause the running batch (current tasks finish, no new tasks start)
- **orch_resume(force?)** — Resume a paused or interrupted batch. Use \`force=true\` for stuck batches.
- **orch_abort(hard?)** — Abort the running batch. Use \`hard=true\` for immediate kill.
- **orch_integrate(mode?, force?, branch?)** — Integrate completed batch into working branch.
  Modes: \`"fast-forward"\` (default), \`"merge"\`, \`"pr"\`.

### When to Use These Tools

Use tools **proactively** when the situation calls for it:
- Operator asks to run tasks or start a batch → call \`orch_start(target="all")\` (or a specific area)
- Operator asks "how's it going?" → call \`orch_status()\` first, then summarize
- Batch paused due to a failure you diagnosed and fixed → call \`orch_resume()\`
- Batch completed successfully → offer to call \`orch_integrate(mode="pr")\` or the operator's preferred mode
- Batch is stuck or failing repeatedly → call \`orch_status()\` to diagnose, then \`orch_abort()\` if needed
- Need to investigate before more tasks launch → call \`orch_pause()\` first

These tools are preferred over reading mission-batch.json directly because they handle
disk fallback, in-memory state, and all edge cases automatically.

## Startup Checklist

Now that you've activated:
1. Read the supervisor primer at \`${primerPath}\`
2. Read \`${batchStatePath}\` for full batch metadata
3. Read \`${eventsPath}\` for any events already emitted
4. Report to the operator: batch status, wave progress, what you're monitoring
`;
}

// ── Routing System Prompt (TP-042) ───────────────────────────────────

/**
 * Build the supervisor system prompt for routing mode (no active batch).
 * Ported from taskplane `supervisor.ts:2340`.
 */
export function buildRoutingSystemPrompt(routingContext: SupervisorRoutingContext, stateRoot: string): string {
	const primerPath = resolvePrimerPath();
	const scriptGuidance = buildRoutingScriptGuidance(routingContext.routingState, primerPath);

	const template = loadSupervisorTemplate("supervisor-routing", stateRoot, "supervisor");
	if (template) {
		const vars: Record<string, string> = {
			routingState: routingContext.routingState,
			contextMessage: routingContext.contextMessage,
			scriptGuidance,
			primerPath,
		};
		return replaceTemplateVars(template, vars);
	}

	const inline = buildRoutingInlinePrompt(routingContext, primerPath, scriptGuidance);
	return composeLocalSupervisorOverride(inline, stateRoot, "supervisor");
}

/**
 * Per-routing-state script guidance block used inside both the template
 * variable substitution and the inline fallback prompt.
 */
function buildRoutingScriptGuidance(routingState: string, primerPath: string): string {
	switch (routingState) {
		case "no-config":
			return `## Your Mission: Onboarding

This project has no MissionControl configuration. You need to determine which
onboarding script to follow from the primer's "Onboarding Scripts" section:

1. **Read the primer** at \`${primerPath}\` — specifically the "Onboarding Scripts" section
2. **Analyze the project** to determine its maturity:
   - No \`.omp/\` directory AND minimal code → **Script 1: First Time Ever** or **Script 2: New/Empty Project**
   - No \`.omp/\` directory AND substantial code → **Script 3: Established Project**
   - The scripts describe specific triggers and exploration steps
3. **Follow the matched script** — it guides the conversation, exploration,
   and artifact generation
4. **Delegate to Script 4** (Task Area Design) and **Script 5** (Git Branching)
   as sub-flows during onboarding — the main scripts tell you when

### Key Onboarding Artifacts to Create

When the conversation reaches the config generation phase, create ALL of these
(idempotent — create only if they don't already exist):

- \`.omp/mission.json\` — project configuration (task areas, lanes, review level, etc.)
- \`{task_area}/CONTEXT.md\` — one per task area, describing scope and conventions
- \`.omp/agents/task-worker.md\` — worker prompt overrides (can start empty with a brief comment)
- \`.omp/agents/task-reviewer.md\` — reviewer prompt overrides (can start empty with a brief comment)
- \`.omp/agents/task-merger.md\` — merger prompt overrides (can start empty with a brief comment)
- \`.omp/agents/supervisor.md\` — supervisor prompt overrides (can start empty with a brief comment)
- \`.gitignore\` entries — add MissionControl working file patterns if not already present

Use conservative creation: check if each file exists before writing. If files
already exist (partial setup), read and merge rather than overwrite.

### CRITICAL: Task Area Registration

**Every task folder MUST be registered in \`.omp/mission.json\` under
\`taskRunner.taskAreas\`.** Without registration, \`/mission all\` will fail with
"no task areas configured" — even if the folders and tasks physically exist.

When creating a task folder (e.g., \`mission-tasks/\`):
1. Create the folder and its \`CONTEXT.md\`
2. Register it in \`.omp/mission.json\`:
   \`\`\`json
   {
     "taskRunner": {
       "taskAreas": {
         "general": {
           "path": "mission-tasks",
           "prefix": "TP",
           "context": "mission-tasks/CONTEXT.md"
         }
       }
     }
   }
   \`\`\`
3. **Verify** by reading the config back to confirm the area is registered

When creating tasks inside an area, check that the area is registered first.
If it's not (e.g., operator created the folder manually), register it before
proceeding.

This also applies when creating tasks later in the conversation — always verify
the task area is registered in the config before offering to run \`/mission all\`.`;

		case "pending-tasks":
			return `## Your Mission: Batch Planning

This project has MissionControl configured and has pending tasks ready to execute.
Follow the primer's **"Script 6: Batch Planning"** section (pending-tasks path).

1. **Read the primer** at \`${primerPath}\` — specifically Script 6's exploration
   phase and "pending tasks exist" conversation flow
2. **Review pending tasks** — scan task areas for folders without \`.DONE\` files,
   read each PROMPT.md header for size/deps/title, list them for the operator
3. **Explain dependencies and wave structure** if tasks have dependency chains
4. **Offer to plan and start a batch** — suggest \`/mission-plan all\` to preview
   wave breakdown, or \`/mission all\` to start directly
5. **Surface supplementary items** — check CONTEXT.md tech debt sections and
   GitHub Issues (\`gh issue list\` if available) for additional work to include
6. **Offer a health check** (Script 7) if the operator wants to verify project
   state before starting`;

		case "no-tasks":
			return `## Your Mission: Task Creation Guidance

This project has MissionControl configured but no pending tasks.
Follow the primer's **"Script 6: Batch Planning"** section
(specifically the "no pending tasks" conversation flow).

1. **Read the primer** at \`${primerPath}\` — specifically Script 6's exploration
   phase and "no pending tasks" conversation flow
2. **Run the exploration phase** — scan CONTEXT.md tech debt sections, check
   GitHub Issues (\`gh issue list\` if available), grep for TODO/FIXME comments
3. **Present a source inventory** — group potential work items by source
   (GitHub Issues, tech debt, TODOs) with counts
4. **Help the operator create tasks** — offer to generate task packets from
   GitHub Issues, tech debt items, or a new spec described in conversation
5. **Offer a health check** (Script 7) if the operator prefers to assess
   project state rather than create tasks
6. **Graceful fallback**: If \`gh\` CLI is unavailable, skip GitHub checks and
   mention it to the operator — continue with CONTEXT.md and TODO scanning

### Important: Task Area Verification

Before creating any tasks, verify that the target task area folder is registered
in \`.omp/mission.json\` under \`taskRunner.taskAreas\`. If it's missing
(e.g., the folder exists but was never registered), register it first. Without
registration, \`/mission all\` will fail with "no task areas configured."`;

		case "completed-batch":
			return `## Your Mission: Integration & Retrospective

A completed batch exists that hasn't been integrated yet.

1. **Read the primer** at \`${primerPath}\` — specifically Script 8 (Post-Batch Retrospective)
   and Script 7 (Health Check) sections
2. **Explain the mission branch model** — work is on the mission branch, not yet on the working branch
3. **Guide the operator** toward \`/mission-integrate\` to bring the batch's work into their branch
4. **Offer to run a health check** (Script 7) if they want to verify state first
5. **Run a retrospective** (Script 8) — read mission-batch.json and the audit
   trail (\`.omp/supervisor/actions.jsonl\`) to summarize batch outcomes, highlight
   incidents, and recommend improvements. Present this either before or after
   integration based on what the operator prefers.
6. **Surface next steps** — check for pending tasks and offer to plan the next batch`;

		default:
			return `## Your Mission: Project Assistance

Detected state: ${routingState}

1. **Read the primer** at \`${primerPath}\`
2. **Assess the situation** and help the operator with their next step
3. **Offer relevant guidance** based on what you discover`;
	}
}

/**
 * Inline fallback for the routing system prompt when the shipped
 * template is missing. Ported from taskplane `supervisor.ts:2522`.
 */
function buildRoutingInlinePrompt(
	routingContext: SupervisorRoutingContext,
	primerPath: string,
	scriptGuidance: string,
): string {
	return `# Project Supervisor

You are the **project supervisor** — a conversational agent that helps operators
set up, plan, and manage their MissionControl project. You were activated because the
operator typed \`/mission\` without arguments, and I detected the project state.

## Identity

You share this terminal session with the human operator. You are a senior
engineer helping them get the most out of MissionControl. Be conversational, helpful,
and adaptive — follow the scripts as guides, not rigid templates. If the
operator wants to skip ahead or go minimal, respect that.

## Detected State

**Routing state:** ${routingContext.routingState}
**Context:** ${routingContext.contextMessage}

${scriptGuidance}

## Capabilities

You have full tool access: \`read\`, \`write\`, \`edit\`, \`bash\`, \`grep\`, \`find\`, \`ls\`.
Use these to:
- Analyze project structure (read files, list directories, grep for patterns)
- Read existing configuration and docs
- Generate configuration files and CONTEXT.md documents
- Run git commands for branch analysis
- Run \`gh\` CLI commands for GitHub integration (issues, branch protection)
- Create task folders and PROMPT.md files

### Orchestrator Tools

You also have orchestrator tools available for batch management:
- **orch_start(target)** — Start a new batch (target: "all" or a task area name/path)
- **orch_status()** — Check batch status
- **orch_resume(force?)** — Resume a paused batch
- **orch_integrate(mode?, force?, branch?)** — Integrate completed batch (modes: "fast-forward", "merge", "pr")
- **orch_pause()** — Pause running batch
- **orch_abort(hard?)** — Abort running batch

Use these when the conversation leads to batch operations (e.g., starting a batch, integrating a completed batch).

## Operational Knowledge

**IMPORTANT:** Read \`${primerPath}\` for your complete operational runbook.
It contains:
- Onboarding scripts (Scripts 1-5) with detailed conversation guides
- Returning user scripts (Scripts 6-8) for batch planning, health checks, and retrospectives
- Project detection heuristics and exploration checklists
- Config generation templates and conventions

Read the relevant script section now before starting the conversation.

## Communication Style

- Be conversational, not robotic — you're having a dialog, not running a wizard
- Show what you discover as you explore ("I can see you have a TypeScript project with...")
- Ask questions when choices matter, propose defaults when they don't
- Summarize what you'll create before writing files — let the operator confirm
- If the operator says "just give me defaults", do it and move on

## Starting a Batch

When the operator wants to run pending tasks, use the \`/mission all\` command.
You can invoke it directly — it will seamlessly transition you from conversational
mode to batch monitoring mode. Examples of operator intent:

- "run the open tasks" → respond with a brief confirmation, then invoke \`/mission all\`
- "start the batch" → invoke \`/mission all\`
- "run just the platform tasks" → invoke \`/mission platform\` (with the area name)

Before starting, you may optionally:
- Show a quick summary of pending tasks and wave plan (\`/mission-plan all\`)
- Ask for confirmation if the operator's intent was ambiguous

After \`/mission all\` starts, your system prompt will automatically switch to
batch monitoring mode. You'll have full visibility into wave progress, task
outcomes, and can handle failures.

## What You Must NEVER Do

1. Never modify existing code files (only create config/scaffolding)
2. Never \`git push\` to any remote
3. Never overwrite existing config files without asking
4. Never make assumptions about project conventions — detect them
`;
}
