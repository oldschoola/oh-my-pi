/**
 * Client-side view types that mirror the server's wire format so the SPA
 * stays decoupled from the server package internals.
 *
 * Field names match what the server actually serialises from src/types.ts.
 * Previous versions had mismatched names (laneId vs lane, state vs status,
 * waveIndex vs wave) that caused silent rendering failures.
 */

export type MissionKind = "simple" | "batch";
export type MissionStatus = "active" | "paused" | "completed" | "failed";
export type BatchPhase = "idle" | "planning" | "running" | "paused" | "merging" | "complete" | "error" | "aborted";

export interface MissionSummary {
	id: string;
	description: string;
	kind: MissionKind;
	status: MissionStatus;
	startedAt: string;
	completedAt?: string;
	phaseCount?: number;
	completedPhases?: number;
	batchPhase?: BatchPhase;
	laneCount?: number;
	cost?: number;
	tasksTotal?: number;
	tasksComplete?: number;
	tasksFailed?: number;
	aggregateTokens?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};
}

export interface MissionPhase {
	id?: string;
	name: string;
	/** Emoji icon (present in server-serialised phases). */
	emoji?: string;
	status: "pending" | "active" | "done" | "failed" | "skipped";
	startedAt?: string;
	completedAt?: string;
}

/** Per-task token/cost telemetry rollup (mirrors server TaskTelemetry). */
export interface TaskTelemetry {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	toolCalls: number;
	durationMs: number;
}

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "stalled" | "skipped";

/** STATUS.md checkbox / step progress parsed server-side. */
export interface TaskStatusData {
	checked: number;
	total: number;
	currentStep?: string;
	iteration: number;
	reviews: number;
}

/** Per-task outcome (mirrors server TaskOutcome). */
export interface TaskOutcome {
	taskId: string;
	status: TaskStatus;
	startTime: number | null;
	endTime: number | null;
	exitReason: string;
	sessionName: string;
	doneFileFound: boolean;
	laneNumber?: number;
	telemetry?: TaskTelemetry;
	statusData?: TaskStatusData;
}

/** Per-lane runtime status (mirrors server LaneStatus). */
export interface LaneStatus {
	/** 1-indexed lane number. */
	lane: number;
	/** Running task id, or null when idle. */
	taskId: string | null;
	status: "idle" | "running" | "complete" | "failed" | "stalled";
	/** Human-readable step progress (e.g. "3 of 7 steps"). */
	stepProgress: string;
	/** Iteration counter for retries/re-runs. */
	iteration: number;
	/** Elapsed milliseconds on the current task. */
	elapsed: number;
	/** Session identifier used by the worker (e.g. "orch-abc123-lane-1"). */
	sessionName: string;
}

/** Wave assignment (mirrors server WaveAssignment). */
export interface WaveAssignment {
	/** 0-indexed wave number. */
	wave: number;
	taskIds: string[];
}

export interface BatchState {
	batchId: string;
	phase: BatchPhase;
	waves: WaveAssignment[];
	currentWave: number;
	laneCount: number;
	laneStatuses: LaneStatus[];
	tasks: TaskOutcome[];
	tasksTotal: number;
	tasksComplete: number;
	tasksFailed: number;
	startTime: number;
	endTime?: number;
	errors: string[];
}

export interface ProgressEvent {
	timestamp: string;
	type: string;
	detail: string;
}

export interface MissionState {
	description: string;
	startedAt: string;
	completedAt?: string;
	paused?: boolean;
	kind?: MissionKind;
	phases?: MissionPhase[];
	progressLog?: ProgressEvent[];
	batch?: BatchState;
}

export interface MissionDetail extends MissionSummary {
	state: MissionState;
}

export interface TelemetrySummary {
	exitCode?: number;
	durationMs?: number;
	tokens?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheCreationInputTokens?: number;
		cacheReadInputTokens?: number;
		totalCostUsd?: number;
	};
	toolCalls?: number;
	/** Total retries observed; absent when zero. */
	retries?: number;
	/** True while the agent is in a retry backoff window. */
	retryActive?: boolean;
	/** Last retry error message; only present when retries > 0. */
	lastRetryError?: string;
	/** Auto-compaction count; absent when zero. */
	compactions?: number;
	/** Live context window utilisation (0–100). */
	contextPct?: number;
	lastToolCall?: string;
	error?: string;
}

export interface TelemetryEvent {
	type?: string;
	ts?: number;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// /mission-gui & dashboard-parity types
// ---------------------------------------------------------------------------

export type AutonomyLevel = "low" | "medium" | "high" | "auto";

export interface MissionStartRequest {
	token: string;
	templateKey: string;
	description: string;
	autonomy: AutonomyLevel;
	modelAssignment: Record<string, string>;
	constraints?: string;
	laneCount?: number;
	waveSize?: number;
}

export interface HistoryTokenCounts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

export interface BatchHistoryTask {
	taskId: string;
	taskName: string;
	status: "succeeded" | "failed" | "skipped" | "blocked" | "stalled" | "pending";
	wave: number;
	lane: number;
	durationMs: number;
	tokens: HistoryTokenCounts;
	exitReason: string | null;
}

export interface BatchHistoryWave {
	wave: number;
	tasks: string[];
	mergeStatus: "succeeded" | "failed" | "partial" | "skipped";
	durationMs: number;
	tokens: HistoryTokenCounts;
}

export interface BatchHistoryEntry {
	batchId: string;
	missionId?: string;
	description?: string;
	phase?: string;
	status?: "completed" | "partial" | "failed" | "aborted";
	startedAt?: string | number;
	completedAt?: string | number;
	endedAt?: string | number;
	durationMs?: number;
	totalWaves?: number;
	totalTasks?: number;
	tasksTotal?: number;
	tasksComplete?: number;
	tasksFailed?: number;
	succeededTasks?: number;
	failedTasks?: number;
	skippedTasks?: number;
	blockedTasks?: number;
	tokens?: HistoryTokenCounts;
	tasks?: BatchHistoryTask[];
	waves?: BatchHistoryWave[];
	integratedAt?: number;
	[key: string]: unknown;
}

export interface SupervisorEvent {
	ts?: string;
	batchId?: string;
	action?: string;
	classification?: string;
	detail?: string;
	[key: string]: unknown;
}

export interface SupervisorLock {
	pid: number;
	sessionId: string;
	batchId: string;
	startedAt: string;
	heartbeat: string;
}

export interface SupervisorStatus {
	state: "active" | "stale" | "inactive";
	lock: SupervisorLock | null;
	heartbeatAgeMs: number | null;
}

export interface SupervisorConversationEntry {
	ts?: string;
	role: string;
	content: string;
}

export interface SupervisorTimelineEntry {
	ts: string;
	action: string;
	label: string;
	tier: 0 | 1;
	outcome?: string;
	classification?: string;
	taskId?: string;
	laneNumber?: number;
	reason?: string;
	detail?: string;
}

export interface SupervisorDetail {
	status: SupervisorStatus;
	conversation: SupervisorConversationEntry[];
	timeline: SupervisorTimelineEntry[];
	summary: string | null;
}

export interface MailboxEvent {
	ts?: string | number;
	messageId?: string;
	direction?: "inbox" | "outbox" | "broadcast";
	from?: string;
	to?: string;
	/** Raw audit-event type (e.g. message_sent, message_delivered). */
	type?: string;
	/** Original message type (e.g. request, response). */
	messageType?: string;
	content?: string;
	contentPreview?: string;
	[key: string]: unknown;
}

export interface AgentSnapshot {
	batchId: string | null;
	registry: {
		agents?: Array<Record<string, unknown>>;
		[key: string]: unknown;
	} | null;
}
