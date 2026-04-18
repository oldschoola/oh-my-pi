/**
 * Pure helpers for dynamic segment-expansion request handling.
 *
 * Ported piecemeal from taskplane's `engine.ts`. This module grows as each
 * validation / mutation / persistence helper for runtime segment expansion
 * lands; it stays free of I/O and pi-framework deps so its logic remains
 * unit-testable in isolation.
 */

import type { ParsedTask } from "./discovery";
import { execLog } from "./log";
import {
	buildSegmentId,
	type MissionBatchRuntimeState,
	type PendingSegmentExpansionRequest,
	type PersistedSegmentRecord,
	type SegmentExpansionRequest,
	type SegmentFrontierTaskState,
	type TaskSegmentNode,
	type WorkspaceConfig,
} from "./types";

/**
 * Return true when the requested expansion edges form a cycle within the
 * subgraph restricted to `requestedRepoIds`. Edges referencing repos outside
 * the request are ignored (validated elsewhere).
 *
 * Implementation: Kahn's algorithm — count in-degree over the restricted
 * edge set, repeatedly remove zero-in-degree nodes, and compare the number
 * of visited nodes to the unique repo count. A mismatch means at least one
 * node remained indegree>0 for the entire traversal, i.e. a cycle exists.
 */
export function expansionRequestHasCycle(request: SegmentExpansionRequest): boolean {
	const requestedRepoIds = [...new Set(request.requestedRepoIds)];
	const indegree = new Map<string, number>();
	const outgoing = new Map<string, string[]>();
	for (const repoId of requestedRepoIds) {
		indegree.set(repoId, 0);
		outgoing.set(repoId, []);
	}
	for (const edge of request.edges) {
		if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
		outgoing.get(edge.from)!.push(edge.to);
		indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
	}

	const ready = [...requestedRepoIds]
		.filter(repoId => (indegree.get(repoId) ?? 0) === 0)
		.sort((a, b) => a.localeCompare(b));
	let visited = 0;
	while (ready.length > 0) {
		const next = ready.shift()!;
		visited += 1;
		for (const dep of outgoing.get(next) ?? []) {
			const count = (indegree.get(dep) ?? 0) - 1;
			indegree.set(dep, count);
			if (count === 0) {
				ready.push(dep);
				ready.sort((a, b) => a.localeCompare(b));
			}
		}
	}

	return visited !== requestedRepoIds.length;
}

/**
 * Validate a pending expansion request against the current task's segment
 * frontier state at a segment boundary. Returns `null` when the request is
 * accepted or a short English reason string when rejected. The function is
 * pure — no state is mutated and nothing is written to disk.
 *
 * Checks (in order, first failure wins):
 * 1. Request's `taskId` + `fromSegmentId` match the active boundary.
 * 2. Task has not reached a terminal status.
 * 3. Placement is either `"after-current"` or `"end"`.
 * 4. `requestId` has not been processed previously.
 * 5. In workspace mode every `requestedRepoId` must be a known workspace repo;
 *    in repo (non-workspace) mode only `"default"` is permitted.
 * 6. No duplicate `requestedRepoIds`.
 * 7. Every `edge.from` / `edge.to` refers to a repo in `requestedRepoIds`, the
 *    anchor segment's repo, or a completed segment's repo (TP-145).
 * 8. The expansion edges do not form a cycle.
 */
export function validateSegmentExpansionRequestAtBoundary(
	requestFile: PendingSegmentExpansionRequest,
	taskId: string,
	segmentId: string,
	segmentState: SegmentFrontierTaskState,
	workspaceConfig: WorkspaceConfig | null | undefined,
	knownRequestIds: ReadonlySet<string>,
): string | null {
	const request = requestFile.request;
	if (request.taskId !== taskId || request.fromSegmentId !== segmentId) {
		return "request does not match the active segment boundary";
	}
	if (segmentState.terminalStatus !== "pending") {
		return "task is already in terminal state";
	}
	if (request.placement !== "after-current" && request.placement !== "end") {
		return `unsupported placement "${request.placement}"`;
	}

	if (knownRequestIds.has(request.requestId)) {
		return `requestId "${request.requestId}" already processed`;
	}

	if (workspaceConfig) {
		for (const repoId of request.requestedRepoIds) {
			if (!workspaceConfig.repos.has(repoId)) {
				return `unknown repoId "${repoId}"`;
			}
		}
	} else {
		for (const repoId of request.requestedRepoIds) {
			if (repoId !== "default") {
				return `repo expansion requires workspace mode (unknown repoId "${repoId}")`;
			}
		}
	}

	const requestedRepoSet = new Set(request.requestedRepoIds);
	if (requestedRepoSet.size !== request.requestedRepoIds.length) {
		return "duplicate repoIds in requestedRepoIds";
	}

	// TP-145: edges may reference the anchor segment's repo and any
	// already-completed segments' repos in addition to requestedRepoIds.
	const knownEdgeRepoIds = new Set(requestedRepoSet);
	const orderedSegments = segmentState.orderedSegments ?? [];
	const anchorSegment = orderedSegments.find(seg => seg.segmentId === segmentId);
	if (anchorSegment) {
		knownEdgeRepoIds.add(anchorSegment.repoId);
	}
	for (const seg of orderedSegments) {
		const status = segmentState.statusBySegmentId?.get(seg.segmentId);
		if (status === "succeeded" || status === "failed" || status === "skipped") {
			knownEdgeRepoIds.add(seg.repoId);
		}
	}

	for (const edge of request.edges) {
		if (!knownEdgeRepoIds.has(edge.from) || !knownEdgeRepoIds.has(edge.to)) {
			return "edge references a repo outside requestedRepoIds and known segments";
		}
	}

	if (expansionRequestHasCycle(request)) {
		return "expansion request introduces a cycle in requested edges";
	}

	return null;
}

/**
 * Validate + acknowledge a pending expansion request at a segment boundary.
 *
 * Side effects (only on success):
 * - Adds `requestFile.request.requestId` to `knownRequestIds` (mutates input).
 * - Emits a single `execLog` entry recording the handoff.
 *
 * On validation failure returns `{ok: false, reason}` without mutation. The
 * graph-mutation step (`applySegmentExpansionMutation`) is invoked separately
 * by the caller so the mutation remains isolated and testable.
 */
export function processSegmentExpansionRequestAtBoundary(
	batchId: string,
	taskId: string,
	segmentId: string,
	agentId: string,
	requestFile: PendingSegmentExpansionRequest,
	segmentState: SegmentFrontierTaskState,
	workspaceConfig: WorkspaceConfig | null | undefined,
	knownRequestIds: Set<string>,
): { ok: true } | { ok: false; reason: string } {
	const validationFailure = validateSegmentExpansionRequestAtBoundary(
		requestFile,
		taskId,
		segmentId,
		segmentState,
		workspaceConfig,
		knownRequestIds,
	);
	if (validationFailure) {
		return { ok: false, reason: validationFailure };
	}

	knownRequestIds.add(requestFile.request.requestId);
	execLog("batch", batchId, "segment expansion request handed off for graph mutation", {
		taskId,
		segmentId,
		agentId,
		requestId: requestFile.request.requestId,
		placement: requestFile.request.placement,
		requestedRepoIds: requestFile.request.requestedRepoIds.join(","),
		requestFile: requestFile.filePath,
	});
	return { ok: true };
}

/**
 * Insert one deterministic continuation segment round immediately after the
 * current wave. Used when dynamic expansion creates executable pending work
 * beyond the planned rounds.
 *
 * Mutates `segmentRounds` in place (splice). Returns the inserted continuation
 * wave (deduped + lex-sorted taskIds), or an empty array when `taskIds` had
 * no unique entries — in which case `segmentRounds` is untouched.
 */
export function scheduleContinuationSegmentRound(
	segmentRounds: string[][],
	currentWaveIndex: number,
	taskIds: Iterable<string>,
): string[] {
	const continuationWave = [...new Set(taskIds)].sort((a, b) => a.localeCompare(b));
	if (continuationWave.length === 0) {
		return [];
	}
	segmentRounds.splice(currentWaveIndex + 1, 0, continuationWave);
	return continuationWave;
}

// --- private helpers for applySegmentExpansionMutation ------------------

function buildOutgoingBySegmentId(dependsOnBySegmentId: Map<string, string[]>): Map<string, string[]> {
	const outgoingBySegmentId = new Map<string, string[]>();
	for (const segmentId of dependsOnBySegmentId.keys()) {
		outgoingBySegmentId.set(segmentId, []);
	}
	for (const [segmentId, deps] of dependsOnBySegmentId.entries()) {
		for (const dep of deps) {
			const outgoing = outgoingBySegmentId.get(dep) ?? [];
			outgoing.push(segmentId);
			outgoingBySegmentId.set(dep, outgoing);
		}
	}
	for (const [segmentId, outgoing] of outgoingBySegmentId.entries()) {
		outgoingBySegmentId.set(
			segmentId,
			[...new Set(outgoing)].sort((a, b) => a.localeCompare(b)),
		);
	}
	return outgoingBySegmentId;
}

function addDependency(dependencyMap: Map<string, string[]>, segmentId: string, depSegmentId: string): void {
	const deps = dependencyMap.get(segmentId) ?? [];
	if (!deps.includes(depSegmentId)) {
		deps.push(depSegmentId);
		deps.sort((a, b) => a.localeCompare(b));
		dependencyMap.set(segmentId, deps);
	}
}

function removeDependency(dependencyMap: Map<string, string[]>, segmentId: string, depSegmentId: string): void {
	const deps = dependencyMap.get(segmentId) ?? [];
	const filtered = deps.filter(dep => dep !== depSegmentId);
	dependencyMap.set(segmentId, filtered);
}

function recomputeNextPendingSegmentIndex(segmentState: SegmentFrontierTaskState): void {
	const nextPendingIndex = segmentState.orderedSegments.findIndex(segment => {
		return segmentState.statusBySegmentId.get(segment.segmentId) === "pending";
	});
	segmentState.nextSegmentIndex = nextPendingIndex >= 0 ? nextPendingIndex : segmentState.orderedSegments.length;
}

function buildRepoMaxSequenceByRepo(orderedSegments: TaskSegmentNode[], taskId: string): Map<string, number> {
	const maxSequenceByRepo = new Map<string, number>();
	for (const segment of orderedSegments) {
		const repoId = segment.repoId;
		const basePrefix = `${taskId}::${repoId}`;
		let sequence = 1;
		if (segment.segmentId.startsWith(`${basePrefix}::`)) {
			const suffix = segment.segmentId.slice(`${basePrefix}::`.length);
			const parsed = Number.parseInt(suffix, 10);
			if (Number.isFinite(parsed) && parsed >= 2) {
				sequence = parsed;
			}
		}
		const currentMax = maxSequenceByRepo.get(repoId) ?? 0;
		maxSequenceByRepo.set(repoId, Math.max(currentMax, sequence));
	}
	return maxSequenceByRepo;
}

/**
 * Apply one approved segment-expansion request to a task frontier DAG.
 *
 * Semantics:
 * - `after-current`: new-segment roots depend on anchor; anchor's former successors
 *   now depend on new-segment sinks, severing their direct anchor dependency.
 * - `end`: new-segment roots depend on every pre-existing terminal segment so the
 *   new segments run after the task's current frontier completes.
 * - Repeat-repo disambiguation: if the task already contains a segment for a
 *   requested repo, the newly inserted segment gets a `::{N}` suffix sequenced
 *   from the current max per repo.
 * - Priority-respecting topological sort: existing segments retain relative
 *   order; new segments are appended in request order when indegree ties occur.
 * - Rollback on cycle: if topo-sort fails to cover every node, the mutation is
 *   fully reverted and `{ insertedSegmentIds: [] }` is returned.
 */
export function applySegmentExpansionMutation(
	segmentState: SegmentFrontierTaskState,
	request: SegmentExpansionRequest,
	anchorSegmentId: string,
): { insertedSegmentIds: string[] } {
	const existingNodeById = new Map<string, TaskSegmentNode>();
	for (const segment of segmentState.orderedSegments) {
		existingNodeById.set(segment.segmentId, segment);
	}

	const dependencyMap = new Map<string, string[]>();
	for (const [segmentId, deps] of segmentState.dependsOnBySegmentId.entries()) {
		dependencyMap.set(
			segmentId,
			[...new Set(deps)].sort((a, b) => a.localeCompare(b)),
		);
	}
	for (const segmentId of existingNodeById.keys()) {
		if (!dependencyMap.has(segmentId)) {
			dependencyMap.set(segmentId, []);
		}
	}

	// Snapshot original state for rollback on topo-sort failure
	const originalOrderedSegments = [...segmentState.orderedSegments];
	const originalDeps = new Map<string, string[]>();
	for (const [k, v] of dependencyMap) originalDeps.set(k, [...v]);

	const outgoingBeforeMutation = buildOutgoingBySegmentId(dependencyMap);
	const anchorSuccessors = outgoingBeforeMutation.get(anchorSegmentId) ?? [];
	const maxOrder = segmentState.orderedSegments.reduce((max, segment) => Math.max(max, segment.order), -1);
	const repoMaxSequenceByRepo = buildRepoMaxSequenceByRepo(segmentState.orderedSegments, request.taskId);

	const newNodes: TaskSegmentNode[] = [];
	const segmentIdByRequestedRepoId = new Map<string, string>();
	for (const [idx, repoId] of request.requestedRepoIds.entries()) {
		const nextSequence = (repoMaxSequenceByRepo.get(repoId) ?? 0) + 1;
		repoMaxSequenceByRepo.set(repoId, nextSequence);
		const segmentId = buildSegmentId(request.taskId, repoId, nextSequence);
		segmentIdByRequestedRepoId.set(repoId, segmentId);
		const node: TaskSegmentNode = {
			segmentId,
			taskId: request.taskId,
			repoId,
			order: maxOrder + idx + 1,
		};
		newNodes.push(node);
		existingNodeById.set(node.segmentId, node);
		dependencyMap.set(node.segmentId, []);
	}

	for (const edge of request.edges) {
		const fromSegmentId = segmentIdByRequestedRepoId.get(edge.from);
		const toSegmentId = segmentIdByRequestedRepoId.get(edge.to);
		if (!fromSegmentId || !toSegmentId) continue;
		addDependency(dependencyMap, toSegmentId, fromSegmentId);
	}

	const internalIncomingCounts = new Map<string, number>();
	const internalOutgoingCounts = new Map<string, number>();
	for (const node of newNodes) {
		internalIncomingCounts.set(node.segmentId, 0);
		internalOutgoingCounts.set(node.segmentId, 0);
	}
	for (const edge of request.edges) {
		const fromSegmentId = segmentIdByRequestedRepoId.get(edge.from);
		const toSegmentId = segmentIdByRequestedRepoId.get(edge.to);
		if (!fromSegmentId || !toSegmentId) continue;
		internalOutgoingCounts.set(fromSegmentId, (internalOutgoingCounts.get(fromSegmentId) ?? 0) + 1);
		internalIncomingCounts.set(toSegmentId, (internalIncomingCounts.get(toSegmentId) ?? 0) + 1);
	}

	const roots = newNodes
		.filter(node => (internalIncomingCounts.get(node.segmentId) ?? 0) === 0)
		.map(node => node.segmentId)
		.sort((a, b) => a.localeCompare(b));
	const sinks = newNodes
		.filter(node => (internalOutgoingCounts.get(node.segmentId) ?? 0) === 0)
		.map(node => node.segmentId)
		.sort((a, b) => a.localeCompare(b));

	if (request.placement === "after-current") {
		for (const root of roots) {
			addDependency(dependencyMap, root, anchorSegmentId);
		}
		for (const successor of anchorSuccessors) {
			removeDependency(dependencyMap, successor, anchorSegmentId);
			for (const sink of sinks) {
				addDependency(dependencyMap, successor, sink);
			}
		}
	} else {
		const terminals = segmentState.orderedSegments
			.map(segment => segment.segmentId)
			.filter(segmentId => (outgoingBeforeMutation.get(segmentId) ?? []).length === 0)
			.sort((a, b) => a.localeCompare(b));
		for (const root of roots) {
			for (const terminal of terminals) {
				if (terminal === root) continue;
				addDependency(dependencyMap, root, terminal);
			}
		}
	}

	const priorityBySegmentId = new Map<string, number>();
	for (const [idx, segment] of segmentState.orderedSegments.entries()) {
		priorityBySegmentId.set(segment.segmentId, idx);
	}
	for (const [idx, node] of newNodes.entries()) {
		priorityBySegmentId.set(node.segmentId, segmentState.orderedSegments.length + idx);
	}

	const outgoing = buildOutgoingBySegmentId(dependencyMap);
	const indegree = new Map<string, number>();
	for (const [segmentId, deps] of dependencyMap.entries()) {
		indegree.set(segmentId, deps.length);
	}
	const ready = [...dependencyMap.keys()]
		.filter(segmentId => (indegree.get(segmentId) ?? 0) === 0)
		.sort((a, b) => {
			const aPriority = priorityBySegmentId.get(a) ?? Number.MAX_SAFE_INTEGER;
			const bPriority = priorityBySegmentId.get(b) ?? Number.MAX_SAFE_INTEGER;
			if (aPriority !== bPriority) return aPriority - bPriority;
			return a.localeCompare(b);
		});

	const nextOrderedSegmentIds: string[] = [];
	while (ready.length > 0) {
		const nextSegmentId = ready.shift()!;
		nextOrderedSegmentIds.push(nextSegmentId);
		for (const depSegmentId of outgoing.get(nextSegmentId) ?? []) {
			const count = (indegree.get(depSegmentId) ?? 0) - 1;
			indegree.set(depSegmentId, count);
			if (count === 0) {
				ready.push(depSegmentId);
				ready.sort((a, b) => {
					const aPriority = priorityBySegmentId.get(a) ?? Number.MAX_SAFE_INTEGER;
					const bPriority = priorityBySegmentId.get(b) ?? Number.MAX_SAFE_INTEGER;
					if (aPriority !== bPriority) return aPriority - bPriority;
					return a.localeCompare(b);
				});
			}
		}
	}

	if (nextOrderedSegmentIds.length !== dependencyMap.size) {
		// Topological sort failed to cover all nodes — likely a cycle introduced
		// by the expansion. Reject the mutation entirely and restore original state.
		execLog("batch", request.taskId, "segment expansion rejected: topological sort failed (possible cycle)", {
			expected: dependencyMap.size,
			covered: nextOrderedSegmentIds.length,
		});
		for (const node of newNodes) {
			segmentState.statusBySegmentId.delete(node.segmentId);
		}
		segmentState.orderedSegments = originalOrderedSegments;
		segmentState.dependsOnBySegmentId = originalDeps;
		return { insertedSegmentIds: [] };
	}

	const nextOrderedSegments = nextOrderedSegmentIds
		.map((segmentId, idx) => {
			const segment = existingNodeById.get(segmentId);
			if (!segment) return null;
			return { ...segment, order: idx };
		})
		.filter((segment): segment is TaskSegmentNode => segment !== null);

	segmentState.orderedSegments = nextOrderedSegments;
	segmentState.dependsOnBySegmentId = dependencyMap;
	for (const node of newNodes) {
		segmentState.statusBySegmentId.set(node.segmentId, "pending");
	}
	recomputeNextPendingSegmentIndex(segmentState);

	return {
		insertedSegmentIds: newNodes.map(node => node.segmentId),
	};
}

function ensureSegmentRecords(batchState: MissionBatchRuntimeState): PersistedSegmentRecord[] {
	if (!batchState.segments) {
		batchState.segments = [];
	}
	return batchState.segments;
}

/**
 * Persist pending segment records for an approved expansion and resync dependency
 * metadata for existing pending records touched by subsequent rewires.
 *
 * For each segment still in `pending` status in `segmentState`:
 * - If the segment was newly inserted by the mutation, create a fresh
 *   `PersistedSegmentRecord` (laneId/sessionName/worktreePath blank, branch =
 *   `fallbackBranch`, `expandedFrom`/`expansionRequestId` set from args).
 * - Otherwise update an existing pending record's `dependsOnSegmentIds` so
 *   anchor-successor rewiring from the mutation is persisted.
 *
 * Returns true when any record was added or mutated; false when nothing changed.
 * Skips silently when no pending segments remain.
 */
export function upsertPendingExpandedSegmentRecords(
	batchState: MissionBatchRuntimeState,
	task: ParsedTask,
	segmentState: SegmentFrontierTaskState,
	insertedSegmentIds: string[],
	expandedFrom: string,
	expansionRequestId: string,
	fallbackBranch: string,
): boolean {
	const insertedSegmentIdSet = new Set(insertedSegmentIds);
	const pendingSegmentIds = segmentState.orderedSegments
		.filter(segment => segmentState.statusBySegmentId.get(segment.segmentId) === "pending")
		.map(segment => segment.segmentId);
	if (pendingSegmentIds.length === 0) return false;

	const segmentRecords = ensureSegmentRecords(batchState);
	let changed = false;

	for (const segmentId of pendingSegmentIds) {
		const segment = segmentState.orderedSegments.find(candidate => candidate.segmentId === segmentId);
		if (!segment) continue;
		const existing = segmentRecords.find(record => record.segmentId === segmentId);
		if (!existing && !insertedSegmentIdSet.has(segmentId)) {
			continue;
		}

		const dependsOnSegmentIds = segmentState.dependsOnBySegmentId.get(segmentId) ?? [];
		const nextExpandedFrom = insertedSegmentIdSet.has(segmentId) ? expandedFrom : existing?.expandedFrom;
		const nextExpansionRequestId = insertedSegmentIdSet.has(segmentId)
			? expansionRequestId
			: existing?.expansionRequestId;
		const next: PersistedSegmentRecord = {
			segmentId,
			taskId: task.taskId,
			repoId: segment.repoId,
			status: "pending",
			laneId: existing?.laneId ?? "",
			sessionName: existing?.sessionName ?? "",
			worktreePath: existing?.worktreePath ?? "",
			branch: existing?.branch ?? fallbackBranch,
			startedAt: null,
			endedAt: null,
			retries: existing?.retries ?? 0,
			exitReason: existing?.exitReason ?? "Segment pending",
			dependsOnSegmentIds,
			expandedFrom: nextExpandedFrom,
			expansionRequestId: nextExpansionRequestId,
		};

		if (!existing) {
			segmentRecords.push(next);
			changed = true;
			continue;
		}

		const recordChanged =
			existing.taskId !== next.taskId ||
			existing.repoId !== next.repoId ||
			existing.status !== next.status ||
			existing.laneId !== next.laneId ||
			existing.sessionName !== next.sessionName ||
			existing.worktreePath !== next.worktreePath ||
			existing.branch !== next.branch ||
			existing.startedAt !== next.startedAt ||
			existing.endedAt !== next.endedAt ||
			existing.retries !== next.retries ||
			existing.exitReason !== next.exitReason ||
			existing.dependsOnSegmentIds.length !== next.dependsOnSegmentIds.length ||
			existing.dependsOnSegmentIds.some((depSegmentId, idx) => depSegmentId !== next.dependsOnSegmentIds[idx]) ||
			existing.expandedFrom !== next.expandedFrom ||
			existing.expansionRequestId !== next.expansionRequestId;

		if (recordChanged) {
			Object.assign(existing, next);
			changed = true;
		}
	}

	return changed;
}

/**
 * Rebuild the in-memory idempotency set from persisted resilience repair history.
 * Used on start/resume to prevent replay of already-processed expansion requests.
 *
 * Reads `resilience.repairHistory`, keeps entries whose `strategy` is
 * `"segment-expansion-request"`, and returns the Set of their `id` fields.
 * Safe to call with an empty/undefined `resilience` (returns empty Set).
 */
export function collectProcessedSegmentExpansionRequestIds(
	batchState: Pick<MissionBatchRuntimeState, "resilience">,
): Set<string> {
	return new Set<string>(
		(batchState.resilience?.repairHistory ?? [])
			.filter(entry => entry.strategy === "segment-expansion-request")
			.map(entry => entry.id),
	);
}
