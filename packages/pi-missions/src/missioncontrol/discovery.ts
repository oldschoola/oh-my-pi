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

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type {
	DiscoveryError,
	DiscoveryResult,
	PromptSegmentDagMetadata,
	StepSegmentMapping,
	TaskArea,
	WorkspaceConfig,
} from "./types";

/**
 * Placeholder repoId used for segment-plan entries when workspace routing
 * cannot (yet) resolve a concrete repoId. Downstream consumers replace this
 * with either the default repo or the task's resolvedRepoId.
 */
export const SEGMENT_FALLBACK_REPO_PLACEHOLDER = "__primary__";

export interface DependencyRef {
	raw: string;
	taskId: string;
	areaName?: string;
}

export interface DiscoveryOptions {
	refreshDependencies?: boolean;
	dependencySource?: "prompt" | "agent";
	useDependencyCache?: boolean;
	/** Workspace config for repo routing (null/undefined = repo mode, no routing). */
	workspaceConfig?: WorkspaceConfig | null;
}

export interface DependencyCacheFile {
	version: number;
	generatedAt: string;
	source: string;
	tasks: Record<string, string[]>;
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
	/** Packet home repo — set when a cross-repo segment reads its packet from a different repo than the execution lane. */
	packetRepoId?: string;
	/** Absolute packet task path — used in cross-repo segments where the packet files live outside the execution worktree. */
	packetTaskPath?: string;
	/** Explicit segment DAG parsed from PROMPT.md metadata (TP-080). */
	explicitSegmentDag?: PromptSegmentDagMetadata;
	/** Explicit step-segment mapping parsed from `#### Segment:` markers (TP-173). */
	stepSegmentMap?: StepSegmentMapping[];
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
 * Normalize a path for case/slash-insensitive comparison.
 * Resolves to absolute, converts backslashes to forward slashes, lowercases.
 * Needed because Windows paths may mix separators and case.
 */
export function normalizePathForCompare(p: string): string {
	return resolve(p).replace(/\\/g, "/").toLowerCase();
}

/**
 * Return true when `childPath` is equal to or nested inside `parentPath`.
 * Comparison is path-separator-insensitive (see normalizePathForCompare).
 */
export function isPathWithin(childPath: string, parentPath: string): boolean {
	const child = normalizePathForCompare(childPath);
	const parent = normalizePathForCompare(parentPath);
	return child === parent || child.startsWith(`${parent}/`);
}

/**
 * Normalize and deduplicate a list of raw dependency tokens.
 * Applies `normalizeDependencyReference` to each entry, drops empties,
 * and preserves first-seen order.
 */
export function dedupeAndNormalizeDeps(deps: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const dep of deps) {
		const norm = normalizeDependencyReference(dep);
		if (!norm || seen.has(norm)) continue;
		seen.add(norm);
		out.push(norm);
	}
	return out;
}

/**
 * Legal shape of a segment repoId in `## Steps` metadata.
 * Lowercase alphanumeric + hyphen, must start with alphanumeric.
 */
export const SEGMENT_REPO_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Normalize a raw segment repo token to a comparable form.
 * Strips surrounding `` ` `` or `**` markdown decoration, trims, lowercases.
 */
export function normalizeSegmentRepoToken(raw: string): string {
	let token = raw.trim();
	token = token.replace(/^`(.+)`$/, "$1").trim();
	token = token.replace(/^\*\*(.+)\*\*$/, "$1").trim();
	return token.toLowerCase();
}

/**
 * Extract checkbox text lines from a content block.
 * Matches `- [ ] text` and `- [x] text` patterns (any indent).
 * Returns the trimmed text after the checkbox marker.
 */
export function extractCheckboxes(content: string): string[] {
	const checkboxes: string[] = [];
	for (const line of content.split(/\r?\n/)) {
		const match = line.match(/^\s*-\s+\[[ x]\]\s+(.+)$/);
		if (match?.[1]) checkboxes.push(match[1].trim());
	}
	return checkboxes;
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

/**
 * Load a cached area dependency file from `<areaPath>/dependencies.json`.
 * Returns null when the file is missing, unreadable, malformed, or missing
 * the required `tasks` map. Never throws.
 */
export function loadAreaDependencyCache(areaPath: string): DependencyCacheFile | null {
	const cachePath = join(areaPath, "dependencies.json");
	if (!existsSync(cachePath)) return null;
	try {
		const raw = readFileSync(cachePath, "utf-8");
		const parsed = JSON.parse(raw) as DependencyCacheFile;
		if (!parsed || typeof parsed !== "object" || !parsed.tasks) return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Write an area dependency cache to `<areaPath>/dependencies.json`. Only
 * tasks whose folder lies within `areaPath` are included. Non-fatal on
 * I/O failure — discovery should still succeed without cache persistence.
 */
export function writeAreaDependencyCache(
	areaPath: string,
	pending: Map<string, ParsedTask>,
	source: "prompt" | "agent",
): void {
	const tasks: Record<string, string[]> = {};
	for (const task of pending.values()) {
		const taskFolder = task.taskFolder ?? task.folderPath;
		if (!isPathWithin(taskFolder, areaPath)) continue;
		tasks[task.taskId] = dedupeAndNormalizeDeps(task.dependencies);
	}

	const cachePath = join(areaPath, "dependencies.json");
	const payload: DependencyCacheFile = {
		version: 1,
		generatedAt: new Date().toISOString(),
		source,
		tasks,
	};

	try {
		const json = JSON.stringify(payload, null, 2);
		writeFileSync(cachePath, `${json}\n`, "utf-8");
	} catch {
		// Non-fatal: discovery still succeeds without cache persistence.
	}
}

/**
 * Apply cached dependency edges onto in-memory discovery results.
 * Iterates each `areaScanPaths` entry, loads its cache (if any), and
 * overwrites `dependencies` on every pending task within that area.
 * Returns `{ applied: true }` when at least one task was updated.
 */
export function applyDependenciesFromCache(discovery: DiscoveryResult, areaScanPaths: string[]): { applied: boolean } {
	let applied = false;
	for (const areaPath of areaScanPaths) {
		const cache = loadAreaDependencyCache(areaPath);
		if (!cache) continue;
		for (const task of discovery.pending.values()) {
			const taskFolder = task.taskFolder ?? task.folderPath;
			if (!isPathWithin(taskFolder, areaPath)) continue;
			const cachedDeps = cache.tasks[task.taskId];
			if (!cachedDeps) continue;
			task.dependencies = dedupeAndNormalizeDeps(cachedDeps);
			applied = true;
		}
	}
	return { applied };
}

/**
 * Result of parsing the optional `## Segment DAG` section in a PROMPT.md.
 * `metadata` is non-null only when the section was well-formed and produced
 * at least one repo or edge. `error` is non-null only on fail-fast validation
 * failures (invalid token, self-edge, unknown endpoint, cycle, etc.).
 */
export interface ParsedSegmentDagBody {
	metadata: PromptSegmentDagMetadata | null;
	error: DiscoveryError | null;
}

/**
 * Parse optional explicit segment DAG metadata from `## Segment DAG`.
 *
 * Supported v1 syntax:
 *
 *     ## Segment DAG
 *     Repos:
 *     - api
 *     - web-client
 *     Edges:
 *     - api -> web-client
 *
 * Notes:
 * - `Repos:` / `Edges:` keys accept markdown decoration (`**Repos:**`) and whitespace.
 * - Repo IDs are normalized (lowercased, backticks/bold stripped) then validated
 *   against {@link SEGMENT_REPO_ID_PATTERN}.
 * - Self-edges, cycles, and edge endpoints not listed in `Repos:` fail fast.
 */
export function parseSegmentDagMetadata(content: string, taskId: string, promptPath: string): ParsedSegmentDagBody {
	const headerMatch = content.match(/^##\s+Segment DAG\s*$/im);
	if (!headerMatch || headerMatch.index === undefined) {
		return { metadata: null, error: null };
	}

	const headerIndex = headerMatch.index;
	const afterHeaderIndex = content.indexOf("\n", headerIndex);
	if (afterHeaderIndex === -1) return { metadata: null, error: null };

	const rest = content.slice(afterHeaderIndex + 1);
	const nextBoundary = rest.search(/^##\s|^---/m);
	const body = nextBoundary !== -1 ? rest.slice(0, nextBoundary) : rest;

	const repoIds: string[] = [];
	const repoSet = new Set<string>();
	const edgePairs = new Set<string>();
	const edges: Array<{ fromRepoId: string; toRepoId: string }> = [];
	const baseLine = content.slice(0, afterHeaderIndex + 1).split(/\r?\n/).length;

	let mode: "repos" | "edges" | null = null;
	const lines = body.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i] ?? "";
		const trimmed = rawLine.trim();
		if (!trimmed) continue;

		if (/^\*?\*?Repos:?\*?\*?\s*$/i.test(trimmed)) {
			mode = "repos";
			continue;
		}
		if (/^\*?\*?Edges:?\*?\*?\s*$/i.test(trimmed)) {
			mode = "edges";
			continue;
		}

		if (!mode) {
			return {
				metadata: null,
				error: {
					code: "SEGMENT_DAG_INVALID",
					message:
						`Task ${taskId} has malformed ## Segment DAG metadata at line ${baseLine + i}: ` +
						"expected a Repos: or Edges: subsection header before entries.",
					taskId,
					taskPath: promptPath,
				},
			};
		}

		const bulletMatch = rawLine.match(/^\s*[-*]\s+(.+)$/);
		if (!bulletMatch?.[1]) {
			return {
				metadata: null,
				error: {
					code: "SEGMENT_DAG_INVALID",
					message:
						`Task ${taskId} has malformed ## Segment DAG metadata at line ${baseLine + i}: ` +
						'expected a bullet entry ("- ...").',
					taskId,
					taskPath: promptPath,
				},
			};
		}

		const entry = bulletMatch[1].trim();
		if (!entry) continue;

		if (mode === "repos") {
			if (entry.includes("->")) {
				return {
					metadata: null,
					error: {
						code: "SEGMENT_DAG_INVALID",
						message:
							`Task ${taskId} has malformed ## Segment DAG metadata at line ${baseLine + i}: ` +
							"repo list entries must be a single repo ID.",
						taskId,
						taskPath: promptPath,
					},
				};
			}
			const repoId = normalizeSegmentRepoToken(entry);
			if (!SEGMENT_REPO_ID_PATTERN.test(repoId)) {
				return {
					metadata: null,
					error: {
						code: "SEGMENT_DAG_INVALID",
						message:
							`Task ${taskId} has invalid repo ID "${entry}" in ## Segment DAG at line ${baseLine + i}. ` +
							"Repo IDs must match /^[a-z0-9][a-z0-9-]*$/.",
						taskId,
						taskPath: promptPath,
					},
				};
			}
			if (!repoSet.has(repoId)) {
				repoSet.add(repoId);
				repoIds.push(repoId);
			}
			continue;
		}

		const edgeMatch = entry.match(/^(.+?)\s*->\s*(.+)$/);
		if (!edgeMatch?.[1] || !edgeMatch[2]) {
			return {
				metadata: null,
				error: {
					code: "SEGMENT_DAG_INVALID",
					message:
						`Task ${taskId} has malformed edge "${entry}" in ## Segment DAG at line ${baseLine + i}. ` +
						"Expected format: <repo-a> -> <repo-b>.",
					taskId,
					taskPath: promptPath,
				},
			};
		}

		const fromRepoId = normalizeSegmentRepoToken(edgeMatch[1]);
		const toRepoId = normalizeSegmentRepoToken(edgeMatch[2]);
		if (!SEGMENT_REPO_ID_PATTERN.test(fromRepoId) || !SEGMENT_REPO_ID_PATTERN.test(toRepoId)) {
			return {
				metadata: null,
				error: {
					code: "SEGMENT_DAG_INVALID",
					message:
						`Task ${taskId} has malformed edge "${entry}" in ## Segment DAG at line ${baseLine + i}. ` +
						"Repo IDs must match /^[a-z0-9][a-z0-9-]*$/.",
					taskId,
					taskPath: promptPath,
				},
			};
		}
		if (fromRepoId === toRepoId) {
			return {
				metadata: null,
				error: {
					code: "SEGMENT_DAG_INVALID",
					message: `Task ${taskId} has self-edge "${fromRepoId} -> ${toRepoId}" in ## Segment DAG at line ${baseLine + i}.`,
					taskId,
					taskPath: promptPath,
				},
			};
		}

		const edgeKey = `${fromRepoId}->${toRepoId}`;
		if (!edgePairs.has(edgeKey)) {
			edgePairs.add(edgeKey);
			edges.push({ fromRepoId, toRepoId });
		}
	}

	if (repoIds.length === 0 && edges.length === 0) {
		return { metadata: null, error: null };
	}

	for (const edge of edges) {
		if (!repoSet.has(edge.fromRepoId)) {
			return {
				metadata: null,
				error: {
					code: "SEGMENT_REPO_UNKNOWN",
					message: `Task ${taskId} has edge endpoint repo "${edge.fromRepoId}" in ## Segment DAG that is not declared in Repos:.`,
					taskId,
					taskPath: promptPath,
				},
			};
		}
		if (!repoSet.has(edge.toRepoId)) {
			return {
				metadata: null,
				error: {
					code: "SEGMENT_REPO_UNKNOWN",
					message: `Task ${taskId} has edge endpoint repo "${edge.toRepoId}" in ## Segment DAG that is not declared in Repos:.`,
					taskId,
					taskPath: promptPath,
				},
			};
		}
	}

	const sortedEdges = [...edges].sort((a, b) => {
		if (a.fromRepoId !== b.fromRepoId) return a.fromRepoId.localeCompare(b.fromRepoId);
		return a.toRepoId.localeCompare(b.toRepoId);
	});

	const adjacency = new Map<string, string[]>();
	for (const repoId of repoIds) adjacency.set(repoId, []);
	for (const edge of sortedEdges) adjacency.get(edge.fromRepoId)?.push(edge.toRepoId);
	for (const neighbors of adjacency.values()) neighbors.sort();

	const visited = new Set<string>();
	const stack = new Set<string>();
	const path: string[] = [];
	let cycle: string[] | null = null;

	function dfs(repoId: string): void {
		if (cycle) return;
		visited.add(repoId);
		stack.add(repoId);
		path.push(repoId);

		const neighbors = adjacency.get(repoId) ?? [];
		for (const next of neighbors) {
			if (cycle) return;
			if (!visited.has(next)) {
				dfs(next);
				continue;
			}
			if (stack.has(next)) {
				const start = path.indexOf(next);
				cycle = [...path.slice(start), next];
				return;
			}
		}

		path.pop();
		stack.delete(repoId);
	}

	for (const repoId of [...repoIds].sort()) {
		if (!visited.has(repoId)) dfs(repoId);
		if (cycle) break;
	}

	if (cycle) {
		return {
			metadata: null,
			error: {
				code: "SEGMENT_DAG_INVALID",
				message: `Task ${taskId} has cyclic ## Segment DAG metadata: ${(cycle as string[]).join(" -> ")}.`,
				taskId,
				taskPath: promptPath,
			},
		};
	}

	return { metadata: { repoIds, edges: sortedEdges }, error: null };
}

/**
 * Result of parsing `## Steps` / `### Step N:` / `#### Segment: <repoId>` markers
 * in a PROMPT.md. `mapping` is empty when the file has no `## Steps` section.
 */
export interface StepSegmentParseResult {
	mapping: StepSegmentMapping[];
	/** True if at least one step had an explicit `#### Segment:` marker. */
	hasExplicitMarkers: boolean;
	warnings: DiscoveryError[];
	errors: DiscoveryError[];
}

/**
 * Parse `#### Segment: <repoId>` markers within `### Step N:` sections of a PROMPT.md.
 *
 * Builds a StepSegmentMapping[] that maps each step to its repo-scoped checkbox groups.
 *
 * Rules:
 * - Checkboxes before any segment header (or in steps with no segment headers)
 *   belong to the task's primary repoId (fallbackRepoId / packet repo).
 * - A repoId may appear at most once within a step (duplicate → error).
 * - Empty segments (header but no checkboxes) produce a warning.
 * - Unknown repoIds are flagged as warnings (validation deferred to routing).
 */
export function parseStepSegmentMapping(
	content: string,
	taskId: string,
	fallbackRepoId: string,
): StepSegmentParseResult {
	const mapping: StepSegmentMapping[] = [];
	const warnings: DiscoveryError[] = [];
	const errors: DiscoveryError[] = [];
	let hasExplicitMarkers = false;

	const stepsSectionMatch = content.match(/^##\s+Steps\s*$/im);
	if (!stepsSectionMatch || stepsSectionMatch.index === undefined) {
		return { mapping, hasExplicitMarkers, warnings, errors };
	}

	const stepsStart = stepsSectionMatch.index;
	const afterStepsHeader = content.indexOf("\n", stepsStart);
	if (afterStepsHeader === -1) {
		return { mapping, hasExplicitMarkers, warnings, errors };
	}
	const rest = content.slice(afterStepsHeader + 1);
	const nextSectionMatch = rest.search(/^##\s+[^#]|^---/m);
	const stepsBody = nextSectionMatch !== -1 ? rest.slice(0, nextSectionMatch) : rest;

	const stepHeaderRegex = /^###\s+Step\s+(\d+):\s*(.+)$/gm;
	const stepHeaders: { index: number; stepNumber: number; stepName: string }[] = [];
	let match: RegExpExecArray | null;
	match = stepHeaderRegex.exec(stepsBody);
	while (match !== null) {
		const numRaw = match[1];
		const nameRaw = match[2];
		if (numRaw && nameRaw) {
			stepHeaders.push({
				index: match.index,
				stepNumber: Number.parseInt(numRaw, 10),
				stepName: nameRaw.trim(),
			});
		}
		match = stepHeaderRegex.exec(stepsBody);
	}

	if (stepHeaders.length === 0) {
		return { mapping, hasExplicitMarkers, warnings, errors };
	}

	for (let i = 0; i < stepHeaders.length; i++) {
		const header = stepHeaders[i];
		if (!header) continue;
		const nextHeader = stepHeaders[i + 1];
		const nextHeaderIndex = nextHeader ? nextHeader.index : stepsBody.length;
		const stepContent = stepsBody.slice(header.index, nextHeaderIndex);

		const segmentHeaderRegex = /^####\s+Segment:\s*(.+)$/gm;
		const segmentHeaders: { index: number; repoId: string; rawRepoId: string }[] = [];
		let segMatch: RegExpExecArray | null;
		segMatch = segmentHeaderRegex.exec(stepContent);
		while (segMatch !== null) {
			const rawToken = segMatch[1];
			if (rawToken) {
				const rawRepoId = rawToken.trim();
				const repoId = normalizeSegmentRepoToken(rawRepoId);
				segmentHeaders.push({ index: segMatch.index, repoId, rawRepoId });
			}
			segMatch = segmentHeaderRegex.exec(stepContent);
		}

		const segments: { repoId: string; checkboxes: string[] }[] = [];

		if (segmentHeaders.length === 0) {
			const checkboxes = extractCheckboxes(stepContent);
			segments.push({ repoId: fallbackRepoId, checkboxes });
		} else {
			hasExplicitMarkers = true;
			const firstSeg = segmentHeaders[0];
			if (!firstSeg) continue;
			const preSegmentContent = stepContent.slice(0, firstSeg.index);
			const preCheckboxes = extractCheckboxes(preSegmentContent);
			if (preCheckboxes.length > 0) {
				segments.push({ repoId: fallbackRepoId, checkboxes: preCheckboxes });
			}

			const seenRepoIds = new Set<string>();
			if (preCheckboxes.length > 0 && fallbackRepoId !== SEGMENT_FALLBACK_REPO_PLACEHOLDER) {
				seenRepoIds.add(fallbackRepoId);
			}

			for (let j = 0; j < segmentHeaders.length; j++) {
				const seg = segmentHeaders[j];
				if (!seg) continue;

				if (!SEGMENT_REPO_ID_PATTERN.test(seg.repoId)) {
					warnings.push({
						code: "SEGMENT_STEP_REPO_INVALID",
						message:
							`Task ${taskId} Step ${header.stepNumber} has invalid segment repo ID "${seg.rawRepoId}". ` +
							"Repo IDs must match /^[a-z0-9][a-z0-9-]*$/.",
						taskId,
					});
				}

				if (seenRepoIds.has(seg.repoId)) {
					errors.push({
						code: "SEGMENT_STEP_DUPLICATE_REPO",
						message:
							`Task ${taskId} Step ${header.stepNumber} has duplicate segment repo ID "${seg.repoId}". ` +
							"A repoId may appear at most once within a step.",
						taskId,
					});
					continue;
				}
				seenRepoIds.add(seg.repoId);

				const nextSeg = segmentHeaders[j + 1];
				const nextSegIndex = nextSeg ? nextSeg.index : stepContent.length;
				const segContent = stepContent.slice(seg.index, nextSegIndex);
				const checkboxes = extractCheckboxes(segContent);

				if (checkboxes.length === 0) {
					warnings.push({
						code: "SEGMENT_STEP_EMPTY",
						message: `Task ${taskId} Step ${header.stepNumber} has empty segment "${seg.repoId}" with no checkboxes.`,
						taskId,
					});
				}

				segments.push({ repoId: seg.repoId, checkboxes });
			}
		}

		mapping.push({
			stepNumber: header.stepNumber,
			stepName: header.stepName,
			segments,
		});
	}

	return { mapping, hasExplicitMarkers, warnings, errors };
}

/**
 * Result of parsing a single PROMPT.md for orchestrator metadata. On fatal
 * failure, `task` is null and `error` describes the cause; on success, `task`
 * is populated and non-fatal issues (invalid segment repo IDs, empty segments)
 * surface in `warnings`.
 */
export interface ParsedPromptResult {
	task: ParsedTask | null;
	error: DiscoveryError | null;
	warnings?: DiscoveryError[];
}

/**
 * Parse a PROMPT.md file and extract orchestrator-relevant metadata.
 *
 * Required:
 *   - Task ID: from `# Task: XX-NNN - Name` heading OR folder name.
 *
 * Optional (defaults used if absent):
 *   - Review Level: 2
 *   - Size: "M"
 *   - Dependencies: []
 *   - File Scope: []
 *   - Task Name: folder name
 *   - Prompt-level repoId: from `## Execution Target` or `**Repo:**`/`**Workspace:**`
 *   - Explicit Segment DAG: from `## Segment DAG`
 *   - Step-segment mapping: from `#### Segment:` markers under `### Step N:`
 */
export function parsePromptForOrchestrator(
	promptPath: string,
	taskFolder: string,
	areaName: string,
): ParsedPromptResult {
	const folderName = basename(taskFolder);
	let content: string;

	try {
		content = readFileSync(promptPath, "utf-8");
	} catch {
		return {
			task: null,
			error: {
				code: "PARSE_MALFORMED",
				message: `Cannot read PROMPT.md: ${promptPath}`,
				taskPath: promptPath,
			},
		};
	}

	let taskId: string | null = null;
	let taskName = folderName;

	const headingMatch = content.match(/^#\s+Task:\s+([A-Z]+-\d+)\s*[-—]\s*(.+)$/m);
	if (headingMatch?.[1] && headingMatch[2]) {
		taskId = headingMatch[1];
		taskName = headingMatch[2].trim();
	}

	if (!taskId) {
		taskId = extractTaskIdFromFolderName(folderName);
	}

	if (!taskId) {
		return {
			task: null,
			error: {
				code: "PARSE_MISSING_ID",
				message: `Cannot extract task ID from heading or folder name "${folderName}" in ${promptPath}`,
				taskPath: promptPath,
			},
		};
	}

	let reviewLevel = 2;
	const reviewMatch = content.match(/^##\s+Review Level:\s*(\d+)/m);
	if (reviewMatch?.[1]) {
		reviewLevel = Number.parseInt(reviewMatch[1], 10);
	}

	let size = "M";
	const sizeMatch = content.match(/\*\*Size:\*\*\s*([SMLsml])/);
	if (sizeMatch?.[1]) {
		size = sizeMatch[1].toUpperCase();
	}

	const dependencies: string[] = [];
	const depSectionMatch = content.match(/^##\s+Dependencies\s*\n([\s\S]*?)(?=\n##\s|\n---|\n$)/m);
	if (depSectionMatch?.[1]) {
		const depBody = depSectionMatch[1].trim();
		if (!/\*?\*?None\*?\*?/i.test(depBody) && depBody.length > 0) {
			const labeledMatches = depBody.matchAll(/\*?\*?(?:Requires|Task):?\*?\*?\s*((?:[a-z0-9-]+\/)?[A-Z]+-\d+)/gi);
			for (const m of labeledMatches) {
				if (!m[1]) continue;
				const dep = normalizeDependencyReference(m[1]);
				if (!dependencies.includes(dep)) dependencies.push(dep);
			}

			const bulletMatches = depBody.matchAll(/^[\s-]*\*?\*?((?:[a-z0-9-]+\/)?[A-Z]+-\d+)\*?\*?/gim);
			for (const m of bulletMatches) {
				if (!m[1]) continue;
				const dep = normalizeDependencyReference(m[1]);
				if (!dependencies.includes(dep)) dependencies.push(dep);
			}

			if (dependencies.length === 0) {
				const inlineMatches = depBody.matchAll(/\b((?:[a-z0-9-]+\/)?[A-Z]+-\d+)\b/gi);
				for (const m of inlineMatches) {
					if (!m[1]) continue;
					const ref = parseDependencyReference(m[1]);
					if (ref.taskId === taskId) continue;
					const normalized = normalizeDependencyReference(m[1]);
					if (!dependencies.includes(normalized)) dependencies.push(normalized);
				}
			}
		}
	}

	const REPO_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
	let promptRepoId: string | undefined;

	const execTargetHeaderIdx = content.search(/^##\s+Execution Target\s*$/m);
	let execTargetSectionBody: string | null = null;
	if (execTargetHeaderIdx !== -1) {
		const afterHeader = content.indexOf("\n", execTargetHeaderIdx);
		if (afterHeader !== -1) {
			const rest = content.slice(afterHeader + 1);
			const nextSectionMatch = rest.search(/^##\s|^---/m);
			execTargetSectionBody = nextSectionMatch !== -1 ? rest.slice(0, nextSectionMatch) : rest;
		}
	}
	if (execTargetSectionBody !== null) {
		const repoLineMatch = execTargetSectionBody.match(/^\s*\*?\*?(?:Repo|Workspace):?\*?\*?\s+(\S+)/im);
		if (repoLineMatch?.[1]) {
			const candidate = repoLineMatch[1].trim().toLowerCase();
			if (REPO_ID_PATTERN.test(candidate)) promptRepoId = candidate;
		}
	}

	if (!promptRepoId) {
		const inlineRepoMatch = content.match(/^\*\*(?:Repo|Workspace):\*\*\s+(\S+)/m);
		if (inlineRepoMatch?.[1]) {
			const candidate = inlineRepoMatch[1].trim().toLowerCase();
			if (REPO_ID_PATTERN.test(candidate)) promptRepoId = candidate;
		}
	}

	const fileScope: string[] = [];
	const fileScopeMatch = content.match(/^##\s+File Scope\s*\n([\s\S]*?)(?=\n##\s|\n---|\n$)/m);
	if (fileScopeMatch?.[1]) {
		const scopeBody = fileScopeMatch[1].trim();
		for (const line of scopeBody.split("\n")) {
			let trimmed = line.replace(/^[\s\-*]+/, "").trim();
			if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
				trimmed = trimmed.slice(1, -1);
			}
			if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("```")) {
				fileScope.push(trimmed);
			}
		}
	}

	const segmentDagResult = parseSegmentDagMetadata(content, taskId, resolve(promptPath));
	if (segmentDagResult.error) {
		return { task: null, error: segmentDagResult.error };
	}
	const explicitSegmentDag = segmentDagResult.metadata;

	const segFallbackRepo = promptRepoId || SEGMENT_FALLBACK_REPO_PLACEHOLDER;
	const stepSegResult = parseStepSegmentMapping(content, taskId, segFallbackRepo);
	if (stepSegResult.errors.length > 0) {
		const firstErr = stepSegResult.errors[0];
		if (firstErr) return { task: null, error: firstErr };
	}
	const stepSegmentMap = stepSegResult.hasExplicitMarkers ? stepSegResult.mapping : undefined;

	const resolvedFolder = resolve(taskFolder);
	const resolvedPrompt = resolve(promptPath);

	return {
		task: {
			taskId,
			taskName,
			folderPath: resolvedFolder,
			taskFolder: resolvedFolder,
			promptPath: resolvedPrompt,
			prompt: content,
			dependencies,
			size,
			reviewLevel,
			fileScope,
			areaName,
			status: "pending",
			...(promptRepoId ? { promptRepoId } : {}),
			...(explicitSegmentDag ? { explicitSegmentDag } : {}),
			...(stepSegmentMap ? { stepSegmentMap } : {}),
		},
		error: null,
		warnings: stepSegResult.warnings,
	};
}

/**
 * Scan an area path for pending tasks.
 *
 * Lists immediate subdirectories only (no recursion). Skips `archive/` and
 * folders with `.DONE` markers. Each remaining subdirectory is parsed via
 * parsePromptForOrchestrator; fatal errors + non-fatal warnings are returned
 * together in `errors` for the caller to classify with FATAL_DISCOVERY_CODES.
 */
export function scanAreaForTasks(
	areaPath: string,
	areaName: string,
): { tasks: ParsedTask[]; errors: DiscoveryError[] } {
	const tasks: ParsedTask[] = [];
	const errors: DiscoveryError[] = [];

	const resolvedPath = resolve(areaPath);
	if (!existsSync(resolvedPath)) {
		errors.push({
			code: "SCAN_ERROR",
			message: `Area path does not exist: ${resolvedPath}`,
			taskPath: resolvedPath,
		});
		return { tasks, errors };
	}

	let entries: string[];
	try {
		entries = readdirSync(resolvedPath);
	} catch {
		errors.push({
			code: "SCAN_ERROR",
			message: `Cannot read area directory: ${resolvedPath}`,
			taskPath: resolvedPath,
		});
		return { tasks, errors };
	}

	for (const entry of entries) {
		if (entry.toLowerCase() === "archive") continue;

		const entryPath = join(resolvedPath, entry);

		try {
			if (!statSync(entryPath).isDirectory()) continue;
		} catch {
			continue;
		}

		if (existsSync(join(entryPath, ".DONE"))) continue;

		const promptPath = join(entryPath, "PROMPT.md");
		if (!existsSync(promptPath)) continue;

		const result = parsePromptForOrchestrator(promptPath, entryPath, areaName);
		if (result.error) errors.push(result.error);
		if (result.warnings) errors.push(...result.warnings);
		if (result.task) tasks.push(result.task);
	}

	return { tasks, errors };
}

/**
 * Build the set of completed task IDs by scanning archive subdirectories and
 * active folders across the provided area paths. Only folders with a `.DONE`
 * marker count as complete. Used by dependency resolution to avoid re-running
 * tasks whose work already shipped.
 */
export function buildCompletedTaskSet(areaPaths: string[]): Set<string> {
	const completed = new Set<string>();

	for (const areaPath of areaPaths) {
		const resolvedPath = resolve(areaPath);
		if (!existsSync(resolvedPath)) continue;

		let entries: string[];
		try {
			entries = readdirSync(resolvedPath);
		} catch {
			continue;
		}

		for (const entry of entries) {
			const entryPath = join(resolvedPath, entry);

			try {
				if (!statSync(entryPath).isDirectory()) continue;
			} catch {
				continue;
			}

			if (entry.toLowerCase() === "archive") {
				let archiveEntries: string[];
				try {
					archiveEntries = readdirSync(entryPath);
				} catch {
					continue;
				}
				for (const archiveEntry of archiveEntries) {
					const archiveFolderPath = join(entryPath, archiveEntry);
					try {
						if (!statSync(archiveFolderPath).isDirectory()) continue;
					} catch {
						continue;
					}
					if (!existsSync(join(archiveFolderPath, ".DONE"))) continue;
					const taskId = extractTaskIdFromFolderName(archiveEntry);
					if (taskId) completed.add(taskId);
				}
			} else if (existsSync(join(entryPath, ".DONE"))) {
				const taskId = extractTaskIdFromFolderName(entry);
				if (taskId) completed.add(taskId);
			}
		}
	}

	return completed;
}

/**
 * Resolve a raw discovery argument string into area scan paths, direct task
 * folders, and error entries. Accepts mixed tokens separated by whitespace:
 *   - "all" → every `task_areas` entry
 *   - Area name → resolves to its configured `path`
 *   - Path ending in `PROMPT.md` → dirname is treated as a direct task folder
 *   - Any other existing directory → treated as an area scan path
 *   - Anything else → UNKNOWN_ARG error, left for the caller to surface
 *
 * All returned paths are absolute (resolved against `cwd`). Duplicates are
 * deduplicated within `areaScanPaths`; direct task folders are not deduped
 * because callers may disambiguate via the folder's PROMPT.md content.
 */
export function resolveArguments(
	args: string,
	taskAreas: Record<string, TaskArea>,
	cwd: string,
): { areaScanPaths: string[]; directTaskFolders: string[]; errors: DiscoveryError[] } {
	const areaScanPaths: string[] = [];
	const directTaskFolders: string[] = [];
	const errors: DiscoveryError[] = [];

	const tokens = args.trim().split(/\s+/).filter(Boolean);

	for (const token of tokens) {
		if (token.toLowerCase() === "all") {
			for (const area of Object.values(taskAreas)) {
				const fullPath = resolve(cwd, area.path);
				if (!areaScanPaths.includes(fullPath)) areaScanPaths.push(fullPath);
			}
			continue;
		}

		const areaMatch = taskAreas[token];
		if (areaMatch) {
			const fullPath = resolve(cwd, areaMatch.path);
			if (!areaScanPaths.includes(fullPath)) areaScanPaths.push(fullPath);
			continue;
		}

		if (token.endsWith("PROMPT.md") && existsSync(resolve(cwd, token))) {
			directTaskFolders.push(resolve(cwd, dirname(token)));
			continue;
		}

		const candidate = resolve(cwd, token);
		if (existsSync(candidate)) {
			try {
				if (statSync(candidate).isDirectory()) {
					if (!areaScanPaths.includes(candidate)) areaScanPaths.push(candidate);
				} else {
					errors.push({
						code: "UNKNOWN_ARG",
						message: `Not a directory or PROMPT.md file: ${token}`,
					});
				}
			} catch {
				errors.push({ code: "UNKNOWN_ARG", message: `Cannot stat path: ${token}` });
			}
			continue;
		}

		errors.push({ code: "UNKNOWN_ARG", message: `Unknown area, path, or file: "${token}"` });
	}

	return { areaScanPaths, directTaskFolders, errors };
}

/**
 * Build the full task registry: pending tasks + completed set.
 *
 * Walks every `areaScanPaths` entry via {@link scanAreaForTasks} and every
 * `directTaskFolders` entry via {@link parsePromptForOrchestrator}, then
 * aggregates a global completed-task set across all configured `taskAreas`
 * (for cross-area dependency resolution).
 *
 * Enforces global uniqueness of task IDs. When two distinct locations yield
 * the same `taskId`, a single `DUPLICATE_ID` error is emitted listing every
 * offending location.
 */
export function buildTaskRegistry(
	areaScanPaths: string[],
	directTaskFolders: string[],
	taskAreas: Record<string, TaskArea>,
	cwd: string,
): DiscoveryResult {
	const pending = new Map<string, ParsedTask>();
	const errors: DiscoveryError[] = [];

	const idLocations = new Map<string, string[]>();
	function trackId(taskId: string, location: string): void {
		const existing = idLocations.get(taskId) ?? [];
		existing.push(location);
		idLocations.set(taskId, existing);
	}

	const areaNameByPath = new Map<string, string>();
	for (const [name, area] of Object.entries(taskAreas)) {
		areaNameByPath.set(resolve(cwd, area.path), name);
	}

	for (const areaPath of areaScanPaths) {
		const areaName = areaNameByPath.get(areaPath) ?? basename(areaPath);
		const result = scanAreaForTasks(areaPath, areaName);
		errors.push(...result.errors);
		for (const task of result.tasks) {
			trackId(task.taskId, task.promptPath);
			pending.set(task.taskId, task);
		}
	}

	for (const taskFolder of directTaskFolders) {
		const promptPath = join(taskFolder, "PROMPT.md");
		if (!existsSync(promptPath)) {
			errors.push({
				code: "SCAN_ERROR",
				message: `No PROMPT.md found in direct task folder: ${taskFolder}`,
				taskPath: taskFolder,
			});
			continue;
		}

		let areaName = "unknown";
		for (const [name, area] of Object.entries(taskAreas)) {
			const resolvedAreaPath = resolve(cwd, area.path);
			if (taskFolder.startsWith(resolvedAreaPath)) {
				areaName = name;
				break;
			}
		}

		if (existsSync(join(taskFolder, ".DONE"))) continue;

		const result = parsePromptForOrchestrator(promptPath, taskFolder, areaName);
		if (result.error) errors.push(result.error);
		if (result.warnings) errors.push(...result.warnings);
		if (result.task) {
			trackId(result.task.taskId, result.task.promptPath);
			pending.set(result.task.taskId, result.task);
		}
	}

	const completed = buildCompletedTaskSet(areaScanPaths);
	const allAreaPaths = Object.values(taskAreas).map(a => resolve(cwd, a.path));
	const globalCompleted = buildCompletedTaskSet(allAreaPaths);
	for (const id of globalCompleted) completed.add(id);

	for (const [taskId, locations] of idLocations) {
		if (locations.length > 1) {
			errors.push({
				code: "DUPLICATE_ID",
				message:
					`Duplicate task ID "${taskId}" found in ${locations.length} locations:\n` +
					locations.map(l => `  - ${l}`).join("\n"),
				taskId,
			});
		}
	}

	return { pending, completed, errors };
}

// ── Cross-Area Dependency Resolution ─────────────────────────────────

/** Candidate match for a dependency reference found in task areas. */
export interface DependencyCandidate {
	areaName: string;
	path: string;
	status: "pending" | "complete";
}

/**
 * Locate every task folder (active or archived) that could satisfy a given
 * `DependencyRef`, across all configured task areas. If the reference is
 * area-qualified, non-matching areas are skipped. Archived entries are
 * considered only when they carry a `.DONE` marker (matches taskplane
 * behavior).
 */
export function findDependencyCandidates(
	depRef: DependencyRef,
	taskAreas: Record<string, TaskArea>,
	cwd: string,
): DependencyCandidate[] {
	const candidates: DependencyCandidate[] = [];
	const sortedAreas = Object.entries(taskAreas).sort((a, b) => a[0].localeCompare(b[0]));

	for (const [areaName, area] of sortedAreas) {
		if (depRef.areaName && depRef.areaName !== areaName.toLowerCase()) continue;

		const areaPath = resolve(cwd, area.path);
		if (!existsSync(areaPath)) continue;

		let entries: string[];
		try {
			entries = readdirSync(areaPath);
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (entry.toLowerCase() === "archive") continue;
			const entryTaskId = extractTaskIdFromFolderName(entry);
			if (entryTaskId !== depRef.taskId) continue;

			const entryPath = join(areaPath, entry);
			try {
				if (!statSync(entryPath).isDirectory()) continue;
			} catch {
				continue;
			}

			candidates.push({
				areaName,
				path: entryPath,
				status: existsSync(join(entryPath, ".DONE")) ? "complete" : "pending",
			});
		}

		const archivePath = join(areaPath, "archive");
		if (!existsSync(archivePath)) continue;
		try {
			const archiveEntries = readdirSync(archivePath);
			for (const archiveEntry of archiveEntries) {
				const entryTaskId = extractTaskIdFromFolderName(archiveEntry);
				if (entryTaskId !== depRef.taskId) continue;

				const archiveTaskPath = join(archivePath, archiveEntry);
				candidates.push({
					areaName,
					path: archiveTaskPath,
					status: existsSync(join(archiveTaskPath, ".DONE")) ? "complete" : "pending",
				});
			}
		} catch {
			// Ignore archive read errors for discovery resilience
		}
	}

	return candidates;
}

/**
 * Resolve dependencies for all pending tasks in the registry. Mutates
 * `discovery.completed` when a dependency is found already done in the
 * filesystem (cross-area).
 *
 * Supports both dependency formats:
 *   - `TASK-ID` (unqualified)
 *   - `area-name/TASK-ID` (area-qualified)
 *
 * Returns a list of `DiscoveryError`s for unresolved, ambiguous, or
 * pending-in-another-area dependencies.
 */
export function resolveDependencies(
	discovery: DiscoveryResult,
	taskAreas: Record<string, TaskArea>,
	cwd: string,
): DiscoveryError[] {
	const errors: DiscoveryError[] = [];

	for (const [taskId, task] of discovery.pending) {
		for (const depRaw of task.dependencies) {
			const depRef = parseDependencyReference(depRaw);
			const depId = depRef.taskId;

			if (!depRef.areaName) {
				if (discovery.pending.has(depId)) continue;
				if (discovery.completed.has(depId)) continue;
			} else {
				const pendingTask = discovery.pending.get(depId);
				if (pendingTask?.areaName && pendingTask.areaName.toLowerCase() === depRef.areaName) continue;
			}

			const candidates = findDependencyCandidates(depRef, taskAreas, cwd);

			if (candidates.length === 0) {
				errors.push({
					code: "DEP_UNRESOLVED",
					message: `${taskId} depends on ${depRaw} which does not exist in any task area`,
					taskId,
					taskPath: task.promptPath,
				});
				continue;
			}

			if (!depRef.areaName && candidates.length > 1) {
				const options = candidates.map(c => `  - ${c.areaName}/${depId} [${c.status}] (${c.path})`).join("\n");
				errors.push({
					code: "DEP_AMBIGUOUS",
					message:
						`${taskId} depends on ${depId}, but multiple tasks match across areas. ` +
						`Use an area-qualified dependency (area/${depId}).\n${options}`,
					taskId,
					taskPath: task.promptPath,
				});
				continue;
			}

			if (depRef.areaName && candidates.length > 1) {
				const options = candidates.map(c => `  - ${c.areaName}/${depId} [${c.status}] (${c.path})`).join("\n");
				errors.push({
					code: "DEP_AMBIGUOUS",
					message:
						`${taskId} depends on ${depRaw}, but multiple matching task folders were found. ` +
						`Resolve duplicate task IDs.\n${options}`,
					taskId,
					taskPath: task.promptPath,
				});
				continue;
			}

			const match = candidates[0];
			if (!match) continue;
			if (match.status === "complete") {
				discovery.completed.add(depId);
				continue;
			}

			errors.push({
				code: "DEP_PENDING",
				message:
					`${taskId} depends on ${depRaw} which is pending in "${match.areaName}". ` +
					`Include that area: /mission ${match.areaName}`,
				taskId,
				taskPath: task.promptPath,
			});
		}
	}

	return errors;
}

// ── Task-to-Repo Routing ─────────────────────────────────────────────

/** Repo ID validation: lowercase alphanumeric + hyphens, starting with alnum */
const ROUTING_REPO_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Simple suggestion helper: find known repo IDs that share a prefix or
 * have 3-char overlap with the unknown repo ID. Private — used only by
 * resolveTaskRouting for SEGMENT_STEP_REPO_INVALID hints.
 */
function suggestRepoMatches(unknown: string, known: string[]): string[] {
	const suggestions: string[] = [];
	for (const k of known) {
		if (k.startsWith(unknown) || unknown.startsWith(k)) {
			suggestions.push(k);
			continue;
		}
		const shorter = unknown.length < k.length ? unknown : k;
		const longer = unknown.length < k.length ? k : unknown;
		if (shorter.length >= 3 && longer.includes(shorter.slice(0, 3))) {
			suggestions.push(k);
		}
	}
	return suggestions;
}

/**
 * Resolve the target repo for each discovered task using the routing
 * precedence chain:
 *
 *   1. `task.promptRepoId` — declared in PROMPT.md metadata
 *   2. `taskArea.repoId` — area-level config
 *   3. `task.fileScope` — majority vote over file path prefixes
 *   4. `workspaceConfig.routing.defaultRepo` — workspace-level default
 *
 * Only applied in workspace mode (when `workspaceConfig` is provided).
 * In repo mode this function is never called.
 *
 * Side effects: mutates `task.resolvedRepoId` and, when a step-segment
 * map is present, replaces `SEGMENT_FALLBACK_REPO_PLACEHOLDER` segments
 * with the resolved primary repo.
 *
 * Returns DiscoveryErrors for routing failures:
 *   - `SEGMENT_REPO_UNKNOWN`, `TASK_ROUTING_STRICT`,
 *   - `TASK_REPO_UNRESOLVED`, `TASK_REPO_UNKNOWN`,
 *   - `SEGMENT_STEP_REPO_INVALID`.
 */
export function resolveTaskRouting(
	discovery: DiscoveryResult,
	taskAreas: Record<string, TaskArea>,
	workspaceConfig: WorkspaceConfig,
): DiscoveryError[] {
	const errors: DiscoveryError[] = [];
	const validRepoIds = workspaceConfig.repos;
	const strictMode = workspaceConfig.routing.strict === true;

	for (const task of discovery.pending.values()) {
		if (task.explicitSegmentDag) {
			const unknownRepos = task.explicitSegmentDag.repoIds.filter(r => !validRepoIds.has(r));
			if (unknownRepos.length > 0) {
				errors.push({
					code: "SEGMENT_REPO_UNKNOWN",
					message:
						`Task ${task.taskId} declares unknown repo ID(s) in ## Segment DAG: ${unknownRepos.join(", ")}. ` +
						`Known repos: ${[...validRepoIds.keys()].join(", ")}`,
					taskId: task.taskId,
					taskPath: task.promptPath,
				});
				continue;
			}
		}

		if (strictMode && !task.promptRepoId) {
			errors.push({
				code: "TASK_ROUTING_STRICT",
				message:
					`Task ${task.taskId} has no explicit execution target, but strict routing is enabled ` +
					`(routing.strict: true in workspace config). ` +
					`Add an execution target to the task's PROMPT.md:\n` +
					`\n` +
					`  ## Execution Target\n` +
					`\n` +
					`  Repo: <repo-id>\n` +
					`\n` +
					`Available repos: ${[...validRepoIds.keys()].join(", ")}`,
				taskId: task.taskId,
				taskPath: task.promptPath,
			});
			continue;
		}

		let resolvedId: string | undefined = task.promptRepoId;
		let source = "prompt";

		if (!resolvedId && task.areaName) {
			const area = taskAreas[task.areaName];
			if (area?.repoId) {
				const candidate = area.repoId.trim().toLowerCase();
				if (ROUTING_REPO_ID_PATTERN.test(candidate)) {
					resolvedId = candidate;
					source = "area";
				}
			}
		}

		if (!resolvedId && task.fileScope && task.fileScope.length > 0) {
			const repoIds = [...validRepoIds.keys()];
			const repoCounts = new Map<string, number>();
			for (const filePath of task.fileScope) {
				const normalized = filePath.replace(/\\/g, "/");
				for (const repoId of repoIds) {
					if (normalized.startsWith(`${repoId}/`) || normalized === repoId) {
						repoCounts.set(repoId, (repoCounts.get(repoId) ?? 0) + 1);
						break;
					}
				}
			}
			if (repoCounts.size === 1) {
				const firstKey = repoCounts.keys().next().value;
				if (firstKey) {
					resolvedId = firstKey;
					source = "file-scope";
				}
			} else if (repoCounts.size > 1) {
				let maxCount = 0;
				for (const [repoId, count] of repoCounts) {
					if (count > maxCount) {
						maxCount = count;
						resolvedId = repoId;
					}
				}
				source = "file-scope";
			}
		}

		if (!resolvedId) {
			resolvedId = workspaceConfig.routing.defaultRepo;
			source = "default";
		}

		if (!resolvedId) {
			errors.push({
				code: "TASK_REPO_UNRESOLVED",
				message:
					`Task ${task.taskId} has no resolved repo. ` +
					`Add file scope paths prefixed with the repo name (e.g., "web-client/src/..."), ` +
					`set repo_id on area "${task.areaName ?? "?"}", ` +
					`or set routing.default_repo in the workspace config.`,
				taskId: task.taskId,
				taskPath: task.promptPath,
			});
			continue;
		}

		if (!validRepoIds.has(resolvedId)) {
			errors.push({
				code: "TASK_REPO_UNKNOWN",
				message:
					`Task ${task.taskId} resolved to repo "${resolvedId}" (via ${source}), ` +
					`but no repo with that ID exists in the workspace config. ` +
					`Known repos: ${[...validRepoIds.keys()].join(", ")}`,
				taskId: task.taskId,
				taskPath: task.promptPath,
			});
			continue;
		}

		task.resolvedRepoId = resolvedId;

		if (task.stepSegmentMap) {
			const knownRepoList = [...validRepoIds.keys()].join(", ");
			for (const step of task.stepSegmentMap) {
				for (const seg of step.segments) {
					if (seg.repoId === SEGMENT_FALLBACK_REPO_PLACEHOLDER) {
						seg.repoId = resolvedId;
						continue;
					}
					if (!validRepoIds.has(seg.repoId)) {
						const knownRepos = [...validRepoIds.keys()];
						const suggestions = suggestRepoMatches(seg.repoId, knownRepos);
						const suggestionHint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
						errors.push({
							code: "SEGMENT_STEP_REPO_INVALID",
							message:
								`Task ${task.taskId} Step ${step.stepNumber} has segment repo "${seg.repoId}" ` +
								`which is not in the workspace config. Known repos: ${knownRepoList}.${suggestionHint}`,
							taskId: task.taskId,
							taskPath: task.promptPath,
						});
					}
				}
			}
		}
	}

	return errors;
}

// ── Discovery Pipeline (Public) ──────────────────────────────────────

/**
 * Run the full discovery pipeline:
 *   1. Resolve arguments to scan paths and direct task folders
 *   2. Build task registry (scan, parse, dedupe)
 *   3. Apply optional dependency cache + fall-back source
 *   4. Resolve cross-area dependencies
 *   5. Persist dependency cache (when enabled)
 *   6. Resolve task-to-repo routing (workspace mode only)
 *   7. Final duplicate-segment check after placeholder resolution
 *
 * Returns a DiscoveryResult bundling pending tasks, the completed set,
 * and every collected error/warning from the stages above.
 */
export function runDiscovery(
	args: string,
	taskAreas: Record<string, TaskArea>,
	cwd: string,
	options: DiscoveryOptions = {},
): DiscoveryResult {
	const dependencySource = options.dependencySource ?? "prompt";
	const useDependencyCache = options.useDependencyCache ?? false;
	const refreshDependencies = options.refreshDependencies ?? false;

	const resolved = resolveArguments(args, taskAreas, cwd);
	if (resolved.errors.length > 0) {
		return { pending: new Map(), completed: new Set(), errors: resolved.errors };
	}

	if (resolved.areaScanPaths.length === 0 && resolved.directTaskFolders.length === 0) {
		return {
			pending: new Map(),
			completed: new Set(),
			errors: [{ code: "UNKNOWN_ARG", message: "No valid areas, paths, or PROMPT.md files found in arguments" }],
		};
	}

	const discovery = buildTaskRegistry(resolved.areaScanPaths, resolved.directTaskFolders, taskAreas, cwd);

	const duplicateErrors = discovery.errors.filter(e => e.code === "DUPLICATE_ID");
	if (duplicateErrors.length > 0) return discovery;

	let effectiveDependencySource: "prompt" | "agent" = dependencySource;
	if (useDependencyCache && !refreshDependencies) {
		const { applied } = applyDependenciesFromCache(discovery, resolved.areaScanPaths);
		if (dependencySource === "agent" && !applied) {
			effectiveDependencySource = "prompt";
			discovery.errors.push({
				code: "DEP_SOURCE_FALLBACK",
				message:
					"dependencies.source=agent requested, but no dependency cache was found for " +
					"the selected areas. Falling back to PROMPT.md dependencies.",
			});
		}
	} else if (dependencySource === "agent") {
		effectiveDependencySource = "prompt";
		discovery.errors.push({
			code: "DEP_SOURCE_FALLBACK",
			message:
				"dependencies.source=agent requested, but agent-based dependency analysis " +
				"is not implemented. Falling back to PROMPT.md dependencies.",
		});
	}

	const depErrors = resolveDependencies(discovery, taskAreas, cwd);
	discovery.errors.push(...depErrors);

	if (useDependencyCache) {
		for (const areaPath of resolved.areaScanPaths) {
			writeAreaDependencyCache(areaPath, discovery.pending, effectiveDependencySource);
		}
	}

	const workspaceConfig = options.workspaceConfig;
	if (workspaceConfig && workspaceConfig.mode === "workspace") {
		const routingErrors = resolveTaskRouting(discovery, taskAreas, workspaceConfig);
		discovery.errors.push(...routingErrors);
	} else {
		for (const task of discovery.pending.values()) {
			if (!task.stepSegmentMap) continue;
			for (const step of task.stepSegmentMap) {
				for (const seg of step.segments) {
					if (seg.repoId === SEGMENT_FALLBACK_REPO_PLACEHOLDER) {
						seg.repoId = "default";
					}
				}
			}
		}
	}

	for (const task of discovery.pending.values()) {
		if (!task.stepSegmentMap) continue;
		for (const step of task.stepSegmentMap) {
			const stepRepoIds = step.segments.map(s => s.repoId);
			const seen = new Set<string>();
			for (const rid of stepRepoIds) {
				if (seen.has(rid)) {
					discovery.errors.push({
						code: "SEGMENT_STEP_DUPLICATE_REPO",
						message:
							`Task ${task.taskId} Step ${step.stepNumber} has duplicate segment repo ID "${rid}" ` +
							`(after resolving primary repo fallback). A repoId may appear at most once within a step.`,
						taskId: task.taskId,
						taskPath: task.promptPath,
					});
					break;
				}
				seen.add(rid);
			}
		}
	}

	return discovery;
}
