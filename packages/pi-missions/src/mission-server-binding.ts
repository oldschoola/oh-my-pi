/**
 * Wire the dashboard server's HTTP-side hooks (declared in `server-hooks.ts`)
 * to the extension's in-memory mission state, persistence path, and
 * `pi.sendUserMessage` channel.
 *
 * Also installs the persistent default GUI bridge so the browser can launch
 * missions without an outstanding `/mission-gui` slash command.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import { type DefaultBridgeHandler, registerDefaultBridge } from "./gui-bridge";
import { kickoffMissionFromRequest } from "./kickoff";
import { type MissionMetaPatch, setMissionServerHooks } from "./server-hooks";
import {
	abortMissionState,
	addProgressEvent,
	advancePhase,
	clearMissionOnDisk,
	pauseMission,
	resumeMission,
	saveMissionState,
	writeMissionToDisk,
} from "./state";
import type { MissionState } from "./types";
import { type MissionWidgetCtx, updateWidget } from "./widget";

export interface MissionServerBindingDeps {
	pi: ExtensionAPI;
	cwd: string;
	getState: () => MissionState | null;
	setState: (s: MissionState | null) => void;
	/**
	 * Last known extension/command context. Used to refresh the on-screen
	 * widget after a state mutation. Optional — when null, the widget will
	 * pick up the change on the next agent turn anyway.
	 */
	getCtx: () => MissionWidgetCtx | null;
}

export function bindMissionServer(deps: MissionServerBindingDeps): void {
	const { pi, cwd, getState, setState, getCtx } = deps;

	function persist(state: MissionState): void {
		setState(state);
		saveMissionState(pi, state);
		const ctx = getCtx();
		if (ctx) updateWidget(ctx, state);
		writeMissionToDisk(cwd, state).catch(err =>
			logger.error("[pi-mission] disk mirror failed", {
				error: err instanceof Error ? err.message : String(err),
			}),
		);
	}

	const defaultHandler: DefaultBridgeHandler = req => {
		try {
			const current = getState();
			if (current && (current.completedAt || current.paused)) {
				setState(null);
				pi.appendEntry("mission-state", null);
				clearMissionOnDisk(cwd).catch(err =>
					logger.error("[pi-mission] disk clear failed", {
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			}
			kickoffMissionFromRequest(pi, cwd, req, persist);
		} catch (err) {
			logger.error("[pi-mission] default bridge handler failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	registerDefaultBridge(defaultHandler);

	setMissionServerHooks({
		redirect: (message: string) => {
			const state = getState();
			if (!state) return { ok: false, reason: "no_active_mission" };
			persist(addProgressEvent(state, "mission_redirect", message));
			pi.sendUserMessage(message, { deliverAs: "followUp" });
			return { ok: true };
		},
		skipPhase: () => {
			const state = getState();
			if (!state || state.completedAt) return { ok: false, reason: "no_active_mission" };
			const active = state.phases.find(p => p.status === "active");
			if (!active) return { ok: false, reason: "no_active_phase" };
			let { state: advanced, completedPhaseName } = advancePhase(state, "skipped");
			if (completedPhaseName) {
				advanced = addProgressEvent(advanced, "phase_complete", `Skipped phase: ${completedPhaseName}`);
			}
			persist(advanced);
			if (advanced.completedAt) pi.setSessionName(`✅ ${advanced.description}`);
			return { ok: true, state: advanced, completedPhaseName: completedPhaseName ?? undefined };
		},
		patchMission: (patch: MissionMetaPatch) => {
			const state = getState();
			if (!state) return { ok: false, reason: "no_active_mission" };
			const next: MissionState = { ...state };
			if (patch.autonomy) next.autonomy = patch.autonomy;
			if (patch.constraints !== undefined) {
				const trimmed = patch.constraints.trim();
				next.constraints = trimmed.length > 0 ? trimmed : undefined;
			}
			persist(next);
			return { ok: true, state: next };
		},
		controlSimple: (action, payload) => {
			const state = getState();
			if (!state) return { ok: false, reason: "no_active_mission" };
			if (action === "pause") {
				if (state.completedAt) return { ok: false, reason: "mission_completed" };
				if (state.paused) return { ok: true, state };
				const next = addProgressEvent(pauseMission(state), "mission_pause", "Mission paused via dashboard");
				persist(next);
				return { ok: true, state: next };
			}
			if (action === "resume") {
				if (!state.paused) return { ok: true, state };
				const next = addProgressEvent(resumeMission(state), "mission_resume", "Mission resumed via dashboard");
				persist(next);
				return { ok: true, state: next };
			}
			// abort
			const reason = payload?.reason?.trim() || "aborted via dashboard";
			const next = abortMissionState(state, reason);
			persist(next);
			pi.setSessionName(`🛑 ${state.description}`);
			return { ok: true, state: next };
		},
	});
}
