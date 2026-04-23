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

import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type {
	AuditTrailEntry,
	EngineEventSummary,
	PersistedBatchState,
	RuntimeLaneSnapshot,
	SupervisorLockfile,
	Tier0EventSummary,
} from "./missioncontrol";
import {
	createSidecarTailState,
	isLockStale,
	loadBatchState,
	loadSupervisorConfig,
	parseStatusMd,
	readAuditTrail,
	readEngineEventsForBatch,
	readLockfile,
	readRegistrySnapshot,
	readReviewerTelemetrySnapshot,
	readTier0EventsForBatch,
	runtimeAgentEventsPath,
	runtimeLaneSnapshotPath,
	supervisorDir,
	tailSidecarJsonl,
} from "./missioncontrol";
import { readSidecar } from "./telemetry/sidecar";
import type { BatchState, LaneStatus, MergeResult, MissionState, ReviewerStatus, TaskOutcome } from "./types";

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
	/** Batch task counts (absent for simple missions). */
	tasksTotal?: number;
	tasksComplete?: number;
	tasksFailed?: number;
	/** Aggregate token totals summed across all batch tasks. */
	aggregateTokens?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	};
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

/**
 * Read `.omp/mission-batch.json` and project it into a dashboard MissionDetail.
 *
 * The same file path is used by two distinct writers: `saveActiveBatch`
 * persists a MissionState (legacy active-mission shape, with `description` and
 * optional nested `batch`) while `saveBatchState` persists a PersistedBatchState
 * (V5 schema with top-level `batchId`/`schemaVersion` and no `description`).
 *
 * Both shapes are projected into the dashboard `MissionDetail` so active batch
 * missions remain visible in the list while the engine is writing V5 state.
 * When a matching archive at `.omp/missions/<batchId>.json` also exists the
 * historical reader surfaces it separately; {@link listMissions} prefers the
 * active entry by unshifting it ahead of the historical list.
 */
async function readActiveBatch(cwd: string): Promise<MissionDetail | null> {
	const file = Bun.file(batchStatePath(cwd));
	if (!(await file.exists())) return null;
	try {
		const raw = (await file.json()) as Record<string, unknown>;
		if (isPersistedBatchStateShape(raw)) {
			return projectPersistedBatchToDetail(raw as unknown as PersistedBatchState);
		}
		const state = raw as unknown as MissionState;
		return toDetail(state.batch?.batchId ?? "active", state);
	} catch {
		return null;
	}
}

/**
 * Detect the PersistedBatchState shape emitted by `saveBatchState`. These
 * files have `schemaVersion` + top-level `batchId` and no MissionState-style
 * `description` field. They are read by {@link loadBatchState} for milestone,
 * rollup, and validation-status endpoints — and now also projected into the
 * mission list so active batch missions stay visible.
 */
function isPersistedBatchStateShape(raw: Record<string, unknown>): boolean {
	return (
		typeof raw.schemaVersion === "number" &&
		typeof raw.batchId === "string" &&
		!("description" in raw) &&
		!("batch" in raw)
	);
}

/**
 * Map an engine-side `MissionBatchPhase` onto the dashboard wire `BatchPhase`.
 * The engine uses `"executing"/"stopped"/"completed"/"failed"` while the
 * dashboard renders `"running"/"aborted"/"complete"/"error"`.
 */
function mapPersistedPhaseToWire(phase: string): BatchState["phase"] {
	switch (phase) {
		case "executing":
			return "running";
		case "launching":
			return "planning";
		case "stopped":
			return "aborted";
		case "completed":
			return "complete";
		case "failed":
			return "error";
		case "idle":
		case "planning":
		case "merging":
		case "paused":
			return phase;
		default:
			return "running";
	}
}

/**
 * Project a V5 `PersistedBatchState` into a dashboard `MissionDetail`. Used
 * when `.omp/mission-batch.json` holds the engine-side schema — the historical
 * MissionState archive is not written until the mission reaches a terminal
 * state, so without this projection active batch missions are invisible in
 * the dashboard list.
 */
function projectPersistedBatchToDetail(persisted: PersistedBatchState): MissionDetail {
	const tasks: TaskOutcome[] = (persisted.tasks ?? []).map(t => ({
		taskId: t.taskId,
		status: t.status,
		startTime: t.startedAt,
		endTime: t.endedAt,
		exitReason: t.exitReason,
		sessionName: t.sessionName,
		doneFileFound: t.doneFileFound,
		laneNumber: t.laneNumber,
		repoId: t.repoId,
		resolvedRepoId: t.resolvedRepoId,
		segmentIds: t.segmentIds ? [...t.segmentIds] : undefined,
		activeSegmentId: t.activeSegmentId ?? undefined,
	}));

	const runningByLane = new Map<number, TaskOutcome>();
	for (const task of tasks) {
		if (task.status === "running" && task.laneNumber != null && !runningByLane.has(task.laneNumber)) {
			runningByLane.set(task.laneNumber, task);
		}
	}

	const laneStatuses: LaneStatus[] = (persisted.lanes ?? []).map(l => {
		const current = runningByLane.get(l.laneNumber);
		const status: LaneStatus["status"] = current ? "running" : "idle";
		const entry: LaneStatus = {
			lane: l.laneNumber,
			taskId: current?.taskId ?? null,
			status,
			stepProgress: "",
			iteration: 0,
			elapsed: 0,
			sessionName: l.laneSessionId,
		};
		if (l.repoId) entry.repoId = l.repoId;
		return entry;
	});

	const waves = (persisted.wavePlan ?? []).map((taskIds, i) => ({ wave: i, taskIds: [...taskIds] }));
	const wirePhase = mapPersistedPhaseToWire(persisted.phase);

	const batchState: BatchState = {
		batchId: persisted.batchId,
		phase: wirePhase,
		waves,
		currentWave: persisted.currentWaveIndex ?? 0,
		laneCount: laneStatuses.length,
		laneStatuses,
		tasks,
		tasksTotal: persisted.totalTasks ?? tasks.length,
		tasksComplete: persisted.succeededTasks ?? 0,
		tasksFailed: persisted.failedTasks ?? 0,
		startTime: persisted.startedAt ?? Date.now(),
		errors: persisted.errors ? [...persisted.errors] : [],
	};
	if (persisted.endedAt != null) batchState.endTime = persisted.endedAt;
	if (persisted.mode === "workspace" || persisted.mode === "repo") batchState.mode = persisted.mode;

	const startedAtIso = new Date(persisted.startedAt ?? Date.now()).toISOString();
	// `completedAt` drives `resolveStatus` → "completed" badge. Only set it
	// when the engine has actually finished the batch; `failed`/`stopped`
	// surface through the wire-phase mapping as "error"/"aborted" instead so
	// the mission list shows a "failed" badge.
	const completedAtIso =
		persisted.endedAt != null && persisted.phase === "completed"
			? new Date(persisted.endedAt).toISOString()
			: undefined;

	const state: MissionState = {
		description: persisted.batchId,
		mode: "simple",
		phases: [],
		autonomy: "auto",
		modelAssignment: {},
		paused: persisted.phase === "paused",
		pauseHistory: [],
		progressLog: [],
		startedAt: startedAtIso,
		kind: "batch",
		batch: batchState,
	};
	if (completedAtIso) state.completedAt = completedAtIso;

	return toDetail(persisted.batchId, state);
}

function toDetail(id: string, state: MissionState): MissionDetail {
	const kind: "simple" | "batch" = state.kind ?? (state.batch ? "batch" : "simple");
	const status = resolveStatus(state);
	const batch = state.batch;
	const agg = batch ? aggregateBatchTelemetry(batch) : null;
	return {
		id,
		description: state.description,
		kind,
		status,
		startedAt: state.startedAt,
		completedAt: state.completedAt,
		phaseCount: state.phases?.length,
		completedPhases: state.phases?.filter(p => p.status === "done").length,
		batchPhase: batch?.phase,
		laneCount: batch?.laneCount,
		tasksTotal: batch?.tasksTotal,
		tasksComplete: batch?.tasksComplete,
		tasksFailed: batch?.tasksFailed,
		cost: agg?.costUsd,
		aggregateTokens: agg
			? {
					inputTokens: agg.inputTokens,
					outputTokens: agg.outputTokens,
					cacheReadTokens: agg.cacheReadTokens,
					cacheWriteTokens: agg.cacheWriteTokens,
				}
			: undefined,
		state,
	};
}

/**
 * Sum per-task telemetry into batch-wide totals. Returns null when the batch
 * has no tasks with telemetry (so the caller can omit the aggregate fields).
 */
function aggregateBatchTelemetry(batch: BatchState): {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
} | null {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let any = false;
	for (const t of batch.tasks ?? []) {
		const tel = t.telemetry;
		if (!tel) continue;
		any = true;
		input += tel.inputTokens;
		output += tel.outputTokens;
		cacheRead += tel.cacheReadTokens;
		cacheWrite += tel.cacheWriteTokens;
		cost += tel.costUsd;
	}
	if (!any) return null;
	return {
		inputTokens: input,
		outputTokens: output,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		costUsd: cost,
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
	if (active) {
		// Drop a historical entry sharing the active batch id so the dashboard
		// shows a single row with live status/telemetry while the engine is
		// still writing the V5 state file.
		const dedup = all.filter(m => m.id !== active.id);
		dedup.unshift(active);
		return dedup.map(({ state: _state, ...summary }) => summary);
	}
	return all.map(({ state: _state, ...summary }) => summary);
}

export async function getMission(cwd: string, id: string): Promise<MissionDetail | null> {
	const detail = await loadMissionRecord(cwd, id);
	if (!detail) return null;
	await enrichBatchStatusData(cwd, detail);
	return detail;
}

async function loadMissionRecord(cwd: string, id: string): Promise<MissionDetail | null> {
	// Active batch wins when its id matches. The engine rewrites the V5 state
	// while the mission is running; a stale MissionState archive may linger
	// from a prior completion and would mask live status/telemetry.
	const active = await readActiveBatch(cwd);
	if (active && active.id === id) return active;

	const file = Bun.file(path.join(projectMissionsDir(cwd), `${id}.json`));
	try {
		const state = (await file.json()) as MissionState;
		return toDetail(id, state);
	} catch (err) {
		if (!isEnoent(err)) {
			// Malformed mission file — fall through. No logging: listMissions
			// already skips unreadable files.
		}
	}
	return null;
}

/**
 * For batch missions, hydrate each task with parsed STATUS.md progress, plus
 * engine-side fields (repoId, segments, merge results, mode) from the
 * PersistedBatchState and live per-lane V2 telemetry snapshots.
 *
 * Best-effort — missing/unparseable files leave the corresponding fields unset.
 */
async function enrichBatchStatusData(cwd: string, detail: MissionDetail): Promise<void> {
	const batch = detail.state.batch;
	if (!batch?.tasks) return;
	const batchId = batch.batchId;
	if (!batchId) return;

	// Parallelize: STATUS.md parsing (per task) + persisted-state merge + V2 snapshot enrichment.
	await Promise.all([
		enrichStatusMdPerTask(cwd, batchId, batch),
		enrichFromPersistedBatchState(cwd, batchId, batch),
		enrichFromV2Snapshots(cwd, batchId, batch),
	]);
}

async function enrichStatusMdPerTask(cwd: string, batchId: string, batch: BatchState): Promise<void> {
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

/**
 * Merge in fields from `.omp/mission-batch.json`: per-lane/task repoId, task
 * segment identity, workspace mode, and per-wave merge results.
 */
async function enrichFromPersistedBatchState(cwd: string, batchId: string, batch: BatchState): Promise<void> {
	let persisted: PersistedBatchState | null;
	try {
		persisted = await loadBatchState(cwd);
	} catch {
		// Malformed or missing persisted state — dashboard still renders from MissionState.
		return;
	}
	if (!persisted || persisted.batchId !== batchId) return;

	// Mode.
	if (persisted.mode === "workspace" || persisted.mode === "repo") {
		batch.mode = persisted.mode;
	}

	// Per-task repoId / resolvedRepoId / segmentIds / activeSegmentId.
	const taskById = new Map(batch.tasks.map(t => [t.taskId, t] as const));
	for (const rec of persisted.tasks ?? []) {
		const task = taskById.get(rec.taskId);
		if (!task) continue;
		if (typeof rec.repoId === "string") task.repoId = rec.repoId;
		if (typeof rec.resolvedRepoId === "string") task.resolvedRepoId = rec.resolvedRepoId;
		if (Array.isArray(rec.segmentIds)) task.segmentIds = [...rec.segmentIds];
		if (rec.activeSegmentId !== undefined) task.activeSegmentId = rec.activeSegmentId;
	}

	// Per-lane repoId.
	const laneByNumber = new Map(batch.laneStatuses.map(l => [l.lane, l] as const));
	for (const laneRec of persisted.lanes ?? []) {
		const lane = laneByNumber.get(laneRec.laneNumber);
		if (!lane) continue;
		if (typeof laneRec.repoId === "string") lane.repoId = laneRec.repoId;
	}

	// Merge results — convert persisted shape to wire shape. Persisted status is
	// narrower ("succeeded" | "failed" | "partial"); dashboard also shows
	// "skipped" occasionally but only engine emits those on the wire.
	if (persisted.mergeResults && persisted.mergeResults.length > 0) {
		batch.mergeResults = persisted.mergeResults.map<MergeResult>(mr => ({
			waveIndex: mr.waveIndex,
			status: mr.status,
			failedLane: mr.failedLane,
			failureReason: mr.failureReason,
			repoResults: mr.repoResults?.map(rr => ({
				repoId: rr.repoId,
				status: rr.status,
				laneNumbers: [...rr.laneNumbers],
				failedLane: rr.failedLane,
				failureReason: rr.failureReason,
			})),
		}));
	}
}

/**
 * Enrich with live per-lane V2 snapshots: `worker.contextPct`, `worker.lastTool`,
 * reviewer sub-row telemetry, and per-worker retry/compaction counters (when the
 * events.jsonl sidecar is available).
 */
async function enrichFromV2Snapshots(cwd: string, batchId: string, batch: BatchState): Promise<void> {
	const taskById = new Map(batch.tasks.map(t => [t.taskId, t] as const));

	await Promise.all(
		batch.laneStatuses.map(async lane => {
			const snapshot = await readLaneSnapshotRaw(cwd, batchId, lane.lane);
			if (!snapshot) return;

			const activeTaskId = snapshot.taskId ?? lane.taskId;
			const task = activeTaskId ? taskById.get(activeTaskId) : undefined;

			// Worker telemetry → enrich current task.
			if (task && snapshot.worker) {
				const worker = snapshot.worker;
				const tel = task.telemetry ?? {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					costUsd: 0,
					toolCalls: 0,
					durationMs: 0,
				};
				if (worker.contextPct > 0) tel.contextPct = worker.contextPct;
				if (worker.lastTool) tel.lastTool = worker.lastTool;
				task.telemetry = tel;
			}

			// Reviewer sub-row (V2 snapshot takes precedence; fallback to .reviewer-state.json).
			const reviewerStatus = resolveReviewerStatus(cwd, batchId, lane, snapshot);
			if (reviewerStatus) lane.reviewer = reviewerStatus;

			// Retry/compaction counters from the worker's events.jsonl, when present.
			if (task) {
				const counters = tailWorkerCounters(cwd, batchId, lane.lane);
				if (counters) {
					const tel = task.telemetry ?? {
						inputTokens: 0,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						costUsd: 0,
						toolCalls: 0,
						durationMs: 0,
					};
					if (counters.retries > 0) tel.retries = counters.retries;
					if (counters.retryActive) tel.retryActive = true;
					task.telemetry = tel;
				}
			}
		}),
	);
}

async function readLaneSnapshotRaw(
	cwd: string,
	batchId: string,
	laneNumber: number,
): Promise<RuntimeLaneSnapshot | null> {
	const file = Bun.file(runtimeLaneSnapshotPath(cwd, batchId, laneNumber));
	try {
		return (await file.json()) as RuntimeLaneSnapshot;
	} catch (err) {
		if (!isEnoent(err)) return null;
		return null;
	}
}

function resolveReviewerStatus(
	cwd: string,
	batchId: string,
	lane: LaneStatus,
	snapshot: RuntimeLaneSnapshot,
): ReviewerStatus | null {
	const rv = snapshot.reviewer;
	if (rv && rv.status === "running") {
		return {
			active: true,
			elapsedMs: rv.elapsedMs,
			toolCalls: rv.toolCalls,
			contextPct: rv.contextPct,
			costUsd: rv.costUsd,
			lastTool: rv.lastTool || undefined,
			inputTokens: rv.inputTokens,
			outputTokens: rv.outputTokens,
			cacheReadTokens: rv.cacheReadTokens,
			cacheWriteTokens: rv.cacheWriteTokens,
		};
	}
	// Fall back to `.reviewer-state.json` beside STATUS.md for the running task.
	const taskId = snapshot.taskId ?? lane.taskId;
	if (!taskId) return null;
	const reviewerPath = path.join(projectMissionsDir(cwd), batchId, "tasks", taskId, ".reviewer-state.json");
	const snap = readReviewerTelemetrySnapshot({ agentIdPrefix: "mission", laneNumber: lane.lane }, reviewerPath);
	if (!snap) return null;
	return {
		active: true,
		reviewType: (snap as { reviewType?: string }).reviewType,
		reviewStep: (snap as { reviewStep?: number }).reviewStep,
		elapsedMs: snap.elapsedMs,
		toolCalls: snap.toolCalls,
		contextPct: snap.contextPct,
		costUsd: snap.costUsd,
		lastTool: snap.lastTool || undefined,
		inputTokens: snap.inputTokens,
		outputTokens: snap.outputTokens,
		cacheReadTokens: snap.cacheReadTokens,
		cacheWriteTokens: snap.cacheWriteTokens,
	};
}

/**
 * Tail the worker's per-agent events.jsonl to derive retry counters.
 * Agent ID derivation uses the lane's persisted session prefix when possible;
 * we approximate by scanning `<agentsDir>` for a worker-role agent on this lane.
 */
interface WorkerCounters {
	retries: number;
	retryActive: boolean;
}
function tailWorkerCounters(cwd: string, batchId: string, laneNumber: number): WorkerCounters | null {
	// Stateful sidecar tail is designed for incremental reads; for a one-shot
	// projection we use a fresh state and read the whole file.
	const agentsDir = path.join(cwd, ".omp", "runtime", batchId, "agents");
	const candidate = discoverWorkerAgentId(agentsDir, laneNumber);
	if (!candidate) return null;
	const eventsPath = runtimeAgentEventsPath(cwd, batchId, candidate);
	const tailState = createSidecarTailState();
	// Collect deltas over the entire file by tailing repeatedly until idle.
	let retries = 0;
	for (let guard = 0; guard < 4; guard++) {
		const delta = tailSidecarJsonl(eventsPath, tailState);
		if (!delta.hadEvents) break;
		retries += delta.retriesStarted;
	}
	return { retries, retryActive: tailState.retryActive };
}

function discoverWorkerAgentId(agentsDir: string, laneNumber: number): string | null {
	// Manifest filenames equal agent IDs. A worker on lane N ends with `-lane-<N>-worker`.
	try {
		const entries = fs.readdirSync(agentsDir);
		const suffix = `-lane-${laneNumber}-worker`;
		for (const entry of entries) {
			if (entry.endsWith(suffix)) return entry;
		}
	} catch {
		// Agents dir does not exist — engine has not started runtime V2 for this batch.
	}
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
	laneNumber?: number | null;
	taskId?: string | null;
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

	// Batch mission — surface the real V2 runtime registry so the client can
	// resolve lane numbers to agent IDs for the events endpoint.
	const batchId = mission.state.batch?.batchId;
	if (batchId) {
		const snapshot = readRegistrySnapshot(cwd, batchId);
		if (snapshot) {
			const agents: AgentStatusEntry[] = Object.values(snapshot.agents ?? {}).map(m => ({
				agentId: m.agentId,
				role: m.role,
				status: m.status,
				pid: m.pid,
				laneNumber: m.laneNumber ?? null,
				taskId: m.taskId ?? null,
			}));
			return { batchId, registry: { agents } };
		}
		return { batchId, registry: { agents: [] } };
	}

	// Simple mission — synthesize phase-indexed entries (no laneNumber).
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

// ---------------------------------------------------------------------------
// Supervisor detail (for /api/supervisor/detail)
// ---------------------------------------------------------------------------

export type SupervisorAutonomyLevel = "interactive" | "supervised" | "autonomous";

export interface SupervisorStatus {
	state: "active" | "stale" | "inactive";
	lock: SupervisorLockfile | null;
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
	/** ISO timestamp (normalized to string). */
	ts: string;
	/** Raw machine-readable action or event type. */
	action: string;
	/** Operator-facing label derived from `action`. */
	label: string;
	/** Tier classification: 0 = engine/Tier0 event, 1 = explicit recovery action. */
	tier: 0 | 1;
	/** Pending/success/failure/skipped when available. */
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

/**
 * Human-readable labels for known recovery action codes. Unknown codes fall
 * back to a prettified form of the raw code (`foo_bar_baz` → `Foo bar baz`).
 */
const RECOVERY_ACTION_LABELS: Readonly<Record<string, string>> = {
	read_batch_state: "Read batch state",
	read_status_md: "Read STATUS.md",
	read_events_jsonl: "Read events log",
	read_merge_results: "Read merge results",
	read_file: "Read file",
	run_git_status: "Run git status",
	run_git_log: "Run git log",
	run_git_diff: "Run git diff",
	retry_lane: "Retry lane",
	cleanup_worktree: "Clean up worktree",
	retry_merge: "Retry merge",
	reset_session: "Reset session collision",
	clear_git_lock: "Clear git lock",
	abort_batch: "Abort batch",
	abort_lane: "Abort lane",
	force_terminate: "Force terminate",
	edit_batch_state: "Edit batch state",
	git_reset: "git reset",
	git_merge: "git merge",
	git_checkout: "git checkout",
	remove_worktree: "Remove worktree",
	edit_status_md: "Edit STATUS.md",
	delete_branch: "Delete branch",
	skip_task: "Skip task",
	skip_wave: "Skip wave",
	tier0_recovery_attempt: "Tier 0 recovery attempt",
	tier0_recovery_success: "Tier 0 recovery success",
	tier0_recovery_exhausted: "Tier 0 recovery exhausted",
	tier0_escalation: "Tier 0 escalation",
	wave_start: "Wave started",
	task_complete: "Task completed",
	task_failed: "Task failed",
	merge_start: "Merge started",
	merge_success: "Merge succeeded",
	merge_failed: "Merge failed",
	batch_complete: "Batch complete",
	batch_paused: "Batch paused",
	milestone_started: "Milestone started",
	milestone_validating: "Milestone validating",
	milestone_passed: "Milestone passed",
	milestone_failed: "Milestone failed",
	validator_started: "Validator started",
	validator_completed: "Validator completed",
};

function labelForAction(action: string): string {
	const known = RECOVERY_ACTION_LABELS[action];
	if (known) return known;
	if (!action) return "event";
	const spaced = action.replace(/_/g, " ").trim();
	return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : action;
}

/**
 * Append an operator-authored supervisor conversation entry to
 * `.omp/supervisor/conversation.jsonl`. Used by the Start tab terminal so
 * messages typed before a batch is running are still captured in the shared
 * supervisor conversation log.
 */
export async function appendSupervisorConversation(cwd: string, entry: SupervisorConversationEntry): Promise<void> {
	const dir = supervisorDir(cwd);
	await fs.promises.mkdir(dir, { recursive: true });
	const line = `${JSON.stringify(entry)}\n`;
	await fs.promises.appendFile(path.join(dir, "conversation.jsonl"), line, "utf8");
}

async function readSupervisorConversation(cwd: string): Promise<SupervisorConversationEntry[]> {
	const file = Bun.file(path.join(supervisorDir(cwd), "conversation.jsonl"));
	let raw: string;
	try {
		raw = await file.text();
	} catch (err) {
		if (isEnoent(err)) return [];
		return [];
	}
	const trimmed = raw.trim();
	if (!trimmed) return [];
	// Parse line-by-line so one malformed entry doesn't discard the whole file.
	// Matches the resilience pattern used in readAuditTrail.
	const entries: SupervisorConversationEntry[] = [];
	for (const line of trimmed.split("\n")) {
		const text = line.trim();
		if (!text) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(text) as Record<string, unknown>;
		} catch {
			continue;
		}
		const role = typeof parsed.role === "string" ? parsed.role : undefined;
		const content = typeof parsed.content === "string" ? parsed.content : undefined;
		if (!role || content === undefined) continue;
		const ts =
			typeof parsed.ts === "string"
				? parsed.ts
				: typeof parsed.timestamp === "string"
					? parsed.timestamp
					: undefined;
		entries.push({ ts, role, content });
	}
	return entries;
}

async function readSupervisorSummary(cwd: string): Promise<string | null> {
	const file = Bun.file(path.join(supervisorDir(cwd), "summary.md"));
	try {
		return await file.text();
	} catch (err) {
		if (isEnoent(err)) return null;
		return null;
	}
}

function auditEntryToTimeline(entry: AuditTrailEntry): SupervisorTimelineEntry {
	return {
		ts: entry.ts,
		action: entry.action,
		label: labelForAction(entry.action),
		tier: 1,
		outcome: entry.result,
		classification: entry.classification,
		taskId: entry.taskId,
		laneNumber: entry.laneNumber,
		detail: entry.detail || undefined,
	};
}

function tier0EventToTimeline(ev: Tier0EventSummary): SupervisorTimelineEntry {
	return {
		ts: ev.timestamp,
		action: ev.type,
		label: labelForAction(ev.type),
		tier: 0,
		taskId: ev.taskId,
		reason: ev.error,
		detail: ev.resolution ?? ev.suggestion ?? undefined,
		classification: ev.pattern,
	};
}

function engineEventToTimeline(ev: EngineEventSummary): SupervisorTimelineEntry {
	let detail: string | undefined;
	if (ev.type === "task_complete" || ev.type === "task_failed") {
		const pieces: string[] = [];
		if (ev.laneNumber != null) pieces.push(`lane ${ev.laneNumber}`);
		if (typeof ev.durationMs === "number" && ev.durationMs > 0) pieces.push(`${Math.round(ev.durationMs / 1000)}s`);
		if (pieces.length > 0) detail = pieces.join(" · ");
	} else if (ev.type === "batch_complete") {
		const succeeded = ev.succeededTasks ?? 0;
		const failed = ev.failedTasks ?? 0;
		detail = `${succeeded} succeeded, ${failed} failed`;
	} else if (ev.type === "wave_start") {
		detail = `wave ${ev.waveIndex}`;
	}
	const entry: SupervisorTimelineEntry = {
		ts: ev.timestamp,
		action: ev.type,
		label: labelForAction(ev.type),
		tier: 0,
	};
	if (ev.taskId) entry.taskId = ev.taskId;
	if (typeof ev.laneNumber === "number") entry.laneNumber = ev.laneNumber;
	if (ev.type === "task_complete") entry.outcome = "succeeded";
	else if (ev.type === "task_failed") entry.outcome = "failed";
	const reason = ev.error || ev.reason;
	if (reason) entry.reason = reason;
	if (detail) entry.detail = detail;
	return entry;
}

export async function getSupervisorDetail(cwd: string, batchId?: string): Promise<SupervisorDetail> {
	const lock = readLockfile(cwd);
	const effectiveBatchId = batchId ?? lock?.batchId;

	const heartbeatAgeMs = lock ? Date.now() - new Date(lock.heartbeat).getTime() : null;
	let autonomy: SupervisorAutonomyLevel | undefined;
	try {
		const cfg = loadSupervisorConfig(cwd);
		if (cfg.autonomy === "interactive" || cfg.autonomy === "supervised" || cfg.autonomy === "autonomous") {
			autonomy = cfg.autonomy;
		}
	} catch {
		// Config missing or unreadable — leave autonomy undefined.
	}
	const status: SupervisorStatus = {
		state: !lock ? "inactive" : isLockStale(lock) ? "stale" : "active",
		lock,
		heartbeatAgeMs: heartbeatAgeMs !== null && Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs : null,
		...(autonomy ? { autonomy } : {}),
	};

	const [conversation, summary] = await Promise.all([readSupervisorConversation(cwd), readSupervisorSummary(cwd)]);

	let auditEntries: AuditTrailEntry[] = [];
	try {
		auditEntries = readAuditTrail(cwd, { limit: 500, batchId: effectiveBatchId });
	} catch {
		auditEntries = [];
	}
	const tier0Events = effectiveBatchId ? readTier0EventsForBatch(cwd, effectiveBatchId) : [];
	const engineEvents = effectiveBatchId ? readEngineEventsForBatch(cwd, effectiveBatchId) : [];

	const timeline: SupervisorTimelineEntry[] = [
		...auditEntries.map(auditEntryToTimeline),
		...tier0Events.map(tier0EventToTimeline),
		...engineEvents.map(engineEventToTimeline),
	];
	timeline.sort((a, b) => {
		const ta = Date.parse(a.ts);
		const tb = Date.parse(b.ts);
		if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
		if (Number.isNaN(ta)) return 1;
		if (Number.isNaN(tb)) return -1;
		return ta - tb;
	});

	return { status, conversation, timeline, summary };
}
