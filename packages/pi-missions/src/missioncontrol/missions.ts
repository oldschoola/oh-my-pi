/**
 * Active mission/lane listing — derives session entries from the in-memory
 * BatchState laneStatuses for dashboard APIs and CLI `omp mission list`.
 *
 * Ported from taskplane `extensions/taskplane/sessions.ts` (renamed to
 * `missions.ts`). Simplified to read directly from `BatchState` instead of
 * taskplane's `OrchBatchRuntimeState` — the MVP has no tmux session layer.
 */

import type { MissionState } from "../types";

export interface MissionSessionEntry {
	sessionName: string;
	laneId: string;
	taskId: string | null;
	status: "alive" | "idle" | "error";
	stepProgress: string;
}

export function listMissionSessions(state: MissionState | null): MissionSessionEntry[] {
	if (!state?.batch) return [];
	return state.batch.laneStatuses
		.map(lane => ({
			sessionName: lane.sessionName,
			laneId: `lane-${lane.lane}`,
			taskId: lane.taskId,
			status:
				lane.status === "running"
					? ("alive" as const)
					: lane.status === "failed"
						? ("error" as const)
						: ("idle" as const),
			stepProgress: lane.stepProgress,
		}))
		.sort((a, b) => a.sessionName.localeCompare(b.sessionName));
}

export function formatMissionSessions(sessions: MissionSessionEntry[]): string {
	if (sessions.length === 0) return "No active mission lanes.";
	const lines: string[] = [`Active lanes (${sessions.length}):`, ""];
	for (const s of sessions) {
		const icon = s.status === "alive" ? "🟢" : s.status === "error" ? "🔴" : "⚪";
		const taskInfo = s.taskId ? ` (${s.taskId})` : "";
		lines.push(`  ${icon} ${s.sessionName} [${s.laneId}]${taskInfo}`);
		if (s.stepProgress) lines.push(`     ${s.stepProgress}`);
	}
	return lines.join("\n");
}
