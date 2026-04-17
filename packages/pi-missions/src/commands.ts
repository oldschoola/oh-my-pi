// src/commands.ts — 7 command handlers + Ctrl+Shift+M shortcut

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type { MissionControlCallbacks, MissionControlResult } from "./mission-control";
import { showMissionControl } from "./mission-control";
import { buildMissionStatusReport } from "./missioncontrol";
import { maybeSwitchModel } from "./model-switch";
import { runMissionPlanner } from "./planner";
import {
	addProgressEvent,
	advancePhase,
	completeMission,
	pauseMission,
	resumeMission,
	saveMissionState,
} from "./state";
import type { MissionState } from "./types";
import { formatDuration, getPhaseIcon } from "./utils";
import { updateWidget } from "./widget";

// ---------------------------------------------------------------------------
// Main registration function
// ---------------------------------------------------------------------------

export function registerMissionCommands(
	pi: ExtensionAPI,
	getState: () => MissionState | null,
	setState: (s: MissionState | null) => void,
): void {
	// Helper: persist + update widget after every state change
	function persist(ctx: Pick<ExtensionCommandContext, "ui">, state: MissionState): void {
		setState(state);
		saveMissionState(pi, state);
		updateWidget(ctx, state);
	}

	// -----------------------------------------------------------------------
	// 1. /mission — Start new mission or show quick status
	// -----------------------------------------------------------------------

	pi.registerCommand("mission", {
		description: "Start a new orchestrated mission or show quick status of the active one",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				const description = args.trim();
				const state = getState();

				// No args + no mission → usage
				if (!description && !state) {
					ctx.ui.notify("Usage: /mission <description of what to build/fix>", "warning");
					return;
				}

				// No args + running mission → quick status notification.
				// Paused/completed missions still let the user start a new one.
				if (!description && state && !state.completedAt && !state.paused) {
					const elapsed = formatDuration(Date.now() - new Date(state.startedAt).getTime());

					const active = state.phases.find(p => p.status === "active");
					const phaseIdx = active ? state.phases.indexOf(active) + 1 : state.phases.length;
					ctx.ui.notify(
						`Active: ${state.description} (${elapsed})\n` +
							`Phase ${phaseIdx}/${state.phases.length}: ${active?.emoji ?? "✅"} ${active?.name ?? "Done"}`,
						"info",
					);
					return;
				}

				// No args + stale state (completed or paused) — show status and stop.
				// Without this branch, the planner runs with an empty description.
				if (!description && state) {
					const label = state.completedAt ? "completed" : "paused";
					ctx.ui.notify(
						`Mission "${state.description}" is ${label}. Use /mission <description> to start a new one, or /mission-reset to clear.`,
						"info",
					);
					return;
				}

				// Has args + truly running mission → confirm overwrite. Paused or
				// completed missions are stale state and shouldn't gate a new start.
				if (description && state && !state.completedAt && !state.paused) {
					const ok = await ctx.ui.confirm(
						"Active Mission",
						`There's already an active mission:\n"${state.description}"\n\nStart a new one?`,
					);
					if (!ok) return;
				}

				// Auto-clear stale state (completed missions or lingering paused
				// state) before starting a new mission so widgets/footer don't
				// keep showing the old one mid-restart.
				if (description && state && (state.completedAt || state.paused)) {
					setState(null);
					pi.appendEntry("mission-state", null);
					updateWidget(ctx, null);
				}

				// Has args → run planner questionnaire, then kick off
				const newState = await runMissionPlanner(ctx, description);
				if (!newState) {
					// User cancelled the planner
					ctx.ui.notify("Operation aborted", "info");
					return;
				}

				persist(ctx, newState);

				// Build kick-off message based on mode
				const firstPhase = newState.phases.find(p => p.status === "active");
				const kickoff =
					`Run an orchestrated mission for: ${description}\n\n` +
					`Start with Phase 1 (${firstPhase?.name ?? "Plan"}): ` +
					"Analyze the codebase and produce a detailed implementation plan. " +
					"Present the plan for my approval before implementing.";

				pi.sendUserMessage(kickoff);
				pi.setSessionName(`🎯 ${description}`);
				ctx.ui.notify(`🚀 Mission started: ${description}`, "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("[pi-mission] /mission failed", { error: message });
				ctx.ui.notify(`Error in /mission: ${message}`, "error");
			}
		},
	});

	// -----------------------------------------------------------------------
	// 2. /mission-status — Detailed status via ctx.ui.select()
	// -----------------------------------------------------------------------

	pi.registerCommand("mission-status", {
		description: "Show detailed mission status with phase/milestone durations",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			try {
				const state = getState();
				if (!state) {
					ctx.ui.notify("No active mission. Use /mission <description> to start one.", "info");
					return;
				}

				const elapsed = formatDuration(Date.now() - new Date(state.startedAt).getTime());
				const lines: string[] = [
					`Mission: ${state.description}`,
					`Mode: ${state.mode}`,
					`Elapsed: ${elapsed}`,
					`Autonomy: ${state.autonomy}`,
				];

				// Model assignment
				const models = Object.entries(state.modelAssignment);
				if (models.length > 0) {
					lines.push("");
					lines.push("Model Assignment:");
					for (const [role, model] of models) {
						lines.push(`  ${role} → ${model}`);
					}
				}

				if (state.completedAt) {
					const totalDuration = formatDuration(
						new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime(),
					);
					lines.push(`Completed in: ${totalDuration}`);
				}

				lines.push("");

				lines.push("Phases:");
				for (let i = 0; i < state.phases.length; i++) {
					const p = state.phases[i];
					const icon = getPhaseIcon(p.status);
					let dur = "";
					if (p.startedAt && p.completedAt) {
						dur = ` (${formatDuration(new Date(p.completedAt).getTime() - new Date(p.startedAt).getTime())})`;
					} else if (p.startedAt) {
						dur = ` (${formatDuration(Date.now() - new Date(p.startedAt).getTime())} elapsed)`;
					}
					lines.push(`  ${icon} Phase ${i + 1}: ${p.emoji} ${p.name}${dur}`);
				}

				if (state.batch) {
					const batchReport = buildMissionStatusReport(state);
					lines.push("");
					for (const line of batchReport.message.split("\n")) lines.push(line);
				}

				await ctx.ui.select("Mission Status", lines);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("[pi-mission] /mission-status failed", { error: message });
				ctx.ui.notify(`Error in /mission-status: ${message}`, "error");
			}
		},
	});

	// -----------------------------------------------------------------------
	// 3. /mission-skip — Skip current phase
	// -----------------------------------------------------------------------

	pi.registerCommand("mission-skip", {
		description: "Skip the current phase or feature",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			try {
				let state = getState();
				if (!state || state.completedAt) {
					ctx.ui.notify("No active mission phase/feature to skip.", "warning");
					return;
				}

				const activePhase = state.phases.find(p => p.status === "active");
				if (!activePhase) {
					ctx.ui.notify("No active phase to skip.", "warning");
					return;
				}

				const ok = await ctx.ui.confirm("Skip Phase", `Skip "${activePhase.name}" phase?`);
				if (!ok) return;

				let { state: advanced, completedPhaseName } = advancePhase(state, "skipped");
				if (completedPhaseName) {
					advanced = addProgressEvent(advanced, "phase_complete", `Skipped phase: ${completedPhaseName}`);
				}
				state = advanced;
				persist(ctx, state);

				const nextPhase = state.phases.find(p => p.status === "active");
				if (state.completedAt) {
					pi.setSessionName(`✅ ${state.description}`);
					ctx.ui.notify("🎉 Mission complete!", "info");
				} else {
					ctx.ui.notify(`Skipped → ${nextPhase?.emoji ?? "📋"} ${nextPhase?.name ?? "—"}`, "info");
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("[pi-mission] /mission-skip failed", { error: message });
				ctx.ui.notify(`Error in /mission-skip: ${message}`, "error");
			}
		},
	});

	// -----------------------------------------------------------------------
	// 4. /mission-done — Mark mission complete
	// -----------------------------------------------------------------------

	pi.registerCommand("mission-done", {
		description: "Mark the current mission as complete",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			try {
				const state = getState();
				if (!state) {
					ctx.ui.notify("No active mission.", "warning");
					return;
				}
				if (state.completedAt) {
					ctx.ui.notify("Mission already completed.", "info");
					return;
				}

				const ok = await ctx.ui.confirm(
					"Complete Mission",
					"Mark mission as done? All remaining phases/features will be skipped.",
				);
				if (!ok) return;

				const updated = addProgressEvent(
					completeMission(state),
					"mission_complete",
					"Mission marked complete by user",
				);
				persist(ctx, updated);

				const totalDuration = formatDuration(
					new Date(updated.completedAt ?? new Date().toISOString()).getTime() -
						new Date(state.startedAt).getTime(),
				);

				pi.setSessionName(`✅ ${state.description}`);
				ctx.ui.notify(`🎉 Mission complete! (${totalDuration})`, "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("[pi-mission] /mission-done failed", { error: message });
				ctx.ui.notify(`Error in /mission-done: ${message}`, "error");
			}
		},
	});

	// -----------------------------------------------------------------------
	// 5. /mission-pause — Toggle pause/resume
	// -----------------------------------------------------------------------

	pi.registerCommand("mission-pause", {
		description: "Toggle pause/resume on the current mission",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			try {
				const state = getState();
				if (!state) {
					ctx.ui.notify("No active mission.", "warning");
					return;
				}
				if (state.completedAt) {
					ctx.ui.notify("Mission already completed.", "info");
					return;
				}

				if (state.paused) {
					const updated = addProgressEvent(resumeMission(state), "mission_resume", "Mission resumed");
					persist(ctx, updated);
					ctx.ui.notify("▶ Mission resumed", "info");
				} else {
					const updated = addProgressEvent(pauseMission(state), "mission_pause", "Mission paused");
					persist(ctx, updated);
					ctx.ui.notify("⏸ Mission paused", "info");
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("[pi-mission] /mission-pause failed", { error: message });
				ctx.ui.notify(`Error in /mission-pause: ${message}`, "error");
			}
		},
	});

	// -----------------------------------------------------------------------
	// 6. /mission-next — Manually advance to next phase
	// -----------------------------------------------------------------------

	pi.registerCommand("mission-next", {
		description: "Advance to the next phase (use when auto-detection missed a transition)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			try {
				let state = getState();
				if (!state || state.completedAt) {
					ctx.ui.notify("No active mission phase to advance.", "warning");
					return;
				}

				const activePhase = state.phases.find(p => p.status === "active");
				if (!activePhase) {
					ctx.ui.notify("No active phase to advance.", "warning");
					return;
				}

				let { state: advanced, completedPhaseName } = advancePhase(state, "done");
				if (completedPhaseName) {
					advanced = addProgressEvent(advanced, "phase_complete", `Manually advanced from: ${completedPhaseName}`);
				}
				state = advanced;
				persist(ctx, state);

				const nextPhase = state.phases.find(p => p.status === "active");
				if (state.completedAt) {
					pi.setSessionName(`✅ ${state.description}`);
					ctx.ui.notify("🎉 Mission complete!", "info");
				} else {
					ctx.ui.notify(
						`✅ ${completedPhaseName ?? "phase"} done → ${nextPhase?.emoji ?? "📋"} ${nextPhase?.name ?? "—"}`,
						"info",
					);
					await maybeSwitchModel(pi, state, ctx);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("[pi-mission] /mission-next failed", { error: message });
				ctx.ui.notify(`Error in /mission-next: ${message}`, "error");
			}
		},
	});

	// -----------------------------------------------------------------------
	// 7. /mission-reset — Clear everything
	// -----------------------------------------------------------------------

	pi.registerCommand("mission-reset", {
		description: "Clear all mission state and widget",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			try {
				const state = getState();
				if (!state) {
					ctx.ui.notify("No mission to reset.", "info");
					return;
				}

				const ok = await ctx.ui.confirm("Reset Mission", "Clear all mission state? This cannot be undone.");
				if (!ok) return;

				setState(null);
				// Persist a null-state marker so restoreMissionState doesn't
				// resurrect the old state on session restart
				pi.appendEntry("mission-state", null);
				ctx.ui.setWidget("mission", undefined);
				pi.setSessionName(""); // Clear session name
				ctx.ui.notify("Mission cleared.", "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("[pi-mission] /mission-reset failed", { error: message });
				ctx.ui.notify(`Error in /mission-reset: ${message}`, "error");
			}
		},
	});

	// -----------------------------------------------------------------------
	// Keyboard shortcut: Ctrl+Shift+M → Mission Control
	// -----------------------------------------------------------------------

	pi.registerShortcut("ctrl+shift+m", {
		description: "Open Mission Control",
		handler: async ctx => {
			try {
				const state = getState();

				// Build callbacks that tie back to state management
				const callbacks: MissionControlCallbacks = {
					onPause: () => {
						const s = getState();
						if (!s || s.completedAt) return;
						const updated = addProgressEvent(
							pauseMission(s),
							"mission_pause",
							"Mission paused via Mission Control",
						);
						setState(updated);
						saveMissionState(pi, updated);
						updateWidget(ctx, updated);
					},
					onResume: () => {
						const s = getState();
						if (!s?.paused) return;
						const updated = addProgressEvent(
							resumeMission(s),
							"mission_resume",
							"Mission resumed via Mission Control",
						);
						setState(updated);
						saveMissionState(pi, updated);
						updateWidget(ctx, updated);
					},
					onSkip: async () => {
						const ok = await ctx.ui.confirm("Skip", "Skip current phase/feature?");
						if (!ok) return false;
						const s = getState();
						if (!s || s.completedAt) return false;

						let { state: updated, completedPhaseName } = advancePhase(s, "skipped");
						if (!completedPhaseName) return false;
						updated = addProgressEvent(
							updated,
							"phase_complete",
							`Skipped ${completedPhaseName} (via Mission Control)`,
						);

						setState(updated);
						saveMissionState(pi, updated);
						updateWidget(ctx, updated);
						if (updated.completedAt) {
							pi.setSessionName(`✅ ${updated.description}`);
						}
						return true;
					},
					onDone: async () => {
						const ok = await ctx.ui.confirm("Complete", "Mark mission as done?");
						if (!ok) return false;
						const s = getState();
						if (!s) return false;

						const updated = addProgressEvent(
							completeMission(s),
							"mission_complete",
							"Mission completed via Mission Control",
						);
						setState(updated);
						saveMissionState(pi, updated);
						updateWidget(ctx, updated);
						pi.setSessionName(`✅ ${s.description}`);
						return true;
					},
					onRedirect: (message: string) => {
						const s = getState();
						if (s) {
							const updated = addProgressEvent(s, "mission_redirect", message);
							setState(updated);
							saveMissionState(pi, updated);
						}
						pi.sendUserMessage(message);
					},
					onModelChange: (role: string, modelId: string) => {
						const s = getState();
						if (!s) return;
						const updated: MissionState = {
							...s,
							modelAssignment: { ...s.modelAssignment, [role]: modelId },
						};
						setState(updated);
						saveMissionState(pi, updated);
					},
				};

				const result: MissionControlResult = await showMissionControl(ctx, state, callbacks, getState);
				// result.action is informational; no further action required here
				void result;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("[pi-mission] mission control failed", { error: message });
				ctx.ui.notify(`Error opening Mission Control: ${message}`, "error");
			}
		},
	});
}
