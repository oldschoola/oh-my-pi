/**
 * Task discovery — pure helpers + minimal folder scanner for task packets.
 *
 * Ported from taskplane `extensions/taskplane/discovery.ts` (1818 LOC).
 * The MVP port keeps only the pure parsers (taskId extraction, dependency
 * references) plus a minimal directory walker that reads
 * `<missionsDir>/tasks/<TASK-ID>/PROMPT.md`. The full discovery surface
 * (segment DAGs, step-segment mapping, workspace routing) lands when the
 * heavier orchestration modules follow.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface DependencyRef {
	raw: string;
	taskId: string;
	areaName?: string;
}

export interface ParsedTask {
	taskId: string;
	taskName: string;
	folderPath: string;
	promptPath: string;
	prompt: string;
	dependencies: string[];
	/** Task size band used for duration estimates (S/M/L). Default "M". */
	size: string;
	/** Absolute path to the task folder. Alias of `folderPath` for taskplane parity. */
	taskFolder?: string;
	/** Task area name (e.g. "api", "frontend"). Optional in simple discovery. */
	areaName?: string;
	/** Review level (taskplane parity). */
	reviewLevel?: number;
	/** File scope globs (taskplane parity). */
	fileScope?: string[];
	/** Task lifecycle status parsed from prompt (taskplane parity). */
	status?: "pending" | "complete";
	/** Repo ID declared in prompt metadata (workspace mode). */
	promptRepoId?: string;
	/** Repo ID after routing precedence (workspace mode). */
	resolvedRepoId?: string;
	/** Segment IDs for the task (v4 TP-081). */
	segmentIds?: string[];
	/** Active segment ID if any (v4 TP-081). */
	activeSegmentId?: string | null;
}

/**
 * Extract a task ID from a folder name.
 *
 * Convention: `"TO-014-accrual-engine"` → `"TO-014"`.
 * Matches prefix-number patterns like `COMP-006`, `TS-004`, `TO-014`.
 */
export function extractTaskIdFromFolderName(folderName: string): string | null {
	const match = folderName.match(/^([A-Z]+-\d+)/);
	return match ? (match[1] ?? null) : null;
}

export function parseDependencyReference(raw: string): DependencyRef {
	const trimmed = raw.trim();
	const qualified = trimmed.match(/^([a-z0-9-]+)\/([A-Z]+-\d+)$/i);
	if (qualified?.[1] && qualified[2]) {
		return {
			raw: trimmed,
			areaName: qualified[1].toLowerCase(),
			taskId: qualified[2].toUpperCase(),
		};
	}

	const idOnly = trimmed.match(/^([A-Z]+-\d+)$/i);
	if (idOnly?.[1]) {
		return { raw: trimmed, taskId: idOnly[1].toUpperCase() };
	}

	return { raw: trimmed, taskId: trimmed.toUpperCase() };
}

export function normalizeDependencyReference(raw: string): string {
	const parsed = parseDependencyReference(raw);
	return parsed.areaName ? `${parsed.areaName}/${parsed.taskId}` : parsed.taskId;
}

/**
 * Parse a `## Dependencies` section from a PROMPT.md body.
 *
 * Accepts bulleted lines (`- TO-001`, `* API/TO-001`) and comma-separated
 * inline lists. Returns normalized dependency references (deduplicated).
 */
export function parseDependencies(content: string): string[] {
	const headerMatch = content.match(/^##\s+Dependencies\s*$/im);
	if (!headerMatch || headerMatch.index === undefined) return [];

	const afterHeader = content.indexOf("\n", headerMatch.index);
	if (afterHeader === -1) return [];

	const rest = content.slice(afterHeader + 1);
	const nextSection = rest.search(/^##\s+[^#]|^---/m);
	const body = nextSection !== -1 ? rest.slice(0, nextSection) : rest;

	const refs = new Set<string>();
	for (const line of body.split(/\r?\n/)) {
		const stripped = line.replace(/^[-*•]\s*/, "").trim();
		if (!stripped || stripped.startsWith("#")) continue;
		for (const token of stripped.split(/[,;\s]+/)) {
			const normalized = normalizeDependencyReference(token);
			if (normalized) refs.add(normalized);
		}
	}
	return [...refs];
}

/**
 * Extract the first `# Heading` from a markdown document, falling back to
 * the task ID if none present.
 */
export function extractTaskName(content: string, fallback: string): string {
	const heading = content.match(/^#\s+(.+?)\s*$/m);
	return heading?.[1]?.trim() || fallback;
}

/**
 * Scan a tasks directory for task packets.
 *
 * Each child folder is treated as a potential task; the taskId is extracted
 * from the folder name and PROMPT.md (if present) is parsed for dependencies.
 * Folders without a recognizable taskId are skipped silently.
 */
export function discoverTasks(tasksDir: string): ParsedTask[] {
	const tasks: ParsedTask[] = [];
	let entries: string[];
	try {
		entries = readdirSync(tasksDir);
	} catch {
		return tasks;
	}

	for (const name of entries) {
		const folderPath = join(tasksDir, name);
		try {
			if (!statSync(folderPath).isDirectory()) continue;
		} catch {
			continue;
		}
		const taskId = extractTaskIdFromFolderName(name);
		if (!taskId) continue;

		const promptPath = join(folderPath, "PROMPT.md");
		let prompt = "";
		try {
			prompt = readFileSync(promptPath, "utf-8");
		} catch {
			// Missing PROMPT.md — still register the task, empty prompt.
		}

		tasks.push({
			taskId,
			taskName: extractTaskName(prompt, taskId),
			folderPath,
			promptPath,
			prompt,
			dependencies: parseDependencies(prompt),
			size: "M",
			taskFolder: folderPath,
		});
	}

	return tasks.sort((a, b) => a.taskId.localeCompare(b.taskId));
}
