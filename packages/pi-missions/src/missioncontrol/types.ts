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
	/** v3 resilience state (stubbed). */
	resilience?: unknown;
	/** v3 diagnostics (per-task exits + batch cost). */
	diagnostics?: BatchDiagnostics;
	/** v4 segment records (stubbed). */
	segments?: unknown[];
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
 * Persisted batch state (minimal surface).
 *
 * Full serialized contract lives under `.omp/mission-batch.json` once
 * the persistence layer is fully ported. Abort only reads `lanes` and
 * `tasks`; other consumers add fields as needed.
 */
export interface PersistedBatchState {
	schemaVersion?: number;
	phase?: MissionBatchPhase;
	batchId: string;
	baseBranch?: string;
	orchBranch?: string;
	mode?: WorkspaceMode;
	startedAt?: number;
	updatedAt?: number;
	endedAt?: number | null;
	lanes: PersistedLaneRecord[];
	tasks: PersistedTaskRecord[];
	lastError?: { code: string; message: string } | null;
	errors?: string[];
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

// ── Merge health classification ──────────────────────────────────────

export type MergeHealthStatus = "healthy" | "warning" | "dead" | "stuck";

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
