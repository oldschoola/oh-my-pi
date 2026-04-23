/**
 * Fix-feature generation — Track A4.
 *
 * When a milestone validator reports blocking findings, the engine
 * generates one fix feature per finding so the next worker round can
 * resolve them. Each fix feature is a real task folder with a PROMPT.md
 * composed from {@link FIX_FEATURE_TEMPLATE_FILENAME}, plus a
 * `PersistedTaskRecord` the engine slots into the batch state.
 *
 * This module is **pure + filesystem** \u2014 it does not touch the runtime
 * engine directly. The engine calls {@link generateFixFeatures} with the
 * validator's structured output and receives back the records + folder
 * paths to attach.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { missionsDir } from "./adapter";
import type { LaneTaskStatus, PersistedTaskRecord } from "./types";

/** Filename under `templates/tasks/`. */
export const FIX_FEATURE_TEMPLATE_FILENAME = "fix-feature-template.md";

/**
 * Severity of a validator finding. Matches the vocabulary used by the
 * scrutiny (Track B) + user-testing (Track C) validators. `blocker`
 * forces fix-feature generation; `warning`/`info` surface but do not
 * block milestone advancement.
 */
export type ValidatorFindingSeverity = "blocker" | "warning" | "info";

/** Which validator emitted a finding \u2014 drives which evidence fields apply. */
export type ValidatorKind = "scrutiny" | "user-testing";

/**
 * Structured finding emitted by either milestone validator. Engineers
 * typing these by hand should prefer the helpers validators export, but
 * this is the canonical shape.
 */
export interface ValidatorFinding {
	/** Stable id per finding; used to correlate across rounds. */
	id: string;
	/** Validator kind that emitted this finding. */
	validator: ValidatorKind;
	/** Validation round (1-indexed) during which the finding surfaced. */
	round: number;
	severity: ValidatorFindingSeverity;
	/** Assertion IDs the finding relates to. */
	assertionIds: string[];
	/** Feature id the finding is rooted in (best-effort \u2014 may be absent). */
	parentFeatureId?: string;
	/** One-line summary for headings + filenames. */
	summary: string;
	/** Full description of the finding. */
	description: string;
	/** Free-form evidence snippet (command output, screenshot path, stack trace). */
	evidence?: string;
	/** Optional resolution hint the validator wants the fix worker to try. */
	resolutionStrategy?: string;
	/** Relative file paths the finding implicates. Used as file scope for the fix feature. */
	filePaths?: string[];
	/** Absolute path to the validator output file, so the fix worker can load it. */
	validatorOutputPath?: string;
	/** Absolute path to the parent feature folder, if known. */
	parentFeatureFolder?: string;
}

/**
 * Record produced by fix-feature generation. Carries both the persisted
 * task record the engine slots into batch state and the absolute folder
 * path where the PROMPT.md was written.
 */
export interface GeneratedFixFeature {
	taskId: string;
	taskFolder: string;
	record: PersistedTaskRecord;
	/** Plaintext rendered PROMPT.md contents (also written to disk). */
	prompt: string;
}

export interface GenerateFixFeaturesOptions {
	/** Project root. */
	cwd: string;
	/** Milestone whose validators produced these findings. */
	milestoneId: string;
	/** Ordered findings from the combined validator output. */
	findings: ValidatorFinding[];
	/** Absolute path to the fix-feature template. When absent, falls back to `templates/tasks/fix-feature-template.md` in the package. */
	templatePath?: string;
	/** Tasks directory override. Defaults to `<projectDir>/tasks/`. */
	tasksDir?: string;
	/**
	 * Number of fix features already written for this milestone across all
	 * rounds. Used to pick sequential IDs that don't collide with earlier
	 * rounds. Defaults to `0`.
	 */
	existingFixFeatureCount?: number;
	/** Deterministic timestamp for tests. Defaults to `Date.now()`. */
	now?: number;
}

/**
 * Max rounds guard violation: when a milestone exhausts
 * `maxValidationRounds` without converging. Surfaced as a distinct
 * error class so callers can distinguish "generator bug" from "keep
 * trying fix loops forever".
 */
export class MaxValidationRoundsExceededError extends Error {
	constructor(
		readonly milestoneId: string,
		readonly attemptedRound: number,
		readonly maxRounds: number,
	) {
		super(
			`Milestone "${milestoneId}" exhausted validation rounds at ` +
				`attempt ${attemptedRound} of ${maxRounds} \u2014 fix features will not be regenerated.`,
		);
		this.name = "MaxValidationRoundsExceededError";
	}
}

/** Sanitise a fragment of a validator finding summary for use in a folder name. */
export function slugify(input: string, maxLength: number = 40): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-+|-+$)/g, "")
		.slice(0, maxLength)
		.replace(/-+$/, "");
	return slug || "fix";
}

/**
 * Build a stable fix-feature task id.
 *
 * Convention: `FIX-<milestoneNumber>-<findingNumber>` where numbers are
 * zero-padded to three digits. `milestoneNumber` is parsed from the
 * `M-###` milestone id; a non-conforming milestone id falls back to
 * `000`.
 */
export function buildFixFeatureId(milestoneId: string, indexWithinMilestone: number): string {
	const milestoneNumMatch = /-(\d+)$/.exec(milestoneId);
	const milestoneNum = milestoneNumMatch ? (milestoneNumMatch[1]?.padStart(3, "0") ?? "000") : "000";
	const findingNum = String(indexWithinMilestone + 1).padStart(3, "0");
	return `FIX-${milestoneNum}-${findingNum}`;
}

/** Find the package-local fix-feature template (inside `templates/tasks/`). */
function resolveDefaultTemplatePath(): string {
	// `import.meta.dir` resolves to this file's directory; the package layout
	// places `templates/` next to `src/missioncontrol/`, so walk two levels up.
	return path.resolve(import.meta.dir, "..", "..", "templates", "tasks", FIX_FEATURE_TEMPLATE_FILENAME);
}

/**
 * Render a template string by replacing `{{name}}` placeholders with
 * values from `vars`. Missing placeholders render as empty strings so
 * partial data never short-circuits generation.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_m, name: string) => vars[name] ?? "");
}

/**
 * Generate fix-feature task folders + persisted records from a set of
 * validator findings. Returns the empty array when `findings` contains
 * only non-blocker entries.
 *
 * Side effects: one directory + one PROMPT.md per blocker finding.
 *
 * @throws when `findings` is empty of blockers and nothing to generate.
 * @throws when the template cannot be loaded.
 */
export async function generateFixFeatures(opts: GenerateFixFeaturesOptions): Promise<GeneratedFixFeature[]> {
	const blockers = opts.findings.filter(f => f.severity === "blocker");
	if (blockers.length === 0) return [];

	const templatePath = opts.templatePath ?? resolveDefaultTemplatePath();
	const template = await Bun.file(templatePath).text();

	const tasksDir = opts.tasksDir ?? path.join(missionsDir(opts.cwd), "tasks");
	await fs.mkdir(tasksDir, { recursive: true });

	const now = opts.now ?? Date.now();
	const createdAt = new Date(now).toISOString();
	const base = opts.existingFixFeatureCount ?? 0;

	const generated: GeneratedFixFeature[] = [];

	for (let i = 0; i < blockers.length; i++) {
		const finding = blockers[i];
		if (!finding) continue;
		const index = base + i;
		const taskId = buildFixFeatureId(opts.milestoneId, index);
		const folderName = `${taskId}-${slugify(finding.summary)}`;
		const taskFolder = path.join(tasksDir, folderName);

		const assertionList = finding.assertionIds.length > 0 ? finding.assertionIds.join(", ") : "none cited";
		const parentFeatureId = finding.parentFeatureId ?? "unknown";
		const fileScope =
			finding.filePaths && finding.filePaths.length > 0
				? finding.filePaths.map(p => `- \`${p}\``).join("\n")
				: "- _Determined during execution._";

		const prompt = renderTemplate(template, {
			fixFeatureId: taskId,
			summary: finding.summary,
			createdAt,
			milestoneId: opts.milestoneId,
			assertionIds: assertionList,
			parentFeatureId,
			validatorKind: finding.validator,
			validationRound: String(finding.round),
			severity: finding.severity,
			findingDescription: finding.description,
			findingEvidence: finding.evidence ?? "_No evidence captured \u2014 see the validator output file._",
			resolutionStrategy: finding.resolutionStrategy ?? "_Worker determines during execution._",
			validatorOutputPath: finding.validatorOutputPath ?? "(validator output path not provided)",
			parentFeatureFolder: finding.parentFeatureFolder ?? "(parent feature folder not provided)",
			fileScope,
		});

		await fs.mkdir(taskFolder, { recursive: true });
		await Bun.write(path.join(taskFolder, "PROMPT.md"), prompt);

		const record: PersistedTaskRecord = {
			taskId,
			laneNumber: 0,
			sessionName: "",
			status: "pending" satisfies LaneTaskStatus,
			taskFolder,
			startedAt: null,
			endedAt: null,
			doneFileFound: false,
			exitReason: "",
			milestoneId: opts.milestoneId,
			fulfillsAssertionIds: [...finding.assertionIds],
			isFixFeature: true,
		};
		if (finding.parentFeatureId) record.parentFeatureId = finding.parentFeatureId;

		generated.push({
			taskId,
			taskFolder,
			record,
			prompt,
		});
	}

	return generated;
}
