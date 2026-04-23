/**
 * Shared orchestrator handlers (Track J1).
 *
 * Each `orch_*` tool has a thin wrapper in `supervisor-tools.ts` that
 * validates input + formats text output. The same backend logic is
 * surfaced to the dashboard via the same handlers so the web UI never
 * diverges from the CLI tool surface.
 *
 * Every handler returns a typed result object; transport-specific
 * serialisation (TextResult for tools, JSON for API) lives at the edge.
 */

import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { projectDir } from "./adapter";
import type { MissionRole } from "./config-schema";
import { readKnowledgeEntries, summariseKnowledge } from "./knowledge";
import { listDraftSkills, listPromotedSkills, type SkillEntry } from "./mission-skills";
import { loadBatchState, saveBatchState } from "./persistence";
import { finalizePlan, loadPlanManifest } from "./planning";
import { describeAllRoleModels, isMissionRole, persistRoleModelOverride } from "./role-models";
import type { MissionRollup, TelemetryRole, TelemetrySample } from "./telemetry-rollup";
import { rollupBatchState } from "./telemetry-rollup";
import type { Milestone, PersistedBatchState } from "./types";
import { DEFAULT_MILESTONE_MAX_VALIDATION_ROUNDS } from "./types";
import type { BehavioralAssertion, ValidationContract } from "./validation-contract";
import {
	addAssertion,
	createEmptyContract,
	loadValidationContract,
	saveValidationContract,
	validateAssertionId,
} from "./validation-contract";

// \u2500\u2500 Validation contract handlers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface WriteValidationContractInput {
	cwd: string;
	missionId: string;
	assertions: BehavioralAssertion[];
	now?: number;
}

export async function handleWriteValidationContract(input: WriteValidationContractInput): Promise<ValidationContract> {
	for (const a of input.assertions) {
		const err = validateAssertionId(a.id);
		if (err) throw new Error(`Invalid assertion: ${err}`);
	}
	const seen = new Set<string>();
	for (const a of input.assertions) {
		if (seen.has(a.id)) throw new Error(`Duplicate assertion id "${a.id}"`);
		seen.add(a.id);
	}
	const now = input.now ?? Date.now();
	const existing = await loadValidationContract(input.cwd).catch(() => null);
	const contract: ValidationContract = {
		schemaVersion: 1,
		missionId: existing?.missionId ?? input.missionId,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		assertions: input.assertions,
	};
	await saveValidationContract(input.cwd, contract);
	return contract;
}

export interface AddAssertionInput {
	cwd: string;
	missionId: string;
	assertion: BehavioralAssertion;
	now?: number;
}

export async function handleAddAssertion(input: AddAssertionInput): Promise<ValidationContract> {
	const now = input.now ?? Date.now();
	let contract = await loadValidationContract(input.cwd).catch(() => null);
	if (!contract) contract = createEmptyContract(input.missionId, now);
	const next = addAssertion(contract, input.assertion, now);
	await saveValidationContract(input.cwd, next);
	return next;
}

export async function handleReadValidationContract(cwd: string): Promise<ValidationContract | null> {
	return loadValidationContract(cwd).catch(() => null);
}

// \u2500\u2500 Milestone handlers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface CreateMilestoneInput {
	cwd: string;
	id: string;
	name: string;
	featureIds?: string[];
	assertionIds?: string[];
	maxValidationRounds?: number;
}

export interface MilestoneWriteResult {
	milestone: Milestone;
	milestoneCount: number;
}

export async function handleCreateMilestone(input: CreateMilestoneInput): Promise<MilestoneWriteResult> {
	if (!input.id || input.id.trim().length === 0) throw new Error("milestone id required");
	if (!input.name || input.name.trim().length === 0) throw new Error("milestone name required");
	const state = await loadBatchState(input.cwd);
	if (!state) throw new Error("No persisted batch state found \u2014 cannot create milestone.");
	const milestones: Milestone[] = state.milestones ? [...state.milestones] : [];
	const existingIdx = milestones.findIndex(m => m.id === input.id);
	const milestone: Milestone = {
		id: input.id,
		name: input.name,
		featureIds: [...(input.featureIds ?? [])],
		assertionIds: [...(input.assertionIds ?? [])],
		status: "pending",
		validationRounds: 0,
		maxValidationRounds: input.maxValidationRounds ?? DEFAULT_MILESTONE_MAX_VALIDATION_ROUNDS,
	};
	if (existingIdx >= 0) {
		const prior = milestones[existingIdx];
		if (prior) {
			milestone.status = prior.status;
			milestone.validationRounds = prior.validationRounds;
			if (prior.startedAt !== undefined) milestone.startedAt = prior.startedAt;
			if (prior.endedAt !== undefined) milestone.endedAt = prior.endedAt;
		}
		milestones[existingIdx] = milestone;
	} else {
		milestones.push(milestone);
	}
	state.milestones = milestones;
	for (const t of state.tasks) {
		if (milestone.featureIds.includes(t.taskId)) t.milestoneId = milestone.id;
	}
	await saveBatchState(JSON.stringify(state, null, 2), input.cwd);
	return { milestone, milestoneCount: milestones.length };
}

export interface MilestoneStatusRow {
	milestone: Milestone;
	boundAssertions: BehavioralAssertion[];
}

export interface ValidationStatusResult {
	batchId: string;
	contract: ValidationContract | null;
	rows: MilestoneStatusRow[];
}

export async function handleReadValidationStatus(
	cwd: string,
	milestoneId?: string,
): Promise<ValidationStatusResult | null> {
	const state = await loadBatchState(cwd);
	if (!state) return null;
	const milestones = state.milestones ?? [];
	const scope = milestoneId ? milestones.filter(m => m.id === milestoneId) : milestones;
	const contract = await loadValidationContract(cwd).catch(() => null);
	const rows: MilestoneStatusRow[] = scope.map(m => ({
		milestone: m,
		boundAssertions: contract
			? contract.assertions.filter(a => m.assertionIds.includes(a.id) || a.milestoneId === m.id)
			: [],
	}));
	return { batchId: state.batchId, contract, rows };
}

// \u2500\u2500 Knowledge handlers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export async function handleReadKnowledge(cwd: string, scope?: string, limit: number = 20): Promise<string> {
	return summariseKnowledge(cwd, scope, limit);
}

export async function handleKnowledgeEntries(cwd: string): Promise<Awaited<ReturnType<typeof readKnowledgeEntries>>> {
	return readKnowledgeEntries(cwd);
}

// \u2500\u2500 Plan manifest handlers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export async function handleReadPlanManifest(cwd: string) {
	return loadPlanManifest(cwd);
}

export interface ApprovePlanInput {
	cwd: string;
	missionId: string;
	milestoneIds: string[];
	featureIds: string[];
	approvedBy: string;
	now?: () => Date;
}

export async function handleApprovePlan(input: ApprovePlanInput) {
	return finalizePlan({
		cwd: input.cwd,
		missionId: input.missionId,
		milestoneIds: input.milestoneIds,
		featureIds: input.featureIds,
		status: "approved",
		approvedBy: input.approvedBy,
		now: input.now,
	});
}

// \u2500\u2500 Role model handlers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface SetRoleModelInput {
	cwd: string;
	role: string;
	model: string;
}

export interface SetRoleModelResult {
	role: MissionRole;
	model: string;
	cleared: boolean;
}

export function handleSetRoleModel(input: SetRoleModelInput): SetRoleModelResult {
	if (!isMissionRole(input.role)) {
		throw new Error(
			`Invalid role "${input.role}". Expected one of: orchestrator, worker, scrutiny_validator, user_testing_validator.`,
		);
	}
	const updated = persistRoleModelOverride(input.cwd, input.role, input.model);
	const bound = updated[input.role] ?? "";
	return {
		role: input.role,
		model: bound,
		cleared: bound.length === 0,
	};
}

export async function handleReadRoleModels(cwd: string, defaultModel: string = "") {
	const { loadProjectConfig } = await import("./config-loader");
	const config = loadProjectConfig(cwd);
	return describeAllRoleModels(config, defaultModel);
}

// \u2500\u2500 Telemetry handlers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export async function handleTelemetryRollup(cwd: string): Promise<MissionRollup | null> {
	const state = await loadBatchState(cwd);
	if (!state) return null;
	const extraSamples = await loadPerRoleSidecarSamples(cwd, state.batchId);
	return rollupBatchState(state, extraSamples);
}

/**
 * Per-role sidecar roles whose telemetry is not captured in the batch's
 * `diagnostics.taskExits` map. Each role's sidecar lives at
 * `.omp/mission-telemetry/<batchId>/<role>.jsonl` and is written by the
 * runtime when the corresponding agent runs. We aggregate each sidecar
 * into a single {@link TelemetrySample} so the Per-Role panel shows the
 * orchestrator + validator columns populated even when the batch only
 * wrote worker-level `taskExits`.
 */
const SIDECAR_TELEMETRY_ROLES: readonly TelemetryRole[] = [
	"orchestrator",
	"scrutiny_validator",
	"user_testing_validator",
];

async function loadPerRoleSidecarSamples(cwd: string, batchId: string): Promise<TelemetrySample[]> {
	const samples: TelemetrySample[] = [];
	await Promise.all(
		SIDECAR_TELEMETRY_ROLES.map(async role => {
			const sample = await readRoleSidecar(cwd, batchId, role);
			if (sample) samples.push(sample);
		}),
	);
	return samples;
}

async function readRoleSidecar(cwd: string, batchId: string, role: TelemetryRole): Promise<TelemetrySample | null> {
	const sidecarPath = path.join(projectDir(cwd), "mission-telemetry", batchId, `${role}.jsonl`);
	let text: string;
	try {
		text = await Bun.file(sidecarPath).text();
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let toolCalls = 0;
	let firstTs: number | null = null;
	let lastTs: number | null = null;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const ts = typeof event.ts === "number" ? event.ts : null;
		if (ts !== null) {
			if (firstTs === null || ts < firstTs) firstTs = ts;
			if (lastTs === null || ts > lastTs) lastTs = ts;
		}
		if (event.type === "tool_execution_start") toolCalls += 1;
		if (event.type === "message_end") {
			const usage = event.usage as Record<string, unknown> | undefined;
			if (usage) {
				input += numberOr(usage.input, 0);
				output += numberOr(usage.output, 0);
				cacheRead += numberOr(usage.cacheRead, 0);
				cacheWrite += numberOr(usage.cacheWrite, 0);
				cost += numberOr(usage.cost, 0);
			}
		}
	}
	if (input === 0 && output === 0 && toolCalls === 0) return null;
	const durationMs = firstTs !== null && lastTs !== null ? Math.max(0, lastTs - firstTs) : 0;
	return {
		role,
		sourceId: `${batchId}-${role}`,
		durationMs,
		inputTokens: input,
		outputTokens: output,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		costUsd: cost,
		toolCalls,
	};
}

function numberOr(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Thin alias \u2014 exposes PersistedBatchState milestones for read-side endpoints. */
export async function handleLoadMilestones(cwd: string): Promise<Milestone[]> {
	const state = await loadBatchState(cwd);
	return state?.milestones ?? [];
}

/** Passthrough re-exports so `handleLoadBatchState` can live on the API edge. */
export async function handleLoadBatchState(cwd: string): Promise<PersistedBatchState | null> {
	return loadBatchState(cwd);
}

// ── Skill discovery handlers (Track J/E2) ─────────────────

/** Response shape for `orch_list_skills` / `/api/mission/:id/skills`. */
export interface ListSkillsResult {
	promoted: SkillEntry[];
	drafts: SkillEntry[];
}

/**
 * Discover promoted + draft mission skills under `<cwd>/.omp/skills/`.
 * Read-only: no writes, no network. Empty roots return empty arrays.
 */
export async function handleListSkills(cwd: string): Promise<ListSkillsResult> {
	const [promoted, drafts] = await Promise.all([listPromotedSkills(cwd), listDraftSkills(cwd)]);
	return { promoted, drafts };
}
