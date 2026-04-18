/**
 * Pure token-aggregation helpers used by batch-history assembly.
 *
 * Ported from `taskplane/extensions/taskplane/engine.ts` (the top 150 LOC
 * of the engine). Kept in a dedicated module so the small MVP `engine.ts`
 * stays focused on state reducers while the port grows incrementally.
 */

import type { LaneTaskOutcome, TokenCounts } from "./types";

/** Zero-token sentinel. Returned (as a fresh copy) when a task had no run. */
const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };

/**
 * Lift embedded `LaneTaskOutcome.telemetry` into the batch-history
 * `TokenCounts` shape. Missing telemetry → a fresh zero-counts object.
 */
export function taskTokensFromOutcomeTelemetry(outcome: LaneTaskOutcome): TokenCounts {
	const telemetry = outcome.telemetry;
	if (!telemetry) return { ...ZERO_TOKENS };
	return {
		input: telemetry.inputTokens,
		output: telemetry.outputTokens,
		cacheRead: telemetry.cacheReadTokens,
		cacheWrite: telemetry.cacheWriteTokens,
		costUsd: telemetry.costUsd,
	};
}

/**
 * Resolve per-task token counts for batch history.
 *
 * Priority (first match wins):
 * 1. Embedded `outcome.telemetry` — authoritative Runtime V2 path.
 * 2. V2 lane snapshot lookup by numeric `laneNumber`.
 * 3. Legacy lane-state sidecar lookup by `sessionName`
 *    (falling back to sessionName without a `-worker|-reviewer` suffix).
 * 4. Legacy lane-state lookup by `lane-{laneNumber}` key.
 * 5. Zero tokens.
 *
 * Skipped tasks short-circuit to zero — no agent process ever ran.
 */
export function resolveBatchHistoryTaskTokens(
	outcome: LaneTaskOutcome,
	laneNumber: number,
	v2LaneTokensByNumber: Map<number, TokenCounts>,
	legacyLaneTokensByKey: Map<string, TokenCounts>,
): TokenCounts {
	if (outcome.status === "skipped") return { ...ZERO_TOKENS };

	if (outcome.telemetry) {
		return taskTokensFromOutcomeTelemetry(outcome);
	}

	if (laneNumber > 0) {
		const v2 = v2LaneTokensByNumber.get(laneNumber);
		if (v2) return v2;
	}

	const bySession =
		legacyLaneTokensByKey.get(outcome.sessionName) ||
		legacyLaneTokensByKey.get(outcome.sessionName?.replace(/-(?:worker|reviewer)$/, ""));
	if (bySession) return bySession;

	if (laneNumber > 0) {
		const byLaneKey = legacyLaneTokensByKey.get(`lane-${laneNumber}`);
		if (byLaneKey) return byLaneKey;
	}

	return { ...ZERO_TOKENS };
}
