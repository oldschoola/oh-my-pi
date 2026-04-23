/**
 * Mission planning artefacts (Track D).
 *
 * Supports the `/enter-mission` planning conversation by providing
 * pure helpers for:
 *
 *   - Drafting a feature (rendering PROMPT.md with Factory metadata)
 *   - Recording operator clarifications (per-mission `clarifications.md`)
 *   - Finalising a plan (writing a plan manifest that the batch runner
 *     consumes)
 *
 * All helpers are per-project + per-mission on disk \u2014 the planning
 * conversation runs once per mission so files layer under
 * `<missionsDir>/planning/` to avoid clashing with active batch state.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { missionsDir } from "./adapter";

/** Directory under `<missionsDir>` that houses planning artefacts. */
export const PLANNING_DIRNAME = "planning";

/** Resolve the planning directory. */
export function planningDir(cwd: string): string {
	return path.join(missionsDir(cwd), PLANNING_DIRNAME);
}

/** File that collects operator clarifications recorded during planning. */
export function clarificationsPath(cwd: string): string {
	return path.join(planningDir(cwd), "clarifications.md");
}

/** File that captures the finalised planning manifest. */
export function planManifestPath(cwd: string): string {
	return path.join(planningDir(cwd), "plan.json");
}

// \u2500\u2500 Feature drafting \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Valid feature id pattern: `XX-NNN` (same convention as existing mission tasks). */
const FEATURE_ID_PATTERN = /^[A-Z]{1,5}-\d{2,5}$/;

/** Inputs for drafting a new feature task folder. */
export interface DraftFeatureOptions {
	cwd: string;
	/** Stable feature id (e.g. `F-001`, `API-042`). */
	featureId: string;
	/** Short feature title used in the `# Task:` heading. */
	title: string;
	/** Milestone id the feature belongs to. */
	milestoneId: string;
	/** Assertion IDs this feature is expected to satisfy. */
	fulfillsAssertionIds: string[];
	/** Size band (S/M/L). Defaults to `M`. */
	size?: "S" | "M" | "L";
	/** Paragraph-level mission description to render under `## Mission`. */
	description: string;
	/** Free-form file scope globs shown under `## File Scope`. */
	fileScope?: string[];
	/** Optional dependency feature ids. */
	dependencies?: string[];
	/** Path override for the tasks directory. Defaults to `<missionsDir>/tasks`. */
	tasksDir?: string;
}

/**
 * One draft feature result. Includes the folder + rendered PROMPT.md so
 * callers (and tests) can inspect the artefacts without touching the
 * filesystem.
 */
export interface DraftedFeature {
	featureId: string;
	folderPath: string;
	promptPath: string;
	prompt: string;
}

/**
 * Render a PROMPT.md string for a drafted feature. Exported for tests.
 */
export function renderFeaturePrompt(opts: DraftFeatureOptions): string {
	const size = opts.size ?? "M";
	const createdAt = new Date().toISOString().split("T")[0] ?? "";
	const fulfills = opts.fulfillsAssertionIds.join(", ");
	const deps =
		opts.dependencies && opts.dependencies.length > 0
			? opts.dependencies.map(d => `- ${d}`).join("\n")
			: "- **None**";
	const fileScope =
		opts.fileScope && opts.fileScope.length > 0
			? opts.fileScope.map(s => `- \`${s}\``).join("\n")
			: "- _Determined during execution._";
	const description = opts.description.trim();
	return [
		`# Task: ${opts.featureId} \u2014 ${opts.title}`,
		"",
		`**Created:** ${createdAt}`,
		`**Size:** ${size}`,
		"",
		`## Milestone: ${opts.milestoneId}`,
		"",
		fulfills ? `## Fulfills: ${fulfills}` : "## Fulfills: _None \u2014 add assertions before execution._",
		"",
		"## Mission",
		"",
		description,
		"",
		"## Dependencies",
		"",
		deps,
		"",
		"## File Scope",
		"",
		fileScope,
		"",
		"## Steps",
		"",
		"### Step 0: Plan",
		"",
		"- [ ] Re-read the mission above and the cited assertions before touching code.",
		"",
		"### Step 1: Implement",
		"",
		"- [ ] Make the changes described above.",
		"",
		"### Step 2: Verify",
		"",
		"- [ ] Run the relevant tests and confirm acceptance criteria hold for each cited assertion.",
		"",
		"### Step 3: Delivery",
		"",
		"- [ ] Commit + STATUS.md + `.DONE`.",
		"",
		"## Completion Criteria",
		"",
		"- [ ] Acceptance criteria in each cited assertion hold without additional context.",
		"",
		"## Do NOT",
		"",
		"- Expand scope outside the fulfilled assertion set without explicit orchestrator confirmation.",
		"",
		"---",
		"",
		"## Amendments (Added During Execution)",
		"",
		"<!-- Workers add amendments here if issues discovered during execution. -->",
		"",
	].join("\n");
}

/**
 * Render + persist a feature draft. Creates the task folder if missing.
 *
 * @throws when `featureId` doesn't match the convention or when the
 *   target folder already has a PROMPT.md (overwrite must be explicit).
 */
export async function draftFeature(opts: DraftFeatureOptions): Promise<DraftedFeature> {
	if (!FEATURE_ID_PATTERN.test(opts.featureId)) {
		throw new Error(`Invalid feature id "${opts.featureId}" \u2014 expected ${FEATURE_ID_PATTERN.source}`);
	}
	if (!opts.title || opts.title.trim().length === 0) {
		throw new Error("feature title is required");
	}
	if (!opts.description || opts.description.trim().length === 0) {
		throw new Error("feature description is required");
	}
	if (!opts.milestoneId || opts.milestoneId.trim().length === 0) {
		throw new Error("milestoneId is required");
	}

	const tasksDir = opts.tasksDir ?? path.join(missionsDir(opts.cwd), "tasks");
	const folderPath = path.join(tasksDir, `${opts.featureId}-${slug(opts.title)}`);
	const promptPath = path.join(folderPath, "PROMPT.md");

	try {
		await fs.access(promptPath);
		throw new Error(
			`Feature "${opts.featureId}" already has a PROMPT.md at ${promptPath}. Discard or edit manually before redrafting.`,
		);
	} catch (err) {
		if (!isEnoent(err) && (err as Error).message?.startsWith('Feature "')) throw err;
	}

	const prompt = renderFeaturePrompt(opts);
	await fs.mkdir(folderPath, { recursive: true });
	await Bun.write(promptPath, prompt);
	return {
		featureId: opts.featureId,
		folderPath,
		promptPath,
		prompt,
	};
}

function slug(title: string, maxLength: number = 40): string {
	const out = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-+|-+$)/g, "")
		.slice(0, maxLength)
		.replace(/-+$/, "");
	return out || "feature";
}

// \u2500\u2500 Clarifications \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** One outstanding clarification question from the planner. */
export interface Clarification {
	id: string;
	timestamp: string;
	question: string;
	context?: string;
	answeredAt?: string;
	answer?: string;
}

const CLARIFICATION_HEADING = "# Planning Clarifications";

function formatClarificationEntry(entry: Clarification): string {
	const lines = [`## ${entry.id} \u2014 ${entry.timestamp}`];
	if (entry.context) {
		lines.push("", `**Context:** ${entry.context.replace(/\r?\n/g, " ").trim()}`);
	}
	lines.push("", `**Q:** ${entry.question.replace(/\r?\n/g, " ").trim()}`);
	if (entry.answer) {
		lines.push("", `**A (${entry.answeredAt ?? ""}):** ${entry.answer.replace(/\r?\n/g, " ").trim()}`);
	} else {
		lines.push("", "_Awaiting operator response._");
	}
	lines.push("");
	return lines.join("\n");
}

/** Append a clarification. Returns the stable id assigned to the entry. */
export async function recordClarification(
	cwd: string,
	question: string,
	options: { context?: string; timestamp?: string; id?: string } = {},
): Promise<string> {
	if (!question || question.trim().length === 0) {
		throw new Error("clarification question required");
	}
	const filePath = clarificationsPath(cwd);
	await fs.mkdir(path.dirname(filePath), { recursive: true });

	let existing = "";
	try {
		existing = await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}

	// Build id if caller didn't supply one: CLR-<seq> where seq is the
	// next unused number across the file.
	const idFromOptions = options.id?.trim();
	let id = idFromOptions;
	if (!id) {
		const existingIds = [...existing.matchAll(/^## (CLR-\d+)\b/gm)].map(m => m[1] ?? "");
		const maxSeq = existingIds.reduce((acc, cur) => {
			const m = /^CLR-(\d+)$/.exec(cur);
			return m ? Math.max(acc, Number.parseInt(m[1] ?? "0", 10)) : acc;
		}, 0);
		id = `CLR-${String(maxSeq + 1).padStart(3, "0")}`;
	}

	const entry: Clarification = {
		id,
		timestamp: options.timestamp ?? new Date().toISOString(),
		question: question.trim(),
	};
	if (options.context) entry.context = options.context.trim();

	const rendered = formatClarificationEntry(entry);
	if (!existing) {
		await Bun.write(filePath, `${CLARIFICATION_HEADING}\n\n${rendered}`);
	} else {
		const separator = existing.endsWith("\n") ? "" : "\n";
		await Bun.write(filePath, `${existing}${separator}${rendered}`);
	}
	return id;
}

/** List every clarification recorded so far. Returns `[]` when file absent. */
export async function listClarifications(cwd: string): Promise<Clarification[]> {
	const filePath = clarificationsPath(cwd);
	let text = "";
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	return parseClarifications(text);
}

/** Parse a clarifications file. Exported for tests. */
export function parseClarifications(text: string): Clarification[] {
	const sections = text.split(/^##\s+/m).slice(1);
	const out: Clarification[] = [];
	for (const section of sections) {
		const headerMatch = /^(CLR-\d+)\s+\u2014\s+(\S+)/.exec(section.trim());
		if (!headerMatch) continue;
		const id = headerMatch[1];
		const timestamp = headerMatch[2];
		if (!id || !timestamp) continue;
		const qMatch = /\*\*Q:\*\*\s*(.+)/.exec(section);
		if (!qMatch) continue;
		const entry: Clarification = {
			id,
			timestamp,
			question: (qMatch[1] ?? "").trim(),
		};
		const ctxMatch = /\*\*Context:\*\*\s*(.+)/.exec(section);
		if (ctxMatch?.[1]) entry.context = ctxMatch[1].trim();
		const aMatch = /\*\*A \(([^)]*)\):\*\*\s*(.+)/.exec(section);
		if (aMatch) {
			entry.answeredAt = aMatch[1]?.trim();
			entry.answer = aMatch[2]?.trim();
		}
		out.push(entry);
	}
	return out;
}

// \u2500\u2500 Plan finalisation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Manifest written when the planner finalises the plan. */
export interface PlanManifest {
	schemaVersion: 1;
	missionId: string;
	status: "draft" | "awaiting-approval" | "approved";
	milestoneIds: string[];
	featureIds: string[];
	createdAt: string;
	updatedAt: string;
	/** Operator who approved the plan (when status === "approved"). */
	approvedBy?: string;
	approvedAt?: string;
}

export interface FinalizePlanOptions {
	cwd: string;
	missionId: string;
	milestoneIds: string[];
	featureIds: string[];
	/** Final status to write. Defaults to `"awaiting-approval"`. */
	status?: PlanManifest["status"];
	/** Operator label when transitioning straight to approved. */
	approvedBy?: string;
	/** Deterministic clock hook. */
	now?: () => Date;
}

/** Write (or update) the plan manifest. Returns the persisted manifest. */
export async function finalizePlan(options: FinalizePlanOptions): Promise<PlanManifest> {
	if (!options.missionId || options.missionId.trim().length === 0) {
		throw new Error("missionId is required");
	}
	if (!Array.isArray(options.milestoneIds) || options.milestoneIds.length === 0) {
		throw new Error("finalizePlan: at least one milestone id is required");
	}
	if (!Array.isArray(options.featureIds) || options.featureIds.length === 0) {
		throw new Error("finalizePlan: at least one feature id is required");
	}
	const now = (options.now ?? (() => new Date()))();
	const nowIso = now.toISOString();
	const filePath = planManifestPath(options.cwd);
	await fs.mkdir(path.dirname(filePath), { recursive: true });

	let existing: Partial<PlanManifest> = {};
	try {
		const text = await Bun.file(filePath).text();
		existing = JSON.parse(text) as PlanManifest;
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}

	const status = options.status ?? "awaiting-approval";
	const manifest: PlanManifest = {
		schemaVersion: 1,
		missionId: options.missionId,
		status,
		milestoneIds: [...options.milestoneIds],
		featureIds: [...options.featureIds],
		createdAt: existing.createdAt ?? nowIso,
		updatedAt: nowIso,
	};
	if (status === "approved") {
		manifest.approvedBy = options.approvedBy?.trim() || "operator";
		manifest.approvedAt = nowIso;
	}
	await Bun.write(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

/** Load the plan manifest. Returns null when absent. */
export async function loadPlanManifest(cwd: string): Promise<PlanManifest | null> {
	const filePath = planManifestPath(cwd);
	try {
		const text = await Bun.file(filePath).text();
		const parsed = JSON.parse(text) as PlanManifest;
		if (!parsed || parsed.schemaVersion !== 1) throw new Error("invalid plan manifest");
		return parsed;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}
