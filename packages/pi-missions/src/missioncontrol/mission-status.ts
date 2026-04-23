/**
 * `/mission-status` command helper — pure function that formats the current
 * batch-mission runtime state for terminal display.
 *
 * Reads `mission.batch` from memory when present; otherwise falls back to the
 * persisted `.omp/mission-batch.json` on disk so operators who restart their
 * session still see the active batch. This mirrors taskplane's `doOrchStatus`
 * (extension.ts:2270-2334) in-memory-first, disk-fallback ordering.
 *
 * Shape: returns `{ message, level }` so the extension layer owns UI glue.
 */

import type { BatchState, LaneStatus, MissionState, TaskStatus } from "../types";
import { loadBatchState } from "./persistence";
import type { LaneTaskStatus, PersistedBatchState } from "./types";

export interface MissionStatusReport {
	message: string;
	level: "info" | "warning";
}

export interface MissionStatusOptions {
	cwd?: string;
}

export async function buildMissionStatusReport(
	mission: MissionState | null,
	options: MissionStatusOptions = {},
): Promise<MissionStatusReport> {
	if (mission?.batch) {
		return { message: formatBatchStatus(mission.batch), level: "info" };
	}
	if (options.cwd) {
		try {
			const persisted = await loadBatchState(options.cwd);
			if (persisted) {
				return { message: formatPersistedBatchStatus(persisted), level: "info" };
			}
		} catch {
			// Fall through to the default warning so the operator still gets
			// actionable guidance even when disk reads fail (corrupt JSON,
			// permission denied). The error is non-fatal for the status command.
		}
	}
	return {
		message: "No batch is running. Use /mission-batch to promote the active mission.",
		level: "warning",
	};
}

function formatBatchStatus(batch: BatchState): string {
	const elapsedSec = batch.endTime
		? Math.round((batch.endTime - batch.startTime) / 1000)
		: Math.round((Date.now() - batch.startTime) / 1000);

	const counts = tallyTasks(batch.tasks);
	const totalWaves = batch.waves.length || 1;
	const waveIdx = Math.min(batch.currentWave, totalWaves - 1);

	const lines: string[] = [
		`📊 Batch ${batch.batchId} — ${batch.phase}`,
		`   Wave: ${waveIdx + 1}/${totalWaves}`,
		`   Tasks: ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.stalled} stalled / ${batch.tasksTotal} total`,
		`   Elapsed: ${elapsedSec}s`,
	];

	const sortedLanes = [...batch.laneStatuses].sort((a, b) => a.lane - b.lane);
	if (sortedLanes.length > 0) {
		lines.push("   Lanes:");
		for (const lane of sortedLanes) {
			lines.push(`   - ${formatLaneLine(lane)}`);
		}
	}

	if (batch.errors.length > 0) {
		lines.push(`   Errors: ${batch.errors.length}`);
	}

	return lines.join("\n");
}

function formatPersistedBatchStatus(state: PersistedBatchState): string {
	const startedAt = state.startedAt ?? Date.now();
	const endedAt = state.endedAt ?? null;
	const elapsedSec = endedAt ? Math.round((endedAt - startedAt) / 1000) : Math.round((Date.now() - startedAt) / 1000);

	const counts = tallyPersistedTasks(state.tasks ?? []);
	const totalWaves = state.totalWaves ?? state.wavePlan?.length ?? 1;
	const waveIdx = Math.max(0, Math.min(state.currentWaveIndex ?? 0, totalWaves - 1));
	const tasksTotal = state.totalTasks ?? state.tasks?.length ?? 0;

	const lines: string[] = [
		`📊 Batch ${state.batchId} — ${state.phase} (disk)`,
		`   Wave: ${waveIdx + 1}/${Math.max(totalWaves, 1)}`,
		`   Tasks: ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.stalled} stalled / ${tasksTotal} total`,
		`   Elapsed: ${elapsedSec}s`,
	];

	if (state.lanes?.length) {
		const sorted = [...state.lanes].sort((a, b) => a.laneNumber - b.laneNumber);
		lines.push("   Lanes:");
		for (const lane of sorted) {
			const runningTask = state.tasks?.find(t => t.laneNumber === lane.laneNumber && t.status === "running");
			const label = runningTask ? `${runningTask.taskId} (${runningTask.status})` : "idle";
			lines.push(`   - Lane ${lane.laneNumber}: ${label}`);
		}
	}

	if (state.errors?.length) {
		lines.push(`   Errors: ${state.errors.length}`);
	}

	return lines.join("\n");
}

interface TaskTally {
	succeeded: number;
	failed: number;
	skipped: number;
	stalled: number;
	running: number;
	pending: number;
}

function tallyTasks(tasks: { status: TaskStatus }[]): TaskTally {
	const tally: TaskTally = { succeeded: 0, failed: 0, skipped: 0, stalled: 0, running: 0, pending: 0 };
	for (const task of tasks) {
		tally[task.status] += 1;
	}
	return tally;
}

function tallyPersistedTasks(tasks: { status: LaneTaskStatus }[]): TaskTally {
	const tally: TaskTally = { succeeded: 0, failed: 0, skipped: 0, stalled: 0, running: 0, pending: 0 };
	for (const task of tasks) {
		tally[task.status] += 1;
	}
	return tally;
}

function formatLaneLine(lane: LaneStatus): string {
	const taskLabel = lane.taskId ? `${lane.taskId} (${lane.status})` : "idle";
	const progress = lane.stepProgress ? ` · ${lane.stepProgress}` : "";
	return `Lane ${lane.lane}: ${taskLabel}${progress}`;
}
