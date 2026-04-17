/**
 * Persistence layer — reads/writes `.omp/mission-batch.json` (active batch)
 * and `.omp/missions/<id>.json` (historical) using Bun-native I/O.
 *
 * Also handles legacy-path migration: if `.pi/batch-state.json` exists but
 * no `.omp/mission-batch.json` does, the legacy file is read once and
 * written forward. The legacy file is left in place (non-destructive).
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { MissionState } from "../types";
import { legacyBatchPath, missionBatchPath, missionsDir } from "./adapter";
import type { AllocatedLane, LaneTaskOutcome, MissionBatchRuntimeState } from "./types";

function parseMissionJson(text: string): MissionState | null {
	if (!text.trim()) return null;
	try {
		return JSON.parse(text) as MissionState;
	} catch {
		return null;
	}
}

export async function loadActiveBatch(cwd: string): Promise<MissionState | null> {
	const primary = Bun.file(missionBatchPath(cwd));
	if (await primary.exists()) {
		const text = await primary.text();
		return parseMissionJson(text);
	}
	return migrateLegacy(cwd);
}

export async function saveActiveBatch(cwd: string, state: MissionState): Promise<void> {
	await Bun.write(missionBatchPath(cwd), `${JSON.stringify(state, null, 2)}\n`);
}

export async function clearActiveBatch(cwd: string): Promise<void> {
	const file = Bun.file(missionBatchPath(cwd));
	if (await file.exists()) {
		await Bun.write(missionBatchPath(cwd), "");
	}
}

export async function archiveMission(cwd: string, id: string, state: MissionState): Promise<void> {
	const target = `${missionsDir(cwd)}/${id}.json`;
	await Bun.write(target, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Delete the active batch state file.
 *
 * Stub: reuses `clearActiveBatch` (empties rather than removes).
 * Real impl will unlink the file once full persistence lands.
 */
export async function deleteBatchState(cwd: string): Promise<void> {
	await clearActiveBatch(cwd);
}

/**
 * Persist runtime state to disk (stub).
 *
 * Full serialization of wave plan, lane records, and task outcomes
 * lands with the execution/supervisor port. For now we log the
 * transition label so abort flows can record their phase change
 * without corrupting on-disk state.
 */
export async function persistRuntimeState(
	label: string,
	batchState: MissionBatchRuntimeState,
	_wavePlan: string[][],
	_lanes: AllocatedLane[],
	_outcomes: LaneTaskOutcome[],
	_discovery: unknown,
	_cwd: string,
): Promise<void> {
	logger.debug("[missioncontrol] persistRuntimeState (stub)", {
		label,
		batchId: batchState.batchId,
		phase: batchState.phase,
	});
}

async function migrateLegacy(cwd: string): Promise<MissionState | null> {
	const legacy = Bun.file(legacyBatchPath(cwd));
	if (!(await legacy.exists())) return null;
	try {
		const text = await legacy.text();
		const parsed = parseMissionJson(text);
		if (!parsed) return null;
		await saveActiveBatch(cwd, parsed);
		logger.debug("[missioncontrol] migrated .pi/batch-state.json → .omp/mission-batch.json");
		return parsed;
	} catch (err) {
		logger.error("[missioncontrol] legacy migration failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}
