/**
 * Dashboard API — reads mission state from disk and serves it to the React UI.
 *
 * Data layout (per-project):
 *   {cwd}/.omp/missions/<missionId>.json          — historical mission states
 *   {cwd}/.omp/mission-batch.json                 — active batch mission (optional)
 *   {cwd}/.omp/mission-telemetry/<id>/*.jsonl     — sidecar events (redacted)
 *   {cwd}/.omp/mission-telemetry/<id>/exit-summary.json
 *
 * All event data is passed through `redactEvent()` before it hits disk, so the
 * dashboard can display events verbatim.
 */

import * as path from "node:path";
import { readSidecar } from "./telemetry/sidecar";
import type { BatchState, MissionState } from "./types";

export interface MissionSummary {
	id: string;
	description: string;
	kind: "simple" | "batch";
	status: "active" | "paused" | "completed" | "failed";
	startedAt: string;
	completedAt?: string;
	phaseCount?: number;
	completedPhases?: number;
	batchPhase?: BatchState["phase"];
	laneCount?: number;
	cost?: number;
}

export interface MissionDetail extends MissionSummary {
	state: MissionState;
}

function projectMissionsDir(cwd: string): string {
	return path.join(cwd, ".omp", "missions");
}

function batchStatePath(cwd: string): string {
	return path.join(cwd, ".omp", "mission-batch.json");
}

function telemetryDir(cwd: string, missionId: string): string {
	return path.join(cwd, ".omp", "mission-telemetry", missionId);
}

async function listHistoricalMissions(cwd: string): Promise<MissionDetail[]> {
	const dir = projectMissionsDir(cwd);
	const results: MissionDetail[] = [];
	const dirHandle = Bun.file(dir);
	try {
		const stat = await dirHandle.stat();
		if (!stat.isDirectory()) return results;
	} catch {
		return results;
	}
	const glob = new Bun.Glob("*.json");
	for await (const entry of glob.scan({ cwd: dir, onlyFiles: true })) {
		const file = Bun.file(path.join(dir, entry));
		if (!(await file.exists())) continue;
		try {
			const state = (await file.json()) as MissionState;
			const id = entry.replace(/\.json$/, "");
			results.push(toDetail(id, state));
		} catch {
			// Skip unreadable files — dashboard is lossy-tolerant.
		}
	}
	return results;
}

async function readActiveBatch(cwd: string): Promise<MissionDetail | null> {
	const file = Bun.file(batchStatePath(cwd));
	if (!(await file.exists())) return null;
	try {
		const state = (await file.json()) as MissionState;
		return toDetail(state.batch?.batchId ?? "active", state);
	} catch {
		return null;
	}
}

function toDetail(id: string, state: MissionState): MissionDetail {
	const kind: "simple" | "batch" = state.kind ?? (state.batch ? "batch" : "simple");
	const status = resolveStatus(state);
	return {
		id,
		description: state.description,
		kind,
		status,
		startedAt: state.startedAt,
		completedAt: state.completedAt,
		phaseCount: state.phases?.length,
		completedPhases: state.phases?.filter(p => p.status === "done").length,
		batchPhase: state.batch?.phase,
		laneCount: state.batch?.laneCount,
		state,
	};
}

function resolveStatus(state: MissionState): MissionSummary["status"] {
	if (state.completedAt) return "completed";
	if (state.paused) return "paused";
	if (state.batch?.phase === "error" || state.batch?.phase === "aborted") return "failed";
	return "active";
}

export async function listMissions(cwd: string): Promise<MissionSummary[]> {
	const [historical, active] = await Promise.all([listHistoricalMissions(cwd), readActiveBatch(cwd)]);
	const all = [...historical];
	if (active) all.unshift(active);
	return all.map(({ state: _state, ...summary }) => summary);
}

export async function getMission(cwd: string, id: string): Promise<MissionDetail | null> {
	const file = Bun.file(path.join(projectMissionsDir(cwd), `${id}.json`));
	if (await file.exists()) {
		try {
			const state = (await file.json()) as MissionState;
			return toDetail(id, state);
		} catch {
			// Fall through to active batch.
		}
	}
	const active = await readActiveBatch(cwd);
	if (active && active.id === id) return active;
	return null;
}

export async function getMissionEvents(
	cwd: string,
	missionId: string,
	role = "worker",
): Promise<Record<string, unknown>[]> {
	const sidecar = path.join(telemetryDir(cwd, missionId), `${role}.jsonl`);
	const events: Record<string, unknown>[] = [];
	for await (const ev of readSidecar(sidecar)) {
		events.push(ev);
	}
	return events;
}

export async function getMissionTelemetrySummary(
	cwd: string,
	missionId: string,
): Promise<Record<string, unknown> | null> {
	const file = Bun.file(path.join(telemetryDir(cwd, missionId), "exit-summary.json"));
	if (!(await file.exists())) return null;
	try {
		return (await file.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}
