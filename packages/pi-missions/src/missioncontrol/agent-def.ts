/**
 * Agent definition loader ported from taskplane
 * `extensions/taskplane/execution.ts:2309-2468`.
 *
 * Resolves agent markdown files (system prompt + tools + model) by
 * composing a base template from the shipped `templates/agents/` dir
 * with an optional project-local override under `<cwd>/.omp/agents/`
 * or `<cwd>/agents/`. In workspace mode (`OMP_WORKSPACE_ROOT` env) a
 * pointer-resolved `agentRoot` is consulted as an additional fallback.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { projectDir } from "./adapter";
import { resolveTaskRunnerPointer } from "./config-loader";
import { resolveAgentTemplate } from "./paths";

export interface AgentFile {
	fm: Record<string, string>;
	body: string;
}

export interface AgentDef {
	systemPrompt: string;
	tools: string;
	model: string;
}

/**
 * Parse a simple frontmatter + body markdown file. Unlike
 * `parseSupervisorTemplate`, an empty/absent frontmatter block still
 * returns `{ fm: {}, body }` rather than null — agent files ship with
 * body-only overrides.
 */
export function parseAgentFile(filePath: string): AgentFile | null {
	try {
		if (!existsSync(filePath)) return null;
		const raw = readFileSync(filePath, "utf-8");
		const fmEnd = raw.indexOf("---", 4);
		if (fmEnd < 0) return { fm: {}, body: raw.trim() };
		const fmBlock = raw.slice(4, fmEnd).trim();
		const fm: Record<string, string> = {};
		for (const line of fmBlock.split("\n")) {
			const m = line.match(/^([\w-]+)\s*:\s*(.+)/);
			if (m?.[1] && m[2]) fm[m[1]] = m[2].trim();
		}
		return { fm, body: raw.slice(fmEnd + 3).trim() };
	} catch {
		return null;
	}
}

/**
 * Load the base agent prompt from the package's shipped
 * `templates/agents/` directory. Returns "" when the template is
 * missing or unreadable so the caller can fall back cleanly.
 */
export function loadBaseAgentPrompt(agentName: string): string {
	try {
		const resolved = resolveAgentTemplate(agentName);
		if (existsSync(resolved)) {
			const def = parseAgentFile(resolved);
			if (def?.body) return def.body;
		}
	} catch {
		/* fall through */
	}
	return "";
}

/**
 * Load a project-local agent prompt from `<cwd>/.omp/agents/` or
 * `<cwd>/agents/`. Honours `standalone: true` (returns body only),
 * otherwise returns body for append-style composition.
 */
export function loadLocalAgentPrompt(stateRoot: string, agentName: string): string {
	const paths = [
		join(projectDir(stateRoot), "agents", `${agentName}.md`),
		join(stateRoot, "agents", `${agentName}.md`),
	];
	for (const p of paths) {
		const def = parseAgentFile(p);
		if (def) {
			if (def.fm.standalone === "true") return def.body;
			if (def.body) return def.body;
		}
	}
	return "";
}

let _execPointerWarningLogged = false;

/** Reset agent pointer warning state for tests. */
export function resetPointerWarning(): void {
	_execPointerWarningLogged = false;
}

/**
 * Resolve agent files using the workspace pointer (workspace mode only).
 * Returns the agentRoot from the pointer, or null in repo mode / on failure.
 */
export function resolveAgentPointerRoot(): string | null {
	const result = resolveTaskRunnerPointer();
	if (!result) return null;
	if (result.warning && !_execPointerWarningLogged) {
		_execPointerWarningLogged = true;
		console.error(`[missioncontrol] pointer: ${result.warning}`);
	}
	return result.agentRoot ?? null;
}

/**
 * Load a complete agent definition (systemPrompt + tools + model) by name.
 *
 * Resolution order:
 *   1. `<cwd>/.omp/agents/<name>.md`
 *   2. `<cwd>/agents/<name>.md`
 *   3. `pointer.agentRoot/<name>.md` (workspace mode only)
 *   4. Base package `templates/agents/<name>.md`
 *
 * If a local file has `standalone: true` in frontmatter, it is used as-is
 * (no base composition). Otherwise, base + local are composed.
 *
 * Returns null if no base and no local file are found.
 */
export function loadAgentDef(cwd: string, name: string): AgentDef | null {
	const localPaths = [join(projectDir(cwd), "agents", `${name}.md`), join(cwd, "agents", `${name}.md`)];

	const agentRoot = resolveAgentPointerRoot();
	if (agentRoot) {
		localPaths.push(join(agentRoot, `${name}.md`));
	}

	let baseDef: AgentFile | null = null;
	try {
		const basePath = resolveAgentTemplate(name);
		if (existsSync(basePath)) {
			baseDef = parseAgentFile(basePath);
		}
	} catch {
		/* fall through */
	}

	let localDef: AgentFile | null = null;
	for (const p of localPaths) {
		localDef = parseAgentFile(p);
		if (localDef) break;
	}

	if (!baseDef && !localDef) return null;

	if (localDef?.fm.standalone === "true") {
		return {
			systemPrompt: localDef.body,
			tools: localDef.fm.tools || "read,grep,find,ls",
			model: localDef.fm.model || "",
		};
	}

	const basePrompt = baseDef?.body ?? "";
	const localPrompt = localDef?.body ?? "";
	const composedPrompt = localPrompt
		? `${basePrompt}\n\n---\n\n## Project-Specific Guidance\n\n${localPrompt}`
		: basePrompt;

	const tools = localDef?.fm.tools || baseDef?.fm.tools || "read,grep,find,ls";
	const model = localDef?.fm.model || baseDef?.fm.model || "";

	return { systemPrompt: composedPrompt.trim(), tools, model };
}
