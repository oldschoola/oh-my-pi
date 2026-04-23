/**
 * Mission skill discovery + draft lifecycle (Track E).
 *
 * Discovers agent skills from two roots:
 *
 *   1. Project-local skills      \u2014 `<cwd>/.omp/skills/<name>/SKILL.md`
 *   2. Project-local drafts      \u2014 `<cwd>/.omp/skills/drafts/<name>/SKILL.md`
 *
 * Each skill is a directory containing a `SKILL.md` file. The parser
 * reads the YAML front-matter (`name`, `version`, `description`) plus a
 * few optional fields used by the missions runtime (`tools`, `tags`).
 * The coding-agent's host skill loader already handles system-level
 * skill roots; missions layers the project-local + draft roots on top so
 * per-project skill development can happen without touching the host's
 * global registry.
 *
 * This module is **pure data** \u2014 no spawn, no prompt injection. The
 * engine wires discovery into `lane-runner` / worker prompt builders
 * separately (see Track E2 when it lands).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { projectDir } from "./adapter";

/**
 * Canonical subdirectory under the project's `.omp/` root that contains
 * promoted + draft skills.
 */
export const SKILLS_DIRNAME = "skills";
/** Drafts subdirectory within the skills root. */
export const SKILL_DRAFTS_DIRNAME = "drafts";

/** Directory that houses promoted skills for a project. */
export function skillsRoot(cwd: string): string {
	return path.join(projectDir(cwd), SKILLS_DIRNAME);
}

/** Directory that houses in-progress skill drafts for a project. */
export function skillDraftsRoot(cwd: string): string {
	return path.join(skillsRoot(cwd), SKILL_DRAFTS_DIRNAME);
}

/** Absolute path to a promoted skill's folder. */
export function skillDir(cwd: string, name: string): string {
	return path.join(skillsRoot(cwd), name);
}

/** Absolute path to a draft skill's folder. */
export function skillDraftDir(cwd: string, name: string): string {
	return path.join(skillDraftsRoot(cwd), name);
}

/** One discovered skill entry. */
export interface SkillEntry {
	/** Stable skill name (directory basename). */
	name: string;
	/** Version string from SKILL.md front-matter, or `""` when absent. */
	version: string;
	/** One-paragraph description from front-matter. */
	description: string;
	/** `"promoted"` for `<cwd>/.omp/skills/<name>/` entries; `"draft"` for `<cwd>/.omp/skills/drafts/<name>/`. */
	origin: "promoted" | "draft";
	/** Absolute path to the skill folder. */
	folderPath: string;
	/** Absolute path to the SKILL.md file. */
	skillPath: string;
	/** Optional `tools` front-matter value (comma-separated tools). */
	tools?: string;
	/** Optional `tags` front-matter (parsed from comma-separated list). */
	tags?: string[];
}

/**
 * Normalise a skill name for comparison. Lowercase alphanumeric +
 * hyphen. Folder basenames must already be in this form; the helper is
 * primarily for user input normalisation.
 */
export function normaliseSkillName(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/(^-+|-+$)/g, "");
}

/** Regex for valid skill directory names: lowercase alphanumeric + hyphen. */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Parse the YAML-ish front-matter of a SKILL.md. Not a full YAML parser;
 * handles `key: value` on one line each. Returns null when the file
 * doesn't start with `---`.
 */
export function parseSkillFrontMatter(content: string): Record<string, string> | null {
	if (!content.startsWith("---")) return null;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return null;
	const block = content.slice(3, end).trim();
	const out: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
		if (!m) continue;
		const key = m[1];
		const value = m[2];
		if (key === undefined || value === undefined) continue;
		out[key] = value.trim();
	}
	return out;
}

/** Read a single skill directory into an entry. Returns `null` when malformed. */
async function loadSkillEntry(folderPath: string, origin: SkillEntry["origin"]): Promise<SkillEntry | null> {
	const name = path.basename(folderPath);
	if (!SKILL_NAME_PATTERN.test(name)) return null;
	const skillPath = path.join(folderPath, "SKILL.md");
	let content: string;
	try {
		content = await Bun.file(skillPath).text();
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	const front = parseSkillFrontMatter(content);
	const entry: SkillEntry = {
		name,
		version: (front?.version ?? "").trim(),
		description: (front?.description ?? "").trim(),
		origin,
		folderPath,
		skillPath,
	};
	if (front?.tools) entry.tools = front.tools;
	if (front?.tags) {
		entry.tags = front.tags
			.split(",")
			.map(t => t.trim())
			.filter(Boolean);
	}
	return entry;
}

/** List every subdirectory of `root`. Returns `[]` when the root is missing. */
async function listDirs(root: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => path.join(root, e.name));
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

/**
 * Discover every promoted skill under the project's skills root. Drafts
 * are excluded (they live under the `drafts/` subdirectory). Results are
 * sorted by name for stable rendering.
 */
export async function listPromotedSkills(cwd: string): Promise<SkillEntry[]> {
	const root = skillsRoot(cwd);
	const folders = (await listDirs(root)).filter(p => path.basename(p) !== SKILL_DRAFTS_DIRNAME);
	const entries: SkillEntry[] = [];
	for (const folder of folders) {
		const entry = await loadSkillEntry(folder, "promoted");
		if (entry) entries.push(entry);
	}
	return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Discover every draft skill under `<cwd>/.omp/skills/drafts/`. */
export async function listDraftSkills(cwd: string): Promise<SkillEntry[]> {
	const folders = await listDirs(skillDraftsRoot(cwd));
	const entries: SkillEntry[] = [];
	for (const folder of folders) {
		const entry = await loadSkillEntry(folder, "draft");
		if (entry) entries.push(entry);
	}
	return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Discover every skill (promoted + draft) with promoted entries listed first. */
export async function listAvailableSkills(cwd: string): Promise<SkillEntry[]> {
	const [promoted, drafts] = await Promise.all([listPromotedSkills(cwd), listDraftSkills(cwd)]);
	return [...promoted, ...drafts];
}

/**
 * Return every skill whose name / description / tags match any of the
 * supplied tokens (case-insensitive substring). Empty `tokens` returns
 * no matches. `skills` is caller-supplied to let tests seed a custom
 * catalogue without touching the filesystem.
 */
export function findMatchingSkills(skills: readonly SkillEntry[], tokens: readonly string[]): SkillEntry[] {
	const cleaned = tokens.map(t => (t ?? "").toLowerCase().trim()).filter(t => t.length > 0);
	if (cleaned.length === 0) return [];
	return skills.filter(s => {
		const haystacks = [s.name, s.description, ...(s.tags ?? [])].map(v => v.toLowerCase());
		for (const token of cleaned) {
			if (haystacks.some(h => h.includes(token))) return true;
		}
		return false;
	});
}

/** Read the raw SKILL.md content for `skillName`, preferring promoted over draft. */
export async function loadSkillContent(cwd: string, skillName: string): Promise<string | null> {
	const candidates = [skillDir(cwd, skillName), skillDraftDir(cwd, skillName)];
	for (const folder of candidates) {
		try {
			return await Bun.file(path.join(folder, "SKILL.md")).text();
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
	}
	return null;
}

// \u2500\u2500 Draft lifecycle (E3) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Options for creating a skill draft. */
export interface CreateSkillDraftOptions {
	cwd: string;
	name: string;
	description: string;
	version?: string;
	tools?: string;
	tags?: readonly string[];
	/** Optional extended body appended after the front-matter. Defaults to a TODO stub. */
	body?: string;
}

/** Render a SKILL.md file from structured fields. */
function renderSkillMarkdown(opts: {
	name: string;
	description: string;
	version?: string;
	tools?: string;
	tags?: readonly string[];
	body?: string;
}): string {
	const frontLines: string[] = ["---"];
	frontLines.push(`name: ${opts.name}`);
	if (opts.version) frontLines.push(`version: ${opts.version}`);
	frontLines.push(`description: ${opts.description.replace(/\r?\n/g, " ").trim()}`);
	if (opts.tools) frontLines.push(`tools: ${opts.tools}`);
	if (opts.tags && opts.tags.length > 0) frontLines.push(`tags: ${opts.tags.join(", ")}`);
	frontLines.push("---");
	const body = opts.body?.trim() ?? "TODO: document the skill.";
	return `${frontLines.join("\n")}\n\n${body}\n`;
}

/**
 * Create a skill draft directory + SKILL.md under `<cwd>/.omp/skills/drafts/<name>/`.
 *
 * Throws when the name is invalid or the draft (or a same-name promoted
 * skill) already exists. Returns the created {@link SkillEntry}.
 */
export async function createSkillDraft(opts: CreateSkillDraftOptions): Promise<SkillEntry> {
	if (!SKILL_NAME_PATTERN.test(opts.name)) {
		throw new Error(`Invalid skill name "${opts.name}" \u2014 expected ${SKILL_NAME_PATTERN.source}`);
	}
	if (!opts.description || opts.description.trim().length === 0) {
		throw new Error("description is required");
	}
	const promotedFolder = skillDir(opts.cwd, opts.name);
	const draftFolder = skillDraftDir(opts.cwd, opts.name);
	try {
		await fs.access(promotedFolder);
		throw new Error(`A promoted skill named "${opts.name}" already exists \u2014 pick a different name.`);
	} catch (err) {
		if (!isEnoent(err) && (err as Error).message?.startsWith("A promoted skill")) throw err;
	}
	try {
		await fs.access(draftFolder);
		throw new Error(`A draft named "${opts.name}" already exists.`);
	} catch (err) {
		if (!isEnoent(err) && (err as Error).message?.startsWith("A draft named")) throw err;
	}

	await fs.mkdir(draftFolder, { recursive: true });
	const markdown = renderSkillMarkdown({
		name: opts.name,
		description: opts.description,
		version: opts.version,
		tools: opts.tools,
		tags: opts.tags,
		body: opts.body,
	});
	await Bun.write(path.join(draftFolder, "SKILL.md"), markdown);
	const entry = await loadSkillEntry(draftFolder, "draft");
	if (!entry) throw new Error(`Draft created but failed to re-read at ${draftFolder}`);
	return entry;
}

/**
 * Promote a draft under `<cwd>/.omp/skills/drafts/<name>/` to a regular
 * skill under `<cwd>/.omp/skills/<name>/` by moving the directory.
 *
 * Throws when the draft is absent or the destination already exists.
 * Returns the freshly-promoted entry.
 */
export async function promoteSkillDraft(cwd: string, name: string): Promise<SkillEntry> {
	if (!SKILL_NAME_PATTERN.test(name)) {
		throw new Error(`Invalid skill name "${name}"`);
	}
	const source = skillDraftDir(cwd, name);
	const dest = skillDir(cwd, name);
	try {
		await fs.access(source);
	} catch (err) {
		if (isEnoent(err)) throw new Error(`Draft "${name}" not found at ${source}`);
		throw err;
	}
	try {
		await fs.access(dest);
		throw new Error(`Cannot promote \u2014 a promoted skill named "${name}" already exists.`);
	} catch (err) {
		if (!isEnoent(err) && (err as Error).message?.startsWith("Cannot promote")) throw err;
	}
	await fs.mkdir(skillsRoot(cwd), { recursive: true });
	await fs.rename(source, dest);
	const entry = await loadSkillEntry(dest, "promoted");
	if (!entry) throw new Error(`Promotion succeeded but re-read failed at ${dest}`);
	return entry;
}

/** Delete a draft. Idempotent: missing draft is a no-op returning `false`. */
export async function discardSkillDraft(cwd: string, name: string): Promise<boolean> {
	if (!SKILL_NAME_PATTERN.test(name)) {
		throw new Error(`Invalid skill name "${name}"`);
	}
	const target = skillDraftDir(cwd, name);
	try {
		await fs.access(target);
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
	await fs.rm(target, { recursive: true, force: true });
	return true;
}

// ── Task skill resolution (Track E2) ───────────────────────────────

/**
 * Minimal task shape the resolvers need — a subset of `ParsedTask` that
 * keeps this helper decoupled from the discovery module.
 */
export interface TaskSkillContext {
	taskName?: string;
	prompt?: string;
	skillsNeeded?: readonly string[];
	fulfillsAssertionIds?: readonly string[];
}

/**
 * Pick the skills relevant to a task from a catalogue.
 *
 * - When `task.skillsNeeded` is set, returns exact-name matches in the
 *   declared order. Unknown names are silently dropped so a stale
 *   `## Skills:` line never breaks worker spawn.
 * - When `task.skillsNeeded` is unset or empty, falls back to keyword
 *   matching against `taskName`, `fulfillsAssertionIds`, and the first
 *   sentence of `prompt` so workers still see contextually-relevant
 *   skills even without explicit metadata.
 */
export function resolveTaskSkills(available: readonly SkillEntry[], task: TaskSkillContext): SkillEntry[] {
	if (task.skillsNeeded && task.skillsNeeded.length > 0) {
		const byName = new Map(available.map(s => [s.name, s] as const));
		const out: SkillEntry[] = [];
		for (const wanted of task.skillsNeeded) {
			const hit = byName.get(wanted);
			if (hit && !out.includes(hit)) out.push(hit);
		}
		return out;
	}
	const phrases: string[] = [];
	if (task.taskName) phrases.push(task.taskName);
	if (task.fulfillsAssertionIds) phrases.push(...task.fulfillsAssertionIds);
	if (task.prompt) {
		const firstSentence = task.prompt.trim().split(/(?<=[.!?])\s+/)[0] ?? "";
		if (firstSentence) phrases.push(firstSentence);
	}
	// Expand phrases into individual words so a task titled "Frontend
	// redesign" matches a skill described as "Frontend design patterns".
	// Short noise tokens (<= 2 chars) are dropped so common filler
	// doesn't fan out matches across the whole catalogue.
	const tokens = new Set<string>();
	for (const phrase of phrases) {
		for (const word of phrase.split(/[^A-Za-z0-9-]+/)) {
			const cleaned = word.trim().toLowerCase();
			if (cleaned.length > 2) tokens.add(cleaned);
		}
	}
	return findMatchingSkills(available, [...tokens]);
}

/**
 * Render the "Relevant skills" prompt block for the worker. Returns an
 * empty array when no skills matched so callers can spread the result
 * unconditionally:
 *
 *     promptLines.push(...buildSkillPromptBlock(resolved));
 *
 * The rendered block reads as:
 *
 *     Relevant skills for this feature:
 *     - skill://<name> (<origin>) — <description>
 *     …
 *     Read each via `read "skill://<name>"` as needed.
 */
export function buildSkillPromptBlock(skills: readonly SkillEntry[]): string[] {
	if (skills.length === 0) return [];
	const lines: string[] = ["", "Relevant skills for this feature:"];
	for (const s of skills) {
		const desc = s.description.trim();
		lines.push(`- skill://${s.name} (${s.origin}) — ${desc}`);
	}
	lines.push("", 'Read each via `read "skill://<name>"` as needed.');
	return lines;
}
