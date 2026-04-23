/**
 * Process-wide registry of callbacks the dashboard server needs from the
 * extension host. The dashboard `Bun.serve` listener lives in `server.ts`
 * and has no direct access to `ExtensionAPI`, `ctx.ui`, or the in-memory
 * mission state — so the extension populates this module at startup and
 * the server dispatches through it.
 *
 * When no hooks are registered (e.g. during e2e tests that launch the server
 * standalone), the endpoints that require them return 503.
 */

import type { BatchPhase, MissionState } from "./types";

export type SimpleControlAction = "pause" | "resume" | "abort";
export type BatchControlAction = "pause" | "resume";

export interface MissionServerHooks {
	/**
	 * Deliver an operator-originated follow-up message to the chat agent and
	 * write a `mission_redirect` progress event to the active mission.
	 */
	redirect?: (message: string) => { ok: boolean; reason?: string };

	/**
	 * Skip the currently-active phase of a simple mission and advance to the
	 * next one. Returns the updated state so the HTTP response can surface it.
	 */
	skipPhase?: () => { ok: boolean; state?: MissionState; completedPhaseName?: string; reason?: string };

	/**
	 * Update mutable mission metadata (autonomy, constraints). Only applies to
	 * the currently-active mission.
	 */
	patchMission?: (patch: MissionMetaPatch) => { ok: boolean; state?: MissionState; reason?: string };

	/**
	 * Pause / resume / abort the active simple mission. Batch missions are
	 * handled directly by the server via `loadActiveBatch` + engine functions,
	 * so this hook only fires for simple missions.
	 */
	controlSimple?: (
		action: SimpleControlAction,
		payload?: { reason?: string },
	) => { ok: boolean; state?: MissionState; reason?: string };

	/**
	 * Signal pause / resume to the live mission-control engine for the
	 * currently-active batch. Mutating disk state alone is not enough — the
	 * engine's in-memory lane-runner only observes phase changes via
	 * `engine.handlers.*`, which also stops the runner loop and releases the
	 * supervisor lockfile. When unset (e.g. standalone dashboard boot), the
	 * server falls back to pure disk-only mutation so the dashboard still
	 * reflects the phase change for paused/resumed snapshots.
	 */
	controlBatch?: (
		action: BatchControlAction,
		payload?: { force?: boolean },
	) => Promise<{ ok: boolean; phase?: BatchPhase; reason?: string }>;
}

export interface MissionMetaPatch {
	autonomy?: MissionState["autonomy"];
	constraints?: string;
}

let hooks: MissionServerHooks = {};

export function setMissionServerHooks(next: MissionServerHooks): void {
	hooks = next;
}

export function getMissionServerHooks(): MissionServerHooks {
	return hooks;
}

export function clearMissionServerHooks(): void {
	hooks = {};
}
