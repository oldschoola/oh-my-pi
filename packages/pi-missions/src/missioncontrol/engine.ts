/**
 * MissionControl state machine — pure reducers over `MissionState`.
 *
 * Trimmed from taskplane's 4523-LOC `engine.ts`: this MVP owns only the
 * state transitions the dashboard, CLI, and `/mission-batch` command need
 * (promote, pause, resume, abort, record outcome, advance wave). Full
 * quality-gate + merge + supervisor coordination ports later.
 */

import type { BatchPhase, BatchState, LaneStatus, MissionState, TaskOutcome, TaskStatus } from "../types";
import type { MissionControlConfig, PromoteBatchOptions } from "./types";
import { DEFAULT_MISSIONCONTROL_CONFIG } from "./types";
import { chunkIntoWaves, nextWaveIndex } from "./waves";

function emptyLane(laneNumber: number): LaneStatus {
	return {
		lane: laneNumber,
		taskId: null,
		status: "idle",
		stepProgress: "",
		iteration: 0,
		elapsed: 0,
		sessionName: `lane-${laneNumber}`,
	};
}

function newBatchId(): string {
	const now = new Date();
	const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}-${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}${String(now.getUTCSeconds()).padStart(2, "0")}`;
	return `batch-${stamp}`;
}

export function promoteToBatch(
	state: MissionState,
	opts: PromoteBatchOptions = {},
	cfg: MissionControlConfig = DEFAULT_MISSIONCONTROL_CONFIG,
): MissionState {
	if (state.kind === "batch" && state.batch) return state;

	const laneCount = opts.laneCount ?? cfg.laneCount;
	const waveSize = opts.waveSize ?? cfg.waveSize;
	const taskIds = opts.taskIds ?? [];
	const waves = chunkIntoWaves(taskIds, waveSize);
	const batch: BatchState = {
		batchId: newBatchId(),
		phase: taskIds.length === 0 ? "idle" : "planning",
		waves,
		currentWave: 0,
		laneCount,
		laneStatuses: Array.from({ length: laneCount }, (_, i) => emptyLane(i + 1)),
		tasks: taskIds.map<TaskOutcome>(id => ({
			taskId: id,
			status: "pending",
			startTime: null,
			endTime: null,
			exitReason: "",
			sessionName: "",
			doneFileFound: false,
		})),
		tasksTotal: taskIds.length,
		tasksComplete: 0,
		tasksFailed: 0,
		startTime: Date.now(),
		errors: [],
	};

	return { ...state, kind: "batch", batch };
}

export function beginBatch(state: MissionState): MissionState {
	if (!state.batch) return state;
	return withBatch(state, b => ({ ...b, phase: "running" }));
}

export function pauseBatch(state: MissionState): MissionState {
	if (!state.batch) return state;
	return withBatch(state, b => ({ ...b, phase: "paused" }));
}

export function resumeBatch(state: MissionState): MissionState {
	if (!state.batch) return state;
	if (state.batch.phase !== "paused") return state;
	return withBatch(state, b => ({ ...b, phase: "running" }));
}

export function abortBatch(state: MissionState, reason: string = "aborted by operator"): MissionState {
	if (!state.batch) return state;
	return withBatch(state, b => ({
		...b,
		phase: "aborted",
		endTime: Date.now(),
		errors: [...b.errors, reason],
	}));
}

export function recordTaskOutcome(state: MissionState, outcome: TaskOutcome): MissionState {
	if (!state.batch) return state;
	return withBatch(state, b => {
		const tasks = b.tasks.map(t => (t.taskId === outcome.taskId ? { ...t, ...outcome } : t));
		const tasksComplete = tasks.filter(t => t.status === "succeeded").length;
		const tasksFailed = tasks.filter(t => t.status === "failed").length;
		return { ...b, tasks, tasksComplete, tasksFailed };
	});
}

export function setLaneStatus(state: MissionState, lane: number, patch: Partial<LaneStatus>): MissionState {
	if (!state.batch) return state;
	return withBatch(state, b => ({
		...b,
		laneStatuses: b.laneStatuses.map(l => (l.lane === lane ? { ...l, ...patch } : l)),
	}));
}

export function advanceWave(state: MissionState): MissionState {
	if (!state.batch) return state;
	const next = nextWaveIndex(state.batch.currentWave, state.batch.waves);
	if (next === null) {
		return withBatch(state, b => ({ ...b, phase: "complete", endTime: Date.now() }));
	}
	return withBatch(state, b => ({ ...b, currentWave: next }));
}

export function phaseAfterOutcomes(state: MissionState): BatchPhase {
	if (!state.batch) return "idle";
	const { tasksTotal, tasksComplete, tasksFailed, phase } = state.batch;
	if (phase === "aborted" || phase === "paused" || phase === "error") return phase;
	if (tasksTotal > 0 && tasksComplete + tasksFailed >= tasksTotal) {
		return tasksFailed === 0 ? "complete" : "error";
	}
	return phase;
}

function withBatch(state: MissionState, fn: (b: BatchState) => BatchState): MissionState {
	if (!state.batch) return state;
	return { ...state, batch: fn(state.batch) };
}

export function deriveStatus(state: MissionState): TaskStatus | "no-batch" {
	if (!state.batch) return "no-batch";
	const { phase } = state.batch;
	if (phase === "complete") return "succeeded";
	if (phase === "error" || phase === "aborted") return "failed";
	if (phase === "paused") return "stalled";
	if (phase === "running" || phase === "planning" || phase === "merging") return "running";
	return "pending";
}
