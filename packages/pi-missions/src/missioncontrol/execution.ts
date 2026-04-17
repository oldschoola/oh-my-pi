/**
 * Pure execution helpers — log-tail readers, STATUS.md parsing, dependency
 * graph math, execution-unit construction, agent-id derivation, reviewer env.
 *
 * Ported from `taskplane/extensions/taskplane/execution.ts`. The file now
 * hosts the monitor surface too (isV2AgentAlive, resolveTaskMonitorState,
 * monitorLanes, ensureTaskFilesCommitted) alongside the pure helpers, since
 * those paths share the same process-registry and git deps. The heavier
 * executor surface (executeWave, executeLaneV2, pollUntilTaskComplete)
 * still lives in taskplane and is deferred until engine/lane-runner wiring
 * lands.
 *
 * Rename: `.pi/orch-logs/` → `.omp/mission-logs/`. The directory sits under
 * the lane worktree so per-lane logs stay colocated with task state.
 */

import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { loadBaseAgentPrompt, loadLocalAgentPrompt } from "./agent-def";
import type { ParsedTask } from "./discovery";
import { runGit, runGitWithEnv } from "./git";
import { executeTaskV2, type LaneRunnerConfig } from "./lane-runner";
import { execLog } from "./log";
import { resolveOperatorId } from "./naming";
import {
	buildRegistrySnapshot,
	detectOrphans,
	isProcessAlive,
	isTerminalStatus,
	markOrphansCrashed,
	readLaneSnapshot,
	readRegistrySnapshot,
	writeRegistrySnapshot,
} from "./process-registry";
import { resolveCanonicalTaskPaths } from "./task-paths";
import {
	type AllocatedLane,
	type AllocatedTask,
	buildRuntimeAgentId,
	type DependencyGraph,
	ExecutionError,
	type ExecutionUnit,
	type LaneExecutionResult,
	type LaneMonitorSnapshot,
	type LaneTaskOutcome,
	type LaneTaskStatus,
	type MonitorState,
	type MtimeTracker,
	type OrchestratorConfig,
	type PacketPaths,
	type RuntimeAgentId,
	type RuntimeAgentRole,
	type RuntimeBackend,
	type RuntimeBackendSelection,
	type RuntimeRegistry,
	resolvePacketPaths,
	runtimeLaneSnapshotPath,
	type SupervisorAlertCallback,
	type TaskMonitorSnapshot,
	type WaveExecutionResult,
	type WorkspaceConfig,
} from "./types";
import { allocateLanes } from "./waves";

// ── V2 Liveness ──────────────────────────────────────────────────────

let _v2LivenessRegistryCache: RuntimeRegistry | null = null;

/**
 * Set the V2 liveness registry cache for the current monitor cycle.
 *
 * Called at the start of each monitor poll so per-task liveness checks
 * share a single registry read. Pass `null` to clear between cycles.
 *
 * Ported from taskplane `execution.ts:111`.
 */
export function setV2LivenessRegistryCache(registry: RuntimeRegistry | null): void {
	_v2LivenessRegistryCache = registry;
}

/**
 * Check whether a V2 agent is alive via the cached registry.
 *
 * Matches in three stages: direct `agentId` lookup, `<agentId>-worker`
 * suffix (monitor uses lane session name while registry uses full agentId),
 * and — in workspace mode — a fallback scan by global `laneNumber` (the
 * laneSessionId encodes a repo-local lane number while the registry keys
 * on global lane numbers).
 *
 * Ported from taskplane `execution.ts:76`.
 */
export function isV2AgentAlive(
	agentIdOrSessionName: string,
	_runtimeBackend?: RuntimeBackend,
	laneNumber?: number,
): boolean {
	if (!_v2LivenessRegistryCache) return false;
	const agents = _v2LivenessRegistryCache.agents;

	const direct = agents[agentIdOrSessionName];
	if (direct && !isTerminalStatus(direct.status) && isProcessAlive(direct.pid)) return true;

	const worker = agents[`${agentIdOrSessionName}-worker`];
	if (worker && !isTerminalStatus(worker.status) && isProcessAlive(worker.pid)) return true;

	if (laneNumber != null) {
		for (const agent of Object.values(agents)) {
			if (
				agent.laneNumber === laneNumber &&
				agent.role === "worker" &&
				!isTerminalStatus(agent.status) &&
				isProcessAlive(agent.pid)
			) {
				return true;
			}
		}
	}
	return false;
}

/**
 * SIGTERM all V2 agents (worker + reviewer) belonging to a lane session.
 *
 * Uses the monitor cache when available; otherwise reads a fresh registry
 * snapshot for cleanup flows outside monitor polling. Dedupes kills by PID
 * and falls back to scanning by global `laneNumber` in workspace mode.
 *
 * Best-effort — kill failures (already-dead PIDs, EPERM) are swallowed.
 *
 * Ported from taskplane `execution.ts:123`.
 */
export function killV2LaneAgents(
	sessionName: string,
	options?: { stateRoot?: string; batchId?: string; logContext?: string; laneNumber?: number },
): void {
	const registry =
		_v2LivenessRegistryCache ??
		(options?.stateRoot && options?.batchId ? readRegistrySnapshot(options.stateRoot, options.batchId) : null);
	if (!registry) return;

	const agents = registry.agents;
	const logContext = options?.logContext ?? "monitor";
	const killedPids = new Set<number>();

	for (const suffix of ["-worker", "-reviewer", ""]) {
		const key = `${sessionName}${suffix}`;
		const manifest = agents[key];
		if (
			manifest &&
			!isTerminalStatus(manifest.status) &&
			isProcessAlive(manifest.pid) &&
			!killedPids.has(manifest.pid)
		) {
			try {
				process.kill(manifest.pid, "SIGTERM");
				killedPids.add(manifest.pid);
				execLog(logContext, key, `killed V2 agent (PID ${manifest.pid})`);
			} catch {
				/* already dead */
			}
		}
	}

	if (options?.laneNumber != null) {
		for (const agent of Object.values(agents)) {
			if (
				agent.laneNumber === options.laneNumber &&
				!isTerminalStatus(agent.status) &&
				isProcessAlive(agent.pid) &&
				!killedPids.has(agent.pid)
			) {
				try {
					process.kill(agent.pid, "SIGTERM");
					killedPids.add(agent.pid);
					execLog(logContext, agent.agentId, `killed V2 agent by lane number (PID ${agent.pid})`);
				} catch {
					/* already dead */
				}
			}
		}
	}
}

// ── Path resolvers ───────────────────────────────────────────────────

const LANE_LOG_DIR = join(".omp", "mission-logs");

function laneSessionIdOf(lane: Pick<AllocatedLane, "laneSessionId">): string {
	return lane.laneSessionId;
}

/**
 * Resolve the absolute lane-log path for a task execution.
 *
 * Logs live under the lane worktree so per-lane execution artifacts stay
 * colocated with task state and survive lane failure inspection.
 */
export function resolveLaneLogPath(lane: AllocatedLane, task: AllocatedTask): string {
	return join(lane.worktreePath, LANE_LOG_DIR, `${laneSessionIdOf(lane)}-${task.taskId}.log`);
}

/**
 * Relative lane-log path with forward-slash separators.
 *
 * Shell-spawn callers use the relative form to dodge Windows drive-letter
 * parsing quirks in redirection (`> .omp/mission-logs/...`).
 */
export function resolveLaneLogRelativePath(lane: AllocatedLane, task: AllocatedTask): string {
	return join(LANE_LOG_DIR, `${laneSessionIdOf(lane)}-${task.taskId}.log`).replace(/\\/g, "/");
}

// ── Tail helpers ─────────────────────────────────────────────────────

/**
 * Async file existence check — a non-blocking `existsSync` replacement for
 * polling paths. Resolves `false` on any error (missing, EACCES, etc.).
 */
export async function fileExistsAsync(filePath: string): Promise<boolean> {
	try {
		await fsAccess(filePath);
		return true;
	} catch {
		return false;
	}
}

function trimTail(raw: string, maxLines: number, maxChars: number): string {
	const tail = raw.split("\n").slice(-maxLines).join("\n").trim();
	if (!tail) return "";
	return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}

/** Read a tail snippet from a lane log (sync). Returns `""` on any error. */
export function readLaneLogTail(logPath: string, maxLines = 40, maxChars = 1200): string {
	if (!existsSync(logPath)) return "";
	try {
		const raw = readFileSync(logPath, "utf-8").replace(/\r\n/g, "\n");
		return trimTail(raw, maxLines, maxChars);
	} catch {
		return "";
	}
}

/** Read a tail snippet from a lane log (async). Returns `""` on any error. */
export async function readLaneLogTailAsync(logPath: string, maxLines = 40, maxChars = 1200): Promise<string> {
	if (!(await fileExistsAsync(logPath))) return "";
	try {
		const raw = (await fsReadFile(logPath, "utf-8")).replace(/\r\n/g, "\n");
		return trimTail(raw, maxLines, maxChars);
	} catch {
		return "";
	}
}

/** Read a tail snippet from a task `STATUS.md` (sync). Returns `""` on any error. */
export function readTaskStatusTail(statusPath: string, maxLines = 40, maxChars = 1200): string {
	if (!existsSync(statusPath)) return "";
	try {
		const raw = readFileSync(statusPath, "utf-8").replace(/\r\n/g, "\n").trim();
		if (!raw) return "";
		return trimTail(raw, maxLines, maxChars);
	} catch {
		return "";
	}
}

/** Read a tail snippet from a task `STATUS.md` (async). Returns `""` on any error. */
export async function readTaskStatusTailAsync(statusPath: string, maxLines = 40, maxChars = 1200): Promise<string> {
	if (!(await fileExistsAsync(statusPath))) return "";
	try {
		const raw = (await fsReadFile(statusPath, "utf-8")).replace(/\r\n/g, "\n").trim();
		if (!raw) return "";
		return trimTail(raw, maxLines, maxChars);
	} catch {
		return "";
	}
}

/**
 * Convenience wrapper: resolve the `.DONE` path inside a worktree.
 *
 * Delegates to {@link resolveCanonicalTaskPaths} so repo-mode and workspace-mode
 * paths stay in lockstep.
 */
export function resolveTaskDonePath(
	taskFolder: string,
	worktreePath: string,
	repoRoot: string,
	isWorkspaceMode?: boolean,
): string {
	return resolveCanonicalTaskPaths(taskFolder, worktreePath, repoRoot, isWorkspaceMode).donePath;
}

// ── STATUS.md parsing ────────────────────────────────────────────────

export interface ParsedWorktreeStatus {
	/** Parsed step information — one entry per `### Step N: ...` heading. */
	steps: {
		number: number;
		name: string;
		status: "not-started" | "in-progress" | "complete";
		totalChecked: number;
		totalItems: number;
	}[];
	/** `**Review Counter:**` value, `0` when absent. */
	reviewCounter: number;
	/** `**Iteration:**` value, `0` when absent. */
	iteration: number;
	/** `statSync` `mtimeMs` — callers use this for change detection. */
	mtime: number;
}

interface StepAccumulator {
	number: number;
	name: string;
	status: "not-started" | "in-progress" | "complete";
	checkboxes: boolean[];
}

function finalizeStep(accum: StepAccumulator): ParsedWorktreeStatus["steps"][number] {
	const totalChecked = accum.checkboxes.filter(c => c).length;
	return {
		number: accum.number,
		name: accum.name,
		status: accum.status,
		totalChecked,
		totalItems: accum.checkboxes.length,
	};
}

function parseStatusText(content: string, mtime: number): ParsedWorktreeStatus {
	const text = content.replace(/\r\n/g, "\n");
	const steps: ParsedWorktreeStatus["steps"] = [];
	let current: StepAccumulator | null = null;
	let reviewCounter = 0;
	let iteration = 0;

	for (const line of text.split("\n")) {
		const rcMatch = line.match(/\*\*Review Counter:\*\*\s*(\d+)/);
		if (rcMatch) reviewCounter = Number.parseInt(rcMatch[1], 10);
		const itMatch = line.match(/\*\*Iteration:\*\*\s*(\d+)/);
		if (itMatch) iteration = Number.parseInt(itMatch[1], 10);

		const stepMatch = line.match(/^###\s+Step\s+(\d+):\s*(.+)/);
		if (stepMatch) {
			if (current) steps.push(finalizeStep(current));
			current = {
				number: Number.parseInt(stepMatch[1], 10),
				name: stepMatch[2].trim(),
				status: "not-started",
				checkboxes: [],
			};
			continue;
		}
		if (current) {
			const statusMatch = line.match(/\*\*Status:\*\*\s*(.*)/);
			if (statusMatch) {
				const s = statusMatch[1];
				if (s.includes("✅") || s.toLowerCase().includes("complete")) {
					current.status = "complete";
				} else if (s.includes("🟨") || s.includes("🟡") || s.toLowerCase().includes("progress")) {
					current.status = "in-progress";
				}
			}
			const cbMatch = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)/);
			if (cbMatch) current.checkboxes.push(cbMatch[1].toLowerCase() === "x");
		}
	}
	if (current) steps.push(finalizeStep(current));

	return { steps, reviewCounter, iteration, mtime };
}

/**
 * Parse a worktree `STATUS.md` by resolving the task folder first.
 *
 * Use {@link parseStatusMdAtPath} when you already have an authoritative
 * `statusPath` from {@link buildExecutionUnit}.
 */
export function parseWorktreeStatusMd(
	taskFolder: string,
	worktreePath: string,
	repoRoot: string,
	isWorkspaceMode?: boolean,
): { parsed: ParsedWorktreeStatus | null; error: string | null } {
	const resolved = resolveCanonicalTaskPaths(taskFolder, worktreePath, repoRoot, isWorkspaceMode);
	const statusPath = resolved.statusPath;

	if (!existsSync(statusPath)) {
		return { parsed: null, error: `STATUS.md not found at ${statusPath}` };
	}

	let content: string;
	let mtime: number;
	try {
		content = readFileSync(statusPath, "utf-8");
		mtime = statSync(statusPath).mtimeMs;
	} catch (err) {
		return {
			parsed: null,
			error: `Cannot read STATUS.md: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	return { parsed: parseStatusText(content, mtime), error: null };
}

async function parseStatusMdContent(
	statusPath: string,
): Promise<{ parsed: ParsedWorktreeStatus | null; error: string | null }> {
	if (!(await fileExistsAsync(statusPath))) {
		return { parsed: null, error: `STATUS.md not found at ${statusPath}` };
	}

	let content: string;
	let mtime: number;
	try {
		content = await fsReadFile(statusPath, "utf-8");
		mtime = (await fsStat(statusPath)).mtimeMs;
	} catch (err) {
		return {
			parsed: null,
			error: `Cannot read STATUS.md: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	return { parsed: parseStatusText(content, mtime), error: null };
}

/**
 * Parse `STATUS.md` from a known absolute path — no re-resolution.
 *
 * Prefer this over {@link parseWorktreeStatusMdAsync} when the caller already
 * has the authoritative path (e.g., from {@link buildExecutionUnit}).
 */
export async function parseStatusMdAtPath(
	statusPath: string,
): Promise<{ parsed: ParsedWorktreeStatus | null; error: string | null }> {
	return parseStatusMdContent(statusPath);
}

/** Async form of {@link parseWorktreeStatusMd}. */
export async function parseWorktreeStatusMdAsync(
	taskFolder: string,
	worktreePath: string,
	repoRoot: string,
	isWorkspaceMode?: boolean,
): Promise<{ parsed: ParsedWorktreeStatus | null; error: string | null }> {
	const resolved = resolveCanonicalTaskPaths(taskFolder, worktreePath, repoRoot, isWorkspaceMode);
	return parseStatusMdContent(resolved.statusPath);
}

// ── Dependency graph math ────────────────────────────────────────────

/**
 * Compute the transitive closure of task dependents downstream of a failure set.
 *
 * Used to decide which pending tasks in later waves must be blocked when
 * upstream tasks fail. Walk is deterministic: dependents are processed in
 * alphabetical order. Failed tasks never re-enter the blocked set so callers
 * can treat `failedTaskIds` and the return value as disjoint.
 */
export function computeTransitiveDependents(failedTaskIds: Set<string>, dependencyGraph: DependencyGraph): Set<string> {
	const blocked = new Set<string>();
	const queue: string[] = [...failedTaskIds];

	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) break;
		const dependents = dependencyGraph.dependents.get(current) ?? [];
		const sortedDependents = [...dependents].sort();
		for (const dep of sortedDependents) {
			if (blocked.has(dep)) continue;
			if (failedTaskIds.has(dep)) continue;
			blocked.add(dep);
			queue.push(dep);
		}
	}

	return blocked;
}

// ── Execution-unit construction ──────────────────────────────────────

/**
 * Build a Runtime V2 `ExecutionUnit` from a lane + allocated task.
 *
 * The unit captures everything `lane-runner`/`agent-host` need to spawn a
 * worker — IDs, worktree, packet paths. Throws {@link ExecutionError} with
 * `EXEC_MISSING_TASK_FOLDER` when `task.task.taskFolder` is empty (usually a
 * persisted-stub reconstruction that skipped discovery enrichment).
 */
export function buildExecutionUnit(
	lane: AllocatedLane,
	task: AllocatedTask,
	repoRoot: string,
	isWorkspaceMode?: boolean,
): ExecutionUnit {
	const taskFolder = task.task?.taskFolder;
	if (!taskFolder) {
		const reason = taskFolder === "" ? "empty" : "undefined";
		throw new ExecutionError(
			"EXEC_MISSING_TASK_FOLDER",
			`Cannot build execution unit for task ${task.taskId}: taskFolder is ${reason}. ` +
				"This typically means the task's persisted record was not enriched with discovery data. " +
				"Re-run discovery or check that the task exists in the task area.",
			"execution",
			task.taskId,
		);
	}

	const resolved = resolveCanonicalTaskPaths(taskFolder, lane.worktreePath, repoRoot, isWorkspaceMode);
	const executionRepoId = lane.repoId ?? "default";
	const packetHomeRepoId = task.task.packetRepoId ?? executionRepoId;
	const segmentId = task.task.activeSegmentId ?? null;
	const id = segmentId ?? task.taskId;

	// Absolute packet path is only used when the packet's home repo differs
	// from the execution repo (cross-repo segment). Same-repo executions
	// resolve packets inside the worktree so `.DONE`/`STATUS.md` writes
	// land next to the lane's checkout, not the canonical repo.
	const useAbsolutePacketPath = task.task.packetTaskPath !== undefined && packetHomeRepoId !== executionRepoId;

	const packet: PacketPaths = useAbsolutePacketPath
		? resolvePacketPaths(task.task.packetTaskPath as string)
		: {
				promptPath: `${resolved.taskFolderResolved}/PROMPT.md`,
				statusPath: resolved.statusPath,
				donePath: resolved.donePath,
				reviewsDir: `${resolved.taskFolderResolved}/.reviews`,
				taskFolder: resolved.taskFolderResolved,
			};

	return {
		id,
		taskId: task.taskId,
		segmentId,
		executionRepoId,
		packetHomeRepoId,
		worktreePath: lane.worktreePath,
		packet,
		task: task.task,
	};
}

// ── Agent-id derivation ──────────────────────────────────────────────

/**
 * Derive a stable `RuntimeAgentId` for a lane's agent from existing naming.
 *
 * Bridges the historic lane-session naming convention into Runtime V2's
 * stable agent IDs so supervisor tools and mailbox addressing keep working
 * unchanged. Merge agents use a distinct pattern (`<prefix>-merge-<index>`)
 * since they operate on the batch, not a single lane.
 */
export function buildAgentIdFromLane(lane: AllocatedLane, role: RuntimeAgentRole, mergeIndex?: number): RuntimeAgentId {
	if (role === "merger" && mergeIndex !== undefined) {
		const prefix = laneSessionIdOf(lane).replace(/-lane-\d+$/, "");
		return `${prefix}-merge-${mergeIndex}`;
	}
	if (role === "lane-runner") {
		return laneSessionIdOf(lane);
	}
	return `${laneSessionIdOf(lane)}-${role}`;
}

// ── Runtime state root ───────────────────────────────────────────────

/**
 * Resolve the Runtime V2 state root from available context.
 *
 * State root is the directory that owns `.omp/runtime/`. In workspace mode
 * that's the workspace root; in plain repo mode it's the repo root. The
 * port keeps this centralized so Runtime V2 callers don't repeat the
 * workspace-vs-repo decision.
 */
export function resolveRuntimeStateRoot(repoRoot: string, workspaceRoot?: string): string {
	return workspaceRoot ?? repoRoot;
}

// ── Runtime backend selection ────────────────────────────────────────

/**
 * Select the execution backend for a mission batch under the TP-105 scope guard.
 *
 * Runtime V2 is the only backend now (TP-108 switched all repo-mode batches,
 * TP-109 did the same for workspace mode), so `backend` is hard-coded to
 * `"v2"`. The auxiliary flags are still useful: callers gate optional features
 * — direct-PROMPT.md shortcuts, single-task fast paths — off them.
 *
 * @param args            raw /mission argument string (areas/paths/all)
 * @param rawWaves        discovered wave grouping (pre-allocation)
 * @param workspaceConfig optional workspace config; falsy → repo mode
 */
export function selectRuntimeBackend(
	args: string,
	rawWaves: string[][],
	workspaceConfig?: WorkspaceConfig | null,
): RuntimeBackendSelection {
	const isSingleTask = rawWaves.length === 1 && rawWaves[0]?.length === 1;
	const isRepoMode = !workspaceConfig;
	const argTokens = args.trim().split(/\s+/).filter(Boolean);
	const isDirectPromptTarget = argTokens.length === 1 && /PROMPT\.md$/i.test(argTokens[0] ?? "");

	// TP-108: Runtime V2 for all repo-mode batches.
	// TP-109: Workspace mode also uses V2 now that packet-home paths are
	// threaded through execution and resume (worktree-relative .DONE check).
	const backend: RuntimeBackend = "v2";

	return {
		backend,
		isSingleTask,
		isRepoMode,
		isDirectPromptTarget,
	};
}

// ── Reviewer env ─────────────────────────────────────────────────────

/**
 * Build reviewer env vars from a reviewer config object.
 *
 * Only non-empty keys are emitted so inherited env vars from the parent
 * process aren't clobbered by an empty/inherit config. Used by the lane
 * runner and resume paths to thread reviewer overrides into worker
 * subprocesses consistently.
 */
export function buildReviewerEnv(
	reviewerConfig?: { model?: string; thinking?: string; tools?: string } | null,
): Record<string, string> {
	const env: Record<string, string> = {};
	if (reviewerConfig?.model) env.MISSION_REVIEWER_MODEL = reviewerConfig.model;
	if (reviewerConfig?.thinking) env.MISSION_REVIEWER_THINKING = reviewerConfig.thinking;
	if (reviewerConfig?.tools) env.MISSION_REVIEWER_TOOLS = reviewerConfig.tools;
	return env;
}

// ── Pre-flight: Commit Untracked Task Files ─────────────────────────

/**
 * Ensure all task files for a wave are committed to git before worktree creation.
 *
 * Git worktrees only contain tracked (committed) files. If a user creates
 * task folders (PROMPT.md, STATUS.md) but doesn't commit them, the worktree
 * won't have those files and the worker will fail with "file not found".
 *
 * This function checks each wave task's folder for untracked or modified files,
 * stages them, and commits them on the orch branch (preferred) or on HEAD with
 * a best-effort fast-forward/merge of the orch branch ref. Must run BEFORE
 * worktree allocation so that worktrees (based on the batch's base branch)
 * include the task files.
 *
 * Only task-specific folders are staged — no other working-tree changes are touched.
 *
 * Ported verbatim from taskplane `execution.ts:1425-1687`.
 */
export function ensureTaskFilesCommitted(
	waveTasks: string[],
	pending: Map<string, ParsedTask>,
	repoRoot: string,
	waveIndex: number,
	orchBranch?: string,
): void {
	const foldersToCheck: { taskId: string; relPath: string }[] = [];
	for (const taskId of waveTasks) {
		const task = pending.get(taskId);
		if (!task) continue;

		const taskFolder = task.taskFolder ?? task.folderPath;
		const absFolder = resolve(taskFolder);
		const relPath = relative(resolve(repoRoot), absFolder).replace(/\\/g, "/");

		if (relPath.startsWith("..")) continue;
		foldersToCheck.push({ taskId, relPath });
	}

	if (foldersToCheck.length === 0) return;

	const foldersToStage: string[] = [];
	for (const { taskId, relPath } of foldersToCheck) {
		const status = runGit(["status", "--porcelain", "--", relPath], repoRoot);
		if (status.ok && status.stdout.trim()) {
			execLog("wave", `W${waveIndex}`, `task ${taskId} has uncommitted files, staging`, {
				folder: relPath,
				status: status.stdout.trim().split("\n").slice(0, 5).join("; "),
			});
			foldersToStage.push(relPath);
		}
	}

	if (foldersToStage.length === 0) return;

	// Preferred path: commit directly on orch branch via temp index, avoids
	// polluting the current branch (e.g. main) with orchestrator-internal
	// staging commits. Falls back to HEAD+fast-forward on any plumbing failure.
	if (orchBranch) {
		const orchTipRes = runGit(["rev-parse", `refs/heads/${orchBranch}`], repoRoot);
		if (orchTipRes.ok) {
			const orchTip = orchTipRes.stdout.trim();
			const tmpIdx = join(repoRoot, ".git", `tmp-staging-idx-wave-${waveIndex}`);

			try {
				const readTreeRes = runGitWithEnv(["read-tree", orchTip], repoRoot, { GIT_INDEX_FILE: tmpIdx });
				if (!readTreeRes.ok) {
					execLog("wave", `W${waveIndex}`, "orch branch staging: read-tree failed, falling back to HEAD commit", {
						error: readTreeRes.stderr,
					});
				} else {
					let addFailed = false;
					for (const folder of foldersToStage) {
						const addRes = runGitWithEnv(["add", "--", folder], repoRoot, { GIT_INDEX_FILE: tmpIdx });
						if (!addRes.ok) {
							execLog(
								"wave",
								`W${waveIndex}`,
								`orch branch staging: git add failed for ${folder}, falling back`,
								{
									error: addRes.stderr,
								},
							);
							addFailed = true;
							break;
						}
					}

					if (!addFailed) {
						const writeTreeRes = runGitWithEnv(["write-tree"], repoRoot, { GIT_INDEX_FILE: tmpIdx });
						if (writeTreeRes.ok) {
							const tree = writeTreeRes.stdout.trim();
							const taskIds = foldersToStage.map(f => f.split("/").pop() || f).join(", ");
							const commitMsg = `chore: stage task files for mission wave ${waveIndex} (${taskIds})`;

							const commitTreeRes = runGit(["commit-tree", tree, "-p", orchTip, "-m", commitMsg], repoRoot);
							if (commitTreeRes.ok) {
								const newCommit = commitTreeRes.stdout.trim();
								const refUpdateRes = runGit(
									["update-ref", `refs/heads/${orchBranch}`, newCommit, orchTip],
									repoRoot,
								);
								if (refUpdateRes.ok) {
									execLog(
										"wave",
										`W${waveIndex}`,
										`committed ${foldersToStage.length} task folder(s) directly on orch branch`,
										{
											orchBranch,
											folders: foldersToStage.join(", "),
											from: orchTip.slice(0, 8),
											to: newCommit.slice(0, 8),
										},
									);
									try {
										unlinkSync(tmpIdx);
									} catch {
										/* best effort */
									}
									return;
								}
								execLog("wave", `W${waveIndex}`, "orch branch staging: ref update failed, falling back", {
									error: refUpdateRes.stderr,
								});
							} else {
								execLog("wave", `W${waveIndex}`, "orch branch staging: commit-tree failed, falling back", {
									error: commitTreeRes.stderr,
								});
							}
						} else {
							execLog("wave", `W${waveIndex}`, "orch branch staging: write-tree failed, falling back", {
								error: writeTreeRes.stderr,
							});
						}
					}
				}
			} catch (err: unknown) {
				execLog("wave", `W${waveIndex}`, "orch branch staging: unexpected error, falling back to HEAD commit", {
					error: err instanceof Error ? err.message : String(err),
				});
			} finally {
				try {
					unlinkSync(tmpIdx);
				} catch {
					/* best effort */
				}
			}
		}
	}

	// Legacy fallback: commit on HEAD + fast-forward/merge orch branch ref.
	for (const folder of foldersToStage) {
		const addResult = runGit(["add", "--", folder], repoRoot);
		if (!addResult.ok) {
			execLog("wave", `W${waveIndex}`, `failed to stage task files: ${addResult.stderr}`, { folder });
			throw new ExecutionError(
				"EXEC_TASK_STAGE_FAILED",
				`Failed to stage task files in "${folder}": ${addResult.stderr}`,
				"wave",
				folder,
			);
		}
	}

	const taskIds = foldersToStage.map(f => f.split("/").pop() || f).join(", ");
	const commitMsg = `chore: stage task files for mission wave ${waveIndex} (${taskIds})`;
	const commitResult = runGit(["commit", "-m", commitMsg], repoRoot);
	if (!commitResult.ok) {
		execLog("wave", `W${waveIndex}`, `failed to commit task files: ${commitResult.stderr}`);
		throw new ExecutionError(
			"EXEC_TASK_COMMIT_FAILED",
			`Failed to commit task files for wave ${waveIndex}: ${commitResult.stderr}`,
			"wave",
			`W${waveIndex}`,
		);
	}

	execLog("wave", `W${waveIndex}`, `committed ${foldersToStage.length} task folder(s) to ensure worktree visibility`, {
		folders: foldersToStage.join(", "),
		commit: commitResult.stdout.trim().split("\n")[0] ?? "",
	});

	if (orchBranch) {
		try {
			const headRes = runGit(["rev-parse", "HEAD"], repoRoot);
			const orchTipRes = runGit(["rev-parse", `refs/heads/${orchBranch}`], repoRoot);

			if (headRes.ok && orchTipRes.ok) {
				const newHead = headRes.stdout.trim();
				const orchTip = orchTipRes.stdout.trim();

				const ancestorCheck = runGit(["merge-base", "--is-ancestor", orchTip, newHead], repoRoot);

				if (ancestorCheck.ok) {
					const ffResult = runGit(["update-ref", `refs/heads/${orchBranch}`, newHead, orchTip], repoRoot);
					if (ffResult.ok) {
						execLog("wave", `W${waveIndex}`, "fast-forwarded orch branch to include staging commit", {
							orchBranch,
							from: orchTip.slice(0, 8),
							to: newHead.slice(0, 8),
						});
					} else {
						execLog("wave", `W${waveIndex}`, "warning: failed to fast-forward orch branch (non-fatal)", {
							orchBranch,
							error: ffResult.stderr,
						});
					}
				} else {
					const mergeTreeRes = runGit(["merge-tree", "--write-tree", orchTip, newHead], repoRoot);
					if (mergeTreeRes.ok) {
						const mergedTree = mergeTreeRes.stdout.trim().split("\n")[0];
						if (mergedTree && /^[0-9a-f]{40}$/i.test(mergedTree)) {
							const mergeMsg = `merge: include staged task files for wave ${waveIndex} into orch branch`;
							const commitTreeRes = runGit(
								["commit-tree", mergedTree, "-p", orchTip, "-p", newHead, "-m", mergeMsg],
								repoRoot,
							);
							if (commitTreeRes.ok) {
								const mergeCommitSha = commitTreeRes.stdout.trim();
								const refUpdateRes = runGit(
									["update-ref", `refs/heads/${orchBranch}`, mergeCommitSha, orchTip],
									repoRoot,
								);
								if (refUpdateRes.ok) {
									execLog("wave", `W${waveIndex}`, "merged staging commit into orch branch (non-FF wave)", {
										orchBranch,
										mergeCommit: mergeCommitSha.slice(0, 8),
									});
								}
							}
						}
					}
				}
			}
		} catch (refErr: unknown) {
			execLog("wave", `W${waveIndex}`, "warning: orch branch ref update threw unexpectedly (non-fatal)", {
				orchBranch,
				error: refErr instanceof Error ? refErr.message : String(refErr),
			});
		}
	}
}

// ── Task monitor state resolver ──────────────────────────────────────

/**
 * Derive a per-task {@link TaskMonitorSnapshot} from the STATUS.md parse
 * result, the `.DONE` file presence, and session/agent liveness.
 *
 * Priority order (mirrors taskplane `execution.ts:807`):
 *  1. `.DONE` file present → `succeeded`
 *  2. STATUS.md mtime quiet for `stallTimeoutMs` → `stalled` + kill agent
 *  3. Session/agent dead without `.DONE` → `failed`
 *  4. Otherwise → `running`
 *
 * When `runtimeBackend === "v2"` and `v2Context` is provided the function
 * consults the lane snapshot file (written ~1/sec by the lane runner) in
 * preference to the registry. Two special cases handle races:
 *
 *  - **Startup grace**: snapshot missing or points to a prior task within
 *    60s of the tracker's `firstObservedAt` → assume alive. Wave/task
 *    transitions commonly leave stale snapshots from the previous task
 *    while the new worker is still spawning.
 *  - **Ghost-worker fast-fail (TP-159)**: snapshot is current but hasn't
 *    updated for more than `stallTimeoutMs / 2`, grace has elapsed, and
 *    the registry confirms the PID is dead → immediately report dead
 *    instead of waiting for the full stall timeout to expire.
 *
 * `tracker` is mutated: `lastMtime` and `stallTimerStart` are updated
 * whenever `statusResult.parsed` is provided, so callers must pass the
 * same tracker instance across polls for a given task.
 */
export async function resolveTaskMonitorState(
	taskId: string,
	donePath: string,
	sessionName: string,
	statusResult: { parsed: ParsedWorktreeStatus | null; error: string | null },
	tracker: MtimeTracker,
	stallTimeoutMs: number,
	now: number,
	runtimeBackend?: RuntimeBackend,
	v2Context?: { stateRoot: string; batchId: string; laneNumber: number },
): Promise<TaskMonitorSnapshot> {
	// Backend-aware liveness check (TP-115/TP-127).
	let sessionAlive: boolean;
	if (runtimeBackend === "v2" && v2Context) {
		const snap = readLaneSnapshot(v2Context.stateRoot, v2Context.batchId, v2Context.laneNumber);
		if (snap == null || snap.taskId !== taskId) {
			const staleMs = snap?.updatedAt ? now - snap.updatedAt : 0;
			if (staleMs > 30_000) {
				const trackerAgeMs = now - tracker.firstObservedAt;
				if (trackerAgeMs < 60_000) {
					sessionAlive = true;
				} else {
					sessionAlive = isV2AgentAlive(sessionName, runtimeBackend, v2Context.laneNumber);
				}
			} else {
				sessionAlive = true;
			}
		} else {
			// TP-159: fast-fail ghost workers that died after first snapshot.
			const trackerAgeMs = now - tracker.firstObservedAt;
			if (
				snap.updatedAt &&
				now - snap.updatedAt > stallTimeoutMs / 2 &&
				trackerAgeMs >= 60_000 &&
				!isV2AgentAlive(sessionName, runtimeBackend, v2Context.laneNumber)
			) {
				execLog("monitor", taskId, "ghost worker fast-fail — dead PID + stale snapshot", {
					session: sessionName,
					snapStaleMs: now - snap.updatedAt,
					trackerAgeMs,
					halfStallTimeoutMs: stallTimeoutMs / 2,
				});
				sessionAlive = false;
			} else {
				sessionAlive = snap.status === "running";
			}
		}
	} else {
		sessionAlive = isV2AgentAlive(sessionName, "v2", v2Context?.laneNumber);
	}

	const doneFileFound = await fileExistsAsync(donePath);

	let currentStepName: string | null = null;
	let currentStepNumber: number | null = null;
	let totalSteps = 0;
	let totalChecked = 0;
	let totalItems = 0;
	let iteration = 0;
	let reviewCounter = 0;
	const parseError = statusResult.error;

	if (statusResult.parsed) {
		const { steps } = statusResult.parsed;
		totalSteps = steps.length;
		iteration = statusResult.parsed.iteration;
		reviewCounter = statusResult.parsed.reviewCounter;

		for (const step of steps) {
			totalChecked += step.totalChecked;
			totalItems += step.totalItems;
		}

		const inProgress = steps.find(s => s.status === "in-progress");
		if (inProgress) {
			currentStepName = inProgress.name;
			currentStepNumber = inProgress.number;
		} else {
			const notStarted = steps.find(s => s.status === "not-started");
			if (notStarted) {
				currentStepName = notStarted.name;
				currentStepNumber = notStarted.number;
			} else if (steps.length > 0) {
				const last = steps[steps.length - 1];
				if (last) {
					currentStepName = last.name;
					currentStepNumber = last.number;
				}
			}
		}

		// Update mtime tracker — in-place mutation, shared across polls.
		if (!tracker.statusFileSeenOnce) {
			tracker.statusFileSeenOnce = true;
			tracker.lastMtime = statusResult.parsed.mtime;
			tracker.stallTimerStart = null;
		} else if (statusResult.parsed.mtime !== tracker.lastMtime) {
			tracker.lastMtime = statusResult.parsed.mtime;
			tracker.stallTimerStart = null;
		} else if (tracker.stallTimerStart === null) {
			tracker.stallTimerStart = now;
		}
	}

	// Priority 1: .DONE file found → succeeded.
	if (doneFileFound) {
		return {
			taskId,
			status: "succeeded",
			currentStepName,
			currentStepNumber,
			totalSteps,
			totalChecked,
			totalItems,
			sessionAlive,
			doneFileFound: true,
			stallReason: null,
			lastHeartbeat: tracker.lastMtime,
			observedAt: now,
			parseError,
			iteration,
			reviewCounter,
		};
	}

	// Priority 2: stall timeout reached → stalled + kill.
	if (
		sessionAlive &&
		tracker.statusFileSeenOnce &&
		tracker.stallTimerStart !== null &&
		now - tracker.stallTimerStart >= stallTimeoutMs
	) {
		const stallMinutes = Math.round((now - tracker.stallTimerStart) / 60_000);
		const stallReason = `STATUS.md unchanged for ${stallMinutes} minutes (threshold: ${Math.round(stallTimeoutMs / 60_000)} min)`;

		execLog("monitor", taskId, "stall detected — killing agent", {
			session: sessionName,
			stallMinutes,
			backend: runtimeBackend ?? "legacy",
		});
		killV2LaneAgents(sessionName, { laneNumber: v2Context?.laneNumber });

		return {
			taskId,
			status: "stalled",
			currentStepName,
			currentStepNumber,
			totalSteps,
			totalChecked,
			totalItems,
			sessionAlive: false,
			doneFileFound: false,
			stallReason,
			lastHeartbeat: tracker.lastMtime,
			observedAt: now,
			parseError,
			iteration,
			reviewCounter,
		};
	}

	// Priority 3: session exited without .DONE → failed.
	if (!sessionAlive) {
		return {
			taskId,
			status: "failed",
			currentStepName,
			currentStepNumber,
			totalSteps,
			totalChecked,
			totalItems,
			sessionAlive: false,
			doneFileFound: false,
			stallReason: null,
			lastHeartbeat: tracker.lastMtime,
			observedAt: now,
			parseError,
			iteration,
			reviewCounter,
		};
	}

	// Priority 4: alive → running.
	return {
		taskId,
		status: "running",
		currentStepName,
		currentStepNumber,
		totalSteps,
		totalChecked,
		totalItems,
		sessionAlive: true,
		doneFileFound: false,
		stallReason: null,
		lastHeartbeat: tracker.lastMtime,
		observedAt: now,
		parseError,
		iteration,
		reviewCounter,
	};
}

// ── Monitor loop ─────────────────────────────────────────────────────

/** Dashboard callback type for per-poll monitor updates. */
export type MonitorUpdateCallback = (state: MonitorState) => void;

/**
 * Monitor all lanes in a wave, polling for progress, completion, and stalls.
 *
 * Air-traffic-control style: does NOT attach to lane sessions directly.
 * Observes via filesystem polling — STATUS.md for step/checkbox progress,
 * `.DONE` files for task completion, registry + snapshot for backend
 * liveness, STATUS.md mtime for stall detection.
 *
 * Runs until all lanes reach terminal states (all tasks succeeded / failed /
 * stalled) or `pauseSignal.paused` is set.
 *
 * Each poll cycle:
 *  1. Refresh the V2 liveness registry cache once (shared by per-task
 *     `resolveTaskMonitorState` calls).
 *  2. Scan for orphan workers (TP-159) — dead PIDs in non-terminal manifest
 *     status get marked crashed and the registry aggregate rebuilt.
 *  3. Walk each lane's tasks in order, calling `resolveTaskMonitorState`
 *     on the first non-terminal task; advance when it reaches terminal.
 *  4. Assemble a `MonitorState` snapshot and fire `onUpdate` (swallow
 *     callback throws — monitor loop must never die on dashboard error).
 *  5. Log only on state-change (`totalDone/totalFailed` key).
 *
 * Ported from taskplane `execution.ts:1075`.
 */
export async function monitorLanes(
	lanes: AllocatedLane[],
	config: OrchestratorConfig,
	repoRoot: string,
	pauseSignal: { paused: boolean },
	waveNumber = 1,
	onUpdate?: MonitorUpdateCallback,
	isWorkspaceMode?: boolean,
	runtimeBackend?: RuntimeBackend,
	batchId?: string,
	stateRootForRegistry?: string,
): Promise<MonitorState> {
	const pollIntervalMs = (config.monitoring.poll_interval || 5) * 1000;
	const stallTimeoutMs = (config.failure.stall_timeout || 30) * 60_000;

	// Per-task mtime trackers — lane advancing to next task gets a fresh one.
	const mtimeTrackers = new Map<string, MtimeTracker>();

	function getOrCreateTracker(taskId: string, now: number): MtimeTracker {
		let tracker = mtimeTrackers.get(taskId);
		if (!tracker) {
			tracker = {
				taskId,
				firstObservedAt: now,
				statusFileSeenOnce: false,
				lastMtime: null,
				stallTimerStart: null,
			};
			mtimeTrackers.set(taskId, tracker);
		}
		return tracker;
	}

	// Terminal-task cache avoids re-scanning a task after it settles.
	const terminalTasks = new Map<string, TaskMonitorSnapshot>();

	let pollCount = 0;
	let lastMonitorStateKey = "";

	const tasksTotal = lanes.reduce((sum, lane) => sum + lane.tasks.length, 0);

	execLog("monitor", "ALL", `starting monitoring for ${lanes.length} lane(s), ${tasksTotal} task(s)`, {
		pollIntervalMs,
		stallTimeoutMin: Math.round(stallTimeoutMs / 60_000),
	});

	while (true) {
		const now = Date.now();
		pollCount++;

		// TP-112: refresh registry cache once per poll.
		if (runtimeBackend === "v2" && batchId) {
			try {
				setV2LivenessRegistryCache(readRegistrySnapshot(stateRootForRegistry ?? repoRoot, batchId));
			} catch {
				setV2LivenessRegistryCache(null);
			}
		} else {
			setV2LivenessRegistryCache(null);
		}

		// TP-159: detect + mark orphaned workers; rebuild registry aggregate.
		if (runtimeBackend === "v2" && batchId) {
			try {
				const registry = readRegistrySnapshot(stateRootForRegistry ?? repoRoot, batchId);
				if (registry) {
					const orphans = detectOrphans(registry);
					if (orphans.length > 0) {
						markOrphansCrashed(stateRootForRegistry ?? repoRoot, batchId, orphans);
						const freshRegistry = buildRegistrySnapshot(stateRootForRegistry ?? repoRoot, batchId);
						writeRegistrySnapshot(stateRootForRegistry ?? repoRoot, freshRegistry);
						setV2LivenessRegistryCache(freshRegistry);
					}
				}
			} catch {
				// Non-fatal — monitor loop must never throw.
			}
		}

		if (pauseSignal.paused) {
			execLog("monitor", "ALL", "pause signal detected — stopping monitoring");
			break;
		}

		const laneSnapshots: LaneMonitorSnapshot[] = [];
		let totalDone = 0;
		let totalFailed = 0;
		let allTerminal = true;

		for (const lane of lanes) {
			const completedTasks: string[] = [];
			const failedTasks: string[] = [];
			const remainingTasks: string[] = [];
			let currentTaskId: string | null = null;
			let currentTaskSnapshot: TaskMonitorSnapshot | null = null;

			for (let i = 0; i < lane.tasks.length; i++) {
				const task = lane.tasks[i];
				if (!task) continue;

				const existingTerminal = terminalTasks.get(task.taskId);
				if (existingTerminal) {
					if (existingTerminal.status === "succeeded") {
						completedTasks.push(task.taskId);
						totalDone++;
					} else {
						failedTasks.push(task.taskId);
						totalFailed++;
					}
					continue;
				}

				if (currentTaskId === null) {
					currentTaskId = task.taskId;
					const tracker = getOrCreateTracker(task.taskId, now);
					const unit = buildExecutionUnit(lane, task, repoRoot, isWorkspaceMode);
					const donePath = unit.packet.donePath;
					const statusPath = unit.packet.statusPath;
					const statusResult = await parseStatusMdAtPath(statusPath);

					const snapshot = await resolveTaskMonitorState(
						task.taskId,
						donePath,
						laneSessionIdOf(lane),
						statusResult,
						tracker,
						stallTimeoutMs,
						now,
						runtimeBackend,
						runtimeBackend === "v2" && batchId
							? {
									stateRoot: stateRootForRegistry ?? repoRoot,
									batchId,
									laneNumber: lane.laneNumber,
								}
							: undefined,
					);

					currentTaskSnapshot = snapshot;

					if (snapshot.status === "succeeded" || snapshot.status === "failed" || snapshot.status === "stalled") {
						terminalTasks.set(task.taskId, snapshot);
						if (snapshot.status === "succeeded") {
							completedTasks.push(task.taskId);
							totalDone++;
						} else {
							failedTasks.push(task.taskId);
							totalFailed++;
						}
						currentTaskId = null;
						currentTaskSnapshot = null;
					} else {
						allTerminal = false;
						for (let j = i + 1; j < lane.tasks.length; j++) {
							const next = lane.tasks[j];
							if (next) remainingTasks.push(next.taskId);
						}
						break;
					}
				} else {
					remainingTasks.push(task.taskId);
				}
			}

			if (currentTaskId !== null) {
				allTerminal = false;
			}

			// TP-148: global laneNumber for workspace-mode fallback lookup.
			const sessionAlive = isV2AgentAlive(laneSessionIdOf(lane), "v2", lane.laneNumber);

			laneSnapshots.push({
				laneId: lane.laneId,
				laneNumber: lane.laneNumber,
				sessionName: laneSessionIdOf(lane),
				sessionAlive,
				currentTaskId,
				currentTaskSnapshot,
				completedTasks,
				failedTasks,
				remainingTasks,
			});
		}

		const monitorState: MonitorState = {
			lanes: laneSnapshots,
			tasksDone: totalDone,
			tasksFailed: totalFailed,
			tasksTotal,
			waveNumber,
			pollCount,
			lastPollTime: now,
			allTerminal,
		};

		if (onUpdate) {
			try {
				onUpdate(monitorState);
			} catch {
				// Callback errors must not kill the monitor loop.
			}
		}

		const currentStateKey = `${totalDone}/${totalFailed}`;
		if (currentStateKey !== lastMonitorStateKey) {
			const activeLanes = laneSnapshots.filter(l => l.currentTaskId !== null);
			execLog(
				"monitor",
				"ALL",
				`poll #${pollCount}: ${totalDone}/${tasksTotal} done, ${totalFailed} failed, ${activeLanes.length} active lane(s)`,
			);
			lastMonitorStateKey = currentStateKey;
		}

		if (allTerminal) {
			execLog("monitor", "ALL", "all lanes terminal — monitoring complete", {
				done: totalDone,
				failed: totalFailed,
				total: tasksTotal,
				polls: pollCount,
			});
			setV2LivenessRegistryCache(null);
			return monitorState;
		}

		await new Promise(r => setTimeout(r, pollIntervalMs));
	}

	// Paused — return a neutral snapshot reflecting the interruption.
	const now = Date.now();
	const laneSnapshots: LaneMonitorSnapshot[] = lanes.map(lane => ({
		laneId: lane.laneId,
		laneNumber: lane.laneNumber,
		sessionName: laneSessionIdOf(lane),
		sessionAlive: false,
		currentTaskId: null,
		currentTaskSnapshot: null,
		completedTasks: [],
		failedTasks: [],
		remainingTasks: lane.tasks.map(t => t.taskId),
	}));

	setV2LivenessRegistryCache(null);
	return {
		lanes: laneSnapshots,
		tasksDone: 0,
		tasksFailed: 0,
		tasksTotal,
		waveNumber,
		pollCount,
		lastPollTime: now,
		allTerminal: false,
	};
}

// ── Stop-all policy race ────────────────────────────────────────────────

/**
 * Execute lanes under the `stop-all` failure policy.
 *
 * Starts every lane in parallel, watches for the first failure across all
 * lanes, and on detection:
 *   1. Sets `pauseSignal.paused = true` to halt the monitor
 *   2. Fires `killV2LaneAgents` for every lane (not only the failing one)
 *
 * All lanes are then awaited via `Promise.allSettled`. Rejected promises
 * become synthetic failed LaneExecutionResults so the caller always gets a
 * same-length array matching `lanes`.
 *
 * Ported verbatim from taskplane/execution.ts:2049.
 */
export async function executeWithStopAll(
	lanes: AllocatedLane[],
	lanePromises: Promise<LaneExecutionResult>[],
	pauseSignal: { paused: boolean },
	waveIndex: number,
): Promise<LaneExecutionResult[]> {
	const results: (LaneExecutionResult | null)[] = new Array(lanes.length).fill(null);
	let abortTriggered = false;

	const wrappedPromises = lanePromises.map(async (promise, idx) => {
		const laneAtIdx = lanes[idx];
		if (!laneAtIdx) {
			throw new Error(`executeWithStopAll: no lane at index ${idx}`);
		}
		try {
			const result = await promise;
			results[idx] = result;

			if (!abortTriggered) {
				const hasFailure = result.tasks.some(t => t.status === "failed" || t.status === "stalled");
				if (hasFailure) {
					abortTriggered = true;
					pauseSignal.paused = true;

					// Deterministic tie-break: first by startTime, then by taskId
					const firstFailed = result.tasks
						.filter(t => t.status === "failed" || t.status === "stalled")
						.sort((a, b) => {
							const timeA = a.startTime || 0;
							const timeB = b.startTime || 0;
							if (timeA !== timeB) return timeA - timeB;
							return a.taskId.localeCompare(b.taskId);
						})[0];

					execLog(
						"wave",
						`W${waveIndex}`,
						`stop-all triggered by ${firstFailed?.taskId || "unknown"} in ${laneAtIdx.laneId}`,
						{ session: laneSessionIdOf(laneAtIdx) },
					);

					for (const lane of lanes) {
						killV2LaneAgents(laneSessionIdOf(lane), { laneNumber: lane.laneNumber });
					}
				}
			}

			return result;
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			if (!abortTriggered) {
				abortTriggered = true;
				pauseSignal.paused = true;
				execLog("wave", `W${waveIndex}`, `stop-all triggered by lane error in ${laneAtIdx.laneId}: ${errMsg}`);
				for (const lane of lanes) {
					killV2LaneAgents(laneSessionIdOf(lane), { laneNumber: lane.laneNumber });
				}
			}

			const failedResult: LaneExecutionResult = {
				laneNumber: laneAtIdx.laneNumber,
				laneId: laneAtIdx.laneId,
				tasks: laneAtIdx.tasks.map(t => ({
					taskId: t.taskId,
					status: "failed" as LaneTaskStatus,
					startTime: null,
					endTime: null,
					exitReason: `Lane aborted: ${errMsg}`,
					sessionName: laneSessionIdOf(laneAtIdx),
					doneFileFound: false,
					laneNumber: laneAtIdx.laneNumber,
				})),
				overallStatus: "failed",
				startTime: Date.now(),
				endTime: Date.now(),
			};
			results[idx] = failedResult;
			return failedResult;
		}
	});

	await Promise.allSettled(wrappedPromises);

	return results.map((r, idx) => {
		if (r) return r;
		const lane = lanes[idx];
		if (!lane) {
			throw new Error(`executeWithStopAll: no lane at index ${idx} for fallback result`);
		}
		return {
			laneNumber: lane.laneNumber,
			laneId: lane.laneId,
			tasks: [],
			overallStatus: "failed" as const,
			startTime: Date.now(),
			endTime: Date.now(),
		};
	});
}

// ── Runtime V2 lane wrapper ────────────────────────────────────────────────

/**
 * Commit all uncommitted artifacts in a lane worktree after a task completes.
 *
 * Worker agents write STATUS.md, .DONE markers, and other artifacts that may
 * not have been committed yet. This wraps those in a single checkpoint commit
 * so the lane branch reflects the task's final state before the next task
 * begins or the merge step runs.
 *
 * Non-fatal — if git fails (e.g., worker already committed everything, or the
 * worktree is in an unexpected state), the error is logged and the function
 * returns silently. The merge path handles "no lane changes" gracefully.
 *
 * Ported from taskplane `execution.ts:487`.
 */
function commitTaskArtifacts(lane: AllocatedLane, task: AllocatedTask, laneId: string): void {
	const worktreePath = lane.worktreePath;

	const statusResult = runGit(["status", "--porcelain"], worktreePath);
	if (!statusResult.ok || !statusResult.stdout.trim()) {
		return;
	}

	const addResult = runGit(["add", "-A"], worktreePath);
	if (!addResult.ok) {
		execLog(laneId, task.taskId, `post-task stage failed (non-fatal): ${addResult.stderr.slice(0, 200)}`);
		return;
	}

	const commitResult = runGit(
		["commit", "-m", `checkpoint: ${task.taskId} task artifacts (.DONE, STATUS.md)`],
		worktreePath,
	);
	if (!commitResult.ok) {
		if (!commitResult.stderr.includes("nothing to commit")) {
			execLog(laneId, task.taskId, `post-task commit failed (non-fatal): ${commitResult.stderr.slice(0, 200)}`);
		}
		return;
	}

	execLog(laneId, task.taskId, "committed task artifacts to lane branch", {
		commit: commitResult.stdout.trim().split("\n")[0],
	});
}

/**
 * Execute one lane through the Runtime V2 lane-runner.
 *
 * Iterates the lane's task list, building an `ExecutionUnit` per task, then
 * delegates to {@link executeTaskV2} for the full worker iteration loop
 * (STATUS.md resume → spawn → progress check → .DONE verification). Between
 * successful tasks, the worktree is reset (`git checkout -- . && git clean -fd`)
 * to give the next task a clean starting state on the same branch.
 *
 * Stop-all policy: if any task fails or stalls, remaining tasks in the lane
 * are marked `"skipped"` and the lane status becomes `"failed"`. A paused
 * signal flagged mid-loop produces the same skip behaviour with reason
 * `"Skipped due to pause signal"`.
 *
 * Worker + segment prompts are composed once per lane from the base template
 * (`templates/agents/task-worker.md`) plus optional local override
 * (`.omp/agents/task-worker.md`). Segment overlay
 * (`templates/agents/task-worker-segment.md`) is appended inside executeTaskV2
 * when the unit is segment-scoped.
 *
 * Ported from taskplane `execution.ts:2516`. Env var rename:
 * `TASKPLANE_SUPERVISOR_AUTONOMY` → `MISSION_SUPERVISOR_AUTONOMY`,
 * `TASKPLANE_REVIEWER_*` → `MISSION_REVIEWER_*`. The `ORCH_BATCH_ID` fallback
 * is preserved so legacy callers keep working.
 */
export async function executeLaneV2(
	lane: AllocatedLane,
	config: OrchestratorConfig,
	repoRoot: string,
	pauseSignal: { paused: boolean },
	workspaceRoot?: string,
	isWorkspaceMode?: boolean,
	extraEnvVars?: Record<string, string>,
	onSupervisorAlert?: SupervisorAlertCallback,
): Promise<LaneExecutionResult> {
	const laneId = lane.laneId;
	const laneStartTime = Date.now();
	const outcomes: LaneTaskOutcome[] = [];
	let shouldSkipRemaining = false;

	const stateRoot = resolveRuntimeStateRoot(repoRoot, workspaceRoot);
	const batchId = extraEnvVars?.ORCH_BATCH_ID || String(Date.now());

	const sessionPrefix = config.orchestrator?.sessionPrefix ?? "mission";
	const opId = resolveOperatorId(config.orchestrator?.operator_id);
	const agentIdPrefix = `${sessionPrefix}-${opId}`;

	let workerSystemPrompt =
		"You are a task execution agent. Read STATUS.md first, find unchecked items, work on them, checkpoint after each.";
	let workerSegmentPrompt = "";
	try {
		const basePrompt = loadBaseAgentPrompt("task-worker");
		const localPrompt = loadLocalAgentPrompt(stateRoot, "task-worker");
		if (basePrompt && localPrompt) {
			workerSystemPrompt = `${basePrompt}\n\n---\n\n## Project-Specific Guidance\n\n${localPrompt}`;
		} else if (basePrompt) {
			workerSystemPrompt = basePrompt;
		} else if (localPrompt) {
			workerSystemPrompt = localPrompt;
		}
		const segPrompt = loadBaseAgentPrompt("task-worker-segment");
		if (segPrompt) workerSegmentPrompt = segPrompt;
	} catch {
		// use default
	}

	execLog(laneId, "LANE", `starting Runtime V2 execution of ${lane.tasks.length} task(s)`, {
		worktree: lane.worktreePath,
		agentPrefix: agentIdPrefix,
	});

	for (const task of lane.tasks) {
		const taskSegmentId = task.task.activeSegmentId ?? null;
		if (shouldSkipRemaining || pauseSignal.paused) {
			const reason = pauseSignal.paused
				? "Skipped due to pause signal"
				: "Skipped due to prior task failure in lane";
			outcomes.push({
				taskId: task.taskId,
				status: "skipped",
				segmentId: taskSegmentId,
				startTime: null,
				endTime: null,
				exitReason: reason,
				sessionName: buildRuntimeAgentId(agentIdPrefix, lane.laneNumber, "worker"),
				doneFileFound: false,
				laneNumber: lane.laneNumber,
			});
			continue;
		}

		const unit = buildExecutionUnit(lane, task, repoRoot, isWorkspaceMode);

		const rawAutonomy = String(extraEnvVars?.MISSION_SUPERVISOR_AUTONOMY ?? "autonomous").toLowerCase();
		const supervisorAutonomy: LaneRunnerConfig["supervisorAutonomy"] =
			rawAutonomy === "interactive" || rawAutonomy === "supervised" || rawAutonomy === "autonomous"
				? (rawAutonomy as LaneRunnerConfig["supervisorAutonomy"])
				: "autonomous";

		const laneRunnerConfig: LaneRunnerConfig = {
			batchId,
			agentIdPrefix,
			laneNumber: lane.laneNumber,
			worktreePath: lane.worktreePath,
			branch: lane.branch,
			repoId: lane.repoId ?? "default",
			stateRoot,
			workerModel: "",
			workerTools: "read,write,edit,bash,grep,find,ls",
			workerThinking: "",
			workerSystemPrompt,
			workerSegmentPrompt,
			reviewerModel: extraEnvVars?.MISSION_REVIEWER_MODEL || "",
			reviewerThinking: extraEnvVars?.MISSION_REVIEWER_THINKING || "",
			reviewerTools: extraEnvVars?.MISSION_REVIEWER_TOOLS || "",
			supervisorAutonomy,
			projectName: "project",
			maxIterations: 20,
			noProgressLimit: 3,
			maxWorkerMinutes: config.failure?.max_worker_minutes || 120,
			warnPercent: 85,
			killPercent: 95,
			onSupervisorAlert,
		};

		try {
			const result = await executeTaskV2(unit, laneRunnerConfig, pauseSignal);
			outcomes.push({
				...result.outcome,
				laneNumber: result.outcome.laneNumber ?? lane.laneNumber,
			});

			if (result.outcome.status === "succeeded") {
				commitTaskArtifacts(lane, task, laneId);
				if (lane.tasks.indexOf(task) < lane.tasks.length - 1) {
					runGit(["checkout", "--", "."], lane.worktreePath);
					runGit(["clean", "-fd"], lane.worktreePath);
				}
			}

			if (result.outcome.status === "failed" || result.outcome.status === "stalled") {
				shouldSkipRemaining = true;
			}
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			execLog(laneId, task.taskId, `Runtime V2 execution error: ${errMsg}`);
			outcomes.push({
				taskId: task.taskId,
				status: "failed",
				segmentId: taskSegmentId,
				startTime: Date.now(),
				endTime: Date.now(),
				exitReason: `Runtime V2 execution error: ${errMsg}`,
				sessionName: buildRuntimeAgentId(agentIdPrefix, lane.laneNumber, "worker"),
				doneFileFound: false,
				laneNumber: lane.laneNumber,
			});
			shouldSkipRemaining = true;
		}
	}

	const endTime = Date.now();
	const succeeded = outcomes.every(o => o.status === "succeeded");
	const failed = outcomes.some(o => o.status === "failed" || o.status === "stalled");

	return {
		laneNumber: lane.laneNumber,
		laneId,
		tasks: outcomes,
		overallStatus: succeeded ? "succeeded" : failed ? "failed" : "partial",
		startTime: laneStartTime,
		endTime,
	};
}

// ── Wave executor ──────────────────────────────────────────────────────────

/**
 * Execute a single wave: allocate lanes, start lane executors in parallel,
 * run the monitor loop concurrently, and apply the failure policy.
 *
 * Five stages:
 *   0. `ensureTaskFilesCommitted` — stage untracked PROMPT.md/STATUS.md files
 *      into the orch branch so lane worktrees inherit them.
 *   1. `allocateLanes` — split wave tasks into lanes + create worktrees.
 *   2. Launch `executeLaneV2` per lane in parallel; `monitorLanes` watches
 *      liveness and can trigger stalls or crashes.
 *   3. Apply failure policy:
 *      - `stop-all` — {@link executeWithStopAll} races for first failure and
 *        kills remaining lanes.
 *      - `stop-wave` — let lanes finish, then set `pauseSignal.paused` so the
 *        caller aborts at the wave boundary.
 *      - `skip-dependents` — let lanes finish, compute transitive dependents
 *        of failed tasks for the caller to block in future waves.
 *   4. Sort task IDs for deterministic output, classify overall status,
 *      build {@link WaveExecutionResult}.
 *
 * Runtime V2 is the only supported backend; legacy `runtimeBackend` argument
 * is accepted for compatibility but logged-and-ignored. Stale lane snapshots
 * from prior waves are deleted before launching workers to prevent the
 * monitor from misreading them as fresh crashes.
 *
 * Ported from taskplane `execution.ts:1741`. Env var rename:
 * `TASKPLANE_SUPERVISOR_AUTONOMY` → `MISSION_SUPERVISOR_AUTONOMY`. Lane
 * snapshot path now goes through `runtimeLaneSnapshotPath` so it resolves to
 * `.omp/runtime/` instead of the hardcoded `.pi/runtime/`.
 */
export async function executeWave(
	waveTasks: string[],
	waveIndex: number,
	pending: Map<string, ParsedTask>,
	config: OrchestratorConfig,
	repoRoot: string,
	batchId: string,
	pauseSignal: { paused: boolean },
	dependencyGraph: DependencyGraph,
	orchBranch: string,
	onMonitorUpdate?: MonitorUpdateCallback,
	onLanesAllocated?: (lanes: AllocatedLane[]) => void,
	workspaceConfig?: WorkspaceConfig | null,
	runtimeBackend?: RuntimeBackend,
	onSupervisorAlert?: SupervisorAlertCallback,
	supervisorAutonomy: "interactive" | "supervised" | "autonomous" = "autonomous",
	reviewerConfig?: { model?: string; thinking?: string; tools?: string },
): Promise<WaveExecutionResult> {
	const startedAt = Date.now();
	const policy = config.failure.on_task_failure;

	execLog("wave", `W${waveIndex}`, "starting wave execution", {
		tasks: waveTasks.length,
		policy,
		batchId,
	});

	// Stage 0: pre-flight commit of untracked task files.
	try {
		ensureTaskFilesCommitted(waveTasks, pending, repoRoot, waveIndex, orchBranch);
	} catch (err: unknown) {
		const errMsg = err instanceof Error ? err.message : String(err);
		execLog("wave", `W${waveIndex}`, `task file commit failed: ${errMsg}`);

		return {
			waveIndex,
			startedAt,
			endedAt: Date.now(),
			laneResults: [],
			policyApplied: policy,
			stoppedEarly: true,
			failedTaskIds: waveTasks,
			skippedTaskIds: [],
			succeededTaskIds: [],
			blockedTaskIds: [...computeTransitiveDependents(new Set(waveTasks), dependencyGraph)],
			laneCount: 0,
			overallStatus: "failed",
			finalMonitorState: null,
			allocatedLanes: [],
		};
	}

	// Stage 1: allocate lanes + worktrees.
	const allocResult = allocateLanes(waveTasks, pending, config, repoRoot, batchId, orchBranch, workspaceConfig);
	if (!allocResult.success) {
		const errMsg = allocResult.error?.message || "Unknown allocation failure";
		execLog("wave", `W${waveIndex}`, `lane allocation failed: ${errMsg}`);

		return {
			waveIndex,
			startedAt,
			endedAt: Date.now(),
			laneResults: [],
			policyApplied: policy,
			stoppedEarly: true,
			failedTaskIds: waveTasks,
			skippedTaskIds: [],
			succeededTaskIds: [],
			blockedTaskIds: [...computeTransitiveDependents(new Set(waveTasks), dependencyGraph)],
			laneCount: 0,
			overallStatus: "failed",
			finalMonitorState: null,
			allocatedLanes: [],
			allocationError: allocResult.error,
		};
	}

	const lanes = allocResult.lanes;
	onLanesAllocated?.(lanes);

	execLog("wave", `W${waveIndex}`, "lanes allocated", {
		laneCount: lanes.length,
		totalTasks: waveTasks.length,
	});

	// Stage 2: launch lane executors + monitor loop.
	const wavePauseSignal = pauseSignal;
	const wsRoot = workspaceConfig ? dirname(dirname(workspaceConfig.configPath)) : undefined;
	const isWsMode = !!workspaceConfig;
	const backend: RuntimeBackend = "v2";
	if (runtimeBackend && runtimeBackend !== "v2") {
		execLog(
			"wave",
			`W${waveIndex}`,
			`legacy runtime backend '${runtimeBackend}' requested but ignored; using Runtime V2`,
		);
	}
	execLog("wave", `W${waveIndex}`, "using Runtime V2 backend (executeLaneV2)");

	// Clear stale lane snapshots from prior waves so the monitor doesn't
	// misread a pre-existing `lane-N.json` from wave N-1 as a fresh crash.
	const snapshotStateRoot = resolveRuntimeStateRoot(repoRoot, wsRoot);
	for (const lane of lanes) {
		try {
			const snapPath = runtimeLaneSnapshotPath(snapshotStateRoot, batchId, lane.laneNumber);
			if (existsSync(snapPath)) unlinkSync(snapPath);
		} catch {
			// best effort
		}
	}

	const lanePromises = lanes.map(lane =>
		executeLaneV2(
			lane,
			config,
			repoRoot,
			wavePauseSignal,
			wsRoot,
			isWsMode,
			{
				ORCH_BATCH_ID: batchId,
				MISSION_SUPERVISOR_AUTONOMY: supervisorAutonomy,
				...buildReviewerEnv(reviewerConfig),
			},
			onSupervisorAlert,
		),
	);

	const monitorStateRoot = resolveRuntimeStateRoot(repoRoot, wsRoot);
	const monitorPromise = monitorLanes(
		lanes,
		config,
		repoRoot,
		wavePauseSignal,
		waveIndex,
		onMonitorUpdate,
		isWsMode,
		backend,
		batchId,
		monitorStateRoot,
	);

	// Stage 3: wait for lanes + apply failure policy.
	let laneResults: LaneExecutionResult[];
	let finalMonitorState: MonitorState | null = null;

	if (policy === "stop-all") {
		laneResults = await executeWithStopAll(lanes, lanePromises, wavePauseSignal, waveIndex);
	} else {
		const settled = await Promise.allSettled(lanePromises);
		laneResults = settled.map((result, idx) => {
			if (result.status === "fulfilled") return result.value;
			const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
			const lane = lanes[idx];
			if (!lane) throw new Error(`executeWave: no lane at index ${idx} for fallback`);
			execLog("wave", `W${waveIndex}`, `lane ${lane.laneId} promise rejected: ${errMsg}`);
			return {
				laneNumber: lane.laneNumber,
				laneId: lane.laneId,
				tasks: lane.tasks.map(t => ({
					taskId: t.taskId,
					status: "failed" as LaneTaskStatus,
					startTime: null,
					endTime: null,
					exitReason: `Lane promise rejected: ${errMsg}`,
					sessionName: laneSessionIdOf(lane),
					doneFileFound: false,
					laneNumber: lane.laneNumber,
				})),
				overallStatus: "failed" as const,
				startTime: startedAt,
				endTime: Date.now(),
			};
		});

		if (policy === "stop-wave") {
			const hasFailure = laneResults.some(lr => lr.tasks.some(t => t.status === "failed" || t.status === "stalled"));
			if (hasFailure) {
				wavePauseSignal.paused = true;
				execLog("wave", `W${waveIndex}`, "stop-wave policy triggered — pausing after this wave");
			}
		}
	}

	try {
		finalMonitorState = await monitorPromise;
	} catch {
		execLog("wave", `W${waveIndex}`, "monitor promise error (non-fatal)");
	}

	// Stage 4: classify tasks + build wave result.
	const failedTaskIds: string[] = [];
	const skippedTaskIds: string[] = [];
	const succeededTaskIds: string[] = [];

	for (const lr of laneResults) {
		for (const t of lr.tasks) {
			if (t.status === "succeeded") {
				succeededTaskIds.push(t.taskId);
			} else if (t.status === "failed" || t.status === "stalled") {
				failedTaskIds.push(t.taskId);
			} else if (t.status === "skipped") {
				skippedTaskIds.push(t.taskId);
			}
		}
	}

	failedTaskIds.sort();
	skippedTaskIds.sort();
	succeededTaskIds.sort();

	let blockedTaskIds: string[] = [];
	if (policy === "skip-dependents" && failedTaskIds.length > 0) {
		const blocked = computeTransitiveDependents(new Set(failedTaskIds), dependencyGraph);
		blockedTaskIds = [...blocked].sort();
		if (blockedTaskIds.length > 0) {
			execLog(
				"wave",
				`W${waveIndex}`,
				`skip-dependents: ${blockedTaskIds.length} task(s) blocked for future waves`,
				{
					blocked: blockedTaskIds.join(","),
				},
			);
		}
	}

	const stoppedEarly =
		(policy === "stop-all" && failedTaskIds.length > 0) || (policy === "stop-wave" && failedTaskIds.length > 0);

	let overallStatus: WaveExecutionResult["overallStatus"];
	if (policy === "stop-all" && failedTaskIds.length > 0) {
		overallStatus = "aborted";
	} else if (failedTaskIds.length === 0) {
		overallStatus = "succeeded";
	} else if (succeededTaskIds.length > 0) {
		overallStatus = "partial";
	} else {
		overallStatus = "failed";
	}

	const endedAt = Date.now();
	const elapsedSec = Math.round((endedAt - startedAt) / 1000);

	execLog("wave", `W${waveIndex}`, `wave execution complete: ${overallStatus}`, {
		succeeded: succeededTaskIds.length,
		failed: failedTaskIds.length,
		skipped: skippedTaskIds.length,
		blocked: blockedTaskIds.length,
		elapsed: `${elapsedSec}s`,
		stoppedEarly,
	});

	return {
		waveIndex,
		startedAt,
		endedAt,
		laneResults,
		policyApplied: policy,
		stoppedEarly,
		failedTaskIds,
		skippedTaskIds,
		succeededTaskIds,
		blockedTaskIds,
		laneCount: lanes.length,
		overallStatus,
		finalMonitorState,
		allocatedLanes: lanes,
	};
}
