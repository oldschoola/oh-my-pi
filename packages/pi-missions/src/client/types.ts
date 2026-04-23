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
	/** Live context window utilisation (0–100). @since round3 */
	contextPct?: number;
	/** Last tool invocation string (name + arg preview). @since round3 */
	lastTool?: string;
	/** Total retry events observed; absent when zero. @since round3 */
	retries?: number;
	/** True while the worker is in a retry backoff window. @since round3 */
	retryActive?: boolean;
	/** Last retry error message; only present when retries > 0. @since round3 */
	lastRetryError?: string;
	/** Auto-compaction count; absent when zero. @since round3 */
	compactions?: number;
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
	/** Repo this task runs in (workspace mode). @since round3 */
	repoId?: string;
	/** Resolved repo after workspace routing (preferred over `repoId`). @since round3 */
	resolvedRepoId?: string;
	/** Ordered segment IDs for multi-repo tasks. @since round3 */
	segmentIds?: string[];
	/** Currently-active segment ID when running. @since round3 */
	activeSegmentId?: string | null;
}

/** Per-repo outcome within a wave merge (workspace mode). @since round3 */
export interface RepoMergeResult {
	repoId?: string;
	status: "succeeded" | "failed" | "partial";
	laneNumbers: number[];
	failedLane?: number | null;
	failureReason?: string | null;
}

/** Per-wave merge outcome. @since round3 */
export interface MergeResult {
	waveIndex: number;
	status: "succeeded" | "failed" | "partial";
	failedLane?: number | null;
	failureReason?: string | null;
	repoResults?: RepoMergeResult[];
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
	/** Repo identity for workspace-mode lanes. @since round3 */
	repoId?: string;
	/** Reviewer sub-row telemetry when a reviewer is running on this lane. @since round3 */
	reviewer?: ReviewerStatus;
}

/** Per-lane reviewer telemetry snapshot. @since round3 */
export interface ReviewerStatus {
	active: boolean;
	reviewType?: string;
	reviewStep?: number;
	elapsedMs?: number;
	toolCalls?: number;
	contextPct?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
	lastTool?: string;
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
	/** Workspace mode. @since round3 */
	mode?: "repo" | "workspace";
	/** Per-wave merge outcomes. @since round3 */
	mergeResults?: MergeResult[];
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
	/** Operator autonomy level mirrored from server-side `MissionState`. */
	autonomy?: "low" | "medium" | "high" | "auto";
	/** Free-form operator constraints — editable from `MissionMetaEditor`. */
	constraints?: string;
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

export type SupervisorAutonomyLevel = "interactive" | "supervised" | "autonomous";

export interface SupervisorStatus {
	state: "active" | "stale" | "inactive";
	lock: SupervisorLock | null;
	heartbeatAgeMs: number | null;
	/** Supervisor autonomy level from project config. @since round3 */
	autonomy?: SupervisorAutonomyLevel;
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

// ---------------------------------------------------------------------------
// Factory-alignment: validation contract, milestones, knowledge, plan,
// role models, telemetry rollup, and skills (Track J2–J10 API shapes)
// ---------------------------------------------------------------------------

export interface BehavioralAssertion {
	id: string;
	area: string;
	title: string;
	description: string;
	acceptanceCriteria: string[];
	milestoneId?: string;
	notes?: string;
}

export interface ValidationContract {
	schemaVersion: number;
	missionId: string;
	updatedAt?: number;
	assertions: BehavioralAssertion[];
}

export type BatchMilestoneStatus = "pending" | "in_progress" | "validating" | "passed" | "failed";

export interface ClientMilestone {
	id: string;
	name: string;
	featureIds: string[];
	assertionIds: string[];
	status: BatchMilestoneStatus;
	validationRounds: number;
	maxValidationRounds: number;
	startedAt?: number;
	endedAt?: number;
}

export interface MilestoneStatusRow {
	milestone: ClientMilestone;
	boundAssertions: BehavioralAssertion[];
	/**
	 * Findings are not yet persisted server-side; the field stays
	 * optional so forward-compatible panels can render them when the
	 * engine starts emitting them.
	 */
	findings?: Array<{ id: string; severity: string; summary: string }>;
}

export interface ValidationStatusResult {
	batchId: string;
	contract: ValidationContract | null;
	rows: MilestoneStatusRow[];
}

export interface KnowledgeEntry {
	scope: string;
	timestamp: string;
	author: string;
	body: string;
	title?: string;
}

export interface KnowledgeResponse {
	entries: KnowledgeEntry[];
	summary: string;
}

export type PlanStatus = "draft" | "awaiting-approval" | "approved";

export interface PlanManifest {
	schemaVersion: number;
	missionId: string;
	status: PlanStatus;
	milestoneIds: string[];
	featureIds: string[];
	createdAt: string;
	updatedAt: string;
	approvedBy?: string;
	approvedAt?: string;
}

export type ResolvedModelSource = "missions-override" | "legacy-seat" | "default" | "none";

export interface ResolvedRoleModel {
	role: "orchestrator" | "worker" | "scrutiny_validator" | "user_testing_validator";
	model: string;
	source: ResolvedModelSource;
}

export interface RoleModelsResponse {
	roles: ResolvedRoleModel[];
}

export interface RoleRollup {
	role: "orchestrator" | "worker" | "fix_worker" | "scrutiny_validator" | "user_testing_validator";
	count: number;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd: number;
	toolCalls: number;
}

export interface MissionRollup {
	perRole: RoleRollup[];
	totals: Omit<RoleRollup, "role">;
}

export interface SkillEntry {
	name: string;
	version: string;
	description: string;
	origin: "promoted" | "draft";
	folderPath: string;
	skillPath: string;
	tools?: string;
	tags?: string[];
}

export interface SkillsResponse {
	promoted: SkillEntry[];
	drafts: SkillEntry[];
}
