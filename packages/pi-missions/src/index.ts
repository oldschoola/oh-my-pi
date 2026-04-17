/**
 * pi-mission — Orchestrated multi-phase development missions
 *
 * Thin orchestrator that wires together the factored modules:
 *   state.ts     — Persistence, phase advancement, progress logging
 *   widget.ts    — Compact always-visible progress widget
 *   detector.ts  — LLM output pattern matching for transitions
 *   protocol.ts  — System prompt injection (mission protocol + live status)
 *   commands.ts  — All /mission* slash command registrations
 *   utils.ts     — Shared helpers (text extraction, formatting)
 *
 * Commands (registered via commands.ts):
 *   /mission <desc>    Start a new mission
 *   /mission           Show quick status
 *   /mission-status    Detailed phase-by-phase status
 *   /mission-skip      Skip current phase
 *   /mission-done      Mark mission complete
 *   /mission-pause     Toggle pause/resume
 *   /mission-next      Manually advance to the next phase
 *   /mission-reset     Clear mission and widget
 *
 * Shortcut:
 *   Ctrl+Shift+M       Open Mission Control overlay
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import { registerMissionCommands } from "./commands";
import { resolvePhaseRole } from "./config";
import { detectMilestonePhases, detectPhaseTransition, detectProposedPhases } from "./detector";
import {
	buildMissionDepsReport,
	createEngine,
	formatMissionSessions,
	listMissionSessions,
	MISSION_MESSAGES,
	reviewerExtension,
} from "./missioncontrol";
import { maybeSwitchModel } from "./model-switch";
import { buildMissionProtocol, buildMissionStatus } from "./protocol";
import { addProgressEvent, advancePhase, expandPhases, restoreMissionState, saveMissionState } from "./state";
import type { MissionState } from "./types";
import { extractRawTextFromMessage, extractTextFromMessage } from "./utils";
import { clearRetryStatus, setRetryStatus, updateWidget } from "./widget";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function missionExtension(pi: ExtensionAPI): void {
	let mission: MissionState | null = null;

	const getState = () => mission;
	const setState = (s: MissionState | null) => {
		mission = s;
	};

	// -------------------------------------------------------------------
	// Session lifecycle — restore persisted state on any session change
	// -------------------------------------------------------------------

	/** Shared restore logic for all session lifecycle events. */
	function restoreFromSession(ctx: Pick<ExtensionContext, "ui" | "sessionManager">, source: string): void {
		try {
			mission = restoreMissionState(ctx.sessionManager.getEntries());
			if (mission && !mission.completedAt) {
				updateWidget(ctx, mission);
				pi.setSessionName(`🎯 ${mission.description}`);
			} else if (mission?.completedAt) {
				updateWidget(ctx, mission); // Show completed widget briefly
				pi.setSessionName(`✅ ${mission.description}`);
			} else {
				updateWidget(ctx, null);
			}
		} catch (err) {
			logger.error(`[pi-mission] ${source} failed`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	pi.on("session_start", async (_event, ctx) => restoreFromSession(ctx, "session_start"));
	pi.on("session_switch", async (_event, ctx) => restoreFromSession(ctx, "session_switch"));
	pi.on("session_compact", async (_event, ctx) => restoreFromSession(ctx, "session_compact"));
	pi.on("session_tree", async (_event, ctx) => restoreFromSession(ctx, "session_tree"));

	// -------------------------------------------------------------------
	// Auto-detect phase/feature transitions from LLM output
	// Note: Mission state survives compaction because appendEntry creates
	// custom entries (type: "custom") which are preserved in the session
	// tree. The before_agent_start handler re-injects the protocol each turn.
	// -------------------------------------------------------------------

	pi.on("message_end", async (event, ctx) => {
		try {
			if (!mission || mission.completedAt || mission.paused) return;
			if (event.message.role !== "assistant") return;

			const text = extractTextFromMessage(event.message);
			if (!text) return;

			let updated = false;

			// Adaptive-mode expansion: if this is the seed `Plan` phase and the
			// agent has proposed a concrete phase list, replace the pending tail
			// before phase-transition detection runs so the transition lands
			// directly into the newly-expanded phases.
			if (mission.templateKey === "adaptive" && !mission.phasesExpanded) {
				const raw = extractRawTextFromMessage(event.message);
				const proposed = detectProposedPhases(raw) ?? detectMilestonePhases(raw);
				if (proposed) {
					mission = expandPhases(mission, proposed);
					mission = addProgressEvent(
						mission,
						"phase_start",
						`Plan proposed ${proposed.length} phases — phase list expanded`,
					);
					updated = true;
				}
			}

			// Phase-based detection
			const activeIdx = mission.phases.findIndex(p => p.status === "active");
			const result = detectPhaseTransition(text, mission.phases, activeIdx);

			if (result) {
				const { state: next, completedPhaseName } = advancePhase(mission, "done");
				mission = next;

				if (completedPhaseName) {
					const label = result.type === "complete" ? "Completed" : "Advancing from";
					mission = addProgressEvent(mission, "phase_complete", `${label} phase: ${completedPhaseName}`);
				}

				if (mission.completedAt) {
					mission = addProgressEvent(mission, "mission_complete", "All phases complete — mission finished");
				} else {
					const nextActive = mission.phases.find(p => p.status === "active");
					if (nextActive) {
						const verb = result.type === "complete" ? "Starting" : "Advancing to";
						mission = addProgressEvent(mission, "phase_start", `${verb} phase: ${nextActive.name}`);
					}
				}

				updated = true;
			}

			if (updated) {
				saveMissionState(pi, mission);
				updateWidget(ctx, mission);

				if (mission.completedAt) {
					// Mission finished — surface it in the session name.
					pi.setSessionName(`✅ ${mission.description}`);
				} else {
					// Auto-switch model for the new phase role before we hand the
					// turn back. `before_agent_start` also calls this, but firing it
					// here ensures the follow-up message below runs on the correct
					// model even if the next turn arrives before before_agent_start.
					await maybeSwitchModel(pi, mission, ctx);

					// Keep the mission moving. `message_end` only fires when the
					// current turn ended — without a follow-up the agent sits idle
					// after announcing phase completion. Trigger the next turn so it
					// picks up the new phase. `before_agent_start` will rebuild the
					// protocol for the now-active phase automatically.
					const nextPhase = mission.phases.find(p => p.status === "active");
					if (nextPhase) {
						const role = resolvePhaseRole(nextPhase.name);
						pi.sendUserMessage(
							`[Mission] Previous phase complete. Begin Phase: ${nextPhase.emoji} ${nextPhase.name} ` +
								`(role: ${role}). Follow the phase instructions in your system prompt.`,
						);
					}
				}
			}
		} catch (err) {
			logger.error("[pi-mission] message_end failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	// -------------------------------------------------------------------
	// System prompt injection — adds protocol + live status
	// -------------------------------------------------------------------

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (!mission || mission.completedAt) return;

			// Align the active model with the current phase's assigned role before
			// the agent consumes this turn. Covers initial kickoff, resumed
			// sessions, and any turn following a phase transition. Safe to call
			// every turn — setModel is a no-op when the target matches current.
			await maybeSwitchModel(pi, mission, ctx);

			const protocol = buildMissionProtocol(mission);
			const status = buildMissionStatus(mission);

			return {
				systemPrompt: `${event.systemPrompt}\n\n---\n\n${protocol}\n\n${status}`,
			};
		} catch (err) {
			logger.error("[pi-mission] before_agent_start failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	// -------------------------------------------------------------------
	// Auto-retry visibility — surface retry waits in the widget so missions
	// don't appear stuck during long backoff periods (e.g. 24-min 429 retry).
	// -------------------------------------------------------------------

	pi.on("auto_retry_start", async (event, ctx) => {
		try {
			if (!mission) return;
			setRetryStatus(ctx, mission, {
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			});
		} catch (err) {
			logger.error("[pi-mission] auto_retry_start failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	pi.on("auto_retry_end", async (_event, ctx) => {
		try {
			if (!mission) return;
			clearRetryStatus(ctx, mission);
		} catch (err) {
			logger.error("[pi-mission] auto_retry_end failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	// -------------------------------------------------------------------
	// Register all /mission* commands
	// -------------------------------------------------------------------

	registerMissionCommands(pi, getState, setState);

	// -------------------------------------------------------------------
	// MissionControl engine — batch-mode orchestration
	//
	// Dormant on simple missions (engine.status().active === false) and
	// only fires when /mission-batch promotes the current mission.
	// -------------------------------------------------------------------

	const engine = createEngine({
		cwd: process.cwd(),
		getMission: getState,
		setMission: setState,
	});

	function parseBatchArgs(args: string): { laneCount?: number; waveSize?: number; taskIds: string[] } {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		const result: { laneCount?: number; waveSize?: number; taskIds: string[] } = { taskIds: [] };
		for (const token of tokens) {
			const [key, value] = token.includes("=") ? token.split("=") : [token, ""];
			if (key === "lanes" && value) result.laneCount = Number.parseInt(value, 10);
			else if (key === "wave" && value) result.waveSize = Number.parseInt(value, 10);
			else result.taskIds.push(key);
		}
		return result;
	}

	pi.registerCommand("mission-batch", {
		description: "Promote the active mission to multi-lane batch orchestration",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const current = getState();
			if (!current) {
				ctx.ui.notify("No active mission. Start one with /mission <description>.", "warning");
				return;
			}
			if (current.completedAt) {
				ctx.ui.notify("Mission is already complete — reset before promoting to batch.", "warning");
				return;
			}
			const parsed = parseBatchArgs(args);
			const next = await engine.handlers.batch(parsed);
			if (!next?.batch) {
				ctx.ui.notify("Failed to promote mission to batch mode.", "error");
				return;
			}
			updateWidget(ctx, next);
			ctx.ui.notify(
				`Promoted to batch — ${next.batch.laneCount} lanes, ${next.batch.waves.length} waves, ${next.batch.tasksTotal} tasks.`,
				"info",
			);
		},
	});

	pi.registerCommand("mission-abort", {
		description: "Abort the active batch mission",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const current = getState();
			if (!current?.batch) {
				ctx.ui.notify(MISSION_MESSAGES.abortNoBatch(), "warning");
				return;
			}
			const reason = args.trim() || "aborted by operator";
			const laneCount = current.batch.laneStatuses.length;
			const next = await engine.handlers.abort(reason);
			if (next) updateWidget(ctx, next);
			ctx.ui.notify(MISSION_MESSAGES.abortComplete("graceful", laneCount), "info");
		},
	});

	pi.registerCommand("mission-batch-resume", {
		description: "Resume a paused batch mission",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const current = getState();
			if (!current?.batch) {
				ctx.ui.notify("No batch mission to resume.", "warning");
				return;
			}
			if (current.batch.phase !== "paused") {
				ctx.ui.notify(`Batch is not paused (phase: ${current.batch.phase}).`, "info");
				return;
			}
			const next = await engine.handlers.resume();
			if (next) updateWidget(ctx, next);
			ctx.ui.notify("Batch mission resumed.", "info");
		},
	});

	pi.registerCommand("mission-batch-pause", {
		description: "Pause the active batch mission",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const current = getState();
			if (!current?.batch) {
				ctx.ui.notify(MISSION_MESSAGES.pauseNoBatch(), "warning");
				return;
			}
			if (current.batch.phase !== "running") {
				ctx.ui.notify(MISSION_MESSAGES.pauseAlreadyPaused(current.batch.batchId), "info");
				return;
			}
			const next = await engine.handlers.pause();
			if (next) updateWidget(ctx, next);
			ctx.ui.notify(MISSION_MESSAGES.pauseActivated(current.batch.batchId), "info");
		},
	});

	pi.registerCommand("mission-sessions", {
		description: "List active mission lanes",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const sessions = listMissionSessions(getState());
			ctx.ui.notify(formatMissionSessions(sessions), "info");
		},
	});

	pi.registerCommand("mission-deps", {
		description: "Show dependency graph: /mission-deps <areas|all> [--task <id>]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const report = buildMissionDepsReport(process.cwd(), args, getState());
			ctx.ui.notify(report.message, report.level);
		},
	});

	// Hydrate persisted batch on session start; pause running batch on end.
	pi.on("session_start", async () => {
		try {
			await engine.hooks.onSessionStart();
		} catch (err) {
			logger.error("[pi-mission] engine.onSessionStart failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	pi.on("session_shutdown", async () => {
		try {
			await engine.hooks.onSessionEnd();
		} catch (err) {
			logger.error("[pi-mission] engine.onSessionEnd failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	// Persistent reviewer tool — self-gates on REVIEWER_SIGNAL_DIR env var,
	// so this is a no-op in non-review agent contexts.
	reviewerExtension(pi);
}
