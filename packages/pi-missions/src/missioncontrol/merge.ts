/**
 * Merge — pure helpers ported from taskplane `extensions/taskplane/merge.ts`.
 *
 * Scope: the four parser/planner helpers that don't need the full engine,
 * agent-host, registry, or timing infrastructure:
 *
 * - `parseMergeResult` / `parseMergeResultAsync` — strict JSON parser for
 *   merge-agent RESULT.md output with a retry-read loop for
 *   partially-written files.
 * - `determineMergeOrder` — orders completed lanes by fewest-files-first
 *   (default) or lane number (sequential).
 * - `buildMergeRequest` — structured text document handed to the merge
 *   agent describing source/target branches, task scope, verification
 *   commands, and the result-file JSON schema.
 * - `classifyMergeHealth` — pure state-machine for merge session health
 *   (healthy / warning / stuck / dead) consumed by the supervisor.
 *
 * Deferred until the engine + registry ports land:
 * `spawnMergeAgentV2`, `waitForMergeResult`, `mergeWave`,
 * `mergeWaveByRepo`, `attemptAutoIntegration`, `MergeHealthMonitor`
 * class, `stageSkippedArtifactsToTargetBranch`.
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";

import type {
	AllocatedLane,
	MergeHealthStatus,
	MergeResult,
	MergeResultStatus,
	MergeSessionHealthState,
} from "./types";
import {
	MERGE_HEALTH_STUCK_THRESHOLD_MS,
	MERGE_HEALTH_WARNING_THRESHOLD_MS,
	MERGE_RESULT_READ_RETRIES,
	MERGE_RESULT_READ_RETRY_DELAY_MS,
	MergeError,
	VALID_MERGE_STATUSES,
} from "./types";

// ── Tiny local sleep helpers ─────────────────────────────────────────
// Inlined until worktree.ts lands. Tests override `MERGE_RESULT_READ_RETRY_DELAY_MS`
// via module-level read — see `parseMergeResult` retry loop.

function sleepSync(ms: number): void {
	// Use Atomics.wait on a shared buffer for cross-platform blocking sleep.
	// Avoids spawning ping/sleep child processes used by taskplane.
	if (ms <= 0) return;
	const shared = new SharedArrayBuffer(4);
	const view = new Int32Array(shared);
	Atomics.wait(view, 0, 0, ms);
}

function sleepAsync(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Merge result parser (shared helpers) ─────────────────────────────

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}
	return null;
}

function hasFlatVerification(obj: Record<string, unknown>): boolean {
	return (
		typeof obj.verification_passed === "boolean" ||
		Array.isArray(obj.verification_commands) ||
		typeof obj.verification_output === "string" ||
		typeof obj.verification_exit_code === "number"
	);
}

function normalizeVerification(obj: Record<string, unknown>): MergeResult["verification"] | null {
	const nested =
		obj.verification && typeof obj.verification === "object" ? (obj.verification as Record<string, unknown>) : null;

	if (!nested && !hasFlatVerification(obj)) {
		return null;
	}

	const passedFromBool =
		(nested && typeof nested.passed === "boolean" ? nested.passed : undefined) ??
		(nested && typeof nested.all_passed === "boolean" ? nested.all_passed : undefined) ??
		(typeof obj.verification_passed === "boolean" ? obj.verification_passed : undefined);

	const exitCode =
		(nested && typeof nested.exitCode === "number" ? nested.exitCode : undefined) ??
		(nested && typeof nested.exit_code === "number" ? nested.exit_code : undefined) ??
		(typeof obj.verification_exit_code === "number" ? obj.verification_exit_code : undefined);

	const passed =
		typeof passedFromBool === "boolean" ? passedFromBool : typeof exitCode === "number" ? exitCode === 0 : false;

	const ran =
		nested && typeof nested.ran === "boolean"
			? nested.ran
			: typeof passedFromBool === "boolean" ||
				typeof exitCode === "number" ||
				(nested && typeof nested.command === "string") ||
				(nested && typeof nested.summary === "string") ||
				typeof obj.verification_output === "string" ||
				Array.isArray(obj.verification_commands);

	const output = (
		(nested && typeof nested.output === "string" ? nested.output : undefined) ??
		(nested && typeof nested.summary === "string" ? nested.summary : undefined) ??
		(nested && typeof nested.notes === "string" ? nested.notes : undefined) ??
		(typeof obj.verification_output === "string" ? obj.verification_output : "")
	).slice(0, 2000);

	return { ran, passed: Boolean(passed), output };
}

function buildMergeResultFromParsed(parsed: Record<string, unknown>, resultPath: string): MergeResult {
	if (typeof parsed.status !== "string") {
		throw new MergeError(
			"MERGE_RESULT_MISSING_FIELDS",
			`Merge result missing required field "status": ${resultPath}`,
		);
	}

	const sourceBranch = pickString(parsed, "source_branch", "sourceBranch", "source");
	if (!sourceBranch) {
		throw new MergeError(
			"MERGE_RESULT_MISSING_FIELDS",
			`Merge result missing required field "source_branch" (accepted aliases: sourceBranch, source): ${resultPath}`,
		);
	}

	const verification = normalizeVerification(parsed);
	if (!verification) {
		throw new MergeError(
			"MERGE_RESULT_MISSING_FIELDS",
			`Merge result missing required field "verification": ${resultPath}`,
		);
	}

	let status = String(parsed.status).toUpperCase();
	if (!VALID_MERGE_STATUSES.has(status)) {
		status = "BUILD_FAILURE";
	}

	const targetBranch = pickString(parsed, "target_branch", "targetBranch", "target") ?? "";
	const mergeCommit = pickString(parsed, "merge_commit", "mergeCommit") ?? "";
	const conflicts = Array.isArray(parsed.conflicts)
		? parsed.conflicts
				.filter(
					(c): c is { file: string; type: string; resolved: boolean; resolution?: string } =>
						typeof c === "object" &&
						c !== null &&
						typeof (c as { file?: unknown }).file === "string" &&
						typeof (c as { type?: unknown }).type === "string" &&
						typeof (c as { resolved?: unknown }).resolved === "boolean",
				)
				.map(c => ({
					file: c.file,
					type: c.type,
					resolved: c.resolved,
					...(typeof c.resolution === "string" ? { resolution: c.resolution } : {}),
				}))
		: [];

	return {
		status: status as MergeResultStatus,
		source_branch: sourceBranch,
		target_branch: targetBranch,
		merge_commit: mergeCommit,
		conflicts,
		verification,
	};
}

/**
 * Parse and validate a merge result JSON file.
 *
 * Strict validation:
 * - Must be valid JSON
 * - Must have required fields: status, source_branch, verification
 * - status must be a known MergeResultStatus
 * - Unknown status values are mapped to BUILD_FAILURE (fail-safe)
 *
 * Retry-read strategy: if initial parse fails, waits and retries up to
 * `MERGE_RESULT_READ_RETRIES` times to handle partially-written files.
 *
 * @throws MergeError with appropriate code on validation failure
 */
export function parseMergeResult(resultPath: string): MergeResult {
	if (!existsSync(resultPath)) {
		throw new MergeError("MERGE_RESULT_INVALID", `Merge result file not found: ${resultPath}`);
	}

	let lastParseError = "";
	for (let attempt = 1; attempt <= MERGE_RESULT_READ_RETRIES; attempt++) {
		try {
			const raw = readFileSync(resultPath, "utf-8").trim();
			if (!raw) {
				lastParseError = "File is empty";
				if (attempt < MERGE_RESULT_READ_RETRIES) {
					sleepSync(MERGE_RESULT_READ_RETRY_DELAY_MS);
					continue;
				}
				throw new MergeError(
					"MERGE_RESULT_INVALID",
					`Merge result file is empty after ${MERGE_RESULT_READ_RETRIES} attempts: ${resultPath}`,
				);
			}

			const parsed = JSON.parse(raw) as Record<string, unknown>;
			return buildMergeResultFromParsed(parsed, resultPath);
		} catch (err: unknown) {
			if (err instanceof MergeError) throw err;

			lastParseError = err instanceof Error ? err.message : String(err);
			if (attempt < MERGE_RESULT_READ_RETRIES) {
				sleepSync(MERGE_RESULT_READ_RETRY_DELAY_MS);
			}
		}
	}

	throw new MergeError(
		"MERGE_RESULT_INVALID",
		`Failed to parse merge result JSON after ${MERGE_RESULT_READ_RETRIES} attempts. ` +
			`Last error: ${lastParseError}. File: ${resultPath}`,
	);
}

/**
 * Async version of `parseMergeResult` — identical validation semantics,
 * non-blocking I/O + retry-sleep.
 */
export async function parseMergeResultAsync(resultPath: string): Promise<MergeResult> {
	if (!existsSync(resultPath)) {
		throw new MergeError("MERGE_RESULT_INVALID", `Merge result file not found: ${resultPath}`);
	}

	let lastParseError = "";
	for (let attempt = 1; attempt <= MERGE_RESULT_READ_RETRIES; attempt++) {
		try {
			const raw = (await fsReadFile(resultPath, "utf-8")).trim();
			if (!raw) {
				lastParseError = "File is empty";
				if (attempt < MERGE_RESULT_READ_RETRIES) {
					await sleepAsync(MERGE_RESULT_READ_RETRY_DELAY_MS);
					continue;
				}
				throw new MergeError(
					"MERGE_RESULT_INVALID",
					`Merge result file is empty after ${MERGE_RESULT_READ_RETRIES} attempts: ${resultPath}`,
				);
			}

			const parsed = JSON.parse(raw) as Record<string, unknown>;
			return buildMergeResultFromParsed(parsed, resultPath);
		} catch (err: unknown) {
			if (err instanceof MergeError) throw err;

			lastParseError = err instanceof Error ? err.message : String(err);
			if (attempt < MERGE_RESULT_READ_RETRIES) {
				await sleepAsync(MERGE_RESULT_READ_RETRY_DELAY_MS);
			}
		}
	}

	throw new MergeError(
		"MERGE_RESULT_INVALID",
		`Failed to parse merge result JSON after ${MERGE_RESULT_READ_RETRIES} attempts. ` +
			`Last error: ${lastParseError}. File: ${resultPath}`,
	);
}

/**
 * Determine merge order for completed lanes.
 *
 * - `"fewest-files-first"` (default): lanes with fewer files in their file
 *   scope merge first; tie-break by branch name alphabetically.
 * - `"sequential"`: lane number ascending.
 */
export function determineMergeOrder(
	lanes: AllocatedLane[],
	order: "fewest-files-first" | "sequential",
): AllocatedLane[] {
	const sorted = [...lanes];

	if (order === "sequential") {
		sorted.sort((a, b) => a.laneNumber - b.laneNumber);
		return sorted;
	}

	sorted.sort((a, b) => {
		const aFiles = a.tasks.reduce((sum, t) => sum + (t.task?.fileScope?.length || 0), 0);
		const bFiles = b.tasks.reduce((sum, t) => sum + (t.task?.fileScope?.length || 0), 0);

		if (aFiles !== bFiles) return aFiles - bFiles;
		return a.branch.localeCompare(b.branch);
	});

	return sorted;
}

/**
 * Build merge-request text handed to the merge agent.
 *
 * Documents source/target branches, task scope, verification commands,
 * and the exact JSON schema + result file path the agent must write.
 */
export function buildMergeRequest(
	lane: AllocatedLane,
	targetBranch: string,
	waveIndex: number,
	verifyCommands: string[],
	resultFilePath: string,
): string {
	const taskIds = lane.tasks.map(t => t.taskId).join(", ");
	const fileScopes = lane.tasks.flatMap(t => t.task?.fileScope || []).filter((f, i, arr) => arr.indexOf(f) === i);

	const mergeMessage = `merge: wave ${waveIndex} lane ${lane.laneNumber} — ${taskIds}`;
	const resultPathPosix = resultFilePath.split("\\").join("/");

	const lines: string[] = [
		"# Merge Request",
		"",
		"## Source Branch",
		`${lane.branch}`,
		"",
		"## Target Branch",
		`${targetBranch}`,
		"",
		"## Merge Message",
		`${mergeMessage}`,
		"",
		"## Tasks Completed",
		...lane.tasks.map(t => `- ${t.taskId}: ${t.task?.taskName ?? "(unknown)"}`),
		"",
		"## File Scope",
		...(fileScopes.length > 0 ? fileScopes.map(f => `- ${f}`) : ["- (no file scope declared)"]),
		"",
		"## Verification Commands",
		...verifyCommands.map(cmd => `\`\`\`bash\n${cmd}\n\`\`\``),
		"",
		"## Result File",
		`result_file: ${resultPathPosix}`,
		`Write your JSON result to EXACTLY this path (do NOT modify or convert it): ${resultPathPosix}`,
		"",
		"## Result JSON Schema (required)",
		"Use EXACT snake_case keys shown below. Do not use camelCase or shortened keys.",
		"",
		"```json",
		"{",
		'  "status": "SUCCESS" | "CONFLICT_RESOLVED" | "CONFLICT_UNRESOLVED" | "BUILD_FAILURE",',
		'  "source_branch": "<source branch name>",',
		'  "target_branch": "<target branch name>",',
		'  "merge_commit": "<merge commit sha or empty string>",',
		'  "conflicts": [{ "file": "...", "type": "...", "resolved": true|false }],',
		'  "verification": { "ran": true|false, "passed": true|false, "output": "..." }',
		"}",
		"```",
		"",
		"Do NOT use keys like source/sourceBranch/target/mergeCommit.",
		"Write valid JSON only (no markdown around the final file).",
		"",
		"## Important",
		"- You are working in an ISOLATED MERGE WORKTREE (not the user's main repo)",
		"- The correct branch is ALREADY checked out — do NOT checkout any other branch",
		"- Simply merge the source branch into the current HEAD",
		"- Run ALL verification commands after a successful merge",
		"- If verification fails, revert the merge commit before writing the result",
		"- Write the result file LAST, after all git operations are complete",
	];

	return lines.join("\n");
}

/**
 * Classify a merge session's health from liveness + activity age.
 *
 * - `dead`:    session exited, no result file
 * - `healthy`: session exited with a result file, OR elapsed-since-activity
 *              below warning threshold
 * - `warning`: session alive, `MERGE_HEALTH_WARNING_THRESHOLD_MS` <=
 *              elapsed < `MERGE_HEALTH_STUCK_THRESHOLD_MS`
 * - `stuck`:   session alive, elapsed >= `MERGE_HEALTH_STUCK_THRESHOLD_MS`
 */
export function classifyMergeHealth(
	sessionAlive: boolean,
	hasResultFile: boolean,
	healthState: MergeSessionHealthState,
	now: number,
): MergeHealthStatus {
	if (!sessionAlive && !hasResultFile) return "dead";
	if (!sessionAlive && hasResultFile) return "healthy";

	const elapsedMs = now - healthState.lastActivityAt;
	if (elapsedMs >= MERGE_HEALTH_STUCK_THRESHOLD_MS) return "stuck";
	if (elapsedMs >= MERGE_HEALTH_WARNING_THRESHOLD_MS) return "warning";
	return "healthy";
}
