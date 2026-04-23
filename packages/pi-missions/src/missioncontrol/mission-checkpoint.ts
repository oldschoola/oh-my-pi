/**
 * Mission checkpoint writer (Track H5).
 *
 * Operators rotating across a multi-day mission (shift handoffs, on-call
 * rotation, session restarts) need a human-readable summary they can
 * drop into a chat / ticket / standup note. `writeMissionCheckpoint`
 * renders a Markdown status snapshot derived from the persisted batch
 * state + validation contract + milestone rollups and writes it to
 * `<projectDir>/checkpoints/<batchId>-<timestamp>.md`.
 *
 * The function is pure relative to its inputs; callers load the
 * persisted state + contract first (keeps the writer easy to test and
 * lets the orchestrator tool fetch from whichever source it already has
 * in hand).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { projectDir } from "./adapter";
import type { PersistedBatchState } from "./types";
import type { ValidationContract } from "./validation-contract";
import { elapsedDays, idleSinceLabel } from "./validator-stall";

/** Directory under the project where checkpoints land. */
export const CHECKPOINTS_DIRNAME = "checkpoints";

/** Resolve the checkpoints directory for a project. */
export function checkpointsDir(cwd: string): string {
	return path.join(projectDir(cwd), CHECKPOINTS_DIRNAME);
}

/** Compute a filename-safe timestamp slug: `YYYYMMDDThhmmss`. */
export function timestampSlug(now: Date = new Date()): string {
	const iso = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z");
	return iso.replace(/Z$/, "").replace(/T/, "T");
}

/** Resolve the absolute path for a single checkpoint file. */
export function checkpointPath(cwd: string, batchId: string, now: Date = new Date()): string {
	const safeBatch = batchId.replace(/[^A-Za-z0-9_-]+/g, "_");
	return path.join(checkpointsDir(cwd), `${safeBatch}-${timestampSlug(now)}.md`);
}

/** Inputs consumed by {@link renderCheckpointMarkdown}. */
export interface CheckpointInput {
	state: PersistedBatchState;
	contract?: ValidationContract | null;
	/** Optional free-form operator note appended to the checkpoint. */
	note?: string;
	/** Deterministic clock override. Default: `new Date()`. */
	now?: Date;
}

/**
 * Render a Markdown checkpoint document. Pure function \u2014 safe to call
 * from tests and the API handler. Output structure:
 *
 * ```
 * # Mission Checkpoint \u2014 <batchId>
 *
 * **Generated:** 2026-04-22T10:15:00.000Z
 * **Phase:** executing
 * **Started:** 2026-04-20T08:00:00.000Z (2 days ago)
 *
 * ## Milestones
 * - M-001 \u2014 status: in_progress, rounds 1/4, 3 features, 2 assertions
 *
 * ## Features
 * - F-001: succeeded
 * - F-002: running (idle 5m)
 *
 * ## Validation Contract
 * - VA-001 [auth]: Login round-trip works
 * - VA-002 [cli]: Help message renders
 *
 * ## Operator Note
 * ... (free-form) ...
 * ```
 */
export function renderCheckpointMarkdown(input: CheckpointInput): string {
	const now = input.now ?? new Date();
	const state = input.state;
	const lines: string[] = [];
	lines.push(`# Mission Checkpoint \u2014 ${state.batchId}`);
	lines.push("");
	lines.push(`**Generated:** ${now.toISOString()}`);
	lines.push(`**Phase:** ${state.phase}`);

	if (typeof state.startedAt === "number" && state.startedAt > 0) {
		const startedDate = new Date(state.startedAt).toISOString();
		const days = elapsedDays(state.startedAt, now.getTime());
		const dayLabel = days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
		lines.push(`**Started:** ${startedDate} (${dayLabel})`);
	}
	if (typeof state.updatedAt === "number" && state.updatedAt > 0) {
		lines.push(`**Last update:** ${idleSinceLabel(state.updatedAt, now.getTime())} ago`);
	}
	lines.push("");

	const milestones = state.milestones ?? [];
	if (milestones.length > 0) {
		lines.push("## Milestones");
		for (const m of milestones) {
			lines.push(
				`- ${m.id} (${m.name}) \u2014 status: ${m.status}, rounds ${m.validationRounds}/${m.maxValidationRounds}, ${m.featureIds.length} feature(s), ${m.assertionIds.length} assertion(s)`,
			);
		}
		lines.push("");
	}

	const tasks = state.tasks ?? [];
	if (tasks.length > 0) {
		lines.push("## Features");
		for (const t of tasks) {
			const suffix = t.isFixFeature ? " [fix feature]" : "";
			const parent = t.parentFeatureId ? ` (parent: ${t.parentFeatureId})` : "";
			lines.push(`- ${t.taskId}: ${t.status}${suffix}${parent}`);
		}
		lines.push("");
	}

	const contract = input.contract;
	if (contract && contract.assertions.length > 0) {
		lines.push("## Validation Contract");
		for (const a of contract.assertions) {
			lines.push(`- ${a.id} [${a.area}]: ${a.title}`);
		}
		lines.push("");
	}

	const counts = [
		`Total: ${state.totalTasks ?? tasks.length}`,
		`Succeeded: ${state.succeededTasks ?? 0}`,
		`Failed: ${state.failedTasks ?? 0}`,
		`Skipped: ${state.skippedTasks ?? 0}`,
		`Blocked: ${state.blockedTasks ?? 0}`,
	];
	lines.push("## Tallies");
	lines.push(`- ${counts.join(" \u00b7 ")}`);
	lines.push("");

	if (input.note && input.note.trim().length > 0) {
		lines.push("## Operator Note");
		lines.push("");
		lines.push(input.note.trim());
		lines.push("");
	}

	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`;
}

/**
 * Render + persist a checkpoint. Returns the absolute path of the
 * written file. Creates the parent directory if missing.
 */
export async function writeMissionCheckpoint(cwd: string, input: CheckpointInput): Promise<string> {
	const now = input.now ?? new Date();
	const filePath = checkpointPath(cwd, input.state.batchId, now);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const markdown = renderCheckpointMarkdown({ ...input, now });
	await Bun.write(filePath, markdown);
	return filePath;
}
