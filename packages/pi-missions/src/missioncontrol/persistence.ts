/**
 * Persistence layer — reads/writes `.omp/mission-batch.json` (active batch)
 * and `.omp/missions/<id>.json` (historical) using Bun-native I/O.
 *
 * Also handles legacy-path migration: if `.pi/batch-state.json` exists but
 * no `.omp/mission-batch.json` does, the legacy file is read once and
 * written forward. The legacy file is left in place (non-destructive).
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { MissionState } from "../types";
import {
	legacyBatchHistoryPath,
	legacyBatchPath,
	missionBatchPath,
	missionHistoryPath,
	missionsDir,
	supervisorDir,
	supervisorEventsPath,
} from "./adapter";
import { normalizeLaneSessionAlias, readLaneSessionAliases } from "./tmux-compat";
import {
	type AllocatedLane,
	BATCH_HISTORY_MAX_ENTRIES,
	BATCH_STATE_SCHEMA_VERSION,
	type BatchHistorySummary,
	defaultBatchDiagnostics,
	defaultResilienceState,
	type EngineEvent,
	type EngineEventCallback,
	type EngineEventType,
	type LaneTaskOutcome,
	type LaneTaskStatus,
	type MergeWaveResult,
	type MissionBatchPhase,
	type MissionBatchRuntimeState,
	type MonitorState,
	type OrphanDetectionResult,
	type OrphanStateStatus,
	type PersistedBatchState,
	type PersistedLaneRecord,
	type PersistedMergeResult,
	type PersistedTaskRecord,
	StateFileError,
	type TaskMonitorSnapshot,
	type Tier0EscalationPattern,
	type Tier0Event,
	type Tier0EventType,
} from "./types";
import type { PreserveFailedLaneProgressResult } from "./worktree";

// ── .DONE marker helpers ────────────────────────────────────────────────────

/**
 * Candidate .DONE file locations for a task folder.
 *
 * Task-runner archives completed tasks by moving:
 *   tasks/<task-folder>/ → tasks/archive/<task-folder>/
 *
 * During resume/orphan detection we must check both locations.
 */
export function getTaskDoneFileCandidates(taskFolder: string): string[] {
	const candidates = [join(taskFolder, ".DONE")];
	const parent = dirname(taskFolder);
	const taskFolderName = basename(taskFolder);

	// If already in archive, avoid duplicate candidate.
	if (basename(parent).toLowerCase() !== "archive") {
		candidates.push(join(parent, "archive", taskFolderName, ".DONE"));
	}

	return candidates;
}

/**
 * Check whether a task has a .DONE marker in active or archived location.
 */
export function hasTaskDoneMarker(taskFolder: string): boolean {
	for (const donePath of getTaskDoneFileCandidates(taskFolder)) {
		try {
			if (existsSync(donePath)) return true;
		} catch {
			// Ignore filesystem errors; caller handles partial visibility.
		}
	}
	return false;
}

// ── Validation constants ────────────────────────────────────────────────────

/** All valid MissionBatchPhase values for validation. */
export const VALID_BATCH_PHASES: ReadonlySet<string> = new Set([
	"idle",
	"launching",
	"planning",
	"executing",
	"merging",
	"paused",
	"stopped",
	"completed",
	"failed",
]);

/** All valid LaneTaskStatus values for validation. */
export const VALID_TASK_STATUSES: ReadonlySet<string> = new Set([
	"pending",
	"running",
	"succeeded",
	"failed",
	"stalled",
	"skipped",
]);

/** All valid merge result statuses for persisted state. */
export const VALID_PERSISTED_MERGE_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "partial"]);

// ── Schema upconvert chain (v1 → v2 → v3 → v4) ────────────────────────────
//
// Migration functions are in-memory and idempotent: calling them on an
// already-upgraded object is a no-op. Upconversion only fills defaults
// during genuine cross-version migration — a native file missing required
// sections is malformed and must be rejected by validation, not patched.

/**
 * Upconvert a v1 state object to v2 by adding repo-aware defaults.
 *
 * Added fields:
 * - `schemaVersion` bumped from 1 → 2.
 * - `baseBranch` defaults to "" when missing.
 * - `mode` defaults to "repo" (v1 was always single-repo).
 *
 * Task and lane repo-aware fields stay undefined (v1 had no values).
 * Idempotent on already-v2+ objects.
 */
export function upconvertV1toV2(obj: Record<string, unknown>): void {
	if ((obj.schemaVersion as number) >= 2) return;
	obj.schemaVersion = 2;
	if (!obj.baseBranch) obj.baseBranch = "";
	if (!obj.mode) obj.mode = "repo";
}

/**
 * Upconvert a v2 state object to v3 by adding resilience and diagnostics
 * sections with conservative defaults.
 *
 * Added fields:
 * - `resilience`: default empty resilience state (no retries, no repairs).
 * - `diagnostics`: default empty diagnostics (no task exits, zero cost).
 *
 * Backfill only happens during genuine v1/v2 → v3 migration. A native v3
 * file missing these sections is rejected by validation. Idempotent on
 * already-v3+ objects.
 */
export function upconvertV2toV3(obj: Record<string, unknown>): void {
	if ((obj.schemaVersion as number) >= 3) return;
	obj.schemaVersion = 3;
	if (!obj.resilience) obj.resilience = defaultResilienceState();
	if (!obj.diagnostics) obj.diagnostics = defaultBatchDiagnostics();
}

/**
 * Upconvert a v3 state object to v4 by adding the `segments` array.
 *
 * Added fields:
 * - `segments`: empty array (no segment records exist in pre-v4 state).
 *
 * Task-level segment fields (`packetRepoId`, `packetTaskPath`,
 * `segmentIds`, `activeSegmentId`) are optional and default to undefined.
 * They are NOT backfilled because values depend on runtime discovery.
 * Idempotent on already-v4+ objects.
 */
export function upconvertV3toV4(obj: Record<string, unknown>): void {
	if ((obj.schemaVersion as number) >= 4) return;
	obj.schemaVersion = 4;
	if (!obj.segments) obj.segments = [];
}

// ── Schema validation ──────────────────────────────────────────────────────

const VALID_REPAIR_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "skipped"]);

const KNOWN_TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set([
	"schemaVersion",
	"phase",
	"batchId",
	"baseBranch",
	"orchBranch",
	"mode",
	"startedAt",
	"updatedAt",
	"endedAt",
	"currentWaveIndex",
	"totalWaves",
	"wavePlan",
	"lanes",
	"tasks",
	"mergeResults",
	"totalTasks",
	"succeededTasks",
	"failedTasks",
	"skippedTasks",
	"blockedTasks",
	"blockedTaskIds",
	"lastError",
	"errors",
	"resilience",
	"diagnostics",
	"segments",
	"_extraFields",
]);

/**
 * Validate a parsed JSON object as a PersistedBatchState.
 *
 * Checks:
 * 1. Schema version is 1/2/3/4 (auto-upconverted to current in memory).
 * 2. All required fields are present with correct types.
 * 3. Enum fields (phase, task status, merge status) contain valid values.
 * 4. Arrays contain valid sub-records.
 * 5. v2 optional fields (repoId, resolvedRepoId, mode) validated when present.
 * 6. v3 resilience + diagnostics sections fully validated.
 * 7. v4 segments array fully validated.
 * 8. Unknown top-level fields captured in `_extraFields` for roundtrip preservation.
 *
 * @throws StateFileError with STATE_SCHEMA_INVALID on any validation failure.
 */
export function validatePersistedState(data: unknown): PersistedBatchState {
	if (!data || typeof data !== "object") {
		throw new StateFileError("STATE_SCHEMA_INVALID", "Batch state must be a non-null object");
	}

	const obj = data as Record<string, unknown>;

	// ── Schema version ───────────────────────────────────────────
	if (typeof obj.schemaVersion !== "number") {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Missing or invalid "schemaVersion" field (expected number, got ${typeof obj.schemaVersion})`,
		);
	}
	const ACCEPTED_VERSIONS = [1, 2, 3, BATCH_STATE_SCHEMA_VERSION];
	if (!ACCEPTED_VERSIONS.includes(obj.schemaVersion as number)) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Unsupported schema version ${obj.schemaVersion} (expected ${BATCH_STATE_SCHEMA_VERSION}). ` +
				`Upgrade missioncontrol to a version that supports schema v${obj.schemaVersion}, ` +
				`or delete mission-batch.json and re-run the batch.`,
		);
	}
	const isV1 = obj.schemaVersion === 1;

	// ── Required string fields ───────────────────────────────────
	for (const field of ["phase", "batchId"] as const) {
		if (typeof obj[field] !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`Missing or invalid "${field}" field (expected string, got ${typeof obj[field]})`,
			);
		}
	}

	// ── Optional: baseBranch ─────────────────────────────────────
	if (obj.baseBranch !== undefined && typeof obj.baseBranch !== "string") {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Invalid "baseBranch" field (expected string, got ${typeof obj.baseBranch})`,
		);
	}

	// ── Optional: orchBranch (default "") ────────────────────────
	if (obj.orchBranch !== undefined && typeof obj.orchBranch !== "string") {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Invalid "orchBranch" field (expected string, got ${typeof obj.orchBranch})`,
		);
	}
	if (obj.orchBranch === undefined) obj.orchBranch = "";

	// ── v2: mode ─────────────────────────────────────────────────
	if (!isV1 && obj.mode === undefined) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Missing required "mode" field in schema v2 (expected "repo" or "workspace")`,
		);
	}
	if (obj.mode !== undefined && typeof obj.mode !== "string") {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Invalid "mode" field (expected string, got ${typeof obj.mode})`,
		);
	}
	if (obj.mode !== undefined && obj.mode !== "repo" && obj.mode !== "workspace") {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Invalid "mode" value "${obj.mode}" (expected "repo" or "workspace")`,
		);
	}

	// ── Phase enum ───────────────────────────────────────────────
	if (!VALID_BATCH_PHASES.has(obj.phase as string)) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Invalid "phase" value "${obj.phase}" (expected one of: ${[...VALID_BATCH_PHASES].join(", ")})`,
		);
	}

	// ── Required numbers ─────────────────────────────────────────
	for (const field of [
		"startedAt",
		"updatedAt",
		"currentWaveIndex",
		"totalWaves",
		"totalTasks",
		"succeededTasks",
		"failedTasks",
		"skippedTasks",
		"blockedTasks",
	] as const) {
		if (typeof obj[field] !== "number") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`Missing or invalid "${field}" field (expected number, got ${typeof obj[field]})`,
			);
		}
	}

	// ── Nullable: endedAt ────────────────────────────────────────
	if (obj.endedAt !== null && typeof obj.endedAt !== "number") {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Invalid "endedAt" field (expected number or null, got ${typeof obj.endedAt})`,
		);
	}

	// ── Required arrays ──────────────────────────────────────────
	for (const field of ["wavePlan", "lanes", "tasks", "mergeResults", "blockedTaskIds", "errors"] as const) {
		if (!Array.isArray(obj[field])) {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`Missing or invalid "${field}" field (expected array, got ${typeof obj[field]})`,
			);
		}
	}

	// ── wavePlan: string[][] ─────────────────────────────────────
	const wavePlan = obj.wavePlan as unknown[];
	for (let i = 0; i < wavePlan.length; i++) {
		if (!Array.isArray(wavePlan[i])) {
			throw new StateFileError("STATE_SCHEMA_INVALID", `wavePlan[${i}] is not an array`);
		}
		for (const taskId of wavePlan[i] as unknown[]) {
			if (typeof taskId !== "string") {
				throw new StateFileError(
					"STATE_SCHEMA_INVALID",
					`wavePlan[${i}] contains non-string value: ${typeof taskId}`,
				);
			}
		}
	}

	// ── tasks[] ──────────────────────────────────────────────────
	const tasks = obj.tasks as unknown[];
	for (let i = 0; i < tasks.length; i++) {
		const t = tasks[i] as Record<string, unknown>;
		if (!t || typeof t !== "object") {
			throw new StateFileError("STATE_SCHEMA_INVALID", `tasks[${i}] is not an object`);
		}
		for (const field of ["taskId", "sessionName", "taskFolder", "exitReason"] as const) {
			if (typeof t[field] !== "string") {
				throw new StateFileError("STATE_SCHEMA_INVALID", `tasks[${i}].${field} is missing or not a string`);
			}
		}
		if (typeof t.laneNumber !== "number") {
			throw new StateFileError("STATE_SCHEMA_INVALID", `tasks[${i}].laneNumber is missing or not a number`);
		}
		if (typeof t.status !== "string" || !VALID_TASK_STATUSES.has(t.status)) {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`tasks[${i}].status is invalid: "${t.status}" (expected one of: ${[...VALID_TASK_STATUSES].join(", ")})`,
			);
		}
		if (t.startedAt !== null && typeof t.startedAt !== "number") {
			throw new StateFileError("STATE_SCHEMA_INVALID", `tasks[${i}].startedAt is not a number or null`);
		}
		if (t.endedAt !== null && typeof t.endedAt !== "number") {
			throw new StateFileError("STATE_SCHEMA_INVALID", `tasks[${i}].endedAt is not a number or null`);
		}
		if (typeof t.doneFileFound !== "boolean") {
			throw new StateFileError("STATE_SCHEMA_INVALID", `tasks[${i}].doneFileFound is missing or not a boolean`);
		}
		if (t.repoId !== undefined && typeof t.repoId !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`tasks[${i}].repoId is not a string (got ${typeof t.repoId})`,
			);
		}
		if (t.resolvedRepoId !== undefined && typeof t.resolvedRepoId !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`tasks[${i}].resolvedRepoId is not a string (got ${typeof t.resolvedRepoId})`,
			);
		}
		if (t.partialProgressCommits !== undefined && typeof t.partialProgressCommits !== "number") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`tasks[${i}].partialProgressCommits is not a number (got ${typeof t.partialProgressCommits})`,
			);
		}
		if (t.partialProgressBranch !== undefined && typeof t.partialProgressBranch !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`tasks[${i}].partialProgressBranch is not a string (got ${typeof t.partialProgressBranch})`,
			);
		}
		if (t.exitDiagnostic !== undefined) {
			if (typeof t.exitDiagnostic !== "object" || t.exitDiagnostic === null || Array.isArray(t.exitDiagnostic)) {
				throw new StateFileError(
					"STATE_SCHEMA_INVALID",
					`tasks[${i}].exitDiagnostic is not a plain object (got ${Array.isArray(t.exitDiagnostic) ? "array" : typeof t.exitDiagnostic})`,
				);
			}
			const ed = t.exitDiagnostic as Record<string, unknown>;
			if (typeof ed.classification !== "string") {
				throw new StateFileError(
					"STATE_SCHEMA_INVALID",
					`tasks[${i}].exitDiagnostic.classification is not a string (got ${typeof ed.classification})`,
				);
			}
		}
	}

	// ── lanes[] ──────────────────────────────────────────────────
	const lanes = obj.lanes as unknown[];
	const legacyTmuxSessionLaneIndexes: number[] = [];
	for (let i = 0; i < lanes.length; i++) {
		const l = lanes[i] as Record<string, unknown>;
		if (!l || typeof l !== "object") {
			throw new StateFileError("STATE_SCHEMA_INVALID", `lanes[${i}] is not an object`);
		}
		for (const field of ["laneId", "worktreePath", "branch"] as const) {
			if (typeof l[field] !== "string") {
				throw new StateFileError("STATE_SCHEMA_INVALID", `lanes[${i}].${field} is missing or not a string`);
			}
		}
		const { laneSessionId, tmuxSessionName } = readLaneSessionAliases(l);
		if (laneSessionId !== undefined && typeof laneSessionId !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`lanes[${i}].laneSessionId is not a string (got ${typeof laneSessionId})`,
			);
		}
		if (tmuxSessionName !== undefined && typeof tmuxSessionName !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`lanes[${i}].tmuxSessionName is not a string (got ${typeof tmuxSessionName})`,
			);
		}
		if (typeof laneSessionId !== "string" && typeof tmuxSessionName !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`lanes[${i}] must include either laneSessionId or tmuxSessionName as a string`,
			);
		}
		if (typeof tmuxSessionName === "string") legacyTmuxSessionLaneIndexes.push(i);
		normalizeLaneSessionAlias(l);
		if (typeof l.laneNumber !== "number") {
			throw new StateFileError("STATE_SCHEMA_INVALID", `lanes[${i}].laneNumber is missing or not a number`);
		}
		if (!Array.isArray(l.taskIds)) {
			throw new StateFileError("STATE_SCHEMA_INVALID", `lanes[${i}].taskIds is missing or not an array`);
		}
		if (l.repoId !== undefined && typeof l.repoId !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`lanes[${i}].repoId is not a string (got ${typeof l.repoId})`,
			);
		}
	}
	if (legacyTmuxSessionLaneIndexes.length > 0) {
		logger.warn(
			"[missioncontrol] migration: detected legacy lanes[].tmuxSessionName in mission-batch.json; " +
				"normalized to lanes[].laneSessionId for this release. Re-save state (or re-run mission-resume) to persist canonical fields.",
		);
	}

	// ── mergeResults[] ───────────────────────────────────────────
	const mergeResults = obj.mergeResults as unknown[];
	for (let i = 0; i < mergeResults.length; i++) {
		const m = mergeResults[i] as Record<string, unknown>;
		if (!m || typeof m !== "object") {
			throw new StateFileError("STATE_SCHEMA_INVALID", `mergeResults[${i}] is not an object`);
		}
		if (typeof m.waveIndex !== "number") {
			throw new StateFileError("STATE_SCHEMA_INVALID", `mergeResults[${i}].waveIndex is missing or not a number`);
		}
		if (typeof m.status !== "string" || !VALID_PERSISTED_MERGE_STATUSES.has(m.status)) {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`mergeResults[${i}].status is invalid: "${m.status}" (expected one of: ${[...VALID_PERSISTED_MERGE_STATUSES].join(", ")})`,
			);
		}
		if (m.repoResults !== undefined) {
			if (!Array.isArray(m.repoResults)) {
				throw new StateFileError(
					"STATE_SCHEMA_INVALID",
					`mergeResults[${i}].repoResults is not an array (got ${typeof m.repoResults})`,
				);
			}
			for (let j = 0; j < (m.repoResults as unknown[]).length; j++) {
				const rr = (m.repoResults as unknown[])[j] as Record<string, unknown>;
				if (!rr || typeof rr !== "object") {
					throw new StateFileError(
						"STATE_SCHEMA_INVALID",
						`mergeResults[${i}].repoResults[${j}] is not an object`,
					);
				}
				if (typeof rr.status !== "string" || !VALID_PERSISTED_MERGE_STATUSES.has(rr.status)) {
					throw new StateFileError(
						"STATE_SCHEMA_INVALID",
						`mergeResults[${i}].repoResults[${j}].status is invalid: "${rr.status}"`,
					);
				}
				if (!Array.isArray(rr.laneNumbers)) {
					throw new StateFileError(
						"STATE_SCHEMA_INVALID",
						`mergeResults[${i}].repoResults[${j}].laneNumbers is not an array`,
					);
				}
			}
		}
	}

	// ── lastError ────────────────────────────────────────────────
	if (obj.lastError !== null) {
		if (typeof obj.lastError !== "object") {
			throw new StateFileError("STATE_SCHEMA_INVALID", `lastError is not an object or null`);
		}
		const le = obj.lastError as Record<string, unknown>;
		if (typeof le.code !== "string" || typeof le.message !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`lastError must have "code" (string) and "message" (string) fields`,
			);
		}
	}

	// ── blockedTaskIds: string[] ─────────────────────────────────
	for (const id of obj.blockedTaskIds as unknown[]) {
		if (typeof id !== "string") {
			throw new StateFileError("STATE_SCHEMA_INVALID", `blockedTaskIds contains non-string value: ${typeof id}`);
		}
	}

	// ── errors: string[] ─────────────────────────────────────────
	for (const err of obj.errors as unknown[]) {
		if (typeof err !== "string") {
			throw new StateFileError("STATE_SCHEMA_INVALID", `errors array contains non-string value: ${typeof err}`);
		}
	}

	// ── Chain upconvert v1→v2→v3→v4 (in-memory) ──────────────────
	upconvertV1toV2(obj);
	upconvertV2toV3(obj);
	upconvertV3toV4(obj);

	// ── v3 resilience ────────────────────────────────────────────
	if (!obj.resilience || typeof obj.resilience !== "object") {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Missing or invalid "resilience" section (expected object, got ${typeof obj.resilience})`,
		);
	}
	const res = obj.resilience as Record<string, unknown>;
	if (typeof res.resumeForced !== "boolean") {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`resilience.resumeForced must be a boolean (got ${typeof res.resumeForced})`,
		);
	}
	if (!res.retryCountByScope || typeof res.retryCountByScope !== "object" || Array.isArray(res.retryCountByScope)) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`resilience.retryCountByScope must be an object (got ${typeof res.retryCountByScope})`,
		);
	}
	for (const [scope, count] of Object.entries(res.retryCountByScope as Record<string, unknown>)) {
		if (typeof count !== "number") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`resilience.retryCountByScope["${scope}"] must be a number (got ${typeof count})`,
			);
		}
	}
	if (res.lastFailureClass !== null && typeof res.lastFailureClass !== "string") {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`resilience.lastFailureClass must be a string or null (got ${typeof res.lastFailureClass})`,
		);
	}
	if (!Array.isArray(res.repairHistory)) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`resilience.repairHistory must be an array (got ${typeof res.repairHistory})`,
		);
	}
	for (let i = 0; i < (res.repairHistory as unknown[]).length; i++) {
		const rec = (res.repairHistory as unknown[])[i];
		if (!rec || typeof rec !== "object") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`resilience.repairHistory[${i}] must be an object (got ${typeof rec})`,
			);
		}
		const r = rec as Record<string, unknown>;
		if (typeof r.id !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`resilience.repairHistory[${i}].id must be a string (got ${typeof r.id})`,
			);
		}
		if (typeof r.strategy !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`resilience.repairHistory[${i}].strategy must be a string (got ${typeof r.strategy})`,
			);
		}
		if (typeof r.status !== "string" || !VALID_REPAIR_STATUSES.has(r.status)) {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`resilience.repairHistory[${i}].status must be "succeeded"|"failed"|"skipped" (got ${JSON.stringify(r.status)})`,
			);
		}
		if (typeof r.startedAt !== "number") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`resilience.repairHistory[${i}].startedAt must be a number (got ${typeof r.startedAt})`,
			);
		}
		if (typeof r.endedAt !== "number") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`resilience.repairHistory[${i}].endedAt must be a number (got ${typeof r.endedAt})`,
			);
		}
		if (r.repoId !== undefined && typeof r.repoId !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`resilience.repairHistory[${i}].repoId must be a string when present (got ${typeof r.repoId})`,
			);
		}
	}

	// ── v3 diagnostics ───────────────────────────────────────────
	if (!obj.diagnostics || typeof obj.diagnostics !== "object") {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Missing or invalid "diagnostics" section (expected object, got ${typeof obj.diagnostics})`,
		);
	}
	const diag = obj.diagnostics as Record<string, unknown>;
	if (!diag.taskExits || typeof diag.taskExits !== "object" || Array.isArray(diag.taskExits)) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`diagnostics.taskExits must be an object (got ${typeof diag.taskExits})`,
		);
	}
	for (const [taskId, entry] of Object.entries(diag.taskExits as Record<string, unknown>)) {
		if (!entry || typeof entry !== "object") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`diagnostics.taskExits["${taskId}"] must be an object (got ${typeof entry})`,
			);
		}
		const te = entry as Record<string, unknown>;
		if (typeof te.classification !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`diagnostics.taskExits["${taskId}"].classification must be a string (got ${typeof te.classification})`,
			);
		}
		if (typeof te.cost !== "number") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`diagnostics.taskExits["${taskId}"].cost must be a number (got ${typeof te.cost})`,
			);
		}
		if (typeof te.durationSec !== "number") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`diagnostics.taskExits["${taskId}"].durationSec must be a number (got ${typeof te.durationSec})`,
			);
		}
		if (te.retries !== undefined && typeof te.retries !== "number") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`diagnostics.taskExits["${taskId}"].retries must be a number when present (got ${typeof te.retries})`,
			);
		}
	}
	if (typeof diag.batchCost !== "number") {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`diagnostics.batchCost must be a number (got ${typeof diag.batchCost})`,
		);
	}

	// ── v4 task-level segment fields (optional) ──────────────────
	for (let i = 0; i < tasks.length; i++) {
		const t = tasks[i] as Record<string, unknown>;
		if (t.packetRepoId !== undefined && typeof t.packetRepoId !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`tasks[${i}].packetRepoId is not a string (got ${typeof t.packetRepoId})`,
			);
		}
		if (t.packetTaskPath !== undefined && typeof t.packetTaskPath !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`tasks[${i}].packetTaskPath is not a string (got ${typeof t.packetTaskPath})`,
			);
		}
		if (t.segmentIds !== undefined) {
			if (!Array.isArray(t.segmentIds)) {
				throw new StateFileError(
					"STATE_SCHEMA_INVALID",
					`tasks[${i}].segmentIds is not an array (got ${typeof t.segmentIds})`,
				);
			}
			for (let j = 0; j < (t.segmentIds as unknown[]).length; j++) {
				if (typeof (t.segmentIds as unknown[])[j] !== "string") {
					throw new StateFileError("STATE_SCHEMA_INVALID", `tasks[${i}].segmentIds[${j}] is not a string`);
				}
			}
		}
		if (t.activeSegmentId !== undefined && t.activeSegmentId !== null && typeof t.activeSegmentId !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`tasks[${i}].activeSegmentId is not a string or null (got ${typeof t.activeSegmentId})`,
			);
		}
	}

	// ── v4 segments[] ────────────────────────────────────────────
	if (!Array.isArray(obj.segments)) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Missing or invalid "segments" field (expected array, got ${typeof obj.segments})`,
		);
	}
	const segments = obj.segments as unknown[];
	for (let i = 0; i < segments.length; i++) {
		const s = segments[i] as Record<string, unknown>;
		if (!s || typeof s !== "object") {
			throw new StateFileError("STATE_SCHEMA_INVALID", `segments[${i}] is not an object`);
		}
		for (const field of [
			"segmentId",
			"taskId",
			"repoId",
			"laneId",
			"sessionName",
			"worktreePath",
			"branch",
			"exitReason",
		] as const) {
			if (typeof s[field] !== "string") {
				throw new StateFileError(
					"STATE_SCHEMA_INVALID",
					`segments[${i}].${field} is missing or not a string (got ${typeof s[field]})`,
				);
			}
		}
		if (typeof s.status !== "string" || !VALID_TASK_STATUSES.has(s.status)) {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`segments[${i}].status is invalid: "${s.status}" (expected one of: ${[...VALID_TASK_STATUSES].join(", ")})`,
			);
		}
		if (s.startedAt !== null && typeof s.startedAt !== "number") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`segments[${i}].startedAt is not a number or null (got ${typeof s.startedAt})`,
			);
		}
		if (s.endedAt !== null && typeof s.endedAt !== "number") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`segments[${i}].endedAt is not a number or null (got ${typeof s.endedAt})`,
			);
		}
		if (typeof s.retries !== "number") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`segments[${i}].retries is not a number (got ${typeof s.retries})`,
			);
		}
		if (!Array.isArray(s.dependsOnSegmentIds)) {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`segments[${i}].dependsOnSegmentIds is not an array (got ${typeof s.dependsOnSegmentIds})`,
			);
		}
		for (let j = 0; j < (s.dependsOnSegmentIds as unknown[]).length; j++) {
			if (typeof (s.dependsOnSegmentIds as unknown[])[j] !== "string") {
				throw new StateFileError(
					"STATE_SCHEMA_INVALID",
					`segments[${i}].dependsOnSegmentIds[${j}] is not a string`,
				);
			}
		}
		if (s.expandedFrom !== undefined && typeof s.expandedFrom !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`segments[${i}].expandedFrom is not a string when present (got ${typeof s.expandedFrom})`,
			);
		}
		if (s.expansionRequestId !== undefined && typeof s.expansionRequestId !== "string") {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`segments[${i}].expansionRequestId is not a string when present (got ${typeof s.expansionRequestId})`,
			);
		}
		if (s.exitDiagnostic !== undefined) {
			if (!s.exitDiagnostic || typeof s.exitDiagnostic !== "object" || Array.isArray(s.exitDiagnostic)) {
				throw new StateFileError(
					"STATE_SCHEMA_INVALID",
					`segments[${i}].exitDiagnostic is not a plain object (got ${Array.isArray(s.exitDiagnostic) ? "array" : typeof s.exitDiagnostic})`,
				);
			}
			const ed = s.exitDiagnostic as Record<string, unknown>;
			if (typeof ed.classification !== "string") {
				throw new StateFileError(
					"STATE_SCHEMA_INVALID",
					`segments[${i}].exitDiagnostic.classification is not a string`,
				);
			}
		}
	}

	// ── Capture unknown fields for roundtrip preservation ────────
	const extraFields: Record<string, unknown> = {};
	for (const key of Object.keys(obj)) {
		if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) extraFields[key] = obj[key];
	}
	if (Object.keys(extraFields).length > 0) obj._extraFields = extraFields;

	return obj as unknown as PersistedBatchState;
}

// ── Serialization (runtime state → persisted JSON) ─────────────────────────

/**
 * Serialize mission batch runtime state to a v4 JSON string.
 *
 * Pure transform — no I/O. Combines runtime state, wave plan, allocated
 * lanes, and accumulated task outcomes into a `PersistedBatchState` shape
 * with `schemaVersion = BATCH_STATE_SCHEMA_VERSION`. Task records enrich
 * from the latest outcome per task plus the allocated task's repo-aware
 * and segment-aware fields. Wave merge results are normalized from
 * 1-based (runtime) to 0-based (persisted) `waveIndex`, clamped to 0.
 * Preserves unknown fields from prior-loaded state via `_extraFields`.
 */
export function serializeBatchState(
	state: MissionBatchRuntimeState,
	wavePlan: string[][],
	lanes: AllocatedLane[],
	allTaskOutcomes: LaneTaskOutcome[],
): string {
	const now = Date.now();

	const laneByTaskId = new Map<string, AllocatedLane>();
	for (const lane of lanes) {
		for (const task of lane.tasks) {
			laneByTaskId.set(task.taskId, lane);
		}
	}

	const outcomeByTaskId = new Map<string, LaneTaskOutcome>();
	for (const outcome of allTaskOutcomes) {
		outcomeByTaskId.set(outcome.taskId, outcome);
	}

	const taskIdSet = new Set<string>();
	for (const wave of wavePlan) {
		for (const taskId of wave) taskIdSet.add(taskId);
	}
	for (const outcome of allTaskOutcomes) {
		taskIdSet.add(outcome.taskId);
	}

	const allocatedTaskByTaskId = new Map<
		string,
		{ allocatedTask: AllocatedLane["tasks"][number]; lane: AllocatedLane }
	>();
	for (const lane of lanes) {
		for (const allocTask of lane.tasks) {
			allocatedTaskByTaskId.set(allocTask.taskId, { allocatedTask: allocTask, lane });
		}
	}

	const taskRecords: PersistedTaskRecord[] = [...taskIdSet].sort().map(taskId => {
		const lane = laneByTaskId.get(taskId);
		const outcome = outcomeByTaskId.get(taskId);
		const allocated = allocatedTaskByTaskId.get(taskId);

		const record: PersistedTaskRecord = {
			taskId,
			laneNumber: lane?.laneNumber ?? outcome?.laneNumber ?? 0,
			sessionName: outcome?.sessionName || lane?.laneSessionId || "",
			status: outcome?.status ?? "pending",
			taskFolder: "",
			startedAt: outcome?.startTime ?? null,
			endedAt: outcome?.endTime ?? null,
			doneFileFound: outcome?.doneFileFound ?? false,
			exitReason: outcome?.exitReason ?? "",
		};

		const parsedTask = allocated?.allocatedTask.task;
		if (parsedTask?.promptRepoId !== undefined) record.repoId = parsedTask.promptRepoId;
		if (parsedTask?.resolvedRepoId !== undefined) record.resolvedRepoId = parsedTask.resolvedRepoId;

		if (outcome?.partialProgressCommits !== undefined) {
			record.partialProgressCommits = outcome.partialProgressCommits;
		}
		if (outcome?.partialProgressBranch !== undefined) {
			record.partialProgressBranch = outcome.partialProgressBranch;
		}
		if (outcome?.exitDiagnostic !== undefined) record.exitDiagnostic = outcome.exitDiagnostic;

		if (parsedTask?.packetRepoId !== undefined) record.packetRepoId = parsedTask.packetRepoId;
		if (parsedTask?.packetTaskPath !== undefined) record.packetTaskPath = parsedTask.packetTaskPath;
		if (parsedTask?.segmentIds !== undefined) record.segmentIds = parsedTask.segmentIds;
		if (parsedTask?.activeSegmentId !== undefined) record.activeSegmentId = parsedTask.activeSegmentId;

		return record;
	});

	const laneRecords: PersistedLaneRecord[] = lanes.map(lane => {
		const record: PersistedLaneRecord = {
			laneNumber: lane.laneNumber,
			laneId: lane.laneId,
			laneSessionId: lane.laneSessionId,
			worktreePath: lane.worktreePath,
			branch: lane.branch,
			taskIds: lane.tasks.map(t => t.taskId),
		};
		if (lane.repoId !== undefined) record.repoId = lane.repoId;
		return record;
	});

	// MergeWaveResult.waveIndex is 1-based; PersistedMergeResult is 0-based.
	// Clamp to 0 — resume re-exec merges use sentinel waveIndex -1 which
	// would otherwise produce -2.
	const runtimeMergeResults = (state.mergeResults ?? []) as MergeWaveResult[];
	const mergeResults: PersistedMergeResult[] = runtimeMergeResults.map(mr => {
		const record: PersistedMergeResult = {
			waveIndex: Math.max(0, mr.waveIndex - 1),
			status: mr.status,
			failedLane: mr.failedLane,
			failureReason: mr.failureReason,
		};
		if (mr.repoResults && mr.repoResults.length > 0) {
			record.repoResults = mr.repoResults.map(rr => ({
				repoId: rr.repoId,
				status: rr.status,
				laneNumbers: rr.laneResults.map(lr => lr.laneNumber),
				failedLane: rr.failedLane,
				failureReason: rr.failureReason,
			}));
		}
		return record;
	});

	const persisted: PersistedBatchState = {
		schemaVersion: BATCH_STATE_SCHEMA_VERSION,
		phase: state.phase,
		batchId: state.batchId,
		baseBranch: state.baseBranch,
		orchBranch: state.orchBranch ?? "",
		mode: state.mode ?? "repo",
		startedAt: state.startedAt,
		updatedAt: now,
		endedAt: state.endedAt,
		currentWaveIndex: state.currentWaveIndex,
		totalWaves: state.totalWaves,
		...(state.taskLevelWaveCount != null ? { taskLevelWaveCount: state.taskLevelWaveCount } : {}),
		...(state.roundToTaskWave != null ? { roundToTaskWave: [...state.roundToTaskWave] } : {}),
		wavePlan,
		lanes: laneRecords,
		tasks: taskRecords,
		mergeResults,
		totalTasks: state.totalTasks,
		succeededTasks: state.succeededTasks,
		failedTasks: state.failedTasks,
		skippedTasks: state.skippedTasks,
		blockedTasks: state.blockedTasks,
		blockedTaskIds: [...state.blockedTaskIds],
		lastError:
			state.errors.length > 0 ? { code: "BATCH_ERROR", message: state.errors[state.errors.length - 1] ?? "" } : null,
		errors: [...state.errors],
		resilience: state.resilience ?? defaultResilienceState(),
		diagnostics: state.diagnostics ?? defaultBatchDiagnostics(),
		segments: (state.segments ?? []) as PersistedBatchState["segments"],
	};

	// Preserve unknown fields from a previously-loaded state so round-trip
	// fidelity holds across versions. Known fields are never overwritten.
	if (state._extraFields) {
		const output = persisted as unknown as Record<string, unknown>;
		for (const [key, value] of Object.entries(state._extraFields)) {
			if (!(key in output)) output[key] = value;
		}
	}

	return JSON.stringify(persisted, null, 2);
}

// ── File I/O for batch state (atomic write + read/validate pipeline) ──────

/** Maximum retries for atomic rename (Windows file locking). */
export const STATE_WRITE_MAX_RETRIES = 3;

/** Delay between rename retries (ms). */
export const STATE_WRITE_RETRY_DELAY_MS = 500;

/**
 * Save serialized batch state to `.omp/mission-batch.json` atomically.
 *
 * Writes to `<path>.tmp`, then renames to the final path. On Windows the
 * rename can transiently fail when another process has the file open, so
 * the rename is retried up to `STATE_WRITE_MAX_RETRIES` times with a
 * `STATE_WRITE_RETRY_DELAY_MS` gap between attempts. On final failure the
 * temp file is cleaned up.
 *
 * @throws StateFileError with STATE_FILE_IO_ERROR on directory creation,
 *   temp write, or exhausted rename retries.
 */
export async function saveBatchState(json: string, cwd: string): Promise<void> {
	const finalPath = missionBatchPath(cwd);
	const tmpPath = `${finalPath}.tmp`;
	const dir = dirname(finalPath);

	if (!existsSync(dir)) {
		try {
			await mkdir(dir, { recursive: true });
		} catch (err: unknown) {
			throw new StateFileError(
				"STATE_FILE_IO_ERROR",
				`Failed to create directory "${dir}": ${(err as Error).message}`,
			);
		}
	}

	try {
		await writeFile(tmpPath, json, "utf-8");
	} catch (err: unknown) {
		throw new StateFileError(
			"STATE_FILE_IO_ERROR",
			`Failed to write temp state file "${tmpPath}": ${(err as Error).message}`,
		);
	}

	let lastError: Error | null = null;
	for (let attempt = 1; attempt <= STATE_WRITE_MAX_RETRIES; attempt++) {
		try {
			await rename(tmpPath, finalPath);
			return;
		} catch (err: unknown) {
			lastError = err as Error;
			if (attempt < STATE_WRITE_MAX_RETRIES) {
				await Bun.sleep(STATE_WRITE_RETRY_DELAY_MS);
			}
		}
	}

	try {
		await unlink(tmpPath);
	} catch {
		// Best-effort cleanup; ignore secondary failure.
	}

	throw new StateFileError(
		"STATE_FILE_IO_ERROR",
		`Failed to atomically save state file "${finalPath}" after ` +
			`${STATE_WRITE_MAX_RETRIES} attempts: ${lastError?.message ?? "unknown error"}`,
	);
}

/**
 * Load and validate batch state from `.omp/mission-batch.json`.
 *
 * Returns null when the file does not exist. When the legacy
 * `.pi/batch-state.json` exists without a native file, it is read in its
 * place (non-destructive — the legacy file stays put).
 *
 * @throws StateFileError with STATE_FILE_IO_ERROR on read failure.
 * @throws StateFileError with STATE_FILE_PARSE_ERROR on invalid JSON.
 * @throws StateFileError with STATE_SCHEMA_INVALID on validation failure.
 */
export async function loadBatchState(cwd: string): Promise<PersistedBatchState | null> {
	let filePath = missionBatchPath(cwd);
	if (!existsSync(filePath)) {
		const legacy = legacyBatchPath(cwd);
		if (!existsSync(legacy)) return null;
		filePath = legacy;
	}

	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (err: unknown) {
		throw new StateFileError(
			"STATE_FILE_IO_ERROR",
			`Failed to read state file "${filePath}": ${(err as Error).message}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err: unknown) {
		throw new StateFileError(
			"STATE_FILE_PARSE_ERROR",
			`State file "${filePath}" contains invalid JSON: ${(err as Error).message}`,
		);
	}

	return validatePersistedState(parsed);
}

/**
 * Delete `.omp/mission-batch.json` if it exists. Idempotent: no error
 * when the file is already gone or is raced away between the existence
 * check and the unlink.
 *
 * @throws StateFileError with STATE_FILE_IO_ERROR on unexpected failure.
 */
export async function unlinkBatchState(cwd: string): Promise<void> {
	const filePath = missionBatchPath(cwd);
	if (!existsSync(filePath)) return;
	try {
		await unlink(filePath);
	} catch (err: unknown) {
		if (!existsSync(filePath)) return;
		throw new StateFileError(
			"STATE_FILE_IO_ERROR",
			`Failed to delete state file "${filePath}": ${(err as Error).message}`,
		);
	}
}

// ── Task outcome upsert + sync (ported from taskplane/persistence.ts) ──────

/**
 * Backfill partial-progress metadata onto matching task outcomes.
 *
 * When a failed task's commits are preserved to a saved branch, the branch
 * name + commit count are written onto the corresponding outcome so they
 * survive the normal outcome → serialization path without needing a separate
 * diagnostics channel. Mutates `outcomes` in place.
 *
 * Returns the number of outcomes that were updated.
 */
export function applyPartialProgressToOutcomes(
	ppResult: PreserveFailedLaneProgressResult,
	outcomes: LaneTaskOutcome[],
): number {
	let updated = 0;
	for (const r of ppResult.results) {
		if (!r.saved || !r.savedBranch) continue;
		const outcome = outcomes.find(o => o.taskId === r.taskId);
		if (outcome) {
			outcome.partialProgressCommits = r.commitCount;
			outcome.partialProgressBranch = r.savedBranch;
			updated++;
		}
	}
	return updated;
}

function sameOutcomeTelemetry(a: LaneTaskOutcome["telemetry"], b: LaneTaskOutcome["telemetry"]): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	return (
		a.inputTokens === b.inputTokens &&
		a.outputTokens === b.outputTokens &&
		a.cacheReadTokens === b.cacheReadTokens &&
		a.cacheWriteTokens === b.cacheWriteTokens &&
		a.costUsd === b.costUsd &&
		a.toolCalls === b.toolCalls &&
		a.durationMs === b.durationMs
	);
}

/**
 * Upsert a task outcome in-place. Returns true if the outcome array was changed.
 * When a prior entry exists, `laneNumber` and `telemetry` are inherited from
 * the prior entry when the incoming fields are nullish — so repeated syncs
 * from low-fidelity sources cannot drop higher-fidelity data.
 */
export function upsertTaskOutcome(outcomes: LaneTaskOutcome[], next: LaneTaskOutcome): boolean {
	const idx = outcomes.findIndex(o => o.taskId === next.taskId);
	if (idx < 0) {
		outcomes.push(next);
		return true;
	}

	const prev = outcomes[idx];
	if (!prev) {
		outcomes[idx] = next;
		return true;
	}
	const mergedNext: LaneTaskOutcome = {
		...next,
		laneNumber: next.laneNumber ?? prev.laneNumber,
		telemetry: next.telemetry ?? prev.telemetry,
	};

	const changed =
		prev.status !== mergedNext.status ||
		prev.startTime !== mergedNext.startTime ||
		prev.endTime !== mergedNext.endTime ||
		prev.exitReason !== mergedNext.exitReason ||
		prev.sessionName !== mergedNext.sessionName ||
		prev.doneFileFound !== mergedNext.doneFileFound ||
		prev.laneNumber !== mergedNext.laneNumber ||
		!sameOutcomeTelemetry(prev.telemetry, mergedNext.telemetry) ||
		prev.partialProgressCommits !== mergedNext.partialProgressCommits ||
		prev.partialProgressBranch !== mergedNext.partialProgressBranch ||
		prev.exitDiagnostic !== mergedNext.exitDiagnostic;

	if (changed) {
		outcomes[idx] = mergedNext;
	}
	return changed;
}

/**
 * Seed `pending` outcomes for every task across freshly allocated lanes.
 * Called at wave start so the persisted state has a full task registry
 * (including lane/session assignment) before any task finishes.
 */
export function seedPendingOutcomesForAllocatedLanes(lanes: AllocatedLane[], outcomes: LaneTaskOutcome[]): boolean {
	let changed = false;
	for (const lane of lanes) {
		for (const laneTask of lane.tasks) {
			const existing = outcomes.find(o => o.taskId === laneTask.taskId);
			if (existing) continue;
			changed =
				upsertTaskOutcome(outcomes, {
					taskId: laneTask.taskId,
					status: "pending",
					startTime: null,
					endTime: null,
					exitReason: "Pending execution",
					sessionName: lane.laneSessionId,
					doneFileFound: false,
					laneNumber: lane.laneNumber,
				}) || changed;
		}
	}
	return changed;
}

/**
 * Sync accumulated task outcomes from a monitor snapshot. Captures
 * in-wave transitions (pending → running → terminal) so persistence
 * does not lag until wave completion.
 */
export function syncTaskOutcomesFromMonitor(monitorState: MonitorState, outcomes: LaneTaskOutcome[]): boolean {
	let changed = false;

	for (const lane of monitorState.lanes) {
		for (const taskId of lane.remainingTasks) {
			const existing = outcomes.find(o => o.taskId === taskId);
			if (
				existing &&
				(existing.status === "succeeded" || existing.status === "failed" || existing.status === "stalled")
			) {
				continue;
			}
			changed =
				upsertTaskOutcome(outcomes, {
					taskId,
					status: "pending",
					startTime: existing?.startTime ?? null,
					endTime: null,
					exitReason: existing?.exitReason || "Pending execution",
					sessionName: existing?.sessionName || lane.sessionName,
					doneFileFound: false,
					laneNumber: existing?.laneNumber ?? lane.laneNumber,
					telemetry: existing?.telemetry,
					partialProgressCommits: existing?.partialProgressCommits,
					partialProgressBranch: existing?.partialProgressBranch,
					exitDiagnostic: existing?.exitDiagnostic,
				}) || changed;
		}

		for (const taskId of lane.completedTasks) {
			const existing = outcomes.find(o => o.taskId === taskId);
			changed =
				upsertTaskOutcome(outcomes, {
					taskId,
					status: "succeeded",
					startTime: existing?.startTime ?? null,
					endTime: existing?.endTime ?? monitorState.lastPollTime,
					exitReason: existing?.exitReason || ".DONE file created by task-runner",
					sessionName: existing?.sessionName || lane.sessionName,
					doneFileFound: true,
					laneNumber: existing?.laneNumber ?? lane.laneNumber,
					telemetry: existing?.telemetry,
					partialProgressCommits: existing?.partialProgressCommits,
					partialProgressBranch: existing?.partialProgressBranch,
					exitDiagnostic: existing?.exitDiagnostic,
				}) || changed;
		}

		for (const taskId of lane.failedTasks) {
			const existing = outcomes.find(o => o.taskId === taskId);
			changed =
				upsertTaskOutcome(outcomes, {
					taskId,
					status: "failed",
					startTime: existing?.startTime ?? null,
					endTime: existing?.endTime ?? monitorState.lastPollTime,
					exitReason: existing?.exitReason || "Task failed or stalled",
					sessionName: existing?.sessionName || lane.sessionName,
					doneFileFound: false,
					laneNumber: existing?.laneNumber ?? lane.laneNumber,
					telemetry: existing?.telemetry,
					partialProgressCommits: existing?.partialProgressCommits,
					partialProgressBranch: existing?.partialProgressBranch,
					exitDiagnostic: existing?.exitDiagnostic,
				}) || changed;
		}

		if (lane.currentTaskId && lane.currentTaskSnapshot) {
			const snap = lane.currentTaskSnapshot;
			const existing = outcomes.find(o => o.taskId === lane.currentTaskId);
			const monitorToLane: Record<TaskMonitorSnapshot["status"], LaneTaskStatus> = {
				pending: "pending",
				running: "running",
				succeeded: "succeeded",
				failed: "failed",
				stalled: "stalled",
				skipped: "skipped",
				unknown: existing?.status || "running",
			};
			const mappedStatus = monitorToLane[snap.status];
			const terminal =
				mappedStatus === "succeeded" ||
				mappedStatus === "failed" ||
				mappedStatus === "stalled" ||
				mappedStatus === "skipped";

			changed =
				upsertTaskOutcome(outcomes, {
					taskId: lane.currentTaskId,
					status: mappedStatus,
					startTime: existing?.startTime ?? snap.observedAt,
					endTime: terminal ? (existing?.endTime ?? snap.observedAt) : null,
					exitReason:
						existing?.exitReason ||
						(mappedStatus === "running" ? "Task in progress" : snap.stallReason || "Task reached terminal state"),
					sessionName: existing?.sessionName || lane.sessionName,
					doneFileFound: snap.doneFileFound,
					laneNumber: existing?.laneNumber ?? lane.laneNumber,
					telemetry: existing?.telemetry,
					partialProgressCommits: existing?.partialProgressCommits,
					partialProgressBranch: existing?.partialProgressBranch,
					exitDiagnostic: existing?.exitDiagnostic,
				}) || changed;
		}
	}

	return changed;
}

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
 * Delete the active batch state file. Idempotent — no error when the
 * file does not exist. Thin wrapper over `unlinkBatchState` preserved
 * for backwards compatibility with earlier callers.
 */
export async function deleteBatchState(cwd: string): Promise<void> {
	await unlinkBatchState(cwd);
}

/**
 * Persist runtime state to `.omp/mission-batch.json` atomically.
 *
 * Serializes the batch state, wave plan, lanes, and accumulated outcomes
 * through `serializeBatchState`, then writes via the atomic `saveBatchState`
 * temp-file+rename pipeline. Errors are caught and recorded on
 * `batchState.errors` so persistence failures never crash the engine —
 * callers still observe the failed write through the accumulated error.
 */
export async function persistRuntimeState(
	reason: string,
	batchState: MissionBatchRuntimeState,
	wavePlan: string[][],
	lanes: AllocatedLane[],
	outcomes: LaneTaskOutcome[],
	_discovery: unknown,
	cwd: string,
): Promise<void> {
	try {
		const json = serializeBatchState(batchState, wavePlan, lanes, outcomes);
		await saveBatchState(json, cwd);
		logger.debug("[missioncontrol] persistRuntimeState", {
			reason,
			batchId: batchState.batchId,
			phase: batchState.phase,
			waveIndex: batchState.currentWaveIndex,
		});
	} catch (err: unknown) {
		const msg =
			err instanceof StateFileError
				? `[${err.code}] ${err.message}`
				: err instanceof Error
					? err.message
					: String(err);
		logger.error("[missioncontrol] persistRuntimeState write failed", {
			reason,
			batchId: batchState.batchId,
			phase: batchState.phase,
			error: msg,
		});
		batchState.errors.push(`State persistence failed (${reason}): ${msg}`);
	}
}

// ── Orphan detection / startup-state analysis ───────────────────────────────

/**
 * Parse tmux `list-sessions -F "#{session_name}"` output.
 *
 * Filters session names by the given prefix (e.g., `"mission"` matches
 * `"mission-lane-1"`). Handles empty output, blank lines, and whitespace-padded
 * names gracefully.
 *
 * Pure function — no process or filesystem access.
 *
 * @param stdout - Raw stdout from `tmux list-sessions -F "#{session_name}"`.
 * @param prefix - Session name prefix to filter by (e.g., `"mission"`).
 * @returns Sorted array of matching session names.
 */
export function parseMissionSessionNames(stdout: string, prefix: string): string[] {
	if (!stdout?.trim()) return [];

	const filterPrefix = `${prefix}-`;

	return stdout
		.split("\n")
		.map(line => line.trim())
		.filter(name => name.length > 0 && name.startsWith(filterPrefix))
		.sort();
}

/**
 * Analyze mission startup state — pure deterministic decision logic.
 *
 * Given the current state of orphan sessions, batch state file, and task
 * completion markers, returns a deterministic recommendation for what the
 * `/mission` command should do.
 *
 * Decision matrix:
 * | Orphans? | State Status | Done? | Action          |
 * |----------|--------------|-------|-----------------|
 * | Yes      | valid        | —     | resume          |
 * | Yes      | missing      | —     | abort-orphans   |
 * | Yes      | invalid      | —     | abort-orphans   |
 * | Yes      | io-error     | —     | abort-orphans   |
 * | No       | valid        | all   | cleanup-stale   |
 * | No       | valid        | !all  | resume          |
 * | No       | missing      | —     | start-fresh     |
 * | No       | invalid      | —     | paused-corrupt  |
 * | No       | io-error     | —     | paused-corrupt  |
 *
 * Pure function — no process or filesystem access.
 */
export function analyzeMissionStartupState(
	orphanSessions: string[],
	stateStatus: OrphanStateStatus,
	loadedState: PersistedBatchState | null,
	stateError: string | null,
	doneTaskIds: ReadonlySet<string>,
): OrphanDetectionResult {
	const hasOrphans = orphanSessions.length > 0;
	const sessionList = orphanSessions.join(", ");

	// ── Orphan sessions exist ────────────────────────────────────
	if (hasOrphans) {
		if (stateStatus === "valid" && loadedState) {
			return {
				orphanSessions,
				stateStatus,
				loadedState,
				stateError,
				recommendedAction: "resume",
				userMessage:
					`Found ${orphanSessions.length} running mission session(s): ${sessionList}\n` +
					`   Batch ${loadedState.batchId} (${loadedState.phase}) has persisted state.\n` +
					`   Use /mission-resume to continue, or /mission-abort to clean up.`,
			};
		}

		// Orphans without usable state (missing, invalid, or io-error)
		const errorCtx = stateError ? `\n   State error: ${stateError}` : "";
		return {
			orphanSessions,
			stateStatus,
			loadedState: null,
			stateError,
			recommendedAction: "abort-orphans",
			userMessage:
				`Found ${orphanSessions.length} orphan mission session(s): ${sessionList}\n` +
				`   No usable batch state file (status: ${stateStatus}).${errorCtx}\n` +
				`   Use /mission-abort to clean up before starting a new batch.`,
		};
	}

	// ── No orphan sessions ───────────────────────────────────────

	if (stateStatus === "missing") {
		return {
			orphanSessions: [],
			stateStatus,
			loadedState: null,
			stateError,
			recommendedAction: "start-fresh",
			userMessage: "",
		};
	}

	if (stateStatus === "valid" && loadedState) {
		const allTaskIds = loadedState.tasks.map(t => t.taskId);
		const allDone = allTaskIds.length > 0 && allTaskIds.every(id => doneTaskIds.has(id));

		if (allDone) {
			return {
				orphanSessions: [],
				stateStatus,
				loadedState,
				stateError,
				recommendedAction: "cleanup-stale",
				userMessage:
					`Found stale batch state file from batch ${loadedState.batchId}.\n` +
					`   All ${allTaskIds.length} task(s) have .DONE files. Cleaning up state file.`,
			};
		}

		const completedCount = allTaskIds.filter(id => doneTaskIds.has(id)).length;

		// Only phases that resume can actually handle should get "resume".
		// Non-resumable phases with 0 completed tasks are pure noise — auto-clean
		// so /mission can start fresh without forcing the user through /mission-abort.
		const resumablePhases: MissionBatchPhase[] = ["paused", "executing", "merging"];
		const isResumable = resumablePhases.includes(loadedState.phase as MissionBatchPhase);

		if (!isResumable && completedCount === 0) {
			return {
				orphanSessions: [],
				stateStatus,
				loadedState,
				stateError,
				recommendedAction: "cleanup-stale",
				userMessage:
					`Found non-resumable batch state (${loadedState.batchId}, phase=${loadedState.phase}, 0 tasks ran).\n` +
					`   Cleaning up stale state file so a fresh batch can start.`,
			};
		}

		return {
			orphanSessions: [],
			stateStatus,
			loadedState,
			stateError,
			recommendedAction: isResumable ? "resume" : "cleanup-stale",
			userMessage: isResumable
				? `Found interrupted batch ${loadedState.batchId} (${loadedState.phase}).\n` +
					`   ${completedCount}/${allTaskIds.length} task(s) completed.\n` +
					`   Use /mission-resume to continue, or /mission-abort to clean up.`
				: `Found non-resumable batch state (${loadedState.batchId}, phase=${loadedState.phase}).\n` +
					`   ${completedCount}/${allTaskIds.length} task(s) completed. Cleaning up state file.`,
		};
	}

	// Invalid or io-error state with no orphans — corrupt state.
	// Never auto-delete: enter paused-corrupt so the user can inspect the file
	// and decide whether to manually recover or remove it.
	return {
		orphanSessions: [],
		stateStatus,
		loadedState: null,
		stateError,
		recommendedAction: "paused-corrupt",
		userMessage:
			`Batch state file is corrupt or unreadable (${stateStatus}).\n` +
			(stateError ? `   Error: ${stateError}\n` : "") +
			`   The file has NOT been deleted. Inspect .omp/mission-batch.json manually,\n` +
			`   then either fix it or delete it and run /mission again.`,
	};
}

/**
 * Detect orphan mission state and analyze startup recovery action.
 *
 * Runtime V2 uses persisted state as the source of truth — tmux session
 * discovery is no longer authoritative, but the `prefix` is retained for
 * API compatibility with legacy callers.
 */
export async function detectOrphanSessions(prefix: string, repoRoot: string): Promise<OrphanDetectionResult> {
	void prefix;

	const orphanSessions: string[] = [];

	// ── 1. Load batch state file ─────────────────────────────────
	let stateStatus: OrphanStateStatus = "missing";
	let loadedState: PersistedBatchState | null = null;
	let stateError: string | null = null;

	try {
		loadedState = await loadBatchState(repoRoot);
		stateStatus = loadedState ? "valid" : "missing";
	} catch (err: unknown) {
		if (err instanceof StateFileError) {
			switch (err.code) {
				case "STATE_FILE_PARSE_ERROR":
				case "STATE_SCHEMA_INVALID":
					stateStatus = "invalid";
					stateError = `[${err.code}] ${err.message}`;
					break;
				case "STATE_FILE_IO_ERROR":
					stateStatus = "io-error";
					stateError = `[${err.code}] ${err.message}`;
					break;
			}
		} else {
			stateStatus = "io-error";
			stateError = err instanceof Error ? err.message : String(err);
		}
	}

	// ── 2. Check .DONE files for stale state detection ───────────
	const doneTaskIds = new Set<string>();
	if (loadedState && orphanSessions.length === 0) {
		for (const task of loadedState.tasks) {
			if (task.taskFolder && hasTaskDoneMarker(task.taskFolder)) {
				doneTaskIds.add(task.taskId);
			}
		}
	}

	// ── 3. Analyze and return ────────────────────────────────────
	return analyzeMissionStartupState(orphanSessions, stateStatus, loadedState, stateError, doneTaskIds);
}

// ── Batch history (`.omp/mission-history.json`) ────────────────────────────

async function readHistoryFile(filePath: string): Promise<BatchHistorySummary[]> {
	if (!existsSync(filePath)) return [];
	try {
		const raw = await readFile(filePath, "utf-8");
		const data = JSON.parse(raw);
		return Array.isArray(data) ? (data as BatchHistorySummary[]) : [];
	} catch (err) {
		logger.warn("[missioncontrol] batch history read failed", {
			path: filePath,
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}
}

/**
 * Load the batch history log from `.omp/mission-history.json`.
 *
 * Falls back to the legacy taskplane path `.pi/batch-history.json` when
 * the new file is absent. Returns `[]` on any read or parse error —
 * history is non-authoritative metadata and must not block the batch.
 */
export async function loadBatchHistory(repoRoot: string): Promise<BatchHistorySummary[]> {
	const newPath = missionHistoryPath(repoRoot);
	if (existsSync(newPath)) return readHistoryFile(newPath);
	return readHistoryFile(legacyBatchHistoryPath(repoRoot));
}

async function writeHistoryAtomic(filePath: string, history: BatchHistorySummary[]): Promise<void> {
	const dir = dirname(filePath);
	if (!existsSync(dir)) await mkdir(dir, { recursive: true });
	const tmp = `${filePath}.tmp`;
	await writeFile(tmp, JSON.stringify(history, null, 2), "utf-8");
	await rename(tmp, filePath);
}

/**
 * Append `summary` to the batch history and trim to `BATCH_HISTORY_MAX_ENTRIES`.
 *
 * Upserts by `batchId` — a resumed batch replaces its earlier partial
 * entry instead of duplicating. Writes atomically via temp + rename.
 * Best-effort: failures are logged, never thrown.
 */
export async function saveBatchHistory(repoRoot: string, summary: BatchHistorySummary): Promise<void> {
	try {
		const history = await loadBatchHistory(repoRoot);
		const next = history.filter(entry => entry.batchId !== summary.batchId);
		next.unshift(summary);
		if (next.length > BATCH_HISTORY_MAX_ENTRIES) {
			next.length = BATCH_HISTORY_MAX_ENTRIES;
		}
		await writeHistoryAtomic(missionHistoryPath(repoRoot), next);
	} catch (err) {
		logger.error("[missioncontrol] batch history save failed", {
			batchId: summary.batchId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Update an existing history entry's `integratedAt` timestamp.
 *
 * No-op when no matching `batchId` is found (the entry may predate the
 * history feature). Best-effort on failure.
 */
export async function updateBatchHistoryIntegration(
	repoRoot: string,
	batchId: string,
	integratedAt: number,
): Promise<void> {
	try {
		const history = await loadBatchHistory(repoRoot);
		const entry = history.find(e => e.batchId === batchId);
		if (!entry) {
			logger.debug("[missioncontrol] no history entry for batchId — skipping integratedAt update", { batchId });
			return;
		}
		entry.integratedAt = integratedAt;
		await writeHistoryAtomic(missionHistoryPath(repoRoot), history);
	} catch (err) {
		logger.error("[missioncontrol] updateBatchHistoryIntegration failed", {
			batchId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── Tier 0 + Engine event emission ──────────────────────────────────────────

/**
 * Build the required base fields for a Tier 0 event.
 *
 * Ensures consistent field population across all emit sites so supervisor
 * consumers get a deterministic event shape. Mirrors taskplane's
 * `buildTier0EventBase` exactly.
 */
export function buildTier0EventBase(
	type: Tier0EventType,
	batchId: string,
	waveIndex: number,
	pattern: Tier0EscalationPattern,
	attempt: number,
	maxAttempts: number,
): Pick<Tier0Event, "timestamp" | "type" | "batchId" | "waveIndex" | "pattern" | "attempt" | "maxAttempts"> {
	return {
		timestamp: new Date().toISOString(),
		type,
		batchId,
		waveIndex,
		pattern,
		attempt,
		maxAttempts,
	};
}

/**
 * Build the base fields for an engine lifecycle event.
 *
 * Analogous to `buildTier0EventBase` — produces the uniform header that
 * every `EngineEvent` emit site must carry.
 */
export function buildEngineEventBase(
	type: EngineEventType,
	batchId: string,
	waveIndex: number,
	phase: MissionBatchPhase,
): Pick<EngineEvent, "timestamp" | "type" | "batchId" | "waveIndex" | "phase"> {
	return {
		timestamp: new Date().toISOString(),
		type,
		batchId,
		waveIndex,
		phase,
	};
}

async function ensureSupervisorDir(stateRoot: string): Promise<void> {
	const dir = supervisorDir(stateRoot);
	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}
}

async function appendEventLine(stateRoot: string, line: string): Promise<void> {
	await ensureSupervisorDir(stateRoot);
	await appendFile(supervisorEventsPath(stateRoot), line, "utf-8");
}

/**
 * Emit a Tier 0 supervisor event to `.omp/supervisor/events.jsonl`.
 *
 * Best-effort: creates the directory if needed, appends the event as a single
 * JSONL line. Failures are logged but never thrown — the batch continues.
 */
export async function emitTier0Event(stateRoot: string, event: Tier0Event): Promise<void> {
	try {
		await appendEventLine(stateRoot, `${JSON.stringify(event)}\n`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("[missioncontrol] tier0 event write failed", {
			batchId: event.batchId,
			eventType: event.type,
			pattern: event.pattern,
			error: msg,
		});
	}
}

/**
 * Emit an engine lifecycle event to `.omp/supervisor/events.jsonl`.
 *
 * Shares the same JSONL file as Tier 0 events for unified supervisor
 * consumption. Best-effort on the write path; the optional `callback`
 * is invoked after the write (errors there are also swallowed + logged).
 */
export async function emitEngineEvent(
	stateRoot: string,
	event: EngineEvent,
	callback?: EngineEventCallback | null,
): Promise<void> {
	try {
		await appendEventLine(stateRoot, `${JSON.stringify(event)}\n`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("[missioncontrol] engine event write failed", {
			batchId: event.batchId,
			eventType: event.type,
			error: msg,
		});
	}

	if (callback) {
		try {
			callback(event);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("[missioncontrol] engine event callback failed", {
				batchId: event.batchId,
				eventType: event.type,
				error: msg,
			});
		}
	}
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
