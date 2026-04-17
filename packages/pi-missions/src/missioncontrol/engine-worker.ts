/**
 * MissionControl engine worker — message types + pure serialization helpers.
 *
 * Ported from `taskplane/extensions/taskplane/engine-worker.ts` (381 LOC).
 * This module has two historical roles in taskplane:
 *   1. Exports types + pure serialization helpers used by the main thread.
 *   2. When forked as a child Node process (`TASKPLANE_ENGINE_FORK=1`), acts
 *      as the engine entry point.
 *
 * In the oh-my-pi port we keep (1) verbatim — the cross-thread message
 * contract stays identical so a future Bun `Worker`-backed runtime can
 * reuse it. (2) is intentionally DROPPED here; it depends on `engine.ts`
 * and `resume.ts` which land in later port batches. The new worker entry
 * will live in `engine-worker-entry.ts` (Bun Worker) and import from this
 * module for types + helpers.
 */
import type {
	AllocatedLane,
	EngineEvent,
	MissionBatchPhase,
	MissionBatchRuntimeState,
	MonitorState,
	OrchestratorConfig,
	SupervisorAlert,
	TaskRunnerConfig,
	WorkspaceConfig,
	WorkspaceRepoConfig,
} from "./types";

// ── Types for worker <-> main thread messages ────────────────────────

/** Where a worker-level fatal error originated. */
export type WorkerErrorSource = "enginePromise" | "uncaughtException" | "unhandledRejection";

/** Messages sent FROM the worker TO the main thread. */
export type WorkerToMainMessage =
	| { type: "notify"; msg: string; level: "info" | "warning" | "error" }
	| { type: "monitor-update"; state: MonitorState }
	| { type: "engine-event"; event: EngineEvent }
	| { type: "supervisor-alert"; alert: SupervisorAlert }
	| { type: "state-sync"; state: SerializedBatchState }
	| { type: "complete"; state: SerializedBatchState }
	| { type: "error"; message: string; stack?: string; source?: WorkerErrorSource };

/** Messages sent FROM the main thread TO the worker. */
export type WorkerInMessage = { type: "pause" } | { type: "resume" } | { type: "abort" };

/**
 * Serializable form of `MissionBatchRuntimeState` fields synced to the
 * main thread. Only the fields the main thread needs for display and
 * state tracking — deep graph + resilience state stays worker-local.
 */
export interface SerializedBatchState {
	phase: MissionBatchPhase;
	batchId: string;
	baseBranch: string;
	orchBranch: string;
	mode: string;
	currentWaveIndex: number;
	totalWaves: number;
	totalTasks: number;
	succeededTasks: number;
	failedTasks: number;
	skippedTasks: number;
	blockedTasks: number;
	startedAt: number;
	endedAt: number | null;
	errors: string[];
	/** Active lanes for the current wave (synced so `mission-sessions` works). */
	currentLanes: AllocatedLane[];
}

/** Serializable form of `WorkspaceConfig` (Map → array of entries). */
export interface SerializedWorkspaceConfig {
	mode: string;
	repos: Array<[string, WorkspaceRepoConfig]>;
	routing: WorkspaceConfig["routing"];
	configPath: string;
}

/** Shape passed to the worker at init time. */
export interface EngineWorkerData {
	/** Sentinel flag — distinguishes engine worker from other Bun Workers. */
	engineWorker: true;
	/** `"execute"` for a new batch, `"resume"` to resume persisted state. */
	mode: "execute" | "resume";
	/** User target string (only for `"execute"` mode). */
	args?: string;
	/** Orchestrator configuration. */
	orchConfig: OrchestratorConfig;
	/** Task runner configuration. */
	runnerConfig: TaskRunnerConfig;
	/** Repository root (cwd). */
	cwd: string;
	/** Workspace configuration (serialized) — null for repo mode. */
	workspaceConfig?: SerializedWorkspaceConfig | null;
	/** Workspace root directory. */
	workspaceRoot?: string;
	/** Agent root directory (mission root — `.omp` projected from `cwd`). */
	agentRoot?: string;
	/** Force flag for resume. */
	force?: boolean;
	/** Supervisor autonomy mode propagated to worker bridge tools. */
	supervisorAutonomy?: "interactive" | "supervised" | "autonomous";
}

// ── Serialization helpers (pure) ─────────────────────────────────────

/**
 * Serialize `WorkspaceConfig` for cross-thread transfer.
 *
 * Converts the `Map<string, WorkspaceRepoConfig>` to an array of entries
 * so the message round-trips through `structuredClone` / `postMessage`.
 */
export function serializeWorkspaceConfig(config: WorkspaceConfig | null | undefined): SerializedWorkspaceConfig | null {
	if (!config) return null;
	return {
		mode: config.mode,
		repos: [...config.repos.entries()],
		routing: config.routing,
		configPath: config.configPath,
	};
}

/** Reconstruct `WorkspaceConfig` from its serialized form. */
export function deserializeWorkspaceConfig(
	serialized: SerializedWorkspaceConfig | null | undefined,
): WorkspaceConfig | null {
	if (!serialized) return null;
	return {
		mode: serialized.mode as WorkspaceConfig["mode"],
		repos: new Map(serialized.repos),
		routing: serialized.routing,
		configPath: serialized.configPath,
	};
}

/** Extract serializable batch state for sync back to the main thread. */
export function serializeBatchForWorker(state: MissionBatchRuntimeState): SerializedBatchState {
	return {
		phase: state.phase,
		batchId: state.batchId,
		baseBranch: state.baseBranch,
		orchBranch: state.orchBranch,
		mode: state.mode,
		currentWaveIndex: state.currentWaveIndex,
		totalWaves: state.totalWaves,
		totalTasks: state.totalTasks,
		succeededTasks: state.succeededTasks,
		failedTasks: state.failedTasks,
		skippedTasks: state.skippedTasks,
		blockedTasks: state.blockedTasks,
		startedAt: state.startedAt,
		endedAt: state.endedAt,
		errors: [...state.errors],
		currentLanes: state.currentLanes,
	};
}

/**
 * Apply serialized batch state from the worker to the main-thread state.
 *
 * Updates only fields the worker tracks — preserves main-thread-only
 * fields like `pauseSignal`, `dependencyGraph`, `resilience`, etc.
 */
export function applySerializedState(batchState: MissionBatchRuntimeState, serialized: SerializedBatchState): void {
	batchState.phase = serialized.phase;
	batchState.batchId = serialized.batchId;
	batchState.baseBranch = serialized.baseBranch;
	batchState.orchBranch = serialized.orchBranch;
	batchState.mode = serialized.mode as MissionBatchRuntimeState["mode"];
	batchState.currentWaveIndex = serialized.currentWaveIndex;
	batchState.totalWaves = serialized.totalWaves;
	batchState.totalTasks = serialized.totalTasks;
	batchState.succeededTasks = serialized.succeededTasks;
	batchState.failedTasks = serialized.failedTasks;
	batchState.skippedTasks = serialized.skippedTasks;
	batchState.blockedTasks = serialized.blockedTasks;
	batchState.startedAt = serialized.startedAt;
	batchState.endedAt = serialized.endedAt;
	batchState.errors = [...serialized.errors];
	batchState.currentLanes = serialized.currentLanes ?? [];
}

// ── Engine child entry (deferred) ────────────────────────────────────
// The forked-process entry from taskplane (`TASKPLANE_ENGINE_FORK=1`) is
// intentionally NOT ported here. A Bun `Worker`-based runtime will live
// in `engine-worker-entry.ts` and will reuse the types + helpers above.
// Wiring lands with the engine + resume module port.
