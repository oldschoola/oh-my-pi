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
import { isEnoent } from "@oh-my-pi/pi-utils";
import { parseStatusMd } from "./missioncontrol";
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
	const detail = await loadMissionRecord(cwd, id);
	if (!detail) return null;
	await enrichBatchStatusData(cwd, detail);
	return detail;
}

async function loadMissionRecord(cwd: string, id: string): Promise<MissionDetail | null> {
	const file = Bun.file(path.join(projectMissionsDir(cwd), `${id}.json`));
	try {
		const state = (await file.json()) as MissionState;
		return toDetail(id, state);
	} catch (err) {
		if (!isEnoent(err)) {
			// Malformed mission file — fall through to active batch. No logging:
			// listMissions already skips unreadable files.
		}
	}
	const active = await readActiveBatch(cwd);
	if (active && active.id === id) return active;
	return null;
}

/**
 * For batch missions, hydrate each task with parsed STATUS.md progress so the
 * dashboard can render checkbox-level progress in LaneGrid without every client
 * having to follow up with its own per-task fetch.
 *
 * Best-effort — missing/unparseable STATUS.md files leave `statusData` unset.
 */
async function enrichBatchStatusData(cwd: string, detail: MissionDetail): Promise<void> {
	const batch = detail.state.batch;
	if (!batch || !batch.tasks) return;
	const batchId = batch.batchId;
	if (!batchId) return;
	await Promise.all(
		batch.tasks.map(async task => {
			const statusPath = path.join(projectMissionsDir(cwd), batchId, "tasks", task.taskId, "STATUS.md");
			try {
				const content = await Bun.file(statusPath).text();
				const parsed = parseStatusMd(content);
				const total = parsed.steps.reduce((acc, s) => acc + s.totalItems, 0);
				const checked = parsed.steps.reduce((acc, s) => acc + s.totalChecked, 0);
				const currentStep =
					parsed.steps.find(s => s.status === "in-progress")?.name ??
					parsed.steps.find(s => s.status === "not-started")?.name ??
					parsed.steps.at(-1)?.name;
				task.statusData = {
					checked,
					total,
					currentStep,
					iteration: parsed.iteration,
					reviews: parsed.reviewCounter,
				};
			} catch (err) {
				if (!isEnoent(err)) {
					// Unparseable STATUS.md — leave statusData unset, dashboard falls back.
				}
			}
		}),
	);
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

/**
 * Read the on-disk exit summary written by either:
 *   - `agent-host.ts`  (batch lane runner) — final write at lane exit.
 *   - `index.ts`       (simple-mission accumulator) — incremental writes.
 *
 * Both writers share the same `tokens / cost / toolCalls / durationSec` shape.
 * The dashboard client expects camelCase token fields plus `durationMs`, so we
 * remap before serving. Returns null when no telemetry file exists yet.
 */
export async function getMissionTelemetrySummary(
	cwd: string,
	missionId: string,
): Promise<TelemetrySummaryResponse | null> {
	const file = Bun.file(path.join(telemetryDir(cwd, missionId), "exit-summary.json"));
	try {
		const raw = (await file.json()) as ServerExitSummary;
		return mapExitSummary(raw);
	} catch (err) {
		if (isEnoent(err)) return null;
		return null;
	}
}

interface ServerExitSummary {
	exitCode?: number | null;
	tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null;
	cost?: number | null;
	toolCalls?: number;
	durationSec?: number;
	lastToolCall?: string | null;
	error?: string | null;
	contextPct?: number | null;
	retries?: number | null;
	retryActive?: boolean | null;
	lastRetryError?: string | null;
	compactions?: number | null;
}

export interface TelemetrySummaryResponse {
	exitCode?: number;
	durationMs?: number;
	tokens?: {
		inputTokens: number;
		outputTokens: number;
		cacheCreationInputTokens: number;
		cacheReadInputTokens: number;
		totalCostUsd: number;
	};
	toolCalls?: number;
	lastToolCall?: string;
	error?: string;
	contextPct?: number;
	retries?: number;
	retryActive?: boolean;
	lastRetryError?: string;
	compactions?: number;
}

/** Map server-side exit-summary fields onto the client `TelemetrySummary` shape. */
function mapExitSummary(raw: ServerExitSummary): TelemetrySummaryResponse {
	const t = raw.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const result: TelemetrySummaryResponse = {
		tokens: {
			inputTokens: t.input ?? 0,
			outputTokens: t.output ?? 0,
			cacheCreationInputTokens: t.cacheWrite ?? 0,
			cacheReadInputTokens: t.cacheRead ?? 0,
			totalCostUsd: raw.cost ?? 0,
		},
		toolCalls: raw.toolCalls ?? 0,
	};
	if (typeof raw.exitCode === "number") result.exitCode = raw.exitCode;
	if (typeof raw.durationSec === "number") result.durationMs = raw.durationSec * 1000;
	if (raw.lastToolCall) result.lastToolCall = raw.lastToolCall;
	if (raw.error) result.error = raw.error;
	if (typeof raw.contextPct === "number") result.contextPct = raw.contextPct;
	if (typeof raw.retries === "number" && raw.retries > 0) result.retries = raw.retries;
	if (raw.retryActive) result.retryActive = true;
	if (raw.lastRetryError) result.lastRetryError = raw.lastRetryError;
	if (typeof raw.compactions === "number" && raw.compactions > 0) result.compactions = raw.compactions;
	return result;
}

export interface SupervisorEvent {
	ts: string;
	action: string;
	classification?: string;
	detail: string;
}

export async function getMissionActivity(cwd: string, id: string): Promise<SupervisorEvent[]> {
	const mission = await getMission(cwd, id);
	if (!mission) return [];
	return (mission.state.progressLog ?? []).map((entry: { timestamp: string; type: string; detail: string }) => ({
		ts: entry.timestamp,
		action: entry.type,
		detail: entry.detail,
	}));
}

export interface AgentStatusEntry {
	agentId: string;
	role: string;
	status: string;
	pid?: number;
}

export interface AgentStatusResult {
	batchId: string | null;
	registry: { agents: AgentStatusEntry[] } | null;
}

function slugifyPhaseName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export async function getMissionAgentStatus(cwd: string, id: string): Promise<AgentStatusResult> {
	const mission = await getMission(cwd, id);
	if (!mission) return { batchId: null, registry: null };
	const agents: AgentStatusEntry[] = [];
	for (const phase of mission.state.phases ?? []) {
		if (phase.status === "skipped") continue;
		const status = phase.status === "active" ? "running" : phase.status === "done" ? "completed" : "pending";
		agents.push({
			agentId: `phase-${slugifyPhaseName(phase.name)}`,
			role: phase.name,
			status,
		});
	}
	return { batchId: id, registry: { agents } };
}
