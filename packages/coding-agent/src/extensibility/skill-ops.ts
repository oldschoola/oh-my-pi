/**
 * Skill ops layer.
 *
 * Pure file/snapshot operations for the `skill_create` and `skill_reload`
 * tools. No tool wiring, no process-global mutation — callers (the tools)
 * are responsible for plumbing approval sinks and pushing the reloaded
 * snapshot into `setActiveSkills`.
 *
 * Validation, path containment, and collision detection live here so the
 * tool layer is a thin schema/approval shell.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { type LoadSkillsOptions, type LoadSkillsResult, loadSkills, type Skill, type SkillWarning } from "./skills";

/** Project-relative directory that holds native skill packages. */
const PROJECT_SKILLS_REL = path.join(".omp", "skills");

/** Lowercase kebab-case identifier, 1-64 chars, leading alnum, [a-z0-9-_] thereafter. */
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,63})$/;

export interface CreateSkillPackageInput {
	/** Unique kebab-case identifier; becomes `.omp/skills/<name>/`. */
	name: string;
	/** One-line summary shown to future agents in the rendered <skills> block. */
	description: string;
	/** SKILL.md body (post-frontmatter, no leading `---`). */
	body: string;
	/** Effective skill surface. Default `"auto"` (omitted from frontmatter). */
	skillSurface?: "auto" | "command";
}

export interface CreateSkillPackageResult {
	/** Absolute path to `<projectRoot>/.omp/skills/<name>/`. */
	skillDir: string;
	/** Absolute path to the created SKILL.md. */
	skillFile: string;
}

export interface ReloadSkillsDiff {
	added: string[];
	removed: string[];
	/** Names present in both snapshots but pointing at a different `filePath`. */
	changed: string[];
	warnings: SkillWarning[];
}

export type SkillOpsErrorCode = "validation" | "collision" | "io";

export class SkillOpsError extends Error {
	constructor(
		readonly code: SkillOpsErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SkillOpsError";
	}
}

function validateName(name: unknown): string {
	if (typeof name !== "string" || name.length === 0) {
		throw new SkillOpsError("validation", "Skill name is required");
	}
	// Reject any path-traversal-shaped or separator-bearing input before the
	// regex so we can give a precise diagnostic instead of a generic "shape".
	if (name.includes("/") || name.includes("\\")) {
		throw new SkillOpsError("validation", `Skill name may not contain path separators: ${JSON.stringify(name)}`);
	}
	if (name === "." || name === "..") {
		throw new SkillOpsError("validation", `Skill name may not be '.' or '..': ${JSON.stringify(name)}`);
	}
	if (name.length > 64) {
		throw new SkillOpsError("validation", `Skill name exceeds 64 characters: ${JSON.stringify(name)}`);
	}
	if (!SKILL_NAME_PATTERN.test(name)) {
		throw new SkillOpsError(
			"validation",
			`Skill name must be lowercase kebab/snake (start alnum, then [a-z0-9_-]): ${JSON.stringify(name)}`,
		);
	}
	return name;
}

function validateDescription(description: unknown): string {
	if (typeof description !== "string" || description.trim().length === 0) {
		throw new SkillOpsError("validation", "Skill description is required");
	}
	return description.trim();
}

/**
 * Resolve and contain the target skill directory under `<projectRoot>/.omp/skills/`.
 * Defence-in-depth against any traversal that slipped past the name regex.
 */
function resolveSkillDir(projectRoot: string, name: string): { skillsRoot: string; skillDir: string } {
	const skillsRoot = path.resolve(projectRoot, PROJECT_SKILLS_REL);
	const skillDir = path.resolve(skillsRoot, name);
	const rel = path.relative(skillsRoot, skillDir);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new SkillOpsError("validation", `Skill path escapes project skills root: ${JSON.stringify(name)}`);
	}
	return { skillsRoot, skillDir };
}

/**
 * Validation phase, separated so tools can fail fast on bad input or
 * collisions BEFORE queueing an approval prompt the user would have to
 * discard.
 *
 * Returns the resolved `skillDir` / `skillFile` and a normalized payload
 * that `commitSkillPackage` consumes verbatim. Performs the same checks
 * the commit phase would, plus an `fs.stat` collision probe.
 */
export interface PreparedSkillPackage {
	name: string;
	description: string;
	body: string;
	skillSurface?: "command";
	skillDir: string;
	skillFile: string;
}

export async function prepareSkillPackage(
	projectRoot: string,
	input: CreateSkillPackageInput,
): Promise<PreparedSkillPackage> {
	const name = validateName(input.name);
	const description = validateDescription(input.description);
	const body = typeof input.body === "string" ? input.body : "";
	const skillSurface = input.skillSurface;
	if (skillSurface !== undefined && skillSurface !== "auto" && skillSurface !== "command") {
		throw new SkillOpsError(
			"validation",
			`skillSurface must be "auto" or "command": ${JSON.stringify(skillSurface)}`,
		);
	}

	const { skillDir } = resolveSkillDir(projectRoot, name);
	const skillFile = path.join(skillDir, "SKILL.md");

	try {
		await fs.stat(skillDir);
		throw new SkillOpsError(
			"collision",
			`Skill directory already exists: ${skillDir}. Refusing to overwrite an existing skill package.`,
		);
	} catch (error) {
		if (error instanceof SkillOpsError) throw error;
		if (!isEnoent(error)) {
			throw new SkillOpsError("io", `Failed to stat skill directory: ${skillDir} (${String(error)})`);
		}
	}

	return {
		name,
		description,
		body,
		skillSurface: skillSurface === "command" ? "command" : undefined,
		skillDir,
		skillFile,
	};
}

/** Write a previously prepared skill package to disk. */
export async function commitSkillPackage(prepared: PreparedSkillPackage): Promise<CreateSkillPackageResult> {
	const frontmatter: Record<string, unknown> = { name: prepared.name, description: prepared.description };
	if (prepared.skillSurface === "command") {
		frontmatter.skillSurface = "command";
	}
	const fm = YAML.stringify(frontmatter).trimEnd();
	const content = `---\n${fm}\n---\n\n${prepared.body.trimEnd()}\n`;
	// Re-check collision at commit time. Between prepare (pre-approval)
	// and commit (post-approval), another process or user may have
	// authored the same skill — refuse instead of overwriting it.
	try {
		await fs.stat(prepared.skillFile);
		throw new SkillOpsError("collision", `Skill already exists at commit time: ${prepared.skillFile}`);
	} catch (error) {
		if (error instanceof SkillOpsError) throw error;
		if (!isEnoent(error)) {
			throw new SkillOpsError("io", `Failed to stat skill file at commit: ${prepared.skillFile} (${String(error)})`);
		}
	}
	try {
		await fs.mkdir(prepared.skillDir, { recursive: true });
		// Exclusive write (wx) guards the narrow window between the stat
		// above and this write — another writer creating the file in
		// between will surface as EEXIST instead of an overwrite.
		await fs.writeFile(prepared.skillFile, content, { flag: "wx", encoding: "utf-8" });
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new SkillOpsError("collision", `Skill was created concurrently: ${prepared.skillFile}`);
		}
		throw new SkillOpsError("io", `Failed to write skill file: ${prepared.skillFile} (${String(error)})`);
	}
	return { skillDir: prepared.skillDir, skillFile: prepared.skillFile };
}

/**
 * Convenience helper: validate-and-commit in one shot. Useful for tests
 * and any callsite that does not stage the write through user approval.
 */
export async function createSkillPackage(
	projectRoot: string,
	input: CreateSkillPackageInput,
): Promise<CreateSkillPackageResult> {
	const prepared = await prepareSkillPackage(projectRoot, input);
	return commitSkillPackage(prepared);
}

/**
 * Re-scan skill directories and compute a diff against an optional prior snapshot.
 *
 * Pure: does NOT call `setActiveSkills`. The caller (tool) decides when to
 * publish the new snapshot to the process-global slot.
 */
export async function reloadSkills(
	options: LoadSkillsOptions,
	previous?: readonly Skill[],
): Promise<{ skills: Skill[]; diff: ReloadSkillsDiff }> {
	const result: LoadSkillsResult = await loadSkills(options);
	const diff = diffSkills(previous ?? [], result.skills);
	diff.warnings = result.warnings;
	return { skills: result.skills, diff };
}

function diffSkills(prev: readonly Skill[], next: readonly Skill[]): ReloadSkillsDiff {
	const prevByName = new Map(prev.map(s => [s.name, s]));
	const nextByName = new Map(next.map(s => [s.name, s]));
	const added: string[] = [];
	const removed: string[] = [];
	const changed: string[] = [];
	for (const [name, nextSkill] of nextByName) {
		const prevSkill = prevByName.get(name);
		if (!prevSkill) {
			added.push(name);
		} else if (prevSkill.filePath !== nextSkill.filePath) {
			changed.push(name);
		}
	}
	for (const name of prevByName.keys()) {
		if (!nextByName.has(name)) removed.push(name);
	}
	added.sort();
	removed.sort();
	changed.sort();
	return { added, removed, changed, warnings: [] };
}
