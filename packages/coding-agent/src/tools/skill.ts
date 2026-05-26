/**
 * Skill tools.
 *
 * Two operations against the native skill package store at
 * `<projectRoot>/.omp/skills/<name>/SKILL.md`:
 *
 *   - `skill_create` — author a new SKILL.md. ALWAYS routes through user
 *     approval via the `resolve` protocol — skills become high-trust
 *     instructions the agent will later read with `skill://<name>`.
 *   - `skill_reload` — refresh the process-global active-skill snapshot
 *     from disk so newly authored (or externally edited) skills become
 *     reachable via `skill://<name>` and `/skill:<name>` without a
 *     session restart. No approval: reload only re-reads files that
 *     already exist on disk.
 *
 * Both tools are gated by the existing `skills.enabled` setting.
 */

import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import type { SkillsSettings } from "../config/settings";
import {
	type CreateSkillPackageInput,
	type CreateSkillPackageResult,
	commitSkillPackage,
	type PreparedSkillPackage,
	prepareSkillPackage,
	type ReloadSkillsDiff,
	reloadSkills,
	SkillOpsError,
} from "../extensibility/skill-ops";
import { getActiveSkills, setActiveSkills } from "../extensibility/skills";
import type { ToolSession } from ".";
import { queueResolveHandler } from "./resolve";
import { ToolError } from "./tool-errors";

// ────────────────────────────────────────────────────────────────────
// shared helpers
// ────────────────────────────────────────────────────────────────────

function toToolError(error: unknown): never {
	if (error instanceof SkillOpsError) {
		throw new ToolError(error.message);
	}
	throw error;
}

function plainText(text: string): AgentToolResult {
	return { content: [{ type: "text", text }] };
}

/**
 * Build a load-skills options object from the session's settings. Mirrors
 * the shape `sdk.ts` passes to `loadSkills` at session start so that the
 * reloaded snapshot matches what the user would see on a fresh launch.
 */
function buildLoadOptions(session: ToolSession) {
	const skillsSettings = (session.settings.getGroup("skills") ?? {}) as SkillsSettings;
	const disabledExtensions = session.settings.get("disabledExtensions") ?? [];
	return {
		...skillsSettings,
		cwd: session.cwd,
		disabledExtensions,
	};
}

// ────────────────────────────────────────────────────────────────────
// schemas
// ────────────────────────────────────────────────────────────────────

const createSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.describe("Lowercase kebab/snake skill identifier, 1-64 chars. Becomes `.omp/skills/<name>/`."),
		description: z
			.string()
			.min(1)
			.describe("One-line skill summary. Shown to future agents in the rendered <skills> block."),
		body: z
			.string()
			.describe(
				"SKILL.md body (markdown). Frontmatter (`name`, `description`, optional `skillSurface`) is generated for you.",
			),
		skillSurface: z
			.enum(["auto", "command"])
			.optional()
			.describe(
				'"auto" (default) — listed in the rendered <skills> block. "command" — hidden from listing, reachable via skill://<name> and /skill:<name> only.',
			),
	})
	.strict();

const reloadSchema = z.object({}).strict();

const listSchema = z
	.object({
		surface: z
			.enum(["auto", "command", "all"])
			.optional()
			.describe(
				'Filter by skill surface. "auto" lists rendered-block skills; "command" lists hidden/command-only skills; "all" (default) lists every active skill.',
			),
	})
	.strict();

// ────────────────────────────────────────────────────────────────────
// tool factories
// ────────────────────────────────────────────────────────────────────

export class SkillCreateTool implements AgentTool<typeof createSchema> {
	readonly name = "skill_create";
	readonly label = "SkillCreate";
	readonly summary = "Author a new skill package";
	readonly loadMode = "discoverable" as const;
	readonly description =
		"Create a new skill package at .omp/skills/<name>/SKILL.md. ALWAYS routes through user approval via the `resolve` protocol — skills become instructions future agents read with high trust. Refuses on name collision, unsafe identifiers, or pre-existing skill directories. After approval, run `skill_reload` to make the new skill reachable via skill://<name> and /skill:<name>. Project-scope only; user-scope skills (~/.omp/agent/skills/) must be authored manually.";
	readonly parameters = createSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof createSchema>,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const input: CreateSkillPackageInput = {
				name: params.name,
				description: params.description,
				body: params.body,
				skillSurface: params.skillSurface,
			};

			// Validate eagerly so name/collision errors surface as ToolError
			// without queueing a doomed preview the user would have to discard.
			let prepared: PreparedSkillPackage;
			try {
				prepared = await prepareSkillPackage(this.session.cwd, input);
			} catch (error) {
				toToolError(error);
			}

			const queue = this.session.getToolChoiceQueue?.();
			const forced = this.session.buildToolChoice?.("resolve");
			if (!queue || !forced || typeof forced === "string") {
				throw new ToolError(
					`skill_create requires user approval but no resolve channel is available in this session. Author the skill manually under .omp/skills/${params.name}/SKILL.md if needed.`,
				);
			}

			const label = `Create skill: ${params.name}`;
			queueResolveHandler(this.session, {
				label,
				sourceToolName: this.name,
				apply: async () => {
					let result: CreateSkillPackageResult;
					try {
						result = await commitSkillPackage(prepared!);
					} catch (error) {
						toToolError(error);
					}
					return plainText(
						`Created skill package: ${result!.skillFile}. Call \`skill_reload\` to activate it (skill://${params.name} will resolve only after reload).`,
					);
				},
			});

			return plainText(
				`Create skill \`${params.name}\` pending user approval. The user must call \`resolve\` to apply or discard.`,
			);
		});
	}
}

export class SkillReloadTool implements AgentTool<typeof reloadSchema> {
	readonly name = "skill_reload";
	readonly label = "SkillReload";
	readonly summary = "Re-scan and reload the active skill snapshot";
	readonly loadMode = "discoverable" as const;
	readonly description =
		"Re-scan skill directories and refresh the process-global active-skill snapshot. Returns added/removed/changed skill names. After a successful reload, new skills are reachable via skill://<name> and /skill:<name>. NOTE: the rendered <skills> system-prompt block reflects the snapshot at session start — restart the session to re-render that block.";
	readonly parameters = reloadSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		_params: z.infer<typeof reloadSchema>,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const previous = getActiveSkills();
			const options = buildLoadOptions(this.session);
			const { skills, diff } = await reloadSkills(options, previous);
			setActiveSkills(skills);
			return plainText(formatReloadOutcome(diff, skills.length));
		});
	}
}

function formatReloadOutcome(diff: ReloadSkillsDiff, total: number): string {
	const lines: string[] = [];
	lines.push(`Reloaded skills: ${total} active.`);
	lines.push(`  added: ${diff.added.length === 0 ? "(none)" : diff.added.join(", ")}`);
	lines.push(`  removed: ${diff.removed.length === 0 ? "(none)" : diff.removed.join(", ")}`);
	lines.push(`  changed: ${diff.changed.length === 0 ? "(none)" : diff.changed.join(", ")}`);
	if (diff.warnings.length > 0) {
		lines.push(`  warnings (${diff.warnings.length}):`);
		for (const w of diff.warnings) {
			lines.push(`    - ${w.skillPath}: ${w.message}`);
		}
	}
	return lines.join("\n");
}

export class SkillListTool implements AgentTool<typeof listSchema> {
	readonly name = "skill_list";
	readonly label = "SkillList";
	readonly summary = "List active skills";
	readonly loadMode = "discoverable" as const;
	readonly description =
		"List currently-active skills (process-global snapshot, updated by `skill_reload`). Returns one skill per line: `<name>  surface=<auto|command>  source=<source>  · <description>`. Use this to see which skills the agent already has — without re-reading the rendered <skills> system block (which only reflects the snapshot at session start).";
	readonly parameters = listSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof listSchema>,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			void this.session; // session reserved for future per-session filtering
			const filter = params.surface ?? "all";
			const skills = getActiveSkills();
			const filtered = skills.filter(skill => {
				if (filter === "all") return true;
				const surface = skill.surface ?? (skill.hide ? "command" : "auto");
				return surface === filter;
			});
			if (filtered.length === 0) {
				return plainText(filter === "all" ? "(no active skills)" : `(no ${filter} skills)`);
			}
			const lines = filtered
				.slice()
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(skill => {
					const surface = skill.surface ?? (skill.hide ? "command" : "auto");
					const source = skill.source || "unknown";
					const desc = skill.description ? ` · ${skill.description}` : "";
					return `${skill.name}  surface=${surface}  source=${source}${desc}`;
				});
			return plainText(lines.join("\n"));
		});
	}
}

export const SKILL_TOOL_NAMES = ["skill_create", "skill_reload", "skill_list"] as const;
