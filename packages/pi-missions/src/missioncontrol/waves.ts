/**
 * Wave scheduling — pure functions that assign tasks to waves.
 *
 * Simplified from taskplane's 1548-LOC `waves.ts`: the heavy dependency-graph
 * scheduler lives there. For the MVP the engine uses a round-robin chunking
 * strategy that fills each wave up to `waveSize` tasks.
 */

import type { WaveAssignment } from "../types";

/**
 * Split a list of task IDs into waves of at most `waveSize`.
 *
 * Tasks within a wave run in parallel on up to `laneCount` lanes. Waves run
 * sequentially. If `laneCount < waveSize` the runtime fills idle lanes from
 * the next queued wave — handled in the engine, not here.
 */
export function chunkIntoWaves(taskIds: string[], waveSize: number): WaveAssignment[] {
	if (waveSize <= 0) return [];
	const waves: WaveAssignment[] = [];
	for (let i = 0; i < taskIds.length; i += waveSize) {
		waves.push({
			wave: waves.length,
			taskIds: taskIds.slice(i, i + waveSize),
		});
	}
	return waves;
}

export function nextWaveIndex(current: number, waves: WaveAssignment[]): number | null {
	const next = current + 1;
	return next < waves.length ? next : null;
}

export function tasksRemaining(waves: WaveAssignment[], completedIds: ReadonlySet<string>): number {
	let remaining = 0;
	for (const w of waves) {
		for (const id of w.taskIds) {
			if (!completedIds.has(id)) remaining++;
		}
	}
	return remaining;
}
