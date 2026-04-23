// src/types.ts — TypeScript interfaces for pi-mission extension

// ---------------------------------------------------------------------------
// Type Aliases
// ---------------------------------------------------------------------------

/** Controls how much the agent can do without user confirmation. */
export type AutonomyLevel = "low" | "medium" | "high" | "auto";

/**
 * Mission operating mode.
 * - `simple`  — linear phase-based flow (plan → implement → review → validate)
 * - `minimal` — lightweight checklist mode
 */
export type MissionMode = "simple" | "minimal";

/** Logical role a phase fulfils during a mission. */
export type PhaseRole = "planner" | "reviewer" | "coder" | "tester" | "auditor" | "verifier";

/** Maps a {@link PhaseRole} to a model identifier (e.g. `"implement" → "claude-sonnet-4"`). */
export type ModelAssignment = Record<string, string>;

// ---------------------------------------------------------------------------
// Core Domain Types
// ---------------------------------------------------------------------------

/** A discrete phase in a simple-mode mission (e.g. "Planning", "Implementation"). */
export interface MissionPhase {
	/** Human-readable phase name. */
	name: string;
	/** Emoji shown in progress displays. */
	emoji: string;
	/** Current lifecycle status. */
	status: "pending" | "active" | "done" | "skipped";
	/** ISO-8601 timestamp when the phase became active. */
	startedAt?: string;
	/** ISO-8601 timestamp when the phase completed or was skipped. */
	completedAt?: string;
}

// ---------------------------------------------------------------------------
// Events & Logging
// ---------------------------------------------------------------------------

/** An immutable record of something noteworthy that happened during a mission. */
export interface ProgressEvent {
	/** ISO-8601 timestamp of the event. */
	timestamp: string;
	/** Discriminator for the kind of event. */
	type:
		| "phase_start"
		| "phase_complete"
		| "mission_pause"
		| "mission_resume"
		| "mission_redirect"
		| "mission_complete";
	/** Human-readable description of what happened. */
	detail: string;
}

// ---------------------------------------------------------------------------
// Mission State (runtime)
// ---------------------------------------------------------------------------

/**
 * The complete runtime state of a mission.
 *
 * Persisted as a custom session entry and reloaded on context resets so
 * the agent can resume exactly where it left off.
 */
export interface MissionState {
	/** High-level description of what this mission aims to achieve. */
	description: string;
	/** Operating mode that governs which fields are active. */
	mode: MissionMode;
	/** Template key used to create this mission (for role group lookup). */
	templateKey?: string;

	// -- Simple-mode fields ---------------------------------------------------
	/** Name of the currently active phase (simple mode). */
	currentPhase?: string;

	/** Ordered phase list (simple mode). */
	phases: MissionPhase[];
	/**
	 * Adaptive missions start with a single seed `Plan` phase and expand the
	 * phase list once the agent proposes one in its plan output. This flag
	 * is set after expansion so it runs exactly once.
	 */
	phasesExpanded?: boolean;

	// -- Shared fields --------------------------------------------------------
	/** How much latitude the agent has to act without confirmation. */
	autonomy: AutonomyLevel;
	/** Per-role model overrides. */
	modelAssignment: ModelAssignment;

	/** Whether the mission is currently paused. */
	paused: boolean;
	/** ISO-8601 timestamp of the most recent pause, if active. */
	pausedAt?: string;
	/** Historical pause/resume pairs for audit. */
	pauseHistory: { pausedAt: string; resumedAt: string }[];

	/** Append-only log of everything notable that happened. */
	progressLog: ProgressEvent[];

	/** ISO-8601 timestamp when the mission was created. */
	startedAt: string;
	/** ISO-8601 timestamp when the mission reached a terminal state. */
	completedAt?: string;

	/**
	 * Mission kind. `simple` = phase-based single-agent flow (default).
	 * `batch` = multi-lane MissionControl orchestration (see `batch` field).
	 */
	kind?: MissionKind;
	/** Populated when `kind === "batch"`. Owned by the MissionControl engine. */
	batch?: BatchState;

	/**
	 * Optional free-form operator guidance (e.g. "don't touch the auth module").
	 * Editable from the dashboard MissionMetaEditor. Surfaced to the agent via
	 * the system-prompt builder in protocol.ts.
	 */
	constraints?: string;
}

// ---------------------------------------------------------------------------
// Configuration & Templates
// ---------------------------------------------------------------------------

/** Blueprint for a phase — no runtime status fields. */
export interface PhaseTemplate {
	/** Phase name. */
	name: string;
	/** Emoji icon. */
	emoji: string;
	/** Instructions shown in the protocol for this phase. */
	instructions: string[];
}

/**
 * Static configuration used to initialise a new mission.
 *
 * Supplied by templates or built interactively during `/mission start`.
 */
export interface MissionConfig {
	/** Operating mode. */
	mode: MissionMode;
	/** Phase definitions. */
	phases?: PhaseTemplate[];
}

/** A reusable, named mission blueprint with flat config fields. */
export interface MissionTemplate {
	/** Template display name (e.g. `"Standard"`, `"Minimal"`). */
	name: string;
	/** What this template is designed for. */
	description: string;
	/** Operating mode. */
	mode: MissionMode;
	/** Phase templates. */
	phases?: PhaseTemplate[];
}

/** Minimal shape of a message content block we extract text from. */
export interface TextContentBlock {
	type: string;
	text?: string;
}

/** Minimal shape of a message with content blocks. */
export interface MessageLike {
	content?: TextContentBlock[];
}

/** Minimal shape of a session entry needed by {@link restoreMissionState}. */
export interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

// ---------------------------------------------------------------------------
// MissionControl batch model (ported from taskplane)
// ---------------------------------------------------------------------------

/**
 * A mission can optionally graduate into a multi-lane orchestrated batch.
 * `kind: "simple"` keeps the phase-based flow above; `kind: "batch"` routes
 * lifecycle events through the MissionControl engine under `src/missioncontrol/`.
 */
export type MissionKind = "simple" | "batch";

/** Aggregate lifecycle phase of a batch mission. */
export type BatchPhase = "idle" | "planning" | "running" | "paused" | "merging" | "complete" | "error" | "aborted";

/** Per-lane runtime status for the dashboard. */
export interface LaneStatus {
	/** Lane number (1-indexed). */
	lane: number;
	/** Currently executing task id, or null when idle. */
	taskId: string | null;
	/** Lane lifecycle. */
	status: "idle" | "running" | "complete" | "failed" | "stalled";
	/** Free-form step progress string (e.g. "2 of 5 steps"). */
	stepProgress: string;
	/** Iteration counter for retries/re-runs. */
	iteration: number;
	/** Elapsed milliseconds on the current task. */
	elapsed: number;
	/** Session identifier used by the worker (mirrors taskplane naming). */
	sessionName: string;
	/** Repo identity for workspace-mode lanes (absent in repo mode). @since round3 */
	repoId?: string;
	/** Reviewer sub-row telemetry when a reviewer is running on this lane. @since round3 */
	reviewer?: ReviewerStatus;
}

/**
 * Per-lane reviewer telemetry snapshot — populated when a reviewer agent is
 * actively running on the lane (file written by the worker's reviewer
 * subprocess to `.reviewer-state.json`). Absent or stale snapshots produce
 * `undefined` on `LaneStatus.reviewer`.
 */
export interface ReviewerStatus {
	/** Reviewer is currently active (file status === "running" and fresh). */
	active: boolean;
	/** Review type (e.g. "step-review", "final-review"). */
	reviewType?: string;
	/** Current review step/iteration. */
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

/** Wave assignment — which tasks run together in parallel on which lanes. */
export interface WaveAssignment {
	wave: number;
	taskIds: string[];
}

/** Per-task telemetry rollup. */
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

/**
 * Parsed STATUS.md progress for a batch task — derived from the checkboxes,
 * current step, iteration counter, and review counter the worker agent
 * maintains. Everything here is derivative data; none of it is persisted to
 * disk by the dashboard.
 */
export interface TaskStatusData {
	/** Total checked boxes across every step. */
	checked: number;
	/** Total boxes across every step. */
	total: number;
	/** Current active step name ("not-started" + "in-progress" steps favoured over "complete"). */
	currentStep?: string;
	/** Iteration counter from the `**Iteration:**` field. */
	iteration: number;
	/** Review counter from the `**Review Counter:**` field. */
	reviews: number;
}

/** Outcome of a single task execution within a lane. */
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
	/**
	 * Live STATUS.md progress, attached by `dashboard-api.ts` when serving
	 * `/api/mission/:id` for batch missions. Absent for simple missions.
	 */
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

/** Per-wave merge outcome. Dashboard renders one row per entry. @since round3 */
export interface MergeResult {
	waveIndex: number;
	status: "succeeded" | "failed" | "partial";
	failedLane?: number | null;
	failureReason?: string | null;
	repoResults?: RepoMergeResult[];
}

/**
 * State of a multi-lane batch mission.
 *
 * Ported and simplified from taskplane `BatchState`. The full engine under
 * `src/missioncontrol/` owns mutation; the dashboard reads this.
 */
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
	/** Workspace mode: `"workspace"` when multi-repo, `"repo"` (default) otherwise. @since round3 */
	mode?: "repo" | "workspace";
	/** Per-wave merge outcomes, populated from engine merge results. @since round3 */
	mergeResults?: MergeResult[];
	/**
	 * Factory-aligned milestones. Groups features into validation boundaries.
	 * Populated by the orchestrator during planning (Track D) or auto-generated
	 * as a single implicit `M-001` milestone when a batch is promoted without
	 * explicit milestone metadata. @since track-A
	 */
	milestones?: BatchMilestone[];
}

/** Lifecycle state for a dashboard-visible milestone view. */
export type BatchMilestoneStatus = "pending" | "in_progress" | "validating" | "passed" | "failed";

/**
 * Dashboard-visible milestone snapshot. The engine's authoritative
 * `Milestone` shape lives in `missioncontrol/types.ts`; this mirrors
 * the fields the client renders.
 */
export interface BatchMilestone {
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
