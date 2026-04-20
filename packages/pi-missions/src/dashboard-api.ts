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
import type { AuditTrailEntry, SupervisorLockfile, Tier0EventSummary } from "./missioncontrol";
import {
	isLockStale,
	parseStatusMd,
	readAuditTrail,
	readLockfile,
	readTier0EventsForBatch,
	supervisorDir,
} from "./missioncontrol";
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
	if (!batch?.tasks) return;
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

// ---------------------------------------------------------------------------
// Supervisor detail (for /api/supervisor/detail)
// ---------------------------------------------------------------------------

export interface SupervisorStatus {
	state: "active" | "stale" | "inactive";
	lock: SupervisorLockfile | null;
	heartbeatAgeMs: number | null;
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
};

function labelForAction(action: string): string {
	const known = RECOVERY_ACTION_LABELS[action];
	if (known) return known;
	if (!action) return "event";
	const spaced = action.replace(/_/g, " ").trim();
	return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : action;
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

export async function getSupervisorDetail(cwd: string, batchId?: string): Promise<SupervisorDetail> {
	const lock = readLockfile(cwd);
	const effectiveBatchId = batchId ?? lock?.batchId;

	const heartbeatAgeMs = lock ? Date.now() - new Date(lock.heartbeat).getTime() : null;
	const status: SupervisorStatus = {
		state: !lock ? "inactive" : isLockStale(lock) ? "stale" : "active",
		lock,
		heartbeatAgeMs: heartbeatAgeMs !== null && Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs : null,
	};

	const [conversation, summary] = await Promise.all([readSupervisorConversation(cwd), readSupervisorSummary(cwd)]);

	let auditEntries: AuditTrailEntry[] = [];
	try {
		auditEntries = readAuditTrail(cwd, { limit: 500, batchId: effectiveBatchId });
	} catch {
		auditEntries = [];
	}
	const tier0Events = effectiveBatchId ? readTier0EventsForBatch(cwd, effectiveBatchId) : [];

	const timeline: SupervisorTimelineEntry[] = [
		...auditEntries.map(auditEntryToTimeline),
		...tier0Events.map(tier0EventToTimeline),
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
