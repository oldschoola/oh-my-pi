/**
 * Pure helpers for segment-plan linearization and segment-round display
 * mapping. Runtime V2 consumes segment DAGs one segment per task at a time,
 * so plans are linearized into a deterministic execution order; the segment
 * round → task-level wave mapping lets the UI keep showing "Wave X of Y"
 * without inflating the wave count as segments expand (TP-166).
 *
 * Ported from taskplane `engine.ts` (linearizeTaskSegmentPlan,
 * resolveDisplayWaveNumber). Keeps no I/O or pi-framework deps.
 */

import { resolve } from "node:path";

import type { ParsedTask } from "./discovery";
import type {
	SegmentFrontierResult,
	SegmentFrontierTaskState,
	SegmentLifecycleStatus,
	TaskSegmentNode,
	TaskSegmentPlan,
	TaskSegmentPlanMap,
} from "./types";

/**
 * Deterministically linearize one task's segment DAG into a sequential order.
 *
 * Runtime V2 executes one segment per task at a time, so even explicit DAGs
 * are consumed through a deterministic topological order. Edges referencing
 * segments outside `plan.segments` are ignored. Ties break by `order`, then
 * by `segmentId` lexicographic order. Cyclic / malformed plans fall back to
 * sorting `plan.segments` by order + segmentId.
 */
export function linearizeTaskSegmentPlan(plan: TaskSegmentPlan): TaskSegmentNode[] {
	const nodeById = new Map<string, TaskSegmentNode>();
	for (const segment of plan.segments) {
		nodeById.set(segment.segmentId, segment);
	}

	const indegree = new Map<string, number>();
	const outgoing = new Map<string, string[]>();
	for (const segment of plan.segments) {
		indegree.set(segment.segmentId, 0);
		outgoing.set(segment.segmentId, []);
	}

	for (const edge of plan.edges) {
		if (!nodeById.has(edge.fromSegmentId) || !nodeById.has(edge.toSegmentId)) {
			continue;
		}
		outgoing.get(edge.fromSegmentId)!.push(edge.toSegmentId);
		indegree.set(edge.toSegmentId, (indegree.get(edge.toSegmentId) ?? 0) + 1);
	}

	for (const list of outgoing.values()) {
		list.sort((a, b) => a.localeCompare(b));
	}

	const ready: TaskSegmentNode[] = plan.segments
		.filter(segment => (indegree.get(segment.segmentId) ?? 0) === 0)
		.sort((a, b) => a.order - b.order || a.segmentId.localeCompare(b.segmentId));

	const ordered: TaskSegmentNode[] = [];
	while (ready.length > 0) {
		const next = ready.shift()!;
		ordered.push(next);
		for (const dep of outgoing.get(next.segmentId) ?? []) {
			const count = (indegree.get(dep) ?? 0) - 1;
			indegree.set(dep, count);
			if (count === 0) {
				const depNode = nodeById.get(dep);
				if (depNode) {
					ready.push(depNode);
					ready.sort((a, b) => a.order - b.order || a.segmentId.localeCompare(b.segmentId));
				}
			}
		}
	}

	if (ordered.length !== plan.segments.length) {
		// Malformed or cyclic plan — fall back to a deterministic sort.
		return [...plan.segments].sort((a, b) => a.order - b.order || a.segmentId.localeCompare(b.segmentId));
	}

	return ordered;
}

/**
 * Resolve the 1-indexed task-level wave number for display from a
 * segment-round index. Segment rounds may outnumber task-level waves once
 * continuation rounds are inserted by dynamic expansion; this mapping keeps
 * the "Wave X of Y" display faithful to the original wave count.
 *
 * Display fallback chain:
 * - `displayWave` = `roundToTaskWave[roundIdx] + 1` when the mapping exists,
 *   otherwise `roundIdx + 1`.
 * - `displayTotal` = `taskLevelWaveCount` when present, otherwise
 *   `fallbackTotal`, otherwise `roundIdx + 1`.
 */
export function resolveDisplayWaveNumber(
	roundIdx: number,
	roundToTaskWave: number[] | undefined,
	taskLevelWaveCount: number | undefined,
	fallbackTotal?: number,
): { displayWave: number; displayTotal: number } {
	const taskWaveIdx = roundToTaskWave?.[roundIdx];
	const displayWave = taskWaveIdx != null ? taskWaveIdx + 1 : roundIdx + 1;
	const displayTotal = taskLevelWaveCount ?? fallbackTotal ?? roundIdx + 1;
	return { displayWave, displayTotal };
}

function buildSegmentDependencyMap(plan: TaskSegmentPlan): Map<string, string[]> {
	const depsBySegmentId = new Map<string, string[]>();
	for (const segment of plan.segments) {
		depsBySegmentId.set(segment.segmentId, []);
	}
	for (const edge of plan.edges) {
		if (!depsBySegmentId.has(edge.toSegmentId)) continue;
		depsBySegmentId.get(edge.toSegmentId)!.push(edge.fromSegmentId);
	}
	for (const [segmentId, deps] of depsBySegmentId.entries()) {
		depsBySegmentId.set(
			segmentId,
			[...new Set(deps)].sort((a, b) => a.localeCompare(b)),
		);
	}
	return depsBySegmentId;
}

function buildFallbackSegmentPlan(taskId: string, task: ParsedTask): TaskSegmentPlan {
	const repoId = task.resolvedRepoId?.trim() || "default";
	return {
		taskId,
		mode: "repo-singleton",
		segments: [
			{
				segmentId: `${taskId}::${repoId}`,
				taskId,
				repoId,
				order: 0,
			},
		],
		edges: [],
	};
}

/**
 * Expand task waves into segment-frontier rounds.
 *
 * Each original task-wave becomes N rounds where N is the max segment count
 * among tasks in that wave. A task with fewer segments simply drops out once
 * its segment list is exhausted. Returns both the expanded rounds and a
 * mapping from segment round index → task-level wave index (TP-166) so the
 * UI keeps showing "Wave X of Y" without inflating the wave count.
 *
 * Side effects: each `ParsedTask` in `pending` has its `segmentIds`,
 * `activeSegmentId`, `packetRepoId`, and `packetTaskPath` fields rewritten.
 * When `workspaceRoot` is provided, `packetTaskPath` resolves to an absolute
 * path so cross-repo lanes can reach the packet folder.
 */
export function buildSegmentFrontierWaves(
	baseTaskWaves: string[][],
	pending: Map<string, ParsedTask>,
	segmentPlans?: TaskSegmentPlanMap,
	packetRepoId?: string,
	workspaceRoot?: string,
): SegmentFrontierResult {
	const taskStateById = new Map<string, SegmentFrontierTaskState>();

	for (const [taskId, task] of pending.entries()) {
		const plan = segmentPlans?.get(taskId) ?? buildFallbackSegmentPlan(taskId, task);
		const orderedSegments = linearizeTaskSegmentPlan(plan);
		const dependsOnBySegmentId = buildSegmentDependencyMap(plan);
		task.segmentIds = orderedSegments.map(segment => segment.segmentId);
		task.activeSegmentId = null;
		if (packetRepoId) {
			task.packetRepoId = packetRepoId;
			task.packetTaskPath =
				workspaceRoot && task.taskFolder ? resolve(workspaceRoot, task.taskFolder) : task.taskFolder;
		}

		taskStateById.set(taskId, {
			taskId,
			orderedSegments,
			nextSegmentIndex: 0,
			statusBySegmentId: new Map(
				orderedSegments.map(segment => [segment.segmentId, "pending" as SegmentLifecycleStatus]),
			),
			dependsOnBySegmentId,
			terminalStatus: "pending",
		});
	}

	const expanded: string[][] = [];
	const roundToTaskWave: number[] = [];
	for (let taskWaveIdx = 0; taskWaveIdx < baseTaskWaves.length; taskWaveIdx++) {
		const waveTasks = baseTaskWaves[taskWaveIdx] ?? [];
		let maxSegmentsInWave = 0;
		for (const taskId of waveTasks) {
			const state = taskStateById.get(taskId);
			if (!state) continue;
			maxSegmentsInWave = Math.max(maxSegmentsInWave, state.orderedSegments.length);
		}

		for (let segmentIndex = 0; segmentIndex < maxSegmentsInWave; segmentIndex++) {
			const segmentRound: string[] = [];
			for (const taskId of waveTasks) {
				const state = taskStateById.get(taskId);
				if (!state) continue;
				if (segmentIndex < state.orderedSegments.length) {
					segmentRound.push(taskId);
				}
			}
			if (segmentRound.length > 0) {
				expanded.push(segmentRound);
				roundToTaskWave.push(taskWaveIdx);
			}
		}
	}

	return {
		waves: expanded,
		taskStateById,
		taskLevelWaveCount: baseTaskWaves.length,
		roundToTaskWave,
	};
}
