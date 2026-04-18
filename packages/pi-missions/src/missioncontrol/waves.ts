/**
 * Wave scheduling — pure functions that assign tasks to waves, plus scope
 * + lane ID helpers and per-repo base-branch resolution.
 *
 * Ported from taskplane's 1548-LOC `waves.ts`. This module ships:
 *   - MVP round-robin wave chunking (chunkIntoWaves, nextWaveIndex, tasksRemaining)
 *   - File-scope helpers (normalize/isGlob/prefix/pathStartsWithSegment/
 *     scopesOverlap/taskScopesOverlap)
 *   - Dependency graph + Kahn's wave computation + cycle detection
 *     (buildDependencyGraph, validateGraph, computeWaves)
 *   - File-scope affinity Union-Find (applyFileScopeAffinity)
 *   - Segment planning (inferTaskRepoOrder, buildSegmentPlanForTask,
 *     buildTaskSegmentPlans)
 *   - Lane assignment within a wave (assignTasksToLanes)
 *   - Global lane cap enforcement across repos (enforceGlobalLaneCap)
 *   - Allocation input validation (validateAllocationInputs)
 *   - Full pure wave pipeline (computeWaveAssignments)
 *   - Repo grouping (groupTasksByRepo + RepoTaskGroup)
 *   - Lane ID generators (generateLaneId / generateLaneSessionId)
 *   - Base-branch resolution (resolveRepoRoot / resolveBaseBranch)
 *   - Full lane allocation I/O wrapper (allocateLanes + AllocateLanesResult)
 */

import type { WaveAssignment } from "../types";
import { type ParsedTask, parseDependencyReference } from "./discovery";
import { getCurrentBranch, runGit } from "./git";
import { resolveOperatorId } from "./naming";
import {
	type AllocatedLane,
	type AllocatedTask,
	AllocationError,
	type AllocationErrorCode,
	buildSegmentId,
	type DependencyGraph,
	type DiscoveryError,
	type GraphValidationResult,
	getTaskDurationMinutes,
	type LaneAssignment,
	type OrchestratorConfig,
	type RuntimeWaveAssignment,
	type TaskSegmentEdge,
	type TaskSegmentNode,
	type TaskSegmentPlan,
	type TaskSegmentPlanMap,
	type WaveComputationResult,
	type WorkspaceConfig,
	type WorktreeInfo,
} from "./types";
import { ensureLaneWorktrees, removeAllWorktrees, removeWorktree } from "./worktree";

// ── MVP wave chunking ───────────────────────────────────────────────────────

/**
 * Split a list of task IDs into waves of at most `waveSize`.
 *
 * Tasks within a wave run in parallel on up to `laneCount` lanes. Waves run
 * sequentially. If `laneCount < waveSize` the runtime fills idle lanes from
 * the next queued wave — handled in the engine, not here.
 */
export function chunkIntoWaves(taskIds: string[], waveSize: number): WaveAssignment[] {
	if (waveSize <= 0) return [];
	const waves: WaveAssignment[] = [];
	for (let i = 0; i < taskIds.length; i += waveSize) {
		waves.push({
			wave: waves.length,
			taskIds: taskIds.slice(i, i + waveSize),
		});
	}
	return waves;
}

export function nextWaveIndex(current: number, waves: WaveAssignment[]): number | null {
	const next = current + 1;
	return next < waves.length ? next : null;
}

export function tasksRemaining(waves: WaveAssignment[], completedIds: ReadonlySet<string>): number {
	let remaining = 0;
	for (const w of waves) {
		for (const id of w.taskIds) {
			if (!completedIds.has(id)) remaining++;
		}
	}
	return remaining;
}

// ── File-scope helpers ──────────────────────────────────────────────────────

export function normalizeScope(scope: string): string {
	return scope.replace(/\\/g, "/").trim().replace(/\/+/g, "/").replace(/\/$/, "");
}

export function isGlobScope(scope: string): boolean {
	return scope.includes("*");
}

export function prefixOfGlob(scope: string): string {
	const idx = scope.indexOf("*");
	if (idx < 0) return scope;
	return scope.slice(0, idx).replace(/\/$/, "");
}

export function pathStartsWithSegment(pathValue: string, prefix: string): boolean {
	if (!prefix) return true;
	return pathValue === prefix || pathValue.startsWith(`${prefix}/`);
}

export function scopesOverlap(aRaw: string, bRaw: string): boolean {
	const a = normalizeScope(aRaw);
	const b = normalizeScope(bRaw);
	if (!a || !b) return false;
	if (a === b) return true;

	const aGlob = isGlobScope(a);
	const bGlob = isGlobScope(b);

	// file vs file (no wildcards): overlap only on exact match
	if (!aGlob && !bGlob) return false;

	if (aGlob && !bGlob) return pathStartsWithSegment(b, prefixOfGlob(a));
	if (!aGlob && bGlob) return pathStartsWithSegment(a, prefixOfGlob(b));

	// glob vs glob: overlap if either prefix contains the other
	const aPrefix = prefixOfGlob(a);
	const bPrefix = prefixOfGlob(b);
	return pathStartsWithSegment(aPrefix, bPrefix) || pathStartsWithSegment(bPrefix, aPrefix);
}

export function taskScopesOverlap(taskA: ParsedTask, taskB: ParsedTask): boolean {
	const aScopes = taskA.fileScope ?? [];
	const bScopes = taskB.fileScope ?? [];
	if (aScopes.length === 0 || bScopes.length === 0) return false;
	for (const scopeA of aScopes) {
		for (const scopeB of bScopes) {
			if (scopesOverlap(scopeA, scopeB)) return true;
		}
	}
	return false;
}

// ── Dependency graph construction ───────────────────────────────────────────

/**
 * Build a dependency graph from the pending task registry.
 *
 * `ParsedTask.dependencies` is the source of truth. Completed tasks are not
 * graph nodes — they contribute 0 in-degree to their dependents during wave
 * computation (pre-satisfied). Edges only connect pending→pending.
 */
export function buildDependencyGraph(pending: Map<string, ParsedTask>, _completed: Set<string>): DependencyGraph {
	const dependencies = new Map<string, string[]>();
	const dependents = new Map<string, string[]>();
	const nodes = new Set<string>();

	for (const taskId of pending.keys()) {
		nodes.add(taskId);
		dependencies.set(taskId, []);
		dependents.set(taskId, []);
	}

	for (const [taskId, task] of pending) {
		const edgeSet = new Set<string>();
		for (const depRaw of task.dependencies) {
			const depId = parseDependencyReference(depRaw).taskId;
			if (edgeSet.has(depId)) continue;
			edgeSet.add(depId);
			if (pending.has(depId)) {
				dependencies.get(taskId)?.push(depId);
				dependents.get(depId)?.push(taskId);
			}
		}
	}

	return { dependencies, dependents, nodes };
}

// ── Graph validation ────────────────────────────────────────────────────────

/**
 * Validate a dependency graph for correctness.
 *
 * Checks: self-edges, duplicate dependency targets, unresolved targets
 * (not pending + not completed), and cycles (DFS with full cycle path).
 * Returns all errors (does not early-exit).
 */
export function validateGraph(
	graph: DependencyGraph,
	pending: Map<string, ParsedTask>,
	completed: Set<string>,
): GraphValidationResult {
	const errors: DiscoveryError[] = [];

	for (const [taskId, task] of pending) {
		for (const depRaw of task.dependencies) {
			const depId = parseDependencyReference(depRaw).taskId;
			if (depId === taskId) {
				errors.push({
					code: "DEP_UNRESOLVED",
					message: `${taskId} has a self-dependency (depends on itself)`,
					taskId,
					taskPath: task.promptPath,
				});
			}
		}
	}

	for (const [taskId, task] of pending) {
		const seenTargets = new Set<string>();
		for (const depRaw of task.dependencies) {
			const depId = parseDependencyReference(depRaw).taskId;
			if (seenTargets.has(depId)) {
				errors.push({
					code: "DEP_UNRESOLVED",
					message: `${taskId} lists duplicate dependency targeting ${depId}`,
					taskId,
					taskPath: task.promptPath,
				});
			}
			seenTargets.add(depId);
		}
	}

	for (const [taskId, task] of pending) {
		for (const depRaw of task.dependencies) {
			const depId = parseDependencyReference(depRaw).taskId;
			if (!pending.has(depId) && !completed.has(depId)) {
				errors.push({
					code: "DEP_UNRESOLVED",
					message: `${taskId} depends on ${depRaw} which is neither pending nor completed`,
					taskId,
					taskPath: task.promptPath,
				});
			}
		}
	}

	const visited = new Set<string>();
	const inStack = new Set<string>();

	function dfs(node: string): string[] | null {
		if (inStack.has(node)) {
			return [node];
		}
		if (visited.has(node)) return null;

		visited.add(node);
		inStack.add(node);

		const deps = graph.dependencies.get(node) ?? [];
		const sortedDeps = [...deps].sort();

		for (const dep of sortedDeps) {
			const cyclePath = dfs(dep);
			if (cyclePath) {
				if (cyclePath.length === 1 || cyclePath[0] !== cyclePath[cyclePath.length - 1]) {
					cyclePath.push(node);
				}
				return cyclePath;
			}
		}

		inStack.delete(node);
		return null;
	}

	const sortedNodes = [...graph.nodes].sort();
	for (const node of sortedNodes) {
		if (!visited.has(node)) {
			const cyclePath = dfs(node);
			if (cyclePath) {
				cyclePath.reverse();
				const cycleStr = cyclePath.join(" → ");
				errors.push({
					code: "DEP_UNRESOLVED",
					message: `Circular dependency detected: ${cycleStr}`,
				});
				break;
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

// ── Wave computation (Kahn's topological sort) ──────────────────────────────

/**
 * Compute execution waves via Kahn's algorithm.
 *
 * Wave 1: pending tasks with 0 in-degree (no unmet pending deps).
 * Wave N+1: tasks whose deps are all placed in waves 1..N or pre-satisfied.
 * Within each wave, task IDs are sorted alphabetically for determinism.
 * Cycle detection: if no zero-in-degree nodes remain, emits DEP_UNRESOLVED.
 */
export function computeWaves(
	graph: DependencyGraph,
	_completed: Set<string>,
	_pending: Map<string, ParsedTask>,
): { waves: string[][]; errors: DiscoveryError[] } {
	const errors: DiscoveryError[] = [];
	const waves: string[][] = [];

	const inDegree = new Map<string, number>();
	for (const node of graph.nodes) {
		const deps = graph.dependencies.get(node) ?? [];
		const pendingDeps = deps.filter(d => graph.nodes.has(d));
		inDegree.set(node, pendingDeps.length);
	}

	const remaining = new Set(graph.nodes);

	while (remaining.size > 0) {
		const waveNodes: string[] = [];
		for (const node of remaining) {
			if ((inDegree.get(node) ?? 0) === 0) {
				waveNodes.push(node);
			}
		}

		waveNodes.sort();

		if (waveNodes.length === 0) {
			const stuckNodes = [...remaining].sort().join(", ");
			errors.push({
				code: "DEP_UNRESOLVED",
				message: `Cannot schedule remaining tasks (possible cycle): ${stuckNodes}`,
			});
			break;
		}

		waves.push(waveNodes);

		for (const node of waveNodes) {
			remaining.delete(node);
			const dependents = graph.dependents.get(node) ?? [];
			for (const dependent of dependents) {
				const current = inDegree.get(dependent) ?? 0;
				inDegree.set(dependent, current - 1);
			}
		}
	}

	return { waves, errors };
}

// ── File-scope affinity grouping ────────────────────────────────────────────

/**
 * Group tasks with overlapping file scopes into affinity groups via
 * Union-Find over the scope-overlap graph. Tasks in the same group should
 * be routed to the same lane to serialize file-writing conflicts.
 *
 * Empty file scopes produce no edges (each task is its own group). Transitive
 * overlaps are preserved: A~B and B~C places A,B,C in one group. Groups are
 * sorted by their first (sorted) task ID for deterministic output.
 */
export function applyFileScopeAffinity(waveTasks: string[], pending: Map<string, ParsedTask>): string[][] {
	if (waveTasks.length === 0) return [];

	const parent = new Map<string, string>();
	const rank = new Map<string, number>();

	for (const taskId of waveTasks) {
		parent.set(taskId, taskId);
		rank.set(taskId, 0);
	}

	function find(x: string): string {
		let cur = x;
		while (parent.get(cur) !== cur) {
			const grandparent = parent.get(parent.get(cur) ?? cur);
			if (grandparent) parent.set(cur, grandparent);
			cur = parent.get(cur) ?? cur;
		}
		return cur;
	}

	function union(a: string, b: string): void {
		const ra = find(a);
		const rb = find(b);
		if (ra === rb) return;
		const rankA = rank.get(ra) ?? 0;
		const rankB = rank.get(rb) ?? 0;
		if (rankA < rankB) {
			parent.set(ra, rb);
		} else if (rankA > rankB) {
			parent.set(rb, ra);
		} else {
			parent.set(rb, ra);
			rank.set(ra, rankA + 1);
		}
	}

	for (let i = 0; i < waveTasks.length; i++) {
		for (let j = i + 1; j < waveTasks.length; j++) {
			const idA = waveTasks[i];
			const idB = waveTasks[j];
			if (!idA || !idB) continue;
			const taskA = pending.get(idA);
			const taskB = pending.get(idB);
			if (!taskA || !taskB) continue;
			if (taskScopesOverlap(taskA, taskB)) {
				union(taskA.taskId, taskB.taskId);
			}
		}
	}

	const groups = new Map<string, string[]>();
	for (const taskId of waveTasks) {
		const root = find(taskId);
		const group = groups.get(root) ?? [];
		group.push(taskId);
		groups.set(root, group);
	}

	const result: string[][] = [];
	for (const group of groups.values()) {
		group.sort();
		result.push(group);
	}
	result.sort((a, b) => {
		const aHead = a[0] ?? "";
		const bHead = b[0] ?? "";
		return aHead.localeCompare(bHead);
	});

	return result;
}

// ── Segment planning (TP-080) ───────────────────────────────────────────────

const SEGMENT_REPO_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const INFERRED_LINEAR_REASON = "inferred:first-appearance-linear-chain";

function normalizeRepoIdCandidate(raw: string): string | null {
	const candidate = raw.trim().toLowerCase();
	if (!SEGMENT_REPO_ID_PATTERN.test(candidate)) return null;
	return candidate;
}

export interface SegmentPlanBuildOptions {
	/** Optional workspace repo IDs used to validate file-scope repo prefixes. */
	workspaceRepoIds?: Iterable<string>;
}

function collectKnownRepoIds(pending: Map<string, ParsedTask>, workspaceRepoIds?: Iterable<string>): Set<string> {
	const known = new Set<string>();

	if (workspaceRepoIds) {
		for (const repoIdRaw of workspaceRepoIds) {
			const repoId = normalizeRepoIdCandidate(String(repoIdRaw));
			if (repoId) known.add(repoId);
		}
	}

	for (const task of pending.values()) {
		if (task.resolvedRepoId) {
			const repoId = normalizeRepoIdCandidate(task.resolvedRepoId);
			if (repoId) known.add(repoId);
		}
		if (task.explicitSegmentDag) {
			for (const repoIdRaw of task.explicitSegmentDag.repoIds) {
				const repoId = normalizeRepoIdCandidate(repoIdRaw);
				if (repoId) known.add(repoId);
			}
		}
	}
	return known;
}

function extractRepoPrefixFromFileScope(fileScopeEntry: string): string | null {
	const normalized = fileScopeEntry.replace(/\\/g, "/").trim();
	if (!normalized) return null;
	const firstSegment = normalized.split("/")[0]?.trim();
	if (!firstSegment) return null;
	return normalizeRepoIdCandidate(firstSegment);
}

export interface InferredRepoOrder {
	repoIds: string[];
	usedFallback: boolean;
}

/**
 * Build deterministic repo ordering for inferred segment plans.
 *
 * Signal precedence:
 *   1) file scope repo prefixes (first appearance)
 *   2) dependency task repos (first appearance)
 *   3) fallback to `resolvedRepoId`, then synthetic `default`
 */
export function inferTaskRepoOrder(
	task: ParsedTask,
	pending: Map<string, ParsedTask>,
	knownRepoIds: Set<string>,
): InferredRepoOrder {
	const firstAppearance = new Map<string, number>();
	let cursor = 0;

	function record(repoIdRaw: string, requireKnown = false): string | null {
		const repoId = normalizeRepoIdCandidate(repoIdRaw);
		if (!repoId) return null;
		if (requireKnown && knownRepoIds.size > 0 && !knownRepoIds.has(repoId)) return null;
		if (!firstAppearance.has(repoId)) {
			firstAppearance.set(repoId, cursor++);
		}
		return repoId;
	}

	let hasPrimarySignal = false;

	const fileScope = task.fileScope ?? [];
	for (const scopeEntry of fileScope) {
		if (knownRepoIds.size === 0) {
			// Repo-mode guard: without known workspace repo IDs, fileScope
			// prefixes like "src/" or "lib/" are ambiguous and should not
			// create synthetic segments.
			continue;
		}
		const repoId = extractRepoPrefixFromFileScope(scopeEntry);
		if (!repoId) continue;
		if (record(repoId, true) !== null) {
			hasPrimarySignal = true;
		}
	}

	for (const depRaw of task.dependencies) {
		const depId = parseDependencyReference(depRaw).taskId;
		const depTask = pending.get(depId);
		if (depTask?.resolvedRepoId && record(depTask.resolvedRepoId, true) !== null) {
			hasPrimarySignal = true;
		}
	}

	if (!hasPrimarySignal) {
		const fallback = normalizeRepoIdCandidate(task.resolvedRepoId ?? "") || "default";
		return {
			repoIds: [fallback],
			usedFallback: true,
		};
	}

	if (task.resolvedRepoId) {
		record(task.resolvedRepoId, true);
	}

	const repoIds = [...firstAppearance.entries()]
		.sort((a, b) => {
			if (a[1] !== b[1]) return a[1] - b[1];
			return a[0].localeCompare(b[0]);
		})
		.map(([repoId]) => repoId);

	return {
		repoIds,
		usedFallback: false,
	};
}

function sortSegmentEdges(edges: TaskSegmentEdge[]): TaskSegmentEdge[] {
	return [...edges].sort((a, b) => {
		if (a.fromSegmentId !== b.fromSegmentId) {
			return a.fromSegmentId.localeCompare(b.fromSegmentId);
		}
		return a.toSegmentId.localeCompare(b.toSegmentId);
	});
}

function buildSegmentNodes(taskId: string, repoIds: string[]): TaskSegmentNode[] {
	const nodes: TaskSegmentNode[] = repoIds.map((repoId, order) => ({
		segmentId: buildSegmentId(taskId, repoId),
		taskId,
		repoId,
		order,
	}));
	return nodes.sort((a, b) => a.order - b.order || a.repoId.localeCompare(b.repoId));
}

/**
 * Build the segment plan for a single task.
 *
 * Explicit DAG wins: if `task.explicitSegmentDag` is populated, use its
 * `repoIds` + `edges` verbatim (mode `explicit-dag`). Otherwise, fall back
 * to `inferTaskRepoOrder` for a deterministic linear chain (mode
 * `inferred-sequential`) or a singleton (mode `repo-singleton`) when no
 * primary signal is available.
 */
export function buildSegmentPlanForTask(
	task: ParsedTask,
	pending: Map<string, ParsedTask>,
	knownRepoIds: Set<string>,
): TaskSegmentPlan {
	if (task.explicitSegmentDag) {
		const repoIds = [...task.explicitSegmentDag.repoIds];
		const segments = buildSegmentNodes(task.taskId, repoIds);
		const edges = sortSegmentEdges(
			task.explicitSegmentDag.edges.map(edge => ({
				fromSegmentId: buildSegmentId(task.taskId, edge.fromRepoId),
				toSegmentId: buildSegmentId(task.taskId, edge.toRepoId),
				provenance: "explicit" as const,
				reason: "prompt:segment-dag",
			})),
		);
		return {
			taskId: task.taskId,
			segments,
			edges,
			mode: "explicit-dag",
		};
	}

	const inferred = inferTaskRepoOrder(task, pending, knownRepoIds);
	const segments = buildSegmentNodes(task.taskId, inferred.repoIds);
	const edges = sortSegmentEdges(
		segments.slice(0, -1).map((segment, idx) => {
			const next = segments[idx + 1];
			return {
				fromSegmentId: segment.segmentId,
				toSegmentId: next?.segmentId ?? segment.segmentId,
				provenance: "inferred" as const,
				reason: INFERRED_LINEAR_REASON,
			};
		}),
	);

	return {
		taskId: task.taskId,
		segments,
		edges,
		mode: inferred.usedFallback ? "repo-singleton" : "inferred-sequential",
	};
}

/** Build a deterministic `taskId→segmentPlan` map for the whole pending set. */
export function buildTaskSegmentPlans(
	pending: Map<string, ParsedTask>,
	options: SegmentPlanBuildOptions = {},
): TaskSegmentPlanMap {
	const knownRepoIds = collectKnownRepoIds(pending, options.workspaceRepoIds);
	const plans: TaskSegmentPlanMap = new Map();
	for (const taskId of [...pending.keys()].sort()) {
		const task = pending.get(taskId);
		if (!task) continue;
		plans.set(taskId, buildSegmentPlanForTask(task, pending, knownRepoIds));
	}
	return plans;
}

// ── Lane assignment ─────────────────────────────────────────────────────────

/**
 * Assign tasks within a wave to lanes.
 *
 * Strategies:
 *   - `"round-robin"`: sequential modulo assignment across lanes.
 *   - `"load-balanced"`: sort groups heaviest-first, place each on the lightest lane.
 *   - default (affinity-first): multi-task groups go first (heaviest-first,
 *     load-balanced), then singletons fill remaining capacity.
 *
 * Affinity groups come from `applyFileScopeAffinity`. Lane count = min(group
 * count, maxLanes). Lane numbers are 1-indexed. Tie-breaks are alphabetical on
 * the first task ID within a group, so output is deterministic.
 */
export function assignTasksToLanes(
	waveTasks: string[],
	pending: Map<string, ParsedTask>,
	maxLanes: number,
	strategy: string,
	sizeWeights: Record<string, number>,
): LaneAssignment[] {
	if (waveTasks.length === 0) return [];

	const affinityGroups = applyFileScopeAffinity(waveTasks, pending);
	const laneCount = Math.min(affinityGroups.length, maxLanes);
	if (laneCount <= 0) return [];

	const laneWeights: number[] = new Array(laneCount).fill(0);
	const laneAssignments: LaneAssignment[][] = Array.from({ length: laneCount }, () => []);

	function getWeight(taskId: string): number {
		const task = pending.get(taskId);
		const fallback = sizeWeights.M ?? 2;
		if (!task) return fallback;
		return sizeWeights[task.size] ?? fallback;
	}

	function groupWeight(group: string[]): number {
		return group.reduce((sum, id) => sum + getWeight(id), 0);
	}

	function assignGroupToLane(group: string[], laneIndex: number): void {
		const bucket = laneAssignments[laneIndex];
		if (!bucket) return;
		for (const taskId of group) {
			const task = pending.get(taskId);
			if (!task) continue;
			bucket.push({
				taskId,
				lane: laneIndex + 1,
				task,
			});
			laneWeights[laneIndex] = (laneWeights[laneIndex] ?? 0) + getWeight(taskId);
		}
	}

	function findLightestLane(): number {
		let minIdx = 0;
		let minWeight = laneWeights[0] ?? 0;
		for (let i = 1; i < laneCount; i++) {
			const weight = laneWeights[i] ?? 0;
			if (weight < minWeight) {
				minWeight = weight;
				minIdx = i;
			}
		}
		return minIdx;
	}

	if (strategy === "round-robin") {
		for (let i = 0; i < affinityGroups.length; i++) {
			const group = affinityGroups[i];
			if (!group) continue;
			assignGroupToLane(group, i % laneCount);
		}
	} else if (strategy === "load-balanced") {
		const sortedGroups = [...affinityGroups].sort((a, b) => {
			const weightA = groupWeight(a);
			const weightB = groupWeight(b);
			if (weightB !== weightA) return weightB - weightA;
			return (a[0] ?? "").localeCompare(b[0] ?? "");
		});
		for (const group of sortedGroups) {
			assignGroupToLane(group, findLightestLane());
		}
	} else {
		// affinity-first: multi-task groups first, then singletons
		const multiGroups = affinityGroups.filter(g => g.length > 1);
		const singleGroups = affinityGroups.filter(g => g.length === 1);

		const sortedMulti = [...multiGroups].sort((a, b) => {
			const weightA = groupWeight(a);
			const weightB = groupWeight(b);
			if (weightB !== weightA) return weightB - weightA;
			return (a[0] ?? "").localeCompare(b[0] ?? "");
		});
		for (const group of sortedMulti) {
			assignGroupToLane(group, findLightestLane());
		}

		const sortedSingles = [...singleGroups].sort((a, b) => {
			const weightA = getWeight(a[0] ?? "");
			const weightB = getWeight(b[0] ?? "");
			if (weightB !== weightA) return weightB - weightA;
			return (a[0] ?? "").localeCompare(b[0] ?? "");
		});
		for (const group of sortedSingles) {
			assignGroupToLane(group, findLightestLane());
		}
	}

	const result: LaneAssignment[] = [];
	for (const assignments of laneAssignments) {
		result.push(...assignments);
	}
	return result;
}

// ── Global lane cap (TP-148) ────────────────────────────────────────────────

/**
 * A single globally-numbered lane entry that wraps per-repo lane assignments.
 * `globalLane` is the 1-indexed lane number across the whole batch; `localLane`
 * is 1-indexed within the lane's repo group.
 */
export interface GlobalLaneEntry {
	globalLane: number;
	localLane: number;
	repoId: string | undefined;
	assignments: LaneAssignment[];
}

/**
 * Enforce a global lane cap across all repo groups.
 *
 * In workspace mode each repo independently allocates up to `maxLanes`. This
 * function reduces the total across all repos to fit within the global
 * `maxLanes` budget by consolidating lanes in the largest repo first.
 *
 * Algorithm:
 *   1. If total lanes ≤ maxLanes, no-op.
 *   2. Group entries by repoId.
 *   3. Iteratively drop the last lane from the repo with the most lanes
 *      (tie-broken alphabetically by repoId). Its assignments merge into the
 *      first lane of the same repo.
 *   4. Stop when excess drained or every repo is down to 1 lane.
 *   5. Emit a warning if cap can't be fully enforced (repo count > maxLanes).
 *   6. Rebuild `entries` with sequential globalLane numbers, sorted by repoId.
 *
 * Mutates `entries` in place.
 */
export function enforceGlobalLaneCap(entries: GlobalLaneEntry[], maxLanes: number): void {
	if (entries.length <= maxLanes) return;

	const byRepo = new Map<string, GlobalLaneEntry[]>();
	for (const entry of entries) {
		const key = entry.repoId ?? "";
		const group = byRepo.get(key) ?? [];
		group.push(entry);
		byRepo.set(key, group);
	}

	let excess = entries.length - maxLanes;

	while (excess > 0) {
		let bestKey = "";
		let bestCount = 0;
		for (const [key, group] of byRepo) {
			if (group.length > bestCount || (group.length === bestCount && key < bestKey)) {
				bestKey = key;
				bestCount = group.length;
			}
		}

		if (bestCount <= 1) break;

		const group = byRepo.get(bestKey);
		if (!group || group.length === 0) break;
		const removed = group.pop();
		if (!removed) break;
		const target = group[0];
		if (!target) break;
		target.assignments.push(...removed.assignments);
		excess--;
	}

	const finalTotal = [...byRepo.values()].reduce((sum, g) => sum + g.length, 0);
	if (finalTotal > maxLanes) {
		console.error(
			`[missioncontrol] warning: global maxLanes=${maxLanes} could not be enforced — ` +
				`${byRepo.size} repos each need at least 1 lane (total: ${finalTotal}). ` +
				`Increase maxLanes to at least ${byRepo.size} to avoid this.`,
		);
	}

	entries.length = 0;
	let globalLane = 1;
	for (const key of [...byRepo.keys()].sort()) {
		const group = byRepo.get(key);
		if (!group) continue;
		for (const entry of group) {
			entry.globalLane = globalLane++;
			entries.push(entry);
		}
	}
}

// ── Allocation input validation ─────────────────────────────────────────────

const VALID_ASSIGNMENT_STRATEGIES = ["affinity-first", "round-robin", "load-balanced"] as const;

/**
 * Preflight validation for `allocateLanes` inputs.
 *
 * Checks:
 *   - `max_lanes` is a positive integer
 *   - `waveTasks` is non-empty
 *   - every task ID in the wave exists in `pending`
 *   - `assignment.strategy` is one of the recognised strategy names
 *   - `worktree_prefix` is a non-empty string
 *
 * Returns `null` when all inputs are valid; otherwise an `AllocationError`
 * describing the first failure.
 */
export function validateAllocationInputs(
	waveTasks: string[],
	pending: Map<string, ParsedTask>,
	config: OrchestratorConfig,
): AllocationError | null {
	const maxLanes = config.orchestrator.max_lanes;
	if (!maxLanes || maxLanes < 1 || !Number.isInteger(maxLanes)) {
		return new AllocationError("ALLOC_INVALID_CONFIG", `max_lanes must be a positive integer, got: ${maxLanes}`);
	}

	if (!waveTasks || waveTasks.length === 0) {
		return new AllocationError("ALLOC_EMPTY_WAVE", "Cannot allocate lanes for an empty wave (no tasks provided)");
	}

	const missingTasks: string[] = [];
	for (const taskId of waveTasks) {
		if (!pending.has(taskId)) missingTasks.push(taskId);
	}
	if (missingTasks.length > 0) {
		return new AllocationError(
			"ALLOC_TASK_NOT_FOUND",
			`Task IDs not found in pending map: ${missingTasks.join(", ")}`,
			`These tasks may have been completed or removed between discovery and allocation.`,
		);
	}

	const strategy = config.assignment.strategy;
	if (!VALID_ASSIGNMENT_STRATEGIES.includes(strategy)) {
		return new AllocationError(
			"ALLOC_INVALID_CONFIG",
			`Unknown assignment strategy: "${strategy}". Valid strategies: ${VALID_ASSIGNMENT_STRATEGIES.join(", ")}`,
		);
	}

	if (!config.orchestrator.worktree_prefix?.trim()) {
		return new AllocationError("ALLOC_INVALID_CONFIG", "worktree_prefix must be a non-empty string");
	}

	return null;
}

// ── Full pure wave pipeline ─────────────────────────────────────────────────

export interface WaveComputationOptions {
	/** Optional workspace repo IDs used by segment inference in workspace mode. */
	workspaceRepoIds?: Iterable<string>;
}

/**
 * Run the full pure wave computation pipeline.
 *
 * Stages:
 *   1. Build the dependency graph from `pending` (completed = pre-satisfied).
 *   2. Validate the graph. On any validation failure, return early with errors.
 *   3. Topologically sort into waves via Kahn's algorithm.
 *   4. Build segment plans (additive metadata).
 *   5. For each wave, assign tasks to lanes via `assignTasksToLanes`.
 *
 * No I/O — no worktree creation, no git calls. The caller (allocateLanes) is
 * responsible for provisioning worktrees and turning the pure wave assignment
 * into AllocatedLane records.
 */
export function computeWaveAssignments(
	pending: Map<string, ParsedTask>,
	completed: Set<string>,
	config: OrchestratorConfig,
	options: WaveComputationOptions = {},
): WaveComputationResult {
	const errors: DiscoveryError[] = [];

	const graph = buildDependencyGraph(pending, completed);

	const validation = validateGraph(graph, pending, completed);
	if (!validation.valid) {
		return { waves: [], errors: validation.errors };
	}

	const { waves: rawWaves, errors: waveErrors } = computeWaves(graph, completed, pending);
	if (waveErrors.length > 0) {
		return { waves: [], errors: waveErrors };
	}

	const segmentPlans = buildTaskSegmentPlans(pending, {
		workspaceRepoIds: options.workspaceRepoIds,
	});

	const waveAssignments: RuntimeWaveAssignment[] = [];
	for (let i = 0; i < rawWaves.length; i++) {
		const waveTasks = rawWaves[i] ?? [];
		const laneAssignments = assignTasksToLanes(
			waveTasks,
			pending,
			config.orchestrator.max_lanes,
			config.assignment.strategy,
			config.assignment.size_weights,
		);
		waveAssignments.push({
			waveNumber: i + 1,
			tasks: laneAssignments,
		});
	}

	return { waves: waveAssignments, errors, segmentPlans };
}

// ── Repo grouping ───────────────────────────────────────────────────────────

/**
 * A group of tasks targeting the same repository.
 *
 * In repo mode: all tasks are in one group with `repoId` undefined.
 * In workspace mode: tasks are grouped by `resolvedRepoId`.
 */
export interface RepoTaskGroup {
	/** Repo ID (undefined for repo mode / tasks without resolvedRepoId) */
	repoId: string | undefined;
	/** Task IDs in this group (sorted alphabetically) */
	taskIds: string[];
}

/**
 * Group wave tasks by their resolved repo ID.
 *
 * Deterministic ordering:
 * 1. Groups sorted by repoId (undefined sorts first as "").
 * 2. Task IDs within each group sorted alphabetically.
 */
export function groupTasksByRepo(waveTasks: string[], pending: Map<string, ParsedTask>): RepoTaskGroup[] {
	const groupMap = new Map<string, string[]>();
	for (const taskId of waveTasks) {
		const task = pending.get(taskId);
		const key = task?.resolvedRepoId ?? "";
		const existing = groupMap.get(key) ?? [];
		existing.push(taskId);
		groupMap.set(key, existing);
	}

	const groups: RepoTaskGroup[] = [];
	const sortedKeys = [...groupMap.keys()].sort();
	for (const key of sortedKeys) {
		const taskIds = [...(groupMap.get(key) ?? [])].sort();
		groups.push({ repoId: key || undefined, taskIds });
	}
	return groups;
}

// ── Lane ID helpers ─────────────────────────────────────────────────────────

/**
 * Generate a lane identifier string.
 *
 * - Repo mode (repoId undefined): `"lane-{N}"`
 * - Workspace mode (repoId set): `"{repoId}/lane-{N}"`
 */
export function generateLaneId(laneLocalNumber: number, repoId?: string): string {
	return repoId ? `${repoId}/lane-${laneLocalNumber}` : `lane-${laneLocalNumber}`;
}

/**
 * Generate a lane session identifier for a lane.
 *
 * Includes the operator identifier (`opId`) for collision resistance across
 * concurrent operators on the same machine.
 *
 * - Repo mode: `"{prefix}-{opId}-lane-{N}"`
 * - Workspace mode: `"{prefix}-{opId}-{repoId}-lane-{N}"`
 */
export function generateLaneSessionId(
	sessionPrefix: string,
	laneLocalNumber: number,
	opId: string,
	repoId?: string,
): string {
	return repoId
		? `${sessionPrefix}-${opId}-${repoId}-lane-${laneLocalNumber}`
		: `${sessionPrefix}-${opId}-lane-${laneLocalNumber}`;
}

// ── Per-repo root + base branch resolution ──────────────────────────────────

/**
 * Resolve the repo root path for a given repo group.
 *
 * - Repo mode (repoId undefined): returns `defaultRepoRoot`.
 * - Workspace mode: looks up `workspaceConfig.repos.get(repoId).path`.
 *   Falls back to `defaultRepoRoot` if repoId is not found (defensive).
 */
export function resolveRepoRoot(
	repoId: string | undefined,
	defaultRepoRoot: string,
	workspaceConfig?: WorkspaceConfig | null,
): string {
	if (!repoId || !workspaceConfig) return defaultRepoRoot;
	const repoConfig = workspaceConfig.repos.get(repoId);
	if (!repoConfig) return defaultRepoRoot;
	return repoConfig.path;
}

/**
 * Resolve the base branch for worktree creation in a given repo.
 *
 * Fallback chain:
 * 0. If `batchBaseBranch` is an `orch/...` branch and exists in this repo,
 *    use it so worktrees inherit merged work from prior waves.
 * 1. Detected current branch via `getCurrentBranch(repoRoot)` (workspace mode).
 * 2. `WorkspaceRepoConfig.defaultBranch` (workspace mode fallback).
 * 3. `batchBaseBranch` (ultimate fallback; throws if it's an orch branch
 *    that doesn't exist in this repo).
 */
export function resolveBaseBranch(
	repoId: string | undefined,
	repoRoot: string,
	batchBaseBranch: string,
	workspaceConfig?: WorkspaceConfig | null,
): string {
	// Step 0: orch-branch short-circuit so wave 2+ worktrees see prior wave code.
	if (batchBaseBranch.startsWith("orch/") && repoId) {
		try {
			const check = runGit(["rev-parse", "--verify", `refs/heads/${batchBaseBranch}`], repoRoot);
			if (check.ok) return batchBaseBranch;
			console.error(
				`[missioncontrol] resolveBaseBranch WARNING: orch branch "${batchBaseBranch}" not found in repo "${repoId}" at ${repoRoot} — falling back to repo HEAD. ` +
					`This bypasses orch branch isolation. Ensure the orch branch was created in all workspace repos.`,
			);
		} catch (err) {
			console.error(
				`[missioncontrol] resolveBaseBranch WARNING: orch branch check failed for repo "${repoId}" at ${repoRoot}: ${err}`,
			);
		}
	}

	// Step 1: detect current branch of this specific repo.
	if (repoId) {
		const detected = getCurrentBranch(repoRoot);
		if (detected) return detected;
	}

	// Step 2: per-repo default branch from workspace config.
	if (repoId && workspaceConfig) {
		const repoConfig = workspaceConfig.repos.get(repoId);
		if (repoConfig?.defaultBranch) return repoConfig.defaultBranch;
	}

	// Step 3: orch-branch fallback fail-fast in workspace mode.
	if (repoId && batchBaseBranch.startsWith("orch/")) {
		throw new Error(
			`Cannot resolve base branch for repo "${repoId}" at ${repoRoot}: ` +
				`HEAD is detached and no defaultBranch is configured. ` +
				`The batch base branch "${batchBaseBranch}" is an orch branch that does not exist in this repo. ` +
				`Configure a defaultBranch for this repo in mission.json workspace settings.`,
		);
	}

	return batchBaseBranch;
}

// ── Full lane allocation pipeline (I/O wrapper) ─────────────────────────────

export interface AllocateLanesResult {
	/** Whether all lanes were allocated successfully */
	success: boolean;
	/** Allocated lanes, sorted by laneNumber. Empty on failure. */
	lanes: AllocatedLane[];
	/** Number of lanes allocated */
	laneCount: number;
	/** Error details (null on success) */
	error: {
		code: AllocationErrorCode;
		message: string;
		details?: string;
	} | null;
	/** Whether partial worktrees were rolled back on failure */
	rolledBack: boolean;
	/** Batch ID used for branch/session naming */
	batchId: string;
}

/**
 * Allocate lanes for a wave — end-to-end I/O wrapper over the pure pipeline.
 *
 * Ported from taskplane/waves.ts:1206. Stages:
 *   0. validateAllocationInputs (pure)
 *   1. groupTasksByRepo (pure)
 *   2. assignTasksToLanes per-repo + enforceGlobalLaneCap (pure)
 *   3. ensureLaneWorktrees per-repo group with cross-repo rollback (I/O)
 *   4. Build AllocatedLane[] from assignments + worktrees (pure)
 *
 * Cross-repo rollback: if any group's worktree creation fails, every
 * already-created worktree in prior groups is removed best-effort.
 */
export function allocateLanes(
	waveTasks: string[],
	pending: Map<string, ParsedTask>,
	config: OrchestratorConfig,
	repoRoot: string,
	batchId: string,
	baseBranch: string,
	workspaceConfig?: WorkspaceConfig | null,
): AllocateLanesResult {
	// ── Stage 0: Input validation ────────────────────────────────
	const validationError = validateAllocationInputs(waveTasks, pending, config);
	if (validationError) {
		return {
			success: false,
			lanes: [],
			laneCount: 0,
			error: {
				code: validationError.code,
				message: validationError.message,
				details: validationError.details,
			},
			rolledBack: false,
			batchId,
		};
	}

	// ── Stage 1: Group tasks by repo ─────────────────────────────
	const repoGroups = groupTasksByRepo(waveTasks, pending);

	// ── Stage 2: Per-repo affinity grouping + strategy assignment ─
	const globalLaneEntries: Array<{
		globalLane: number;
		localLane: number;
		repoId: string | undefined;
		assignments: LaneAssignment[];
	}> = [];

	let globalLaneOffset = 0;

	for (const group of repoGroups) {
		const groupAssignments = assignTasksToLanes(
			group.taskIds,
			pending,
			config.orchestrator.max_lanes,
			config.assignment.strategy,
			config.assignment.size_weights,
		);

		const localLaneNumbers = new Set(groupAssignments.map(a => a.lane));
		const sortedLocalLanes = [...localLaneNumbers].sort((a, b) => a - b);

		const localToGlobal = new Map<number, number>();
		for (let i = 0; i < sortedLocalLanes.length; i++) {
			const local = sortedLocalLanes[i];
			if (local === undefined) continue;
			localToGlobal.set(local, globalLaneOffset + i + 1);
		}

		const byLocalLane = new Map<number, LaneAssignment[]>();
		for (const a of groupAssignments) {
			const existing = byLocalLane.get(a.lane) || [];
			existing.push(a);
			byLocalLane.set(a.lane, existing);
		}

		for (const localLane of sortedLocalLanes) {
			const globalLane = localToGlobal.get(localLane);
			if (globalLane === undefined) continue;
			globalLaneEntries.push({
				globalLane,
				localLane,
				repoId: group.repoId,
				assignments: byLocalLane.get(localLane) || [],
			});
		}

		globalLaneOffset += sortedLocalLanes.length;
	}

	// ── Stage 2b: Enforce global lane cap ────────────────────────
	enforceGlobalLaneCap(globalLaneEntries, config.orchestrator.max_lanes);

	const laneCount = globalLaneEntries.length;

	if (laneCount === 0) {
		return {
			success: false,
			lanes: [],
			laneCount: 0,
			error: {
				code: "ALLOC_EMPTY_WAVE",
				message: "Lane assignment produced zero lanes (no tasks could be assigned)",
			},
			rolledBack: false,
			batchId,
		};
	}

	// ── Stage 3: Ensure lane worktrees exist per repo group ──────
	const repoLaneGroups = new Map<string, number[]>();
	const repoIdForGroup = new Map<string, string | undefined>();
	for (const entry of globalLaneEntries) {
		const key = entry.repoId ?? "";
		const existing = repoLaneGroups.get(key) || [];
		existing.push(entry.globalLane);
		repoLaneGroups.set(key, existing);
		repoIdForGroup.set(key, entry.repoId);
	}
	const sortedGroupKeys = [...repoLaneGroups.keys()].sort();

	const allWorktrees = new Map<number, WorktreeInfo>();
	const createdGroupKeys: string[] = [];

	for (const groupKey of sortedGroupKeys) {
		const groupLaneNumbers = repoLaneGroups.get(groupKey);
		if (!groupLaneNumbers) continue;
		const groupRepoId = repoIdForGroup.get(groupKey);
		const groupRepoRoot = resolveRepoRoot(groupRepoId, repoRoot, workspaceConfig);
		const groupBaseBranch = resolveBaseBranch(groupRepoId, groupRepoRoot, baseBranch, workspaceConfig);

		const worktreeResult = ensureLaneWorktrees(groupLaneNumbers, batchId, config, groupRepoRoot, groupBaseBranch);

		if (!worktreeResult.success) {
			// Cross-repo rollback: remove worktrees from all previously-succeeded groups
			const rollbackErrors: string[] = [];
			for (const prevKey of createdGroupKeys) {
				const prevRepoId = repoIdForGroup.get(prevKey);
				const prevRepoRoot = resolveRepoRoot(prevRepoId, repoRoot, workspaceConfig);
				const prevLanes = repoLaneGroups.get(prevKey) ?? [];
				for (const lane of prevLanes) {
					const wt = allWorktrees.get(lane);
					if (wt) {
						try {
							removeWorktree(wt, prevRepoRoot);
						} catch (rbErr: unknown) {
							rollbackErrors.push(
								`Lane ${lane} (repo ${prevRepoId ?? "default"}): ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`,
							);
						}
					}
				}
			}

			const failedLanes = worktreeResult.errors
				.map(e => `Lane ${e.laneNumber}: [${e.code}] ${e.message}`)
				.join("\n");
			const withinGroupRollbackIssues =
				worktreeResult.rollbackErrors.length > 0
					? "\nWithin-group rollback issues:\n" +
						worktreeResult.rollbackErrors.map(e => `  Lane ${e.laneNumber}: [${e.code}] ${e.message}`).join("\n")
					: "";
			const crossRepoRollbackIssues =
				rollbackErrors.length > 0
					? `\nCross-repo rollback issues:\n${rollbackErrors.map(e => `  ${e}`).join("\n")}`
					: "";

			return {
				success: false,
				lanes: [],
				laneCount: 0,
				error: {
					code: "ALLOC_WORKTREE_FAILED",
					message: `Failed to create worktrees for repo "${groupRepoId ?? "default"}" (${groupLaneNumbers.length} lane(s))`,
					details: failedLanes + withinGroupRollbackIssues + crossRepoRollbackIssues,
				},
				rolledBack: true,
				batchId,
			};
		}

		for (const wt of worktreeResult.worktrees) {
			allWorktrees.set(wt.laneNumber, wt);
		}
		createdGroupKeys.push(groupKey);
	}

	// ── Stage 4: Build AllocatedLane[] from assignments + worktrees ─
	const sessionPrefix = config.orchestrator.sessionPrefix || "orch";
	const opId = resolveOperatorId(config.orchestrator.operator_id);
	const strategy = config.assignment.strategy as AllocatedLane["strategy"];
	const sizeWeights = config.assignment.size_weights;

	const allocatedLanes: AllocatedLane[] = [];

	for (const entry of globalLaneEntries) {
		const wt = allWorktrees.get(entry.globalLane);
		if (!wt) {
			// Defensive — should never happen if ensureLaneWorktrees and assignTasksToLanes agree.
			for (const groupKey of createdGroupKeys) {
				const groupRepoId = repoIdForGroup.get(groupKey);
				const groupRepoRoot = resolveRepoRoot(groupRepoId, repoRoot, workspaceConfig);
				removeAllWorktrees(config.orchestrator.worktree_prefix, groupRepoRoot, opId, undefined, batchId, config);
			}
			return {
				success: false,
				lanes: [],
				laneCount: 0,
				error: {
					code: "ALLOC_WORKTREE_FAILED",
					message: `No worktree found for lane ${entry.globalLane} — lane count mismatch between assignment and worktree creation`,
				},
				rolledBack: true,
				batchId,
			};
		}

		const allocatedTasks: AllocatedTask[] = entry.assignments.map((a, idx) => ({
			taskId: a.taskId,
			order: idx,
			task: a.task,
			estimatedMinutes: getTaskDurationMinutes(a.task.size, sizeWeights),
		}));

		const estimatedLoad = allocatedTasks.reduce(
			(sum, t) => sum + (sizeWeights[t.task.size] || sizeWeights.M || 2),
			0,
		);
		const estimatedMinutes = allocatedTasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);

		const laneSessionId = generateLaneSessionId(sessionPrefix, entry.localLane, opId, entry.repoId);
		allocatedLanes.push({
			laneNumber: entry.globalLane,
			laneId: generateLaneId(entry.localLane, entry.repoId),
			laneSessionId,
			worktreePath: wt.path,
			branch: wt.branch,
			tasks: allocatedTasks,
			strategy,
			estimatedLoad,
			estimatedMinutes,
			repoId: entry.repoId,
		});
	}

	allocatedLanes.sort((a, b) => a.laneNumber - b.laneNumber);

	return {
		success: true,
		lanes: allocatedLanes,
		laneCount: allocatedLanes.length,
		error: null,
		rolledBack: false,
		batchId,
	};
}
