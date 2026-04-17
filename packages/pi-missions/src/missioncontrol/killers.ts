/**
 * Agent kill helpers (stub).
 *
 * Stand-in for the lane/merge agent kill routines that will live in
 * `execution.ts` and `merge.ts` once those modules are fully ported.
 * `abort.ts` invokes these to terminate worker, reviewer, and merge
 * agents during graceful + hard abort flows.
 *
 * Behavior: no-op at stub stage — each helper records a debug log and
 * returns a success-shaped result so callers can continue. Real
 * implementations land with execution + merge.
 */

import { execLog } from "./log";

/**
 * Kill a single merge agent by session name (stub).
 *
 * Real impl lives in `merge.ts`: looks up merge agent PID by session,
 * sends kill signal, marks merge snapshot failed.
 */
export function killMergeAgentV2(baseSessionName: string): boolean {
	execLog("killer", "-", `kill merge agent: ${baseSessionName} (stub)`);
	return false;
}

/**
 * Kill all active merge agents across the batch (stub).
 *
 * Real impl lives in `merge.ts`: iterates active merge snapshots,
 * kills each, returns count.
 */
export function killAllMergeAgentsV2(): number {
	execLog("killer", "-", "kill all merge agents (stub)");
	return 0;
}
