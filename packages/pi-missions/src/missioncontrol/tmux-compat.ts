/**
 * Migration-only helpers for legacy lane-session field normalization.
 *
 * Ported from `taskplane/extensions/taskplane/tmux-compat.ts` (37 LOC).
 * Retained as a one-release state-ingress normalizer: earlier taskplane
 * batches persisted `lanes[].tmuxSessionName`; current MissionControl
 * schema uses `lanes[].laneSessionId`. These helpers smooth the upgrade
 * path without re-introducing TMUX runtime semantics.
 *
 * psmux (the Windows tmux port) is a separate concern — when the CLI
 * exposes psmux-assisted session listing, it consumes `laneSessionId`
 * directly and does not need these helpers.
 */

/** Shape that readers + writers of persisted lane records share. */
export interface LaneSessionAliasTarget {
	laneSessionId?: unknown;
	tmuxSessionName?: unknown;
}

/**
 * Read canonical + legacy lane-session fields from a lane-like record.
 *
 * Pure — returns a snapshot of both fields without mutating the target.
 */
export function readLaneSessionAliases(target: LaneSessionAliasTarget): {
	laneSessionId: unknown;
	tmuxSessionName: unknown;
} {
	return {
		laneSessionId: target.laneSessionId,
		tmuxSessionName: target.tmuxSessionName,
	};
}

/**
 * Normalize `tmuxSessionName` → `laneSessionId` in place and drop the
 * legacy key. Idempotent: calling repeatedly is a no-op once migrated.
 */
export function normalizeLaneSessionAlias(target: LaneSessionAliasTarget): void {
	if (typeof target.laneSessionId !== "string" && typeof target.tmuxSessionName === "string") {
		target.laneSessionId = target.tmuxSessionName;
	}
	if ("tmuxSessionName" in target) {
		delete target.tmuxSessionName;
	}
}
