/**
 * MissionControl engine type surface.
 *
 * Trimmed from taskplane's 4272-LOC `types.ts` to only the shapes the
 * MVP runtime + persistence need. Extra types will land alongside the
 * full supervisor/merge/worker modules.
 *
 * `BatchState`, `LaneStatus`, `WaveAssignment`, `TaskOutcome`, `TaskStatus`,
 * `TaskTelemetry`, `BatchPhase` live in `../types.ts` so the dashboard API
 * shares them. Re-exported here for engine-local clarity.
 */

export type {
	BatchPhase,
	BatchState,
	LaneStatus,
	TaskOutcome,
	TaskStatus,
	TaskTelemetry,
	WaveAssignment,
} from "../types";

export type Autonomy = "low" | "medium" | "high" | "auto";

export interface MissionControlConfig {
	laneCount: number;
	waveSize: number;
	model: string;
	autonomy: Autonomy;
	qualityGates: {
		typecheck: boolean;
		lint: boolean;
		test: boolean;
	};
}

export const DEFAULT_MISSIONCONTROL_CONFIG: MissionControlConfig = {
	laneCount: 2,
	waveSize: 4,
	model: "claude-sonnet-4-6",
	autonomy: "medium",
	qualityGates: { typecheck: true, lint: true, test: true },
};

export interface PromoteBatchOptions {
	taskIds?: string[];
	laneCount?: number;
	waveSize?: number;
	model?: string;
}

export interface EngineStatus {
	active: boolean;
	batchId?: string;
	phase?: import("../types").BatchPhase;
	laneCount?: number;
	tasksTotal?: number;
	tasksComplete?: number;
	tasksFailed?: number;
}

// ── Workspace Mode Types ─────────────────────────────────────────────
//
// Ported from taskplane/types.ts lines 3326–3593. Runtime shapes consumed
// by `workspace.ts`. Filenames renamed: `taskplane-*` → `mission-*`.
// `.pi/` path fragments are replaced by `projectDir(cwd)` from adapter
// in the workspace module itself — these type helpers stay path-free.

export type WorkspaceMode = "repo" | "workspace";

export interface WorkspaceRepoConfig {
	id: string;
	path: string;
	defaultBranch?: string;
}

export interface WorkspaceRoutingConfig {
	tasksRoot: string;
	defaultRepo: string;
	taskPacketRepo: string;
	strict?: boolean;
}

export interface WorkspaceConfig {
	mode: WorkspaceMode;
	repos: Map<string, WorkspaceRepoConfig>;
	routing: WorkspaceRoutingConfig;
	configPath: string;
}

export type WorkspaceConfigErrorCode =
	| "WORKSPACE_FILE_READ_ERROR"
	| "WORKSPACE_FILE_PARSE_ERROR"
	| "WORKSPACE_MISSING_REPOS"
	| "WORKSPACE_REPO_PATH_MISSING"
	| "WORKSPACE_REPO_PATH_NOT_FOUND"
	| "WORKSPACE_REPO_NOT_GIT"
	| "WORKSPACE_MISSING_TASKS_ROOT"
	| "WORKSPACE_TASKS_ROOT_NOT_FOUND"
	| "WORKSPACE_MISSING_DEFAULT_REPO"
	| "WORKSPACE_DEFAULT_REPO_NOT_FOUND"
	| "WORKSPACE_TASK_PACKET_REPO_NOT_FOUND"
	| "WORKSPACE_TASKS_ROOT_OUTSIDE_PACKET_REPO"
	| "WORKSPACE_TASK_AREA_OUTSIDE_TASKS_ROOT"
	| "WORKSPACE_SETUP_REQUIRED"
	| "WORKSPACE_DUPLICATE_REPO_PATH"
	| "WORKSPACE_SCHEMA_INVALID";

export class WorkspaceConfigError extends Error {
	code: WorkspaceConfigErrorCode;
	repoId?: string;
	relatedPath?: string;

	constructor(code: WorkspaceConfigErrorCode, message: string, repoId?: string, relatedPath?: string) {
		super(message);
		this.name = "WorkspaceConfigError";
		this.code = code;
		this.repoId = repoId;
		this.relatedPath = relatedPath;
	}
}

export interface PointerResolution {
	used: boolean;
	configRoot: string;
	agentRoot: string;
	warning?: string;
}

/**
 * Runtime backend discriminator for mission batch execution.
 *
 * - `"v2"`: current RPC-driven agent host (default).
 * - `"legacy"`: preserved for backwards-compat resume of pre-V2 persisted state.
 */
export type RuntimeBackend = "legacy" | "v2";

/**
 * Result of the TP-105 scope guard evaluation in {@link selectRuntimeBackend}.
 *
 * Consumers inspect the auxiliary flags (single-task, repo-mode,
 * direct-PROMPT.md target) to gate optional Runtime V2 features even though
 * `backend` itself is always `"v2"` under the post-TP-108/TP-109 regime.
 */
export interface RuntimeBackendSelection {
	backend: RuntimeBackend;
	isSingleTask: boolean;
	isRepoMode: boolean;
	isDirectPromptTarget: boolean;
}

/** Canonical on-disk filenames (renamed from taskplane-*). */
export const POINTER_FILENAME = "mission-pointer.json";
export const WORKSPACE_CONFIG_FILENAME = "mission-workspace.yaml";

// ── Runtime V2 Types (ported from taskplane types.ts) ────────────────
//
// Scope: the subset required by `formatting.ts` + downstream engine
// modules. `Orch*` names rename to `Mission*`; `WaveAssignment` keeps
// the existing simpler dashboard shape (see `../types`) so this file
// introduces `RuntimeWaveAssignment` to avoid collision. Deep optional
// shapes (merge/resilience/segment records) stay as `unknown` stubs
// until the supervisor/merge port needs them.

import type { TaskExitDiagnostic } from "./diagnostics";
import type { ParsedTask } from "./discovery";

// ── Segment types ────────────────────────────────────────────────────

export type SegmentId = `${string}::${string}` | `${string}::${string}::${number}`;
export type SegmentEdgeProvenance = "explicit" | "inferred";

/** Build a stable segment ID from task + repo identity (`<taskId>::<repoId>[::N]`). */
export function buildSegmentId(taskId: string, repoId: string, sequence?: number): SegmentId {
	if (typeof sequence === "number" && Number.isFinite(sequence) && sequence >= 2) {
		return `${taskId}::${repoId}::${Math.floor(sequence)}` as SegmentId;
	}
	return `${taskId}::${repoId}` as SegmentId;
}

/**
 * Read `repoId` from structured segment metadata.
 *
 * `SegmentId` is opaque — never parse it by string-splitting.
 */
export function parseSegmentIdRepo(segment: { repoId: string }): string {
	return segment.repoId;
}

/** Build a dynamic segment expansion request ID (`exp-{timestamp}-{random5}`). */
export function buildExpansionRequestId(timestamp = Date.now()): string {
	const ts = Number.isFinite(timestamp) ? Math.floor(timestamp) : Date.now();
	const base = Math.random()
		.toString(36)
		.slice(2)
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
	const random5 = `${base}00000`.slice(0, 5);
	return `exp-${ts}-${random5}`;
}

export interface PromptSegmentDagEdge {
	fromRepoId: string;
	toRepoId: string;
}

export interface PromptSegmentDagMetadata {
	repoIds: string[];
	edges: PromptSegmentDagEdge[];
}

export interface SegmentCheckboxGroup {
	repoId: string;
	checkboxes: string[];
}

export interface StepSegmentMapping {
	stepNumber: number;
	stepName: string;
	segments: SegmentCheckboxGroup[];
}

export interface TaskSegmentNode {
	segmentId: SegmentId;
	taskId: string;
	repoId: string;
	order: number;
}

export interface TaskSegmentEdge {
	fromSegmentId: SegmentId;
	toSegmentId: SegmentId;
	provenance: SegmentEdgeProvenance;
	reason?: string;
}

export interface TaskSegmentPlan {
	taskId: string;
	segments: TaskSegmentNode[];
	edges: TaskSegmentEdge[];
	mode: "explicit-dag" | "inferred-sequential" | "repo-singleton";
}

export type TaskSegmentPlanMap = Map<string, TaskSegmentPlan>;

// ── Segment expansion (dynamic runtime expansion) ──────────────────────

/**
 * Edge added to the segment plan as part of a dynamic-expansion request.
 * Both endpoints refer to repo IDs in `SegmentExpansionRequest.requestedRepoIds`.
 */
export interface SegmentExpansionEdge {
	from: string;
	to: string;
}

/**
 * Lifecycle status of an individual segment within a task's ordered segment
 * plan — tracked by `SegmentFrontierTaskState.statusBySegmentId`.
 */
export type SegmentLifecycleStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

/**
 * Runtime state of one task's segment-frontier execution: which segments have
 * run (and with what outcome), which segment is next to execute, and the
 * mutable dependency graph (mutated when dynamic expansion requests succeed).
 */
export interface SegmentFrontierTaskState {
	taskId: string;
	orderedSegments: TaskSegmentNode[];
	nextSegmentIndex: number;
	statusBySegmentId: Map<string, SegmentLifecycleStatus>;
	dependsOnBySegmentId: Map<string, string[]>;
	terminalStatus: "pending" | "succeeded" | "failed" | "skipped";
}

/**
 * Result of `buildSegmentFrontierWaves()`. Contains both the expanded segment
 * rounds and task-level wave metadata for correct display (TP-166).
 */
export interface SegmentFrontierResult {
	/** Expanded segment rounds (execution-level). */
	waves: string[][];
	/** Per-task segment frontier state keyed by taskId. */
	taskStateById: Map<string, SegmentFrontierTaskState>;
	/** Number of original dependency-driven task-level waves. */
	taskLevelWaveCount: number;
	/**
	 * Maps each segment round index (0-based) to its parent task-level wave
	 * index (0-based). Must be kept in lockstep when continuation rounds are
	 * dynamically inserted via `scheduleContinuationSegmentRound`.
	 */
	roundToTaskWave: number[];
}

/**
 * One pending expansion request file read from a worker's outbox, paired with
 * its source path so validation/acknowledgement code can rename it in place.
 */
export interface PendingSegmentExpansionRequest {
	filePath: string;
	request: SegmentExpansionRequest;
}

/**
 * File IPC payload for worker-initiated dynamic segment expansion requests.
 *
 * Written to: `.omp/mailbox/{batchId}/{agentId}/outbox/segment-expansion-{requestId}.json`
 */
export interface SegmentExpansionRequest {
	/** Unique request ID: `exp-{timestamp}-{random5}` */
	requestId: string;
	/** Task ID making the expansion request. */
	taskId: string;
	/** Segment active when the request was emitted. */
	fromSegmentId: SegmentId;
	/** Repo IDs the worker is requesting the engine to add. */
	requestedRepoIds: string[];
	/** Human rationale from the worker. */
	rationale: string;
	/** Placement directive for inserting new segments. */
	placement: "after-current" | "end";
	/** Optional inter-request ordering edges. */
	edges: SegmentExpansionEdge[];
	/** Epoch milliseconds when the request was emitted. */
	timestamp: number;
}

// ── Task assignment types ────────────────────────────────────────────

export interface TaskArea {
	path: string;
	prefix: string;
	context: string;
	repoId?: string;
}

/** Taskplane runtime wave assignment. Differs from dashboard `WaveAssignment`. */
export interface RuntimeWaveAssignment {
	waveNumber: number;
	tasks: LaneAssignment[];
}

export interface LaneAssignment {
	taskId: string;
	lane: number;
	task: ParsedTask;
	repoId?: string;
}

// ── Discovery + dependency types ─────────────────────────────────────

export interface DiscoveryError {
	code:
		| "PARSE_MISSING_ID"
		| "PARSE_MALFORMED"
		| "DUPLICATE_ID"
		| "UNKNOWN_ARG"
		| "SCAN_ERROR"
		| "DEP_UNRESOLVED"
		| "DEP_PENDING"
		| "DEP_AMBIGUOUS"
		| "DEP_SOURCE_FALLBACK"
		| "TASK_REPO_UNRESOLVED"
		| "TASK_REPO_UNKNOWN"
		| "TASK_ROUTING_STRICT"
		| "SEGMENT_DAG_INVALID"
		| "SEGMENT_REPO_UNKNOWN"
		| "SEGMENT_STEP_DUPLICATE_REPO"
		| "SEGMENT_STEP_EMPTY"
		| "SEGMENT_STEP_REPO_INVALID";
	message: string;
	taskPath?: string;
	taskId?: string;
}

export const FATAL_DISCOVERY_CODES: ReadonlyArray<DiscoveryError["code"]> = [
	"DUPLICATE_ID",
	"DEP_UNRESOLVED",
	"DEP_PENDING",
	"DEP_AMBIGUOUS",
	"PARSE_MISSING_ID",
	"TASK_REPO_UNRESOLVED",
	"TASK_REPO_UNKNOWN",
	"TASK_ROUTING_STRICT",
	"SEGMENT_DAG_INVALID",
	"SEGMENT_REPO_UNKNOWN",
	"SEGMENT_STEP_DUPLICATE_REPO",
] as const;

/**
 * Result of the full discovery pipeline (ported from taskplane types.ts:623).
 * Used by formatDiscoveryResults + runDiscovery (runDiscovery not yet ported).
 */
export interface DiscoveryResult {
	pending: Map<string, ParsedTask>;
	completed: Set<string>;
	errors: DiscoveryError[];
}

export interface DependencyGraph {
	dependencies: Map<string, string[]>;
	dependents: Map<string, string[]>;
	nodes: Set<string>;
}

export interface GraphValidationResult {
	valid: boolean;
	errors: DiscoveryError[];
}

export interface WaveComputationResult {
	waves: RuntimeWaveAssignment[];
	errors: DiscoveryError[];
	segmentPlans?: TaskSegmentPlanMap;
}

// ── Allocation types ─────────────────────────────────────────────────

export type AllocationErrorCode =
	| "ALLOC_INVALID_CONFIG"
	| "ALLOC_EMPTY_WAVE"
	| "ALLOC_WORKTREE_FAILED"
	| "ALLOC_TASK_NOT_FOUND";

export class AllocationError extends Error {
	code: AllocationErrorCode;
	details?: string;

	constructor(code: AllocationErrorCode, message: string, details?: string) {
		super(message);
		this.name = "AllocationError";
		this.code = code;
		this.details = details;
	}
}

export interface AllocatedTask {
	taskId: string;
	order: number;
	task: ParsedTask;
	estimatedMinutes: number;
}

export interface AllocatedLane {
	laneNumber: number;
	laneId: string;
	laneSessionId: string;
	worktreePath: string;
	branch: string;
	tasks: AllocatedTask[];
	strategy: "affinity-first" | "round-robin" | "load-balanced";
	estimatedLoad: number;
	estimatedMinutes: number;
	repoId?: string;
}

// ── Execution types ──────────────────────────────────────────────────

export type LaneTaskStatus = "pending" | "running" | "succeeded" | "failed" | "stalled" | "skipped";

export interface LaneTaskOutcomeTelemetry {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	toolCalls: number;
	durationMs: number;
}

export interface LaneTaskOutcome {
	taskId: string;
	status: LaneTaskStatus;
	segmentId?: string | null;
	startTime: number | null;
	endTime: number | null;
	exitReason: string;
	sessionName: string;
	doneFileFound: boolean;
	laneNumber?: number;
	telemetry?: LaneTaskOutcomeTelemetry;
	partialProgressCommits?: number;
	partialProgressBranch?: string;
	exitDiagnostic?: TaskExitDiagnostic;
}

export interface LaneExecutionResult {
	laneNumber: number;
	laneId: string;
	tasks: LaneTaskOutcome[];
	overallStatus: "succeeded" | "failed" | "partial";
	startTime: number;
	endTime: number;
}

// ── Monitoring types ─────────────────────────────────────────────────

export interface TaskMonitorSnapshot {
	taskId: string;
	status: "pending" | "running" | "succeeded" | "failed" | "stalled" | "skipped" | "unknown";
	currentStepName: string | null;
	currentStepNumber: number | null;
	totalSteps: number;
	totalChecked: number;
	totalItems: number;
	sessionAlive: boolean;
	doneFileFound: boolean;
	stallReason: string | null;
	lastHeartbeat: number | null;
	observedAt: number;
	parseError: string | null;
	iteration: number;
	reviewCounter: number;
}

export interface LaneMonitorSnapshot {
	laneId: string;
	laneNumber: number;
	sessionName: string;
	sessionAlive: boolean;
	currentTaskId: string | null;
	currentTaskSnapshot: TaskMonitorSnapshot | null;
	completedTasks: string[];
	failedTasks: string[];
	remainingTasks: string[];
}

export interface MonitorState {
	lanes: LaneMonitorSnapshot[];
	tasksDone: number;
	tasksFailed: number;
	tasksTotal: number;
	waveNumber: number;
	pollCount: number;
	lastPollTime: number;
	allTerminal: boolean;
}

/**
 * Per-task tracker used by `resolveTaskMonitorState` to detect stalls.
 *
 * Monitor polling updates `lastMtime` whenever the task's STATUS file mtime
 * advances; `stallTimerStart` arms on a quiet window and fires when the
 * configured stall timeout elapses.
 */
export interface MtimeTracker {
	taskId: string;
	firstObservedAt: number;
	statusFileSeenOnce: boolean;
	lastMtime: number | null;
	stallTimerStart: number | null;
}

// ── Wave execution + batch runtime ───────────────────────────────────

export interface WaveExecutionResult {
	waveIndex: number;
	startedAt: number;
	endedAt: number;
	laneResults: LaneExecutionResult[];
	policyApplied: "skip-dependents" | "stop-wave" | "stop-all";
	stoppedEarly: boolean;
	failedTaskIds: string[];
	skippedTaskIds: string[];
	succeededTaskIds: string[];
	blockedTaskIds: string[];
	laneCount: number;
	overallStatus: "succeeded" | "failed" | "partial" | "aborted";
	finalMonitorState: MonitorState | null;
	allocatedLanes: AllocatedLane[];
	allocationError?: {
		code: AllocationErrorCode;
		message: string;
		details?: string;
	} | null;
}

/** Mission batch runtime phase (rename of `OrchBatchPhase`). */
export type MissionBatchPhase =
	| "idle"
	| "launching"
	| "planning"
	| "executing"
	| "merging"
	| "paused"
	| "stopped"
	| "completed"
	| "failed";

// ── Persisted diagnostics (v3, TP-030) ───────────────────────────────

/**
 * Per-task exit summary stored in batch-state.json diagnostics section.
 *
 * Canonical structured exit data emitted by the engine when a task
 * reaches terminal state. Classification drives dashboard color-coding
 * and aggregate reporting. `cost` and `durationSec` feed the batch
 * cost/time totals.
 */
export interface PersistedTaskExitSummary {
	classification: import("./diagnostics").ExitClassification;
	cost: number;
	durationSec: number;
	retries?: number;
}

/**
 * Batch-level diagnostics section for batch-state.json.
 *
 * Aggregates per-task exit summaries + batch-wide cost for dashboard
 * display and post-mortem analysis.
 */
export interface BatchDiagnostics {
	taskExits: Record<string, PersistedTaskExitSummary>;
	batchCost: number;
}

/** Default BatchDiagnostics with empty/zero initial values. */
export function defaultBatchDiagnostics(): BatchDiagnostics {
	return { taskExits: {}, batchCost: 0 };
}

// ── Persisted resilience (v3, TP-030) ────────────────────────────────

/**
 * Record of a single automated repair action taken by the orchestrator.
 *
 * Repair actions are deterministic strategies applied when known failure
 * classes are detected (e.g., stale worktree cleanup, lock file removal).
 * Each entry is immutable once written — history is append-only.
 */
export interface PersistedRepairRecord {
	/** Unique repair ID (e.g., "r-20260319-001"). */
	id: string;
	/** Strategy name that was applied (e.g., "stale-worktree-cleanup"). */
	strategy: string;
	/** Outcome of the repair. */
	status: "succeeded" | "failed" | "skipped";
	/** Repo ID targeted by the repair (undefined in repo mode). */
	repoId?: string;
	/** Epoch ms when the repair started. */
	startedAt: number;
	/** Epoch ms when the repair ended. */
	endedAt: number;
}

/**
 * Resilience state section for mission-batch.json.
 *
 * Tracks retry/repair metadata so the engine can make informed decisions
 * about retries, force-resume, and failure escalation. Migration from
 * v1/v2 fills conservative defaults (no retries, no repairs, no forced
 * resume).
 */
export interface ResilienceState {
	/** Whether the last resume was a --force resume. */
	resumeForced: boolean;
	/**
	 * Retry counts keyed by scope string.
	 * Scope format: `{taskId}:w{waveIndex}:l{laneNumber}`.
	 */
	retryCountByScope: Record<string, number>;
	/** Exit classification of the most recent failure (null if none). */
	lastFailureClass: import("./diagnostics").ExitClassification | null;
	/** Chronological history of automated repair actions. Append-only. */
	repairHistory: PersistedRepairRecord[];
}

/** Default ResilienceState with conservative initial values. */
export function defaultResilienceState(): ResilienceState {
	return {
		resumeForced: false,
		retryCountByScope: {},
		lastFailureClass: null,
		repairHistory: [],
	};
}

// ── Schema version & state-file errors ───────────────────────────────

/**
 * Current schema version for mission-batch.json.
 *
 * Version history:
 *   v1 — Original schema. No repo-aware fields on task records.
 *   v2 — Repo-aware records. Adds `repoId`/`resolvedRepoId` to task
 *         records, formalizes `repoId` on lane records, adds top-level
 *         `mode` ("repo" | "workspace").
 *   v3 — Resilience & diagnostics. Adds `resilience` + `diagnostics`
 *         sections; task records gain optional `exitDiagnostic`.
 *   v4 — Segment execution. Adds optional `segments` array and
 *         per-task `packetRepoId`, `packetTaskPath`, `segmentIds`,
 *         `activeSegmentId` fields.
 *
 * Compatibility policy:
 *   - load accepts v1/v2/v3/v4 files; v1→v2→v3→v4 auto-upconverted
 *     in memory (chained). On-disk file is NOT rewritten during load.
 *   - save always writes v4.
 *   - Schema versions > 4 are rejected with STATE_SCHEMA_INVALID.
 */
export const BATCH_STATE_SCHEMA_VERSION = 4;

/**
 * Error codes for state persistence operations.
 *
 * - STATE_FILE_IO_ERROR: Filesystem read/write/rename failure.
 * - STATE_FILE_PARSE_ERROR: File exists but contains invalid JSON.
 * - STATE_SCHEMA_INVALID: JSON is valid but fails schema validation.
 */
export type StateFileErrorCode = "STATE_FILE_IO_ERROR" | "STATE_FILE_PARSE_ERROR" | "STATE_SCHEMA_INVALID";

/** Typed error class for state file operations. */
export class StateFileError extends Error {
	code: StateFileErrorCode;

	constructor(code: StateFileErrorCode, message: string) {
		super(message);
		this.name = "StateFileError";
		this.code = code;
	}
}

/**
 * Persisted record of a single task's execution state.
 *
 * Contains everything `mission-resume` needs to reconstruct task
 * progress without re-running discovery. `repoId`/`resolvedRepoId`
 * carry workspace-mode repo attribution; `exitDiagnostic` is the
 * v3-canonical structured exit data (preferred over `exitReason`).
 */
export interface PersistedTaskRecord {
	taskId: string;
	laneNumber: number;
	sessionName: string;
	status: LaneTaskStatus;
	taskFolder: string;
	startedAt: number | null;
	endedAt: number | null;
	doneFileFound: boolean;
	exitReason: string;
	repoId?: string;
	resolvedRepoId?: string;
	partialProgressCommits?: number;
	partialProgressBranch?: string;
	exitDiagnostic?: TaskExitDiagnostic;
	packetRepoId?: string;
	packetTaskPath?: string;
	segmentIds?: string[];
	activeSegmentId?: string | null;
}

/**
 * Mission batch runtime state (rename of `OrchBatchRuntimeState`).
 *
 * Deep optional fields use `unknown` stubs until the full supervisor/merge
 * port lands. Shape is otherwise byte-compatible with taskplane.
 */
export interface MissionBatchRuntimeState {
	phase: MissionBatchPhase;
	batchId: string;
	baseBranch: string;
	orchBranch: string;
	mode: WorkspaceMode;
	pauseSignal: { paused: boolean };
	waveResults: WaveExecutionResult[];
	currentWaveIndex: number;
	totalWaves: number;
	taskLevelWaveCount?: number;
	roundToTaskWave?: number[];
	blockedTaskIds: Set<string>;
	startedAt: number;
	endedAt: number | null;
	totalTasks: number;
	succeededTasks: number;
	failedTasks: number;
	skippedTasks: number;
	blockedTasks: number;
	errors: string[];
	currentLanes: AllocatedLane[];
	dependencyGraph: DependencyGraph | null;
	/** Merge wave results — stubbed until merge module is ported. */
	mergeResults: unknown[];
	/** v3 resilience state (retry counters, force-resume, repair history). */
	resilience?: ResilienceState;
	/** v3 diagnostics (per-task exits + batch cost). */
	diagnostics?: BatchDiagnostics;
	/** v4 segment records. */
	segments?: PersistedSegmentRecord[];
	_extraFields?: Record<string, unknown>;
}

export function generateBatchId(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function freshMissionBatchState(): MissionBatchRuntimeState {
	return {
		phase: "idle",
		batchId: "",
		baseBranch: "",
		orchBranch: "",
		mode: "repo",
		pauseSignal: { paused: false },
		waveResults: [],
		currentWaveIndex: -1,
		totalWaves: 0,
		blockedTaskIds: new Set(),
		startedAt: 0,
		endedAt: null,
		totalTasks: 0,
		succeededTasks: 0,
		failedTasks: 0,
		skippedTasks: 0,
		blockedTasks: 0,
		errors: [],
		currentLanes: [],
		dependencyGraph: null,
		mergeResults: [],
	};
}

// ── Dashboard view-model types ───────────────────────────────────────

export interface MissionSummaryCounts {
	completed: number;
	running: number;
	queued: number;
	failed: number;
	blocked: number;
	stalled: number;
	total: number;
}

export interface MissionLaneCardData {
	laneNumber: number;
	laneId: string;
	sessionName: string;
	sessionAlive: boolean;
	currentTaskId: string | null;
	currentStepName: string | null;
	totalChecked: number;
	totalItems: number;
	completedTasks: number;
	totalLaneTasks: number;
	status: "idle" | "running" | "succeeded" | "failed" | "stalled";
	stallReason: string | null;
}

export interface MissionDashboardViewModel {
	phase: MissionBatchPhase;
	batchId: string;
	orchBranch: string;
	waveProgress: string;
	elapsed: string;
	summary: MissionSummaryCounts;
	laneCards: MissionLaneCardData[];
	attachHint: string;
	errors: string[];
	failurePolicy: string | null;
}

// ── Duration model ───────────────────────────────────────────────────

export const SIZE_DURATION_MINUTES: Record<string, number> = {
	S: 30,
	M: 60,
	L: 120,
};

export const DURATION_BASE_MINUTES = 30;

export function getTaskDurationMinutes(size: string, sizeWeights: Record<string, number>): number {
	if (SIZE_DURATION_MINUTES[size] !== undefined) {
		return SIZE_DURATION_MINUTES[size];
	}
	const weight = sizeWeights[size] || sizeWeights.M || 2;
	return weight * DURATION_BASE_MINUTES;
}

// ─────────────────────────────────────────────────────────────────────
// Runtime V2 Agent Types (ported from taskplane TP-102/104/115/164/172)
//
// File-backed process registry for agent lifecycle. Replaces legacy
// terminal-session discovery with explicit manifests, normalized events,
// and lane/merge snapshots. All paths rebase from `.pi/runtime/` to
// `.omp/runtime/` (see runtimeRoot helpers below).
// ─────────────────────────────────────────────────────────────────────

/** Canonical agent roles in Runtime V2. @since TP-102 */
export type RuntimeAgentRole = "worker" | "reviewer" | "merger" | "lane-runner";

/** Agent lifecycle states. @since TP-102 */
export type RuntimeAgentStatus = "spawning" | "running" | "wrapping_up" | "exited" | "crashed" | "timed_out" | "killed";

/** Set of terminal agent statuses. @since TP-102 */
export const TERMINAL_AGENT_STATUSES: ReadonlySet<RuntimeAgentStatus> = new Set([
	"exited",
	"crashed",
	"timed_out",
	"killed",
]);

/** Stable agent identity for Runtime V2. @since TP-102 */
export type RuntimeAgentId = string;

/** Explicit packet-path authority for a task execution. @since TP-102 */
export interface PacketPaths {
	promptPath: string;
	statusPath: string;
	donePath: string;
	reviewsDir: string;
	taskFolder: string;
}

/** Pure helper to build PacketPaths from a task folder. @since TP-102 */
export function resolvePacketPaths(taskFolder: string): PacketPaths {
	return {
		promptPath: `${taskFolder}/PROMPT.md`,
		statusPath: `${taskFolder}/STATUS.md`,
		donePath: `${taskFolder}/.DONE`,
		reviewsDir: `${taskFolder}/.reviews`,
		taskFolder,
	};
}

/** A single execution unit in Runtime V2 (whole task or one segment). @since TP-102 */
export interface ExecutionUnit {
	id: string;
	taskId: string;
	segmentId: string | null;
	executionRepoId: string;
	packetHomeRepoId: string;
	worktreePath: string;
	packet: PacketPaths;
	task: ParsedTask;
}

/** Per-agent process manifest. @since TP-102 */
export interface RuntimeAgentManifest {
	batchId: string;
	agentId: RuntimeAgentId;
	role: RuntimeAgentRole;
	laneNumber: number | null;
	taskId: string | null;
	repoId: string;
	pid: number;
	parentPid: number;
	startedAt: number;
	status: RuntimeAgentStatus;
	cwd: string;
	packet: PacketPaths | null;
}

/** Batch-level registry snapshot. @since TP-102 */
export interface RuntimeRegistry {
	batchId: string;
	updatedAt: number;
	agents: Record<RuntimeAgentId, RuntimeAgentManifest>;
}

/** Lane execution snapshot from the lane-runner. @since TP-102 */
export interface RuntimeLaneSnapshot {
	batchId: string;
	laneNumber: number;
	laneId: string;
	repoId: string;
	taskId: string | null;
	segmentId: string | null;
	status: "idle" | "running" | "complete" | "failed";
	worker: RuntimeAgentTelemetrySnapshot | null;
	reviewer: RuntimeAgentTelemetrySnapshot | null;
	progress: RuntimeTaskProgress | null;
	updatedAt: number;
}

/** Telemetry snapshot for a single agent within a lane. @since TP-102 */
export interface RuntimeAgentTelemetrySnapshot {
	agentId: RuntimeAgentId;
	status: RuntimeAgentStatus;
	elapsedMs: number;
	toolCalls: number;
	contextPct: number;
	costUsd: number;
	lastTool: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

/** Task progress derived from STATUS.md parsing. @since TP-102 */
export interface RuntimeTaskProgress {
	currentStep: string;
	checked: number;
	total: number;
	iteration: number;
	reviews: number;
}

/** Normalized agent event types. @since TP-102 */
export type RuntimeAgentEventType =
	| "agent_started"
	| "agent_exited"
	| "agent_killed"
	| "agent_crashed"
	| "agent_timeout"
	| "prompt_sent"
	| "assistant_message"
	| "tool_call"
	| "tool_result"
	| "usage_delta"
	| "context_usage"
	| "retry_started"
	| "retry_finished"
	| "compaction_started"
	| "compaction_finished"
	| "message_delivered"
	| "reply_sent"
	| "escalation_sent"
	| "review_requested"
	| "review_completed"
	| "review_failed"
	| "exit_intercepted";

/** Normalized event emitted by an agent host. @since TP-102 */
export interface RuntimeAgentEvent {
	batchId: string;
	agentId: RuntimeAgentId;
	role: RuntimeAgentRole;
	laneNumber: number | null;
	taskId: string | null;
	repoId: string;
	ts: number;
	type: RuntimeAgentEventType;
	payload: Record<string, unknown>;
}

/** Telemetry snapshot for a merge agent. @since TP-164 */
export interface RuntimeMergeSnapshot {
	batchId: string;
	mergeNumber: number;
	sessionName: string;
	waveIndex: number;
	status: "running" | "complete" | "failed";
	agent: RuntimeAgentTelemetrySnapshot | null;
	updatedAt: number;
}

// ── Runtime V2 Path Helpers ──────────────────────────────────────────
// Paths rebase `.pi/runtime/` → `.omp/runtime/` for oh-my-pi.

export function runtimeRoot(stateRoot: string, batchId: string): string {
	return `${stateRoot}/.omp/runtime/${batchId}`;
}

export function runtimeAgentDir(stateRoot: string, batchId: string, agentId: RuntimeAgentId): string {
	return `${stateRoot}/.omp/runtime/${batchId}/agents/${agentId}`;
}

export function runtimeManifestPath(stateRoot: string, batchId: string, agentId: RuntimeAgentId): string {
	return `${runtimeAgentDir(stateRoot, batchId, agentId)}/manifest.json`;
}

export function runtimeAgentEventsPath(stateRoot: string, batchId: string, agentId: RuntimeAgentId): string {
	return `${runtimeAgentDir(stateRoot, batchId, agentId)}/events.jsonl`;
}

export function runtimeLaneSnapshotPath(stateRoot: string, batchId: string, laneNumber: number): string {
	return `${stateRoot}/.omp/runtime/${batchId}/lanes/lane-${laneNumber}.json`;
}

export function runtimeMergeSnapshotPath(stateRoot: string, batchId: string, mergeNumber: number): string {
	return `${stateRoot}/.omp/runtime/${batchId}/lanes/merge-${mergeNumber}.json`;
}

export function runtimeRegistryPath(stateRoot: string, batchId: string): string {
	return `${stateRoot}/.omp/runtime/${batchId}/registry.json`;
}

/** Build a canonical RuntimeAgentId from components. @since TP-102 */
export function buildRuntimeAgentId(
	prefix: string,
	laneNumber: number | null,
	role: RuntimeAgentRole,
	mergeIndex?: number,
): RuntimeAgentId {
	if (role === "merger" && mergeIndex != null) {
		return `${prefix}-merge-${mergeIndex}`;
	}
	if (role === "lane-runner" && laneNumber != null) {
		return `${prefix}-lane-${laneNumber}`;
	}
	if (laneNumber != null) {
		return `${prefix}-lane-${laneNumber}-${role}`;
	}
	return `${prefix}-${role}`;
}

/** Validate a RuntimeAgentManifest. Returns error strings (empty = valid). @since TP-102 */
export function validateAgentManifest(manifest: unknown): string[] {
	const errors: string[] = [];
	if (!manifest || typeof manifest !== "object") {
		return ["manifest must be a non-null object"];
	}
	const m = manifest as Record<string, unknown>;

	if (typeof m.batchId !== "string" || !m.batchId) errors.push("batchId must be a non-empty string");
	if (typeof m.agentId !== "string" || !m.agentId) errors.push("agentId must be a non-empty string");
	if (typeof m.role !== "string") {
		errors.push("role must be a string");
	} else {
		const validRoles: ReadonlySet<string> = new Set(["worker", "reviewer", "merger", "lane-runner"]);
		if (!validRoles.has(m.role)) errors.push(`role must be one of: ${[...validRoles].join(", ")}`);
	}
	if (typeof m.pid !== "number" || !Number.isFinite(m.pid) || m.pid <= 0) {
		errors.push("pid must be a positive finite number");
	}
	if (typeof m.parentPid !== "number" || !Number.isFinite(m.parentPid) || m.parentPid <= 0) {
		errors.push("parentPid must be a positive finite number");
	}
	if (typeof m.startedAt !== "number" || !Number.isFinite(m.startedAt)) {
		errors.push("startedAt must be a finite number");
	}
	if (typeof m.status !== "string") {
		errors.push("status must be a string");
	} else {
		const validStatuses: ReadonlySet<string> = new Set([
			"spawning",
			"running",
			"wrapping_up",
			"exited",
			"crashed",
			"timed_out",
			"killed",
		]);
		if (!validStatuses.has(m.status)) {
			errors.push(`status must be one of: ${[...validStatuses].join(", ")}`);
		}
	}
	if (typeof m.cwd !== "string" || !m.cwd) errors.push("cwd must be a non-empty string");
	if (typeof m.repoId !== "string") errors.push("repoId must be a string");

	return errors;
}

/** Validate a PacketPaths object. @since TP-102 */
export function validatePacketPaths(packet: unknown): string[] {
	const errors: string[] = [];
	if (!packet || typeof packet !== "object") {
		return ["packet must be a non-null object"];
	}
	const p = packet as Record<string, unknown>;

	for (const field of ["promptPath", "statusPath", "donePath", "reviewsDir", "taskFolder"] as const) {
		if (typeof p[field] !== "string" || !p[field]) {
			errors.push(`${field} must be a non-empty string`);
		}
	}

	return errors;
}

// ─────────────────────────────────────────────────────────────────────
// Persisted Lane Record + Batch State (minimal shapes)
//
// Full taskplane `PersistedBatchState` has 30+ fields (resilience,
// diagnostics, segments, wavePlan, mergeResults, etc.). We only port
// the shape abort/resume needs right now — downstream modules will
// extend this as they land.
// ─────────────────────────────────────────────────────────────────────

/** Persisted per-lane record written to mission-batch.json. */
export interface PersistedLaneRecord {
	laneNumber: number;
	laneId: string;
	laneSessionId: string;
	worktreePath: string;
	branch: string;
	taskIds: string[];
	repoId?: string;
}

/**
 * Persisted batch state (expanding surface).
 *
 * Full serialized contract lives under `.omp/mission-batch.json`.
 * Fields ported as downstream consumers (abort, resume, merge, ...) land.
 */
export interface PersistedBatchState {
	schemaVersion?: number;
	phase: MissionBatchPhase;
	batchId: string;
	baseBranch?: string;
	orchBranch?: string;
	mode?: WorkspaceMode;
	startedAt?: number;
	updatedAt?: number;
	endedAt?: number | null;
	currentWaveIndex?: number;
	totalWaves?: number;
	taskLevelWaveCount?: number;
	roundToTaskWave?: number[];
	totalTasks?: number;
	succeededTasks?: number;
	failedTasks?: number;
	skippedTasks?: number;
	blockedTasks?: number;
	blockedTaskIds?: string[];
	lanes: PersistedLaneRecord[];
	tasks: PersistedTaskRecord[];
	segments?: PersistedSegmentRecord[];
	wavePlan: string[][];
	mergeResults?: PersistedMergeResult[];
	resilience?: ResilienceState;
	diagnostics?: BatchDiagnostics;
	lastError?: { code: string; message: string } | null;
	errors?: string[];
	/** Unknown top-level fields preserved for round-trip fidelity across schema versions. */
	_extraFields?: Record<string, unknown>;
}

/**
 * Persisted record for a single segment within a multi-repo task (v4,
 * TP-081). Resume uses this to reconstruct the per-task segment
 * frontier and decide which segment to execute next. `status` draws
 * from `PersistedSegmentStatus` defined later in this module.
 */
export interface PersistedSegmentRecord {
	segmentId: string;
	taskId: string;
	repoId: string;
	status: PersistedSegmentStatus;
	laneId: string;
	sessionName: string;
	worktreePath: string;
	branch: string;
	startedAt: number | null;
	endedAt: number | null;
	retries: number;
	dependsOnSegmentIds: string[];
	exitDiagnostic?: TaskExitDiagnostic;
	exitReason: string;
	expandedFrom?: string;
	expansionRequestId?: string;
}

/** Persisted per-repo merge outcome within a wave merge (v2, TP-009). */
export interface PersistedRepoMergeOutcome {
	repoId: string | undefined;
	status: "succeeded" | "failed" | "partial";
	laneNumbers: number[];
	failedLane: number | null;
	failureReason: string | null;
}

/** Persisted summary of a wave merge result. */
export interface PersistedMergeResult {
	waveIndex: number;
	status: "succeeded" | "failed" | "partial";
	failedLane: number | null;
	failureReason: string | null;
	repoResults?: PersistedRepoMergeOutcome[];
}

// ─────────────────────────────────────────────────────────────────────
// Resume types (ported from taskplane types.ts:3064-3122)
// ─────────────────────────────────────────────────────────────────────

/**
 * Reconciled view of one task after resume compares persisted state
 * against live signals (alive sessions, `.DONE` markers, worktrees).
 * `action` is the decision the resume engine executes.
 */
export interface ReconciledTaskState {
	taskId: string;
	persistedStatus: LaneTaskStatus;
	liveStatus: LaneTaskStatus;
	sessionAlive: boolean;
	doneFileFound: boolean;
	worktreeExists: boolean;
	action: "reconnect" | "mark-complete" | "mark-failed" | "re-execute" | "skip" | "pending";
}

/** Result of the phase-driven resume eligibility check. */
export interface ResumeEligibility {
	eligible: boolean;
	reason: string;
	phase: MissionBatchPhase;
	batchId: string;
}

/**
 * Resume point computed from reconciled task states + wave plan.
 * Tells the resume engine where to restart and which tasks fall in
 * each bucket. `mergeRetryWaveIndexes` captures waves whose tasks are
 * terminal but whose merge is missing/failed (TP-037).
 */
export interface ResumePoint {
	resumeWaveIndex: number;
	completedTaskIds: string[];
	pendingTaskIds: string[];
	failedTaskIds: string[];
	reconnectTaskIds: string[];
	reExecuteTaskIds: string[];
	mergeRetryWaveIndexes: number[];
}

// ─────────────────────────────────────────────────────────────────────
// Abort types
//
// Ported verbatim from taskplane types.ts:3125-3214. Abort mode,
// error codes, per-lane and aggregate result shapes, action-plan
// discriminant, and target-session enrichment record.
// ─────────────────────────────────────────────────────────────────────

/** Abort mode: graceful (checkpoint + wait + force-kill) or hard (immediate kill). */
export type AbortMode = "graceful" | "hard";

/**
 * Error codes for abort operations.
 *
 * - ABORT_TMUX_LIST_FAILED: Could not list legacy session records
 * - ABORT_WRAPUP_WRITE_FAILED: Failed to write wrap-up signal file(s)
 * - ABORT_KILL_FAILED: Failed to kill one or more lane sessions
 * - ABORT_STATE_DELETE_FAILED: Failed to delete batch-state.json
 */
export type AbortErrorCode =
	| "ABORT_TMUX_LIST_FAILED"
	| "ABORT_WRAPUP_WRITE_FAILED"
	| "ABORT_KILL_FAILED"
	| "ABORT_STATE_DELETE_FAILED";

/** Per-lane result from an abort operation. */
export interface AbortLaneResult {
	sessionName: string;
	laneId: string;
	taskId: string | null;
	taskFolderInWorktree: string | null;
	wrapUpWritten: boolean;
	wrapUpError: string | null;
	sessionKilled: boolean;
	exitedGracefully: boolean;
}

/** Overall result from an abort operation. */
export interface AbortResult {
	mode: AbortMode;
	sessionsFound: number;
	sessionsKilled: number;
	gracefulExits: number;
	laneResults: AbortLaneResult[];
	wrapUpFailures: number;
	stateDeleted: boolean;
	errors: Array<{ code: AbortErrorCode; message: string }>;
	durationMs: number;
}

/** Action step in an abort plan. */
export type AbortActionStep =
	| { type: "write-wrapup" }
	| { type: "poll-wait"; gracePeriodMs: number; pollIntervalMs: number }
	| { type: "kill-remaining" }
	| { type: "kill-all" };

/** Target session with enrichment from persisted state. */
export interface AbortTargetSession {
	sessionName: string;
	laneId: string;
	taskId: string | null;
	taskFolderInWorktree: string | null;
	worktreePath: string | null;
}

// ── Orchestrator runtime config (taskplane parity) ───────────────────

/**
 * Full orchestrator config shape (ported from taskplane `OrchestratorConfig`).
 *
 * The MVP `MissionControlConfig` up top is the user-facing surface; this
 * extended shape is what the engine + supervisor consume at runtime. Loaded
 * from `.omp/mission.json` (preferred) or legacy `.pi/taskplane-config.json`.
 */
export interface OrchestratorConfig {
	orchestrator: {
		max_lanes: number;
		worktree_location: "sibling" | "subdirectory";
		worktree_prefix: string;
		batch_id_format: "timestamp" | "sequential";
		spawn_mode: "subprocess";
		sessionPrefix: string;
		operator_id: string;
		integration: "manual" | "supervised" | "auto";
	};
	dependencies: {
		source: "prompt" | "agent";
		cache: boolean;
	};
	assignment: {
		strategy: "affinity-first" | "round-robin" | "load-balanced";
		size_weights: Record<string, number>;
	};
	pre_warm: {
		auto_detect: boolean;
		commands: Record<string, string>;
		always: string[];
	};
	merge: {
		model: string;
		tools: string;
		thinking: string;
		verify: string[];
		order: "fewest-files-first" | "sequential";
		timeout_minutes: number;
	};
	failure: {
		on_task_failure: "skip-dependents" | "stop-wave" | "stop-all";
		on_merge_failure: "pause" | "abort";
		stall_timeout: number;
		max_worker_minutes: number;
		abort_grace_period: number;
	};
	monitoring: {
		poll_interval: number;
	};
	verification: {
		enabled: boolean;
		mode: "strict" | "permissive";
		flaky_reruns: number;
	};
}

/** Subset of task-runner.yaml that the orchestrator needs. */
export interface TaskRunnerConfig {
	task_areas: Record<string, TaskArea>;
	reference_docs: Record<string, string>;
	testing_commands?: Record<string, string>;
	model_fallback?: "inherit" | "fail";
	reviewer?: {
		model: string;
		thinking: string;
		tools: string;
	};
}

// ── Merge Types ──────────────────────────────────────────────────────
//
// Ported from taskplane types.ts lines 1262–1657. Full wave/lane result
// surface + error class + constants required by the pure-helper merge
// module (`parseMergeResult`, `determineMergeOrder`, `buildMergeRequest`,
// `classifyMergeHealth`). Heavier orchestration (MergeHealthMonitor,
// spawnMergeAgentV2, mergeWave) is deferred until the engine lands.

/** Valid merge result statuses (task-merger contract). */
export type MergeResultStatus = "SUCCESS" | "CONFLICT_RESOLVED" | "CONFLICT_UNRESOLVED" | "BUILD_FAILURE";

export const VALID_MERGE_STATUSES: ReadonlySet<string> = new Set([
	"SUCCESS",
	"CONFLICT_RESOLVED",
	"CONFLICT_UNRESOLVED",
	"BUILD_FAILURE",
]);

export interface MergeConflict {
	file: string;
	type: string;
	resolved: boolean;
	resolution?: string;
}

export interface MergeVerification {
	ran: boolean;
	passed: boolean;
	output: string;
}

/** Merge result JSON written by the merge agent. */
export interface MergeResult {
	status: MergeResultStatus;
	source_branch: string;
	target_branch: string;
	merge_commit: string;
	conflicts: MergeConflict[];
	verification: MergeVerification;
}

/**
 * Orchestrator-side verification baseline comparison result for a single lane.
 * Populated when verification baseline fingerprinting is enabled.
 */
export interface VerificationBaselineResult {
	performed: boolean;
	newFailureCount: number;
	preExistingCount: number;
	fixedCount: number;
	classification: "pass" | "verification_new_failure" | "flaky_suspected";
	newFailureSummary: string;
	flakyRerunPerformed: boolean;
}

/** Per-lane merge outcome. */
export interface MergeLaneResult {
	laneNumber: number;
	laneId: string;
	sourceBranch: string;
	targetBranch: string;
	result: MergeResult | null;
	error: string | null;
	durationMs: number;
	repoId?: string;
	verificationBaseline?: VerificationBaselineResult;
}

/** Per-repo wave merge outcome (workspace mode). */
export interface RepoMergeOutcome {
	repoId: string | undefined;
	status: "succeeded" | "failed" | "partial";
	laneResults: MergeLaneResult[];
	failedLane: number | null;
	failureReason: string | null;
}

/** Overall wave merge outcome. */
export interface MergeWaveResult {
	waveIndex: number;
	status: "succeeded" | "failed" | "partial";
	laneResults: MergeLaneResult[];
	failedLane: number | null;
	failureReason: string | null;
	totalDurationMs: number;
	repoResults?: RepoMergeOutcome[];
	rollbackFailed?: boolean;
	/** Transaction records — deferred until verification module ports. */
	transactionRecords?: unknown[];
	persistenceErrors?: string[];
}

// ── Merge Error Types ────────────────────────────────────────────────

export type MergeErrorCode =
	| "MERGE_SPAWN_FAILED"
	| "MERGE_TIMEOUT"
	| "MERGE_SESSION_DIED"
	| "MERGE_RESULT_INVALID"
	| "MERGE_RESULT_MISSING_FIELDS"
	| "MERGE_UNKNOWN_STATUS"
	| "MERGE_GIT_ERROR";

export class MergeError extends Error {
	code: MergeErrorCode;

	constructor(code: MergeErrorCode, message: string) {
		super(message);
		this.name = "MergeError";
		this.code = code;
	}
}

// ── Merge Constants ──────────────────────────────────────────────────

/** Default merge agent timeout (ms). Config `merge.timeout_minutes` overrides. */
export const MERGE_TIMEOUT_MS = 90 * 60 * 1000;

/** Polling interval for merge result file (ms). */
export const MERGE_POLL_INTERVAL_MS = 2_000;

/** Grace period after a merge agent exits before declaring failure (ms). */
export const MERGE_RESULT_GRACE_MS = 3_000;

/** Maximum retries for reading a partially-written result file. */
export const MERGE_RESULT_READ_RETRIES = 3;

/** Delay between result-file read retries (ms). */
export const MERGE_RESULT_READ_RETRY_DELAY_MS = 1_000;

/** Maximum retries for merge-agent spawn. */
export const MERGE_SPAWN_RETRY_MAX = 2;

/** Maximum retries on merge-agent timeout (doubling timeout each retry). */
export const MERGE_TIMEOUT_MAX_RETRIES = 2;

// ── Merge Health Monitoring Constants ────────────────────────────────

/** Polling interval for merge health monitor (ms). */
export const MERGE_HEALTH_POLL_INTERVAL_MS = 2 * 60 * 1000;

/** Warning threshold (ms) for inactive merge session. */
export const MERGE_HEALTH_WARNING_THRESHOLD_MS = 10 * 60 * 1000;

/** Stuck threshold (ms) for inactive merge session. */
export const MERGE_HEALTH_STUCK_THRESHOLD_MS = 20 * 60 * 1000;

/** Number of lines to capture from recent merge output snapshots. */
export const MERGE_HEALTH_CAPTURE_LINES = 10;

// ── Merge Health Classification ──────────────────────────────────────

export type MergeHealthStatus = "healthy" | "warning" | "dead" | "stuck";

export type MergeHealthEventType = "merge_health_warning" | "merge_health_dead" | "merge_health_stuck";

export interface MergeSessionSnapshot {
	content: string;
	capturedAt: number;
}

export interface MergeSessionHealthState {
	sessionName: string;
	laneNumber: number;
	lastSnapshot: MergeSessionSnapshot | null;
	lastActivityAt: number;
	status: MergeHealthStatus;
	warningEmitted: boolean;
	stuckEmitted: boolean;
	deadEmitted: boolean;
}

// ── Segment lifecycle status ─────────────────────────────────────────

export type PersistedSegmentStatus = "pending" | "running" | "succeeded" | "failed" | "stalled" | "skipped";

// ── Engine events ────────────────────────────────────────────────────

export type EngineEventType =
	| "wave_start"
	| "task_complete"
	| "task_failed"
	| "merge_start"
	| "merge_success"
	| "merge_failed"
	| "merge_health_warning"
	| "merge_health_dead"
	| "merge_health_stuck"
	| "batch_complete"
	| "batch_paused";

/**
 * Structured engine event written to `.omp/supervisor/events.jsonl`.
 * Shares the same JSONL file as Tier 0 events with a consistent base
 * payload (`timestamp`, `batchId`, `waveIndex`) for uniform consumption
 * by the supervisor agent.
 */
export interface EngineEvent {
	timestamp: string;
	type: EngineEventType;
	batchId: string;
	waveIndex: number;
	phase: MissionBatchPhase;
	taskIds?: string[];
	laneCount?: number;
	taskId?: string;
	durationMs?: number;
	outcome?: string;
	reason?: string;
	partialProgress?: boolean;
	laneNumber?: number;
	error?: string;
	testCount?: number;
	totalWaves?: number;
	succeededTasks?: number;
	failedTasks?: number;
	skippedTasks?: number;
	blockedTasks?: number;
	batchDurationMs?: number;
	sessionName?: string;
	healthStatus?: MergeHealthStatus;
	stalledMinutes?: number;
}

export type EngineEventCallback = (event: EngineEvent) => void;

// ── Supervisor alerts ────────────────────────────────────────────────

export type SupervisorAlertCategory =
	| "task-failure"
	| "merge-failure"
	| "batch-complete"
	| "agent-message"
	| "worker-exit-intercept"
	| "segment-expansion-requested"
	| "segment-expansion-approved"
	| "segment-expansion-rejected";

export interface SupervisorSegmentFrontierSnapshot {
	taskId: string;
	totalSegments: number;
	terminalSegments: number;
	activeSegmentId: string | null;
	segments: Array<{
		segmentId: string;
		repoId: string;
		status: PersistedSegmentStatus;
		dependsOnSegmentIds: string[];
	}>;
}

export interface SupervisorAlertContext {
	taskId?: string;
	segmentId?: string;
	repoId?: string;
	laneId?: string;
	laneNumber?: number;
	waveIndex?: number;
	exitReason?: string;
	segmentFrontier?: SupervisorSegmentFrontierSnapshot;
	agentId?: string;
	messageId?: string;
	expansionRequestId?: string;
	partialProgress?: boolean;
	batchProgress?: {
		succeededTasks: number;
		failedTasks: number;
		skippedTasks: number;
		blockedTasks: number;
		totalTasks: number;
		currentWave: number;
		totalWaves: number;
	};
	mergeError?: string;
	batchDurationMs?: number;
}

export interface SupervisorAlert {
	category: SupervisorAlertCategory;
	summary: string;
	context: SupervisorAlertContext;
}

export type SupervisorAlertCallback = (alert: SupervisorAlert) => void;

// ── Worktree surface (subset) ────────────────────────────────────────

export interface WorktreeInfo {
	path: string;
	branch: string;
	laneNumber: number;
}

export interface CreateWorktreeOptions {
	laneNumber: number;
	batchId: string;
	baseBranch: string;
	prefix: string;
	opId: string;
	config?: OrchestratorConfig;
}

export type WorktreeErrorCode =
	| "WORKTREE_PATH_IS_WORKTREE"
	| "WORKTREE_PATH_NOT_EMPTY"
	| "WORKTREE_BRANCH_EXISTS"
	| "WORKTREE_INVALID_BASE"
	| "WORKTREE_GIT_ERROR"
	| "WORKTREE_VERIFY_FAILED"
	| "WORKTREE_REMOVE_FAILED"
	| "WORKTREE_REMOVE_RETRY_EXHAUSTED"
	| "WORKTREE_BRANCH_DELETE_FAILED"
	| "WORKTREE_NOT_FOUND"
	| "WORKTREE_NOT_REGISTERED"
	| "WORKTREE_DIRTY"
	| "WORKTREE_RESET_FAILED";

export class WorktreeError extends Error {
	code: WorktreeErrorCode;

	constructor(code: WorktreeErrorCode, message: string) {
		super(message);
		this.name = "WorktreeError";
		this.code = code;
	}
}

// ── Branch protection result types ──────────────────────────────────

/** Typed error codes for `preserveBranch`. */
export type PreserveBranchErrorCode =
	| "TARGET_BRANCH_MISSING"
	| "UNMERGED_COUNT_FAILED"
	| "SAVED_BRANCH_CREATE_FAILED"
	| "UNKNOWN_RESOLUTION";

/**
 * Result of `preserveBranch` — either the branch was preserved, was
 * already preserved, was fully merged (nothing to preserve), had no
 * branch to operate on, or preservation failed.
 */
export interface PreserveBranchResult {
	/** Whether the preservation check succeeded. */
	ok: boolean;
	/** What action was taken. */
	action: "preserved" | "already-preserved" | "fully-merged" | "no-branch" | "error";
	/** The saved branch name (if preserved). */
	savedBranch?: string;
	/** Number of unmerged commits (if checked). */
	unmergedCount?: number;
	/** Typed error code (if `action === "error"`). */
	code?: PreserveBranchErrorCode;
	/** Error message (if `action === "error"`). */
	error?: string;
}

/**
 * Result of `ensureBranchDeleted` — either the branch was deleted, or
 * it was preserved because it had unmerged commits vs a target branch.
 */
export interface EnsureBranchDeletedResult {
	/** Whether the original branch was deleted. */
	deleted: boolean;
	/** Whether the branch was preserved (unmerged commits present). */
	preserved: boolean;
	/** Saved branch name (if preserved). */
	savedBranch?: string;
	/** Number of unmerged commits (if preserved). */
	unmergedCount?: number;
}

/**
 * Result of `removeWorktree` — status flags describing what happened to
 * both the worktree directory + the lane branch.
 */
export interface RemoveWorktreeResult {
	/** Whether the worktree was successfully removed in this call. */
	removed: boolean;
	/** Whether the worktree was already absent before the call. */
	alreadyRemoved: boolean;
	/** Whether the lane branch was deleted. */
	branchDeleted: boolean;
	/** Whether the lane branch was preserved (unmerged commits). */
	branchPreserved: boolean;
	/** Saved branch name (if branch was preserved). */
	savedBranch?: string;
	/** Number of unmerged commits (if branch was preserved). */
	unmergedCount?: number;
}

// ── Bulk worktree operation types ───────────────────────────────────

/** Per-lane error surfaced from bulk create/remove operations. */
export interface BulkWorktreeError {
	/** Lane number that failed. */
	laneNumber: number;
	/** `WorktreeErrorCode` when the failure carried one, else `"UNKNOWN"`. */
	code: WorktreeErrorCode | "UNKNOWN";
	/** Human-readable error message. */
	message: string;
}

/**
 * Result of `createLaneWorktrees` bulk creation.
 *
 * On success: `success=true` + `worktrees` holds all created entries.
 * On failure: `success=false` + `errors` lists per-lane failures;
 * `rolledBack` indicates whether partial-state cleanup succeeded.
 */
export interface CreateLaneWorktreesResult {
	/** Whether every lane worktree was created successfully. */
	success: boolean;
	/** Created worktrees (sorted by laneNumber). Empty on rolled-back failure. */
	worktrees: WorktreeInfo[];
	/** Per-lane errors encountered during creation. */
	errors: BulkWorktreeError[];
	/** Whether rollback of partially-created worktrees succeeded (failure path only). */
	rolledBack: boolean;
	/** Errors encountered during rollback (if any). */
	rollbackErrors: BulkWorktreeError[];
}

/** Per-worktree outcome from `removeAllWorktrees`. */
export interface RemoveWorktreeOutcome {
	/** The worktree that was targeted for removal. */
	worktree: WorktreeInfo;
	/** Removal result (`null` if removal threw). */
	result: RemoveWorktreeResult | null;
	/** Error encountered during removal (`null` on success). */
	error: BulkWorktreeError | null;
}

/**
 * Result of `removeAllWorktrees` best-effort bulk removal.
 *
 * Never fails fast — per-worktree errors are captured in `outcomes`
 * and the loop continues to the next target.
 */
export interface RemoveAllWorktreesResult {
	/** Total worktrees that matched the scan filter. */
	totalAttempted: number;
	/** Successfully removed (or already-removed) worktrees. */
	removed: WorktreeInfo[];
	/** Worktrees that failed to remove. */
	failed: RemoveWorktreeOutcome[];
	/** All per-worktree outcomes in scan order. */
	outcomes: RemoveWorktreeOutcome[];
	/** Branches preserved during removal (had unmerged commits). */
	preserved: Array<{
		branch: string;
		savedBranch: string;
		laneNumber: number;
		unmergedCount?: number;
	}>;
}

// ── Preflight checks ─────────────────────────────────────────────────

/**
 * Aggregate preflight outcome — `passed` is false if any check has
 * `status === "fail"`. Warnings don't block.
 */
export interface PreflightResult {
	passed: boolean;
	checks: PreflightCheck[];
}

/**
 * One line item in a preflight report. `hint` is shown only for non-pass
 * entries; it usually points at a fix or install link.
 */
export interface PreflightCheck {
	name: string;
	status: "pass" | "fail" | "warn";
	message: string;
	hint?: string;
}

// ── Mission state detection (routing for /mission no-args) ──────────

/**
 * Strict precedence-ordered project state for /mission no-args routing.
 *
 * Order (first match wins): active-batch → completed-batch → no-config
 * → pending-tasks → no-tasks. Active batch is checked before onboarding
 * so an orphaned mission-batch.json is surfaced even if config was
 * deleted.
 */
export type MissionProjectState = "no-config" | "active-batch" | "completed-batch" | "pending-tasks" | "no-tasks";

/**
 * Result of `detectMissionState` — the detected project state plus
 * context data the supervisor activation prompt threads into its copy
 * (batch id/phase, orch branch name, pending task count).
 */
export interface MissionStateDetection {
	state: MissionProjectState;
	contextMessage: string;
	pendingTaskCount?: number;
	batchId?: string;
	batchPhase?: string;
	orchBranch?: string;
}

/**
 * Dependencies injected into `detectMissionState` for testability. All
 * filesystem / git / discovery I/O is supplied by the caller so the
 * detector itself stays pure.
 */
export interface MissionStateDetectionDeps {
	/** Return true if any MissionControl config file exists (JSON or YAML). */
	hasConfig: () => boolean;
	/** Load the persisted batch state, or null when no state file exists. */
	loadBatchState: () => PersistedBatchState | null;
	/** List local `orch/*` branches (sorted by recency or creation — caller's choice). */
	listOrchBranches: () => string[];
	/** Run task discovery and return the number of pending tasks. */
	countPendingTasks: () => number;
}

// ── /mission-integrate context resolution ───────────────────────────

/**
 * Successful resolution output of `resolveIntegrationContext`. Callers
 * thread `orchBranch` + `baseBranch` + `batchId` into the executor; the
 * `notices` array carries advisory copy (auto-detect hints, recovered
 * state-read errors) that the caller prepends to its user output.
 */
export interface IntegrationContext {
	orchBranch: string;
	baseBranch: string;
	batchId: string;
	currentBranch: string;
	/** Informational messages generated during resolution (auto-detect notices, etc.). */
	notices: string[];
}

/**
 * Error result from `resolveIntegrationContext`. `severity: "info"` is
 * used for soft rejections (legacy merge-mode batches where integration
 * is a no-op); `"error"` is used for real failures the caller should
 * surface prominently.
 */
export interface IntegrationContextError {
	error: string;
	severity: "info" | "error";
}

/**
 * Dependencies injected into `resolveIntegrationContext`. All git + FS
 * I/O is supplied by the caller so the resolver itself stays pure.
 */
export interface IntegrationDeps {
	/** Load the persisted batch state, or null when no state file exists. */
	loadBatchState: () => PersistedBatchState | null;
	/** Return the current local branch, or null for detached HEAD. */
	getCurrentBranch: () => string | null;
	/** Enumerate `orch/*` branches in the local repo. */
	listOrchBranches: () => string[];
	/** Check that a specific branch exists locally. */
	orchBranchExists: (branch: string) => boolean;
}

// ── /mission-integrate execution ─────────────────────────────────────

/**
 * Result of an integration attempt produced by `executeIntegration`.
 *
 * `integratedLocally` is `true` only for ff/merge paths that landed work
 * into the base branch — PR mode never integrates locally because the
 * mission branch must survive until the remote PR is merged. Callers use
 * this flag to gate post-integration cleanup (stale-branch delete,
 * autostash drop, batch-history marker).
 *
 * `commitCount` is carried as a string so callers may substitute a
 * pre-computed count (`"?"` placeholder when the executor cannot measure
 * it itself).
 */
export interface IntegrationResult {
	success: boolean;
	/** True iff ff/merge landed work — controls cleanup eligibility. */
	integratedLocally: boolean;
	commitCount: string;
	/** Final user-facing message on success (may be appended with cleanup warnings). */
	message: string;
	/** User-facing error copy — populated only when `success === false`. */
	error?: string;
}

/**
 * Dependencies injected into `executeIntegration`.
 *
 * `runGit` wraps the repo-scoped git runner; `runCommand` is a generic
 * subprocess runner used for `gh pr create`. `deleteBatchState` is a
 * best-effort effect fired on successful ff/merge paths to clear the
 * persisted batch state file.
 */
export interface IntegrationExecDeps {
	runGit: (args: string[]) => { ok: boolean; stdout: string; stderr: string };
	runCommand: (cmd: string, args: string[]) => { ok: boolean; stdout: string; stderr: string };
	deleteBatchState: () => void;
}

/**
 * Integration executor callback — wraps `executeIntegration` so callers
 * (supervisor auto-integration path, /mission-integrate handler) only
 * need to hand over the plan mode + resolved integration context.
 *
 * Kept as a top-level type to sidestep a circular import between the
 * executor builder and the supervisor modules that receive it.
 */
export type IntegrationExecutor = (
	mode: "ff" | "merge" | "pr",
	context: { orchBranch: string; baseBranch: string; batchId: string; currentBranch: string; notices: string[] },
) => { success: boolean; integratedLocally: boolean; commitCount: string; message: string; error?: string };

/**
 * Dependencies injected alongside an `IntegrationExecutor` for the
 * programmatic CI-polling + PR-merge path. `runCommand` is the generic
 * subprocess runner (used for `gh` invocations); `runGit` is the
 * repo-scoped git runner; `deleteBatchState` is a best-effort effect
 * invoked after the remote PR merges.
 */
export interface CiDeps {
	runCommand: (cmd: string, args: string[]) => { ok: boolean; stdout: string; stderr: string };
	runGit: (args: string[]) => { ok: boolean; stdout: string; stderr: string };
	deleteBatchState: () => void;
}

// ── Model availability validation ────────────────────────────────────

/**
 * Minimal model descriptor returned by the host model registry. Only the
 * fields consumed by `validateModelAvailability` are required — providers
 * may return richer objects without breaking the contract.
 */
export interface ResolvedModelInfo {
	id: string;
	provider?: string;
}

/**
 * Entry describing one role whose model the caller wants validated.
 * `modelStr` is the raw configured override (empty string ⇒ inherit the
 * session model).
 */
export interface ModelCheckEntry {
	role: string;
	modelStr: string;
}

// ── Execution Constants ──────────────────────────────────────────────

/**
 * Grace period (ms) after a lane session exits before declaring failure.
 * Allows time for .DONE file to be flushed to disk on slow filesystems.
 */
export const DONE_GRACE_MS = 5_000;

/** Polling interval (ms) for checking session liveness and .DONE file. */
export const EXECUTION_POLL_INTERVAL_MS = 2_000;

/**
 * Maximum retries for legacy lane-session spawn failures.
 * Only transient failures (session name collision) are retried.
 */
export const SESSION_SPAWN_RETRY_MAX = 2;

// ── Execution Error Types ────────────────────────────────────────────

/**
 * Error codes for lane execution failures.
 *
 * - `EXEC_SPAWN_FAILED` — lane session could not be created after retries.
 * - `EXEC_TASK_FAILED` — task completed without `.DONE` (non-zero exit).
 * - `EXEC_TASK_STALLED` — `STATUS.md` unchanged for stall_timeout.
 * - `EXEC_TASK_STAGE_FAILED` — `git add` failed for task files.
 * - `EXEC_TASK_COMMIT_FAILED` — `git commit` failed for staged task files.
 * - `EXEC_TMUX_NOT_AVAILABLE` — legacy `tmux` binary not found (compat path).
 * - `EXEC_WORKTREE_MISSING` — lane worktree path doesn't exist.
 * - `EXEC_MISSING_TASK_FOLDER` — allocated task has no `taskFolder`
 *   (e.g., persisted stub without discovery enrichment).
 */
export type ExecutionErrorCode =
	| "EXEC_SPAWN_FAILED"
	| "EXEC_TASK_FAILED"
	| "EXEC_TASK_STALLED"
	| "EXEC_TASK_STAGE_FAILED"
	| "EXEC_TASK_COMMIT_FAILED"
	| "EXEC_TMUX_NOT_AVAILABLE"
	| "EXEC_WORKTREE_MISSING"
	| "EXEC_MISSING_TASK_FOLDER";

/** Typed error for lane execution failures. */
export class ExecutionError extends Error {
	code: ExecutionErrorCode;
	laneId?: string;
	taskId?: string;

	constructor(code: ExecutionErrorCode, message: string, laneId?: string, taskId?: string) {
		super(message);
		this.name = "ExecutionError";
		this.code = code;
		this.laneId = laneId;
		this.taskId = taskId;
	}
}

// ── Default orchestrator config (taskplane parity) ───────────────────

/**
 * Baseline orchestrator config — mirrors taskplane's
 * `DEFAULT_ORCHESTRATOR_CONFIG`. Consumed by worktree path helpers and
 * any module that wants a sensible fallback when the loaded config is
 * missing a section.
 */
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
	orchestrator: {
		max_lanes: 3,
		worktree_location: "subdirectory",
		worktree_prefix: "mission-wt",
		batch_id_format: "timestamp",
		spawn_mode: "subprocess",
		sessionPrefix: "mission",
		operator_id: "",
		integration: "manual",
	},
	dependencies: {
		source: "prompt",
		cache: true,
	},
	assignment: {
		strategy: "affinity-first",
		size_weights: { S: 1, M: 2, L: 4 },
	},
	pre_warm: {
		auto_detect: false,
		commands: {},
		always: [],
	},
	merge: {
		model: "",
		tools: "read,write,edit,bash,grep,find,ls",
		thinking: "off",
		verify: [],
		order: "fewest-files-first",
		timeout_minutes: 90,
	},
	failure: {
		on_task_failure: "skip-dependents",
		on_merge_failure: "pause",
		stall_timeout: 30,
		max_worker_minutes: 30,
		abort_grace_period: 60,
	},
	monitoring: {
		poll_interval: 5,
	},
	verification: {
		enabled: false,
		mode: "permissive",
		flaky_reruns: 1,
	},
};

// ── Tier 0 Recovery Event Types ──────────────────────────────────────

/** Tier 0 recovery patterns (mirrors taskplane `Tier0RecoveryPattern`). */
export type Tier0RecoveryPattern = "worker_crash" | "stale_worktree" | "cleanup_gate" | "model_fallback";

/** Extended escalation pattern that includes merge timeouts. */
export type Tier0EscalationPattern = Tier0RecoveryPattern | "merge_timeout";

/** Typed escalation context emitted when a Tier 0 pattern exhausts retries. */
export interface EscalationContext {
	pattern: Tier0EscalationPattern;
	attempts: number;
	maxAttempts: number;
	lastError: string;
	affectedTasks: string[];
	suggestion: string;
}

/** Event types emitted by Tier 0 recovery actions. */
export type Tier0EventType =
	| "tier0_recovery_attempt"
	| "tier0_recovery_success"
	| "tier0_recovery_exhausted"
	| "tier0_escalation";

/** Structured Tier 0 event written to `.omp/supervisor/events.jsonl`. */
export interface Tier0Event {
	timestamp: string;
	type: Tier0EventType;
	batchId: string;
	waveIndex: number;
	pattern: Tier0EscalationPattern;
	attempt: number;
	maxAttempts: number;
	taskId?: string;
	laneNumber?: number;
	repoId?: string | null;
	classification?: string;
	error?: string;
	resolution?: string;
	cooldownMs?: number;
	scopeKey?: string;
	affectedTaskIds?: string[];
	suggestion?: string;
	escalation?: EscalationContext;
}

// ── Supervisor Recovery Classification ───────────────────────────────

/**
 * Recovery action classification (ported from taskplane `RecoveryActionClassification`).
 *
 * - `diagnostic`: read-only — always allowed at any autonomy level
 * - `tier0_known`: known recovery patterns (auto in supervised/autonomous)
 * - `destructive`: mutating actions (ask in interactive/supervised, auto in autonomous)
 */
export type RecoveryActionClassification = "diagnostic" | "tier0_known" | "destructive";

// ── Supervisor Audit Trail ───────────────────────────────────────────

/**
 * Audit trail entry written to `.omp/supervisor/actions.jsonl`.
 *
 * Destructive actions log a pre-action entry with `result: "pending"` then
 * append a follow-up entry with the actual result. Field layout is stable
 * across takeovers — add optional fields, never rename or remove.
 */
export interface AuditTrailEntry {
	ts: string;
	action: string;
	classification: RecoveryActionClassification;
	context: string;
	command: string;
	result: "pending" | "success" | "failure" | "skipped";
	detail: string;
	batchId: string;
	waveIndex?: number;
	laneNumber?: number;
	taskId?: string;
	durationMs?: number;
}

// ── Branch Protection Detection ──────────────────────────────────────

/** Outcome of a `gh` branch-protection probe. */
export type BranchProtectionStatus = "protected" | "unprotected" | "unknown";

// ── Supervisor-Managed Integration Flow ──────────────────────────────

/** Plan describing the integration mode the supervisor will use. */
export interface IntegrationPlan {
	mode: "ff" | "merge" | "pr";
	orchBranch: string;
	baseBranch: string;
	batchId: string;
	branchProtection: BranchProtectionStatus;
	rationale: string;
	succeededTasks: number;
	failedTasks: number;
}

// ── Batch Summary ────────────────────────────────────────────────────

/**
 * Compact Tier 0 event summary used by batch summary rendering.
 */
export interface Tier0EventSummary {
	timestamp: string;
	type: string;
	pattern: string;
	attempt: number;
	maxAttempts: number;
	taskId?: string;
	resolution?: string;
	error?: string;
	suggestion?: string;
	affectedTaskIds?: string[];
}

/**
 * Structured data used to render a batch summary (pure — no I/O).
 */
export interface BatchSummaryData {
	batchId: string;
	phase: string;
	startedAt: number;
	endedAt: number | null;
	totalTasks: number;
	succeededTasks: number;
	failedTasks: number;
	skippedTasks: number;
	blockedTasks: number;
	batchCost: number;
	wavePlan: string[][];
	waveResults: Array<{
		waveIndex: number;
		startedAt: number;
		endedAt: number;
		succeededTaskIds: string[];
		failedTaskIds: string[];
		skippedTaskIds: string[];
		overallStatus: string;
	}>;
	taskExits: Record<string, { classification: string; cost: number; durationSec: number }>;
	mergeResults: Array<{
		waveIndex: number;
		status: string;
		failedLane: number | null;
		failureReason: string | null;
	}>;
	segmentOutcomes: {
		totalSegments: number;
		succeeded: number;
		failed: number;
		stalled: number;
		skipped: number;
		running: number;
		pending: number;
		multiSegmentTasks: Array<{
			taskId: string;
			totalSegments: number;
			terminalSegments: number;
			succeeded: number;
			failed: number;
			stalled: number;
			skipped: number;
			running: number;
			pending: number;
		}>;
	} | null;
	auditEntries: AuditTrailEntry[];
	tier0Events: Tier0EventSummary[];
	errors: string[];
}

// ── Supervisor Config ────────────────────────────────────────────────

/**
 * Autonomy level controlling supervisor confirmation behaviour.
 *
 * | Level         | diagnostic | tier0_known | destructive |
 * |---------------|------------|-------------|-------------|
 * | interactive   | auto       | ask         | ask         |
 * | supervised    | auto       | auto        | ask         |
 * | autonomous    | auto       | auto        | auto        |
 */
export type SupervisorAutonomyLevel = "interactive" | "supervised" | "autonomous";

/** Supervisor configuration resolved from project config + global prefs. */
export interface SupervisorConfig {
	/** Model for supervisor agent. Empty string = inherit session model. */
	model: string;
	/** Autonomy level controlling confirmation behaviour. */
	autonomy: SupervisorAutonomyLevel;
}

/** Default supervisor config (fallback when no config sections provided). */
export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
	model: "",
	autonomy: "supervised",
};

// ── Supervisor Lockfile ──────────────────────────────────────────────

/** Supervisor heartbeat interval (30s). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Staleness threshold: 3 missed heartbeats (90s). */
export const STALE_LOCK_THRESHOLD_MS = 90_000;

/**
 * Supervisor lockfile shape — written to `.omp/supervisor/lock.json`.
 *
 * Enforces 1:1 ratio between supervisors and batches; only one supervisor
 * session may be active per project at a time.
 */
export interface SupervisorLockfile {
	pid: number;
	sessionId: string;
	batchId: string;
	startedAt: string;
	heartbeat: string;
}

/** Outcome of the startup lockfile check. */
export type LockfileCheckResult =
	| { status: "no-active-batch" }
	| { status: "no-lockfile"; batchState: PersistedBatchState }
	| { status: "stale"; lock: SupervisorLockfile; batchState: PersistedBatchState }
	| { status: "live"; lock: SupervisorLockfile; batchState: PersistedBatchState }
	| { status: "corrupt"; batchState: PersistedBatchState };

/** Phases that indicate the batch is terminal (no active supervision). */
export const TERMINAL_BATCH_PHASES: ReadonlySet<string> = new Set(["idle", "completed", "failed", "stopped"]);

// ── Supervisor Event Tailer ──────────────────────────────────────────

/** Event tailer poll interval (10s). */
export const EVENT_POLL_INTERVAL_MS = 10_000;

/** Task digest coalescing window (30s). */
export const TASK_DIGEST_INTERVAL_MS = 30_000;

/** Unified event type covering both engine and Tier 0 events. */
export type UnifiedEventType = EngineEventType | Tier0EventType;

/**
 * Parsed event from the unified `events.jsonl` — minimal superset of
 * `EngineEvent` and `Tier0Event` fields. All event-specific fields are
 * optional so one shape can describe both sources.
 */
export interface ParsedSupervisorEvent {
	timestamp: string;
	type: UnifiedEventType;
	batchId: string;
	waveIndex: number;
	// EngineEvent-specific optional fields
	phase?: string;
	taskIds?: string[];
	laneCount?: number;
	taskId?: string;
	durationMs?: number;
	outcome?: string;
	reason?: string;
	partialProgress?: boolean;
	laneNumber?: number;
	error?: string;
	testCount?: number;
	totalWaves?: number;
	succeededTasks?: number;
	failedTasks?: number;
	skippedTasks?: number;
	blockedTasks?: number;
	batchDurationMs?: number;
	sessionName?: string;
	healthStatus?: string;
	stalledMinutes?: number;
	// Tier0Event-specific optional fields
	pattern?: string;
	attempt?: number;
	maxAttempts?: number;
	classification?: string;
	resolution?: string;
	suggestion?: string;
	affectedTaskIds?: string[];
	message?: string;
}

/** Event types delivered as immediate notifications (non-digest). */
export const SIGNIFICANT_SUPERVISOR_EVENT_TYPES: ReadonlySet<UnifiedEventType> = new Set<UnifiedEventType>([
	"wave_start",
	"merge_start",
	"merge_success",
	"merge_failed",
	"merge_health_warning",
	"merge_health_dead",
	"merge_health_stuck",
	"batch_complete",
	"batch_paused",
	"tier0_escalation",
]);

/** Event types coalesced into periodic task digests. */
export const DIGEST_SUPERVISOR_EVENT_TYPES: ReadonlySet<UnifiedEventType> = new Set<UnifiedEventType>([
	"task_complete",
	"task_failed",
	"tier0_recovery_attempt",
	"tier0_recovery_success",
	"tier0_recovery_exhausted",
]);

/**
 * Buffered task events for digest coalescing.
 */
export interface TaskDigestBuffer {
	completed: string[];
	failed: string[];
	recoveryAttempts: number;
	recoverySuccesses: number;
	recoveryExhausted: number;
}

/**
 * Event tailer state — tracks the byte offset cursor, digest buffer, and
 * timer handles for the polling loop and digest flush.
 */
export interface EventTailerState {
	running: boolean;
	byteOffset: number;
	partialLine: string;
	batchId: string;
	digestBuffer: TaskDigestBuffer;
	pollTimer: ReturnType<typeof setInterval> | null;
	digestTimer: ReturnType<typeof setInterval> | null;
}

// ── Supervisor Routing + State ───────────────────────────────────────

/** Routing context attached when activating the supervisor via `/orch` no-args. */
export interface SupervisorRoutingContext {
	routingState: string;
	contextMessage: string;
}

/** Batch-summary inputs carried by the supervisor state for deferred presentation. */
export interface SupervisorSummaryDeps {
	opId: string;
	diagnostics: {
		taskExits: Record<string, { classification: string; cost: number; durationSec: number }>;
		batchCost: number;
	} | null;
	mergeResults: Array<{
		waveIndex: number;
		status: string;
		failedLane: number | null;
		failureReason: string | null;
	}>;
}

/**
 * Runtime state for the supervisor agent.
 *
 * Typed loosely on `previousModel` (pi-ai `Model<Api>` type is imported
 * lazily by the adapter) so pure helpers can manipulate state without
 * pulling in the model registry.
 */
export interface SupervisorState {
	active: boolean;
	batchId: string;
	config: SupervisorConfig;
	batchStateRef: MissionBatchRuntimeState | null;
	orchConfigRef: OrchestratorConfig | null;
	stateRoot: string;
	previousModel: unknown | null;
	didSwitchModel: boolean;
	lockSessionId: string;
	heartbeatTimer: ReturnType<typeof setInterval> | null;
	eventTailer: EventTailerState;
	routingContext: SupervisorRoutingContext | null;
	pendingSummaryDeps: SupervisorSummaryDeps | null;
}

// ── Batch history (mission-history.json) ────────────────────────────────

/** Token counts for a task, wave, or batch. */
export interface TokenCounts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

/** Per-task summary retained in mission history. */
export interface BatchTaskSummary {
	taskId: string;
	taskName: string;
	status: "succeeded" | "failed" | "skipped" | "blocked" | "stalled" | "pending";
	/** 1-based wave index. */
	wave: number;
	/** 1-based lane index. */
	lane: number;
	durationMs: number;
	tokens: TokenCounts;
	exitReason: string | null;
}

/** Per-wave summary retained in mission history. */
export interface BatchWaveSummary {
	/** 1-based wave index. */
	wave: number;
	/** Task IDs in the wave. */
	tasks: string[];
	mergeStatus: "succeeded" | "failed" | "partial" | "skipped";
	durationMs: number;
	tokens: TokenCounts;
}

/**
 * Complete batch history entry — written after a batch terminates.
 *
 * Mirrors taskplane's `BatchHistorySummary`. Stored in
 * `.omp/mission-history.json` as a newest-first JSON array, trimmed to
 * `BATCH_HISTORY_MAX_ENTRIES` entries.
 */
export interface BatchHistorySummary {
	batchId: string;
	status: "completed" | "partial" | "failed" | "aborted";
	startedAt: number;
	endedAt: number;
	durationMs: number;
	totalWaves: number;
	totalTasks: number;
	succeededTasks: number;
	failedTasks: number;
	skippedTasks: number;
	blockedTasks: number;
	tokens: TokenCounts;
	tasks: BatchTaskSummary[];
	waves: BatchWaveSummary[];
	/** Timestamp (ms since epoch) when the batch was integrated by the operator. */
	integratedAt?: number;
}

/** Maximum number of batch history entries to retain in mission-history.json. */
export const BATCH_HISTORY_MAX_ENTRIES = 100;

// ── Orphan / startup-state analysis ────────────────────────────────────

/**
 * Status of the persisted batch state file discovered at mission startup.
 *
 * - "valid"     — File exists and parses cleanly through schema validation
 * - "missing"   — No state file exists (clean slate)
 * - "invalid"   — File exists but has parse or schema errors
 * - "io-error"  — File could not be read due to an I/O error
 */
export type OrphanStateStatus = "valid" | "missing" | "invalid" | "io-error";

/**
 * Deterministic recommendation returned by the startup analyzer.
 *
 * - "resume"         — Resume an existing mission via `/mission-resume`
 * - "abort-orphans"  — Orphan sessions without usable state — prompt `/mission-abort`
 * - "cleanup-stale"  — Auto-clean a stale state file and start fresh
 * - "paused-corrupt" — Corrupt state without orphans — require manual inspection
 * - "start-fresh"    — No orphans, no state file — proceed normally
 */
export type OrphanRecommendedAction = "resume" | "abort-orphans" | "cleanup-stale" | "paused-corrupt" | "start-fresh";

/**
 * Result of the orphan / startup-state analysis.
 *
 * Machine-usable fields drive automated handling; `userMessage` is a
 * pre-formatted human-readable summary suitable for a CLI prompt.
 */
export interface OrphanDetectionResult {
	/** Session names discovered alive that match the mission prefix. */
	orphanSessions: string[];
	/** Status of the persisted batch state file. */
	stateStatus: OrphanStateStatus;
	/** Validated state payload, or null when unavailable/corrupt. */
	loadedState: PersistedBatchState | null;
	/** Error string when loading failed (null otherwise). */
	stateError: string | null;
	/** Deterministic recommendation. */
	recommendedAction: OrphanRecommendedAction;
	/** Human-readable summary for CLI display. */
	userMessage: string;
}

// ── /mission-integrate cleanup acceptance check ──────────────────────

/**
 * Per-repo acceptance check findings after /mission-integrate.
 * Collected by scanning all workspace repos (not just repos that had
 * the mission branch).
 */
export interface IntegrateCleanupRepoFindings {
	/** Repo root path. */
	repoRoot: string;
	/** Repo ID (undefined for repo-mode / primary). */
	repoId: string | undefined;
	/** Stale lane worktrees still registered (`git worktree list` matches). */
	staleWorktrees: string[];
	/** Stale lane branches (`task/{opId}-lane-*` + `saved/task/{opId}-lane-*`). */
	staleLaneBranches: string[];
	/** Stale mission branches that still exist (only present in non-PR mode). */
	staleOrchBranches: string[];
	/** Batch-scoped autostash entries still present (stash indices). */
	staleAutostashEntries: string[];
	/** Non-empty `.worktrees/` containers (subdirectory layout only). */
	nonEmptyWorktreeContainers: string[];
}

/**
 * Result of the /mission-integrate cleanup acceptance check.
 * Pure function output — callers use it to format the summary
 * notification appended to the integrate report.
 */
export interface IntegrateCleanupResult {
	/** True when every repo passes every acceptance criterion. */
	clean: boolean;
	/** Notification severity: `info` when clean, `warning` when dirty. */
	notifyLevel: "info" | "warning";
	/** Per-repo findings, filtered to those with at least one issue. */
	dirtyRepos: IntegrateCleanupRepoFindings[];
	/** User-facing cleanup report appended to the integrate summary. */
	report: string;
}
