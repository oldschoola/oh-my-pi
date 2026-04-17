/**
 * `/mission-status` command helper — pure function that formats the current
 * batch-mission runtime state for terminal display.
 *
 * Trimmed port of taskplane `doOrchStatus` (extension.ts:2270-2334). The MVP
 * reads from in-memory `mission.batch` only — disk-fallback to
 * `loadBatchState` is deferred until the persistence I/O layer fully lands.
 *
 * Shape: returns `{ message, level }` so the extension layer owns UI glue.
 */

import type { BatchState, LaneStatus, MissionState, TaskStatus } from "../types";

export interface MissionStatusReport {
	message: string;
	level: "info" | "warning";
}

export function buildMissionStatusReport(mission: MissionState | null): MissionStatusReport {
	if (!mission?.batch) {
		return {
			message: "No batch is running. Use /mission-batch to promote the active mission.",
			level: "warning",
		};
	}
	return { message: formatBatchStatus(mission.batch), level: "info" };
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

function formatLaneLine(lane: LaneStatus): string {
	const taskLabel = lane.taskId ? `${lane.taskId} (${lane.status})` : "idle";
	const progress = lane.stepProgress ? ` · ${lane.stepProgress}` : "";
	return `Lane ${lane.lane}: ${taskLabel}${progress}`;
}
