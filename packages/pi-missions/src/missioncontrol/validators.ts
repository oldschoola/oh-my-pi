/**
 * Milestone validator spawn + parse (Track B + C).
 *
 * The scrutiny validator (Track B) reviews worker artifacts + trajectories
 * for a milestone. The user-testing validator (Track C) exercises the
 * system black-box. Both agents produce a JSON document at a well-known
 * path; the orchestrator reads it, threads findings into fix-feature
 * generation (see `./fix-features.ts`), and ingests lessons into the
 * knowledge library.
 *
 * This module owns:
 *   - `MilestoneValidatorOutput` \u2014 the shared on-disk shape.
 *   - `parseMilestoneValidatorResult` \u2014 strict JSON validator.
 *   - `spawnScrutinyValidator` \u2014 thin wrapper over `spawnHostedAgent`
 *     that wires the agent prompt, tool allow-list, and output file.
 *
 * Agent spawns are short-lived, fresh-context, and read-only from the batch's
 * perspective (no merge, no push, no branch creation).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { projectDir } from "./adapter";
import type { AgentHostResult } from "./agent-host";
import { spawnHostedAgent } from "./agent-host";
import type { ValidatorFinding, ValidatorFindingSeverity, ValidatorKind } from "./fix-features";
import { knowledgePath } from "./knowledge";
import { resolveAgentTemplate } from "./paths";
import type { RuntimeAgentRole } from "./types";
import { StateFileError } from "./types";

/** The validator's top-level verdict. */
export type MilestoneValidatorVerdict = "pass" | "needs-fix" | "fail";

/**
 * Parsed on-disk output from either validator. Both validators write this
 * exact shape; downstream consumers (fix-feature generator, knowledge
 * ingestor, dashboard) distinguish sources via `validator`.
 */
export interface MilestoneValidatorOutput {
	schemaVersion: 1;
	validator: ValidatorKind;
	milestoneId: string;
	round: number;
	startedAt: number;
	completedAt: number;
	verdict: MilestoneValidatorVerdict;
	summary: string;
	findings: ValidatorFinding[];
	lessons: string[];
}

export const MILESTONE_VALIDATOR_SCHEMA_VERSION = 1 as const;

/** Validator outputs live under `<projectDir>/validation/<batchId>/`. */
export function validationOutputDir(cwd: string, batchId: string): string {
	return path.join(projectDir(cwd), "validation", batchId);
}

/** Canonical path for a single validator run. */
export function validationOutputPath(
	cwd: string,
	batchId: string,
	milestoneId: string,
	round: number,
	kind: ValidatorKind,
): string {
	const suffix = kind === "scrutiny" ? "scrutiny" : "user-testing";
	return path.join(validationOutputDir(cwd, batchId), `${milestoneId}-${suffix}-round${round}.json`);
}

const VALID_SEVERITIES: ReadonlySet<ValidatorFindingSeverity> = new Set(["blocker", "warning", "info"]);
const VALID_VERDICTS: ReadonlySet<MilestoneValidatorVerdict> = new Set(["pass", "needs-fix", "fail"]);
const VALID_KINDS: ReadonlySet<ValidatorKind> = new Set(["scrutiny", "user-testing"]);

/**
 * Validate a finding sub-record. Returns a typed `ValidatorFinding`; throws
 * `StateFileError(STATE_SCHEMA_INVALID)` on any violation. Called from the
 * parser; not exported directly.
 */
function validateFinding(raw: unknown, index: number): ValidatorFinding {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new StateFileError("STATE_SCHEMA_INVALID", `findings[${index}] must be an object`);
	}
	const f = raw as Record<string, unknown>;
	for (const field of ["id", "summary", "description"] as const) {
		if (typeof f[field] !== "string" || (f[field] as string).length === 0) {
			throw new StateFileError("STATE_SCHEMA_INVALID", `findings[${index}].${field} must be a non-empty string`);
		}
	}
	if (!VALID_KINDS.has(f.validator as ValidatorKind)) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`findings[${index}].validator must be "scrutiny" or "user-testing" (got ${JSON.stringify(f.validator)})`,
		);
	}
	if (typeof f.round !== "number" || f.round < 1) {
		throw new StateFileError("STATE_SCHEMA_INVALID", `findings[${index}].round must be a positive number`);
	}
	if (!VALID_SEVERITIES.has(f.severity as ValidatorFindingSeverity)) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`findings[${index}].severity must be one of: ${[...VALID_SEVERITIES].join(", ")}`,
		);
	}
	if (!Array.isArray(f.assertionIds)) {
		throw new StateFileError("STATE_SCHEMA_INVALID", `findings[${index}].assertionIds must be an array`);
	}
	for (const id of f.assertionIds as unknown[]) {
		if (typeof id !== "string" || id.length === 0) {
			throw new StateFileError(
				"STATE_SCHEMA_INVALID",
				`findings[${index}].assertionIds contains a non-string or empty value`,
			);
		}
	}
	if (f.parentFeatureId !== undefined && (typeof f.parentFeatureId !== "string" || f.parentFeatureId.length === 0)) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`findings[${index}].parentFeatureId must be a non-empty string when set`,
		);
	}
	if (f.evidence !== undefined && typeof f.evidence !== "string") {
		throw new StateFileError("STATE_SCHEMA_INVALID", `findings[${index}].evidence must be a string when set`);
	}
	if (f.resolutionStrategy !== undefined && typeof f.resolutionStrategy !== "string") {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`findings[${index}].resolutionStrategy must be a string when set`,
		);
	}
	if (f.filePaths !== undefined) {
		if (!Array.isArray(f.filePaths)) {
			throw new StateFileError("STATE_SCHEMA_INVALID", `findings[${index}].filePaths must be an array when set`);
		}
		for (const p of f.filePaths as unknown[]) {
			if (typeof p !== "string") {
				throw new StateFileError(
					"STATE_SCHEMA_INVALID",
					`findings[${index}].filePaths contains a non-string value`,
				);
			}
		}
	}

	const finding: ValidatorFinding = {
		id: f.id as string,
		validator: f.validator as ValidatorKind,
		round: f.round as number,
		severity: f.severity as ValidatorFindingSeverity,
		assertionIds: [...(f.assertionIds as string[])],
		summary: f.summary as string,
		description: f.description as string,
	};
	if (f.parentFeatureId !== undefined) finding.parentFeatureId = f.parentFeatureId as string;
	if (f.evidence !== undefined) finding.evidence = f.evidence as string;
	if (f.resolutionStrategy !== undefined) finding.resolutionStrategy = f.resolutionStrategy as string;
	if (f.filePaths !== undefined) finding.filePaths = [...(f.filePaths as string[])];
	return finding;
}

/**
 * Parse a validator output file.
 *
 * @throws `StateFileError` with
 *   - `STATE_FILE_IO_ERROR` when the file cannot be read
 *   - `STATE_FILE_PARSE_ERROR` when JSON parsing fails
 *   - `STATE_SCHEMA_INVALID` when the shape is wrong
 */
export async function parseMilestoneValidatorResult(filePath: string): Promise<MilestoneValidatorOutput> {
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		if (isEnoent(err)) {
			throw new StateFileError(
				"STATE_FILE_IO_ERROR",
				`Validator output not found at ${filePath}. The agent exited without writing its result.`,
			);
		}
		throw new StateFileError(
			"STATE_FILE_IO_ERROR",
			`Failed to read validator output at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new StateFileError(
			"STATE_FILE_PARSE_ERROR",
			`Validator output at ${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new StateFileError("STATE_SCHEMA_INVALID", "Validator output must be a non-null object");
	}
	const obj = raw as Record<string, unknown>;
	if (obj.schemaVersion !== MILESTONE_VALIDATOR_SCHEMA_VERSION) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Unsupported validator output schemaVersion ${String(obj.schemaVersion)} (expected ${MILESTONE_VALIDATOR_SCHEMA_VERSION})`,
		);
	}
	if (!VALID_KINDS.has(obj.validator as ValidatorKind)) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Invalid "validator" field (expected "scrutiny" or "user-testing", got ${JSON.stringify(obj.validator)})`,
		);
	}
	if (typeof obj.milestoneId !== "string" || obj.milestoneId.length === 0) {
		throw new StateFileError("STATE_SCHEMA_INVALID", '"milestoneId" must be a non-empty string');
	}
	if (typeof obj.round !== "number" || obj.round < 1) {
		throw new StateFileError("STATE_SCHEMA_INVALID", '"round" must be a positive number');
	}
	for (const field of ["startedAt", "completedAt"] as const) {
		if (typeof obj[field] !== "number") {
			throw new StateFileError("STATE_SCHEMA_INVALID", `"${field}" must be a number`);
		}
	}
	if (!VALID_VERDICTS.has(obj.verdict as MilestoneValidatorVerdict)) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Invalid "verdict" field (expected one of: ${[...VALID_VERDICTS].join(", ")})`,
		);
	}
	if (typeof obj.summary !== "string") {
		throw new StateFileError("STATE_SCHEMA_INVALID", '"summary" must be a string');
	}
	if (!Array.isArray(obj.findings)) {
		throw new StateFileError("STATE_SCHEMA_INVALID", '"findings" must be an array');
	}
	const findings: ValidatorFinding[] = [];
	for (let i = 0; i < obj.findings.length; i++) {
		findings.push(validateFinding(obj.findings[i], i));
	}
	if (!Array.isArray(obj.lessons)) {
		throw new StateFileError("STATE_SCHEMA_INVALID", '"lessons" must be an array');
	}
	for (const lesson of obj.lessons as unknown[]) {
		if (typeof lesson !== "string") {
			throw new StateFileError("STATE_SCHEMA_INVALID", '"lessons" contains a non-string value');
		}
	}

	// Cross-field consistency: verdict must reflect the findings.
	const hasBlocker = findings.some(f => f.severity === "blocker");
	if (obj.verdict === "pass" && hasBlocker) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			'Inconsistent output: verdict="pass" but findings contain at least one blocker',
		);
	}
	if (obj.verdict === "needs-fix" && !hasBlocker) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			'Inconsistent output: verdict="needs-fix" but findings contain no blockers',
		);
	}

	return {
		schemaVersion: MILESTONE_VALIDATOR_SCHEMA_VERSION,
		validator: obj.validator as ValidatorKind,
		milestoneId: obj.milestoneId as string,
		round: obj.round as number,
		startedAt: obj.startedAt as number,
		completedAt: obj.completedAt as number,
		verdict: obj.verdict as MilestoneValidatorVerdict,
		summary: obj.summary as string,
		findings,
		lessons: [...(obj.lessons as string[])],
	};
}

/**
 * Convenience wrapper for the scrutiny-specific path. Propagates the
 * generic parser's errors verbatim.
 */
export async function parseScrutinyValidatorResult(filePath: string): Promise<MilestoneValidatorOutput> {
	const result = await parseMilestoneValidatorResult(filePath);
	if (result.validator !== "scrutiny") {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Expected scrutiny validator output but found "${result.validator}" at ${filePath}`,
		);
	}
	return result;
}

/**
 * Minimum fields the engine needs to ask the validator to run.
 *
 * The spawn function loads the agent template, injects the mission's paths,
 * and writes the prompt to the agent. It does NOT own the timeout or exit
 * summary — caller provides those via `SpawnScrutinyValidatorOptions`.
 */
export interface SpawnScrutinyValidatorOptions {
	cwd: string;
	batchId: string;
	milestoneId: string;
	round: number;
	/** Absolute path the agent MUST write its output file to. */
	outputPath: string;
	/** Absolute path to the validation contract (or "" when there is none). */
	contractPath: string;
	/** Absolute path to the persisted batch state snapshot. */
	batchStatePath: string;
	/** Agent id used by Runtime V2 registry (e.g. `scrutiny-M-001-r1`). */
	agentId?: string;
	/** Optional model override. */
	model?: string;
	/** Optional timeout. `0` / unset disables timeout. */
	timeoutMs?: number;
	/** Optional Runtime V2 state root for manifest writes. */
	stateRoot?: string;
	/** Deterministic clock hook for tests. */
	now?: () => number;
	/**
	 * Inject a fake spawn function for tests. Must match the
	 * `spawnHostedAgent` signature exactly.
	 */
	spawn?: typeof spawnHostedAgent;
	/** Inject a fake template loader for tests. */
	loadTemplate?: (templatePath: string) => Promise<string>;
}

/**
 * Build the scrutiny validator's prompt by interpolating placeholders in
 * the template. Kept exported so tests can exercise the string building
 * without running the full spawn.
 */
export function renderScrutinyPrompt(
	template: string,
	vars: { milestoneId: string; round: number; contractPath: string; batchStatePath: string; outputPath: string },
): string {
	return template
		.replace(/\{\{milestoneId\}\}/g, vars.milestoneId)
		.replace(/\{\{round\}\}/g, String(vars.round))
		.replace(/\{\{contractPath\}\}/g, vars.contractPath)
		.replace(/\{\{batchStatePath\}\}/g, vars.batchStatePath)
		.replace(/\{\{outputPath\}\}/g, vars.outputPath);
}

/**
 * Spawn a fresh scrutiny validator agent. Resolves with the
 * {@link AgentHostResult} once the agent exits. The caller is expected to
 * then call {@link parseScrutinyValidatorResult} on
 * `options.outputPath` to read the structured output.
 *
 * The spawn pre-creates the output file's parent directory so the agent
 * can write unconditionally.
 */
export async function spawnScrutinyValidator(options: SpawnScrutinyValidatorOptions): Promise<AgentHostResult> {
	const spawn = options.spawn ?? spawnHostedAgent;
	const loadTemplate = options.loadTemplate ?? (p => Bun.file(p).text());
	const now = options.now ?? (() => Date.now());

	await fs.mkdir(path.dirname(options.outputPath), { recursive: true });

	const templatePath = resolveAgentTemplate("milestone-scrutiny-validator");
	const template = await loadTemplate(templatePath);
	const prompt = renderScrutinyPrompt(template, {
		milestoneId: options.milestoneId,
		round: options.round,
		contractPath: options.contractPath,
		batchStatePath: options.batchStatePath,
		outputPath: options.outputPath,
	});

	const agentId = options.agentId ?? `scrutiny-${options.milestoneId}-r${options.round}-${now()}`;
	const handle = spawn({
		agentId,
		// Milestone validators report as "reviewer" role to keep existing
		// registry filters (supervisor tools, killers) working unchanged.
		role: "reviewer" satisfies RuntimeAgentRole,
		batchId: options.batchId,
		laneNumber: null,
		taskId: options.milestoneId,
		repoId: "",
		cwd: options.cwd,
		prompt,
		model: options.model,
		timeoutMs: options.timeoutMs,
		stateRoot: options.stateRoot,
		eventsPath: null,
		exitSummaryPath: null,
		env: {
			MISSION_VALIDATOR_KIND: "scrutiny",
			MISSION_VALIDATOR_MILESTONE: options.milestoneId,
			MISSION_VALIDATOR_ROUND: String(options.round),
			MISSION_VALIDATOR_OUTPUT_PATH: options.outputPath,
			MISSION_KNOWLEDGE_LIBRARY: knowledgePath(options.cwd),
		},
	});

	return handle.promise;
}

// ── User-testing validator (Track C) ─────────────────────────

/**
 * Convenience wrapper for the user-testing-specific path.
 * Propagates the generic parser's errors verbatim.
 */
export async function parseUserTestingValidatorResult(filePath: string): Promise<MilestoneValidatorOutput> {
	const result = await parseMilestoneValidatorResult(filePath);
	if (result.validator !== "user-testing") {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`Expected user-testing validator output but found "${result.validator}" at ${filePath}`,
		);
	}
	return result;
}

/**
 * Spawn options for the user-testing validator. Shape mirrors
 * {@link SpawnScrutinyValidatorOptions} so callers can construct both
 * with the same inputs.
 */
export type SpawnUserTestingValidatorOptions = SpawnScrutinyValidatorOptions;

/**
 * Same placeholder set as {@link renderScrutinyPrompt}. Kept distinct so
 * the two validators can evolve template-specific placeholders later
 * without breaking callers.
 */
export function renderUserTestingPrompt(
	template: string,
	vars: { milestoneId: string; round: number; contractPath: string; batchStatePath: string; outputPath: string },
): string {
	return renderScrutinyPrompt(template, vars);
}

/**
 * Spawn a fresh user-testing validator. Identical wiring to
 * {@link spawnScrutinyValidator} except the template is
 * `milestone-user-testing-validator` and the env var
 * `MISSION_VALIDATOR_KIND` is set to `"user-testing"` so the child
 * agent can detect its role at runtime.
 */
export async function spawnUserTestingValidator(options: SpawnUserTestingValidatorOptions): Promise<AgentHostResult> {
	const spawn = options.spawn ?? spawnHostedAgent;
	const loadTemplate = options.loadTemplate ?? (p => Bun.file(p).text());
	const now = options.now ?? (() => Date.now());

	await fs.mkdir(path.dirname(options.outputPath), { recursive: true });

	const templatePath = resolveAgentTemplate("milestone-user-testing-validator");
	const template = await loadTemplate(templatePath);
	const prompt = renderUserTestingPrompt(template, {
		milestoneId: options.milestoneId,
		round: options.round,
		contractPath: options.contractPath,
		batchStatePath: options.batchStatePath,
		outputPath: options.outputPath,
	});

	const agentId = options.agentId ?? `user-testing-${options.milestoneId}-r${options.round}-${now()}`;
	const handle = spawn({
		agentId,
		role: "reviewer" satisfies RuntimeAgentRole,
		batchId: options.batchId,
		laneNumber: null,
		taskId: options.milestoneId,
		repoId: "",
		cwd: options.cwd,
		prompt,
		model: options.model,
		timeoutMs: options.timeoutMs,
		stateRoot: options.stateRoot,
		eventsPath: null,
		exitSummaryPath: null,
		env: {
			MISSION_VALIDATOR_KIND: "user-testing",
			MISSION_VALIDATOR_MILESTONE: options.milestoneId,
			MISSION_VALIDATOR_ROUND: String(options.round),
			MISSION_VALIDATOR_OUTPUT_PATH: options.outputPath,
			MISSION_KNOWLEDGE_LIBRARY: knowledgePath(options.cwd),
		},
	});

	return handle.promise;
}

// ── Combined milestone validation (Tracks B + C union) ────────────

/**
 * Combined output of a milestone validation round — both validator runs
 * plus a merged verdict and a unified finding list that the fix-feature
 * generator consumes.
 */
export interface MilestoneValidationRound {
	milestoneId: string;
	round: number;
	startedAt: number;
	completedAt: number;
	scrutiny: MilestoneValidatorOutput;
	userTesting: MilestoneValidatorOutput;
	/** Union of findings from both validators (preserved in input order: scrutiny first). */
	findings: ValidatorFinding[];
	/** Combined verdict derived from the two runs (see {@link combineValidatorVerdicts}). */
	verdict: MilestoneValidatorVerdict;
	/** Union of lessons (deduped preserving first-seen order). */
	lessons: string[];
}

/**
 * Combine two validator verdicts into the milestone-level verdict.
 *
 * Semantics:
 *   - `"fail"` dominates everything (aborts the milestone).
 *   - `"needs-fix"` dominates `"pass"` (blockers anywhere → more fix features).
 *   - Both `"pass"` → `"pass"`.
 *
 * Exported so dashboards and integration tests can reuse the rule without
 * re-deriving it.
 */
export function combineValidatorVerdicts(
	a: MilestoneValidatorVerdict,
	b: MilestoneValidatorVerdict,
): MilestoneValidatorVerdict {
	if (a === "fail" || b === "fail") return "fail";
	if (a === "needs-fix" || b === "needs-fix") return "needs-fix";
	return "pass";
}

/**
 * Union the findings of two validator runs. Preserves the per-validator
 * ordering (scrutiny first, then user-testing) and drops exact duplicates
 * by finding id.
 */
export function unionFindings(
	scrutinyFindings: readonly ValidatorFinding[],
	userTestingFindings: readonly ValidatorFinding[],
): ValidatorFinding[] {
	const seen = new Set<string>();
	const merged: ValidatorFinding[] = [];
	for (const f of [...scrutinyFindings, ...userTestingFindings]) {
		if (seen.has(f.id)) continue;
		seen.add(f.id);
		merged.push(f);
	}
	return merged;
}

/** Dedupe lessons preserving first-seen order across both validators. */
export function unionLessons(scrutinyLessons: readonly string[], userTestingLessons: readonly string[]): string[] {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const lesson of [...scrutinyLessons, ...userTestingLessons]) {
		const trimmed = lesson.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		merged.push(trimmed);
	}
	return merged;
}

/**
 * Merge two validator outputs into a single {@link MilestoneValidationRound}.
 *
 * @throws when the two outputs disagree on `milestoneId` or `round` —
 * that would mean a spawn got wired to the wrong run and the merge is
 * unsafe.
 */
export function mergeValidatorRound(
	scrutiny: MilestoneValidatorOutput,
	userTesting: MilestoneValidatorOutput,
): MilestoneValidationRound {
	if (scrutiny.validator !== "scrutiny" || userTesting.validator !== "user-testing") {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`mergeValidatorRound: validator kinds mismatched (got scrutiny="${scrutiny.validator}", userTesting="${userTesting.validator}")`,
		);
	}
	if (scrutiny.milestoneId !== userTesting.milestoneId) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`mergeValidatorRound: milestoneId mismatch (scrutiny="${scrutiny.milestoneId}", userTesting="${userTesting.milestoneId}")`,
		);
	}
	if (scrutiny.round !== userTesting.round) {
		throw new StateFileError(
			"STATE_SCHEMA_INVALID",
			`mergeValidatorRound: round mismatch (scrutiny=${scrutiny.round}, userTesting=${userTesting.round})`,
		);
	}
	return {
		milestoneId: scrutiny.milestoneId,
		round: scrutiny.round,
		startedAt: Math.min(scrutiny.startedAt, userTesting.startedAt),
		completedAt: Math.max(scrutiny.completedAt, userTesting.completedAt),
		scrutiny,
		userTesting,
		findings: unionFindings(scrutiny.findings, userTesting.findings),
		verdict: combineValidatorVerdicts(scrutiny.verdict, userTesting.verdict),
		lessons: unionLessons(scrutiny.lessons, userTesting.lessons),
	};
}
