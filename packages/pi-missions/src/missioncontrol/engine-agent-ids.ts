/**
 * Agent-ID resolution helpers — pure, extracted from taskplane's engine.ts.
 *
 * Kept in a tiny module so the MVP `engine.ts` state reducers stay focused
 * while the broader engine port lands incrementally.
 */

import type { AllocatedLane, LaneTaskOutcome } from "./types";

/**
 * Resolve the *worker* agent ID for a task, used by mailbox/outbox paths.
 *
 * Priority (first match wins):
 * 1. `outcome.sessionName` from the already-completed task outcome (authoritative).
 * 2. Reconstructed `{agentIdPrefix}-lane-{laneNumber}-worker` — matches the ID
 *    produced by `buildRuntimeAgentId(agentIdPrefix, lane.laneNumber, "worker")`
 *    inside `executeLaneV2`. Needed because in workspace mode `lane.laneSessionId`
 *    uses repo-scoped local numbering while the worker ID uses the *global*
 *    `laneNumber` — the two diverge (see TP-165).
 * 3. Legacy `{laneSessionId}-worker` — only used when `agentIdPrefix` is absent.
 *
 * Returns `null` when the task has no completed outcome *and* no lane allocation.
 */
export function resolveTaskWorkerAgentId(
	taskId: string,
	allTaskOutcomes: LaneTaskOutcome[],
	laneByTaskId: Map<string, AllocatedLane>,
	agentIdPrefix?: string,
): string | null {
	const outcome = allTaskOutcomes.find(candidate => candidate.taskId === taskId);
	if (outcome?.sessionName) {
		return outcome.sessionName;
	}

	const lane = laneByTaskId.get(taskId);
	if (!lane) return null;

	if (agentIdPrefix) {
		return `${agentIdPrefix}-lane-${lane.laneNumber}-worker`;
	}

	return `${lane.laneSessionId}-worker`;
}
