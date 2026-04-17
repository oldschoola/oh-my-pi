/**
 * Client-side view types mirror the server's dashboard-api shape so the SPA
 * can stay decoupled from the server package.
 */

export type MissionKind = "simple" | "batch";
export type MissionStatus = "active" | "paused" | "completed" | "failed";
export type BatchPhase = "planning" | "running" | "complete" | "error" | "aborted";

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
}

export interface MissionPhase {
	id: string;
	name: string;
	status: "pending" | "active" | "done" | "failed" | "skipped";
	startedAt?: string;
	completedAt?: string;
}

export interface LaneStatus {
	laneId: number;
	state: "idle" | "running" | "complete" | "failed" | "recovering";
	currentTaskId?: string;
	currentTaskTitle?: string;
	startedAt?: number;
	pid?: number;
}

export interface WaveAssignment {
	waveIndex: number;
	taskIds: string[];
	state: "pending" | "running" | "complete" | "failed";
}

export interface TaskOutcome {
	taskId: string;
	title: string;
	status: "pending" | "running" | "done" | "failed" | "skipped";
	laneId?: number;
	waveIndex?: number;
	durationMs?: number;
	error?: string;
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

export interface MissionState {
	description: string;
	startedAt: string;
	completedAt?: string;
	paused?: boolean;
	kind?: MissionKind;
	phases?: MissionPhase[];
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
	retries?: Array<{ attempt: number; error?: string }>;
	lastToolCall?: string;
	error?: string;
}

export interface TelemetryEvent {
	type?: string;
	ts?: number;
	[key: string]: unknown;
}
