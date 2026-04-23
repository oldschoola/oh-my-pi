// src/commands.ts — 7 command handlers + Ctrl+Shift+M shortcut

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import { createGuiBridge, type MissionStartRequest } from "./gui-bridge";
import { kickoffMissionFromRequest } from "./kickoff";
import type { MissionControlCallbacks, MissionControlResult } from "./mission-control";
import { showMissionControl } from "./mission-control";
import { buildMissionStatusReport } from "./missioncontrol";
import { maybeSwitchModel } from "./model-switch";
import { runMissionPlanner } from "./planner";
import { startServer } from "./server";

/** Best-effort open a URL in the default browser. Duplicated from coding-agent/utils/open.ts (private). */
function openInBrowser(url: string): void {
	let cmd: string[];
	switch (process.platform) {
		case "darwin":
			cmd = ["open", url];
			break;
		case "win32":
			cmd = ["rundll32", "url.dll,FileProtocolHandler", url];
			break;
		default:
			cmd = ["xdg-open", url];
			break;
	}
	try {
		Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	} catch {}
}

/** Module-scoped singleton so repeated `/mission` and `/mission-gui` calls reuse the dashboard server. */
let dashboardServer: Promise<{ port: number; stop: () => void }> | null = null;
/** Whether the dashboard URL has been opened in the browser this session. */
let dashboardBrowserOpened = false;

async function ensureDashboardServer(): Promise<{ port: number; stop: () => void }> {
	if (!dashboardServer) {
		dashboardServer = startServer({ port: Number.parseInt(process.env.OMP_MISSION_PORT ?? "3848", 10) }).catch(
			err => {
				dashboardServer = null;
				throw err;
			},
		);
	}
	return dashboardServer;
}

/**
 * Start the dashboard server, build a mission-aware URL, and open it in the
 * default browser the first time it is launched in this session. Subsequent
 * calls just notify the URL. Pass `token` for an explicit `/mission-gui`
 * bridge, `viewHint` for a plain `?view=<name>` query string.
 */
async function openDashboardInBrowser(
	ctx: Pick<ExtensionCommandContext, "ui">,
	opts: { viewHint?: string; token?: string } = {},
): Promise<{ url: string; port: number } | null> {
	try {
		const { port } = await ensureDashboardServer();
		let url = `http://localhost:${port}`;
		if (opts.token) {
			url = `${url}/?gui=${encodeURIComponent(opts.token)}`;
		} else if (opts.viewHint) {
			url = `${url}/?view=${encodeURIComponent(opts.viewHint)}`;
		}
		const message = opts.token
			? `🌐 MissionControl: ${url}\nAwaiting mission config from the browser…`
			: opts.viewHint === "start"
				? `🌐 MissionControl: ${url}\nConfigure your mission in the browser.`
				: `Dashboard: ${url}`;
		ctx.ui.notify(message, "info");
		if (!dashboardBrowserOpened) {
			dashboardBrowserOpened = true;
			openInBrowser(url);
		}
		return { url, port };
	} catch (err) {
		logger.error("[pi-mission] openDashboardInBrowser failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		ctx.ui.notify("Could not launch dashboard.", "error");
		return null;
	}
}

import { resetTelemetry } from "./index";
import KICKOFF_TEMPLATE from "./prompts/mission-gui-kickoff.md" with { type: "text" };
import {
	addProgressEvent,
	advancePhase,
	clearMissionOnDisk,
	completeMission,
	pauseMission,
	resumeMission,
	saveMissionState,
	writeMissionToDisk,
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
	cwd: string,
	_batchHandler?: (opts: { laneCount?: number; waveSize?: number; taskIds: string[] }) => Promise<MissionState | null>,
): void {
	// Helper: persist + update widget after every state change
	function persist(ctx: Pick<ExtensionCommandContext, "ui">, state: MissionState): void {
		setState(state);
		saveMissionState(pi, state);
		updateWidget(ctx, state);
		writeMissionToDisk(cwd, state).catch(err =>
			logger.error("[pi-mission] disk mirror failed", { error: err instanceof Error ? err.message : String(err) }),
		);
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

				// No args + no mission → open the dashboard form via the default
				// GUI bridge so the user can configure a mission in the browser.
				if (!description && !state) {
					await openDashboardInBrowser(ctx, { viewHint: "start" });
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
					clearMissionOnDisk(cwd).catch(err =>
						logger.error("[pi-mission] disk clear failed", {
							error: err instanceof Error ? err.message : String(err),
						}),
					);
				}

				// Has args → run planner questionnaire, then kick off
				const newState = await runMissionPlanner(ctx, description);
				if (!newState) {
					// User cancelled the planner
					ctx.ui.notify("Operation aborted", "info");
					return;
				}

				resetTelemetry(cwd);

				persist(ctx, newState);

				// Start dashboard server so the web UI can track real-time progress.
				// Auto-opens the browser the first time a mission is started in this session.
				void openDashboardInBrowser(ctx);

				// Build kick-off message based on mode
				const firstPhase = newState.phases.find(p => p.status === "active");
				const kickoff = KICKOFF_TEMPLATE.replace("{{description}}", description).replace(
					"{{phaseName}}",
					firstPhase?.name ?? "Plan",
				);

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
					const batchReport = await buildMissionStatusReport(state, { cwd: ctx.cwd ?? process.cwd() });
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
				clearMissionOnDisk(cwd).catch(err =>
					logger.error("[pi-mission] disk clear failed", {
						error: err instanceof Error ? err.message : String(err),
					}),
				);
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
						pi.sendUserMessage(message, { deliverAs: "followUp" });
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

	// -----------------------------------------------------------------------
	// 8. /mission-gui — Launch dashboard, configure a mission in the browser,
	//                   then kick it off in this chat session.
	// -----------------------------------------------------------------------

	pi.registerCommand("mission-gui", {
		description:
			"Launch MissionControl in the browser, configure a mission visually, and auto-start it in this session",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const bridge = createGuiBridge();
			try {
				await openDashboardInBrowser(ctx, { token: bridge.token });

				const state = getState();
				if (state && !state.completedAt && !state.paused) {
					const ok = await ctx.ui.confirm(
						"Active Mission",
						`There's already an active mission:\n"${state.description}"\n\nContinue and replace it once the browser form is submitted?`,
					);
					if (!ok) {
						bridge.close();
						ctx.ui.notify("Operation aborted", "info");
						return;
					}
				}

				const req: MissionStartRequest = await bridge.waitForStart();

				// Stale state cleanup mirrors /mission.
				if (state && (state.completedAt || state.paused)) {
					setState(null);
					pi.appendEntry("mission-state", null);
					updateWidget(ctx, null);
					clearMissionOnDisk(cwd).catch(err =>
						logger.error("[pi-mission] disk clear failed", {
							error: err instanceof Error ? err.message : String(err),
						}),
					);
				}

				kickoffMissionFromRequest(pi, cwd, req, s => persist(ctx, s));

				const batchNote =
					req.laneCount && req.laneCount > 1
						? ` Promote to a ${req.laneCount}-lane batch with /mission-batch when ready.`
						: "";
				ctx.ui.notify(`🚀 Mission started from GUI: ${req.description}.${batchNote}`, "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("[pi-mission] /mission-gui failed", { error: message });
				ctx.ui.notify(`Error in /mission-gui: ${message}`, "error");
			} finally {
				bridge.close();
			}
		},
	});

	// -----------------------------------------------------------------------
	// 8. /enter-mission (alias /missions) — Factory-style planning entry point (Track D)
	// -----------------------------------------------------------------------

	const enterMissionHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		try {
			const description = args.trim();
			const state = getState();

			// Bare call with no active mission — open the dashboard's planning view.
			// The planning conversation agent takes over once the operator submits.
			if (!description && !state) {
				await openDashboardInBrowser(ctx, { viewHint: "start" });
				ctx.ui.notify(
					"Opening the mission planning console. The orchestrator will interview you for requirements, then seek approval before any feature work starts.",
					"info",
				);
				return;
			}

			// Same quick-status behaviour as /mission when a mission is running.
			if (!description && state && !state.completedAt && !state.paused) {
				const elapsed = formatDuration(Date.now() - new Date(state.startedAt).getTime());
				ctx.ui.notify(
					`Active mission: ${state.description} (${elapsed}).\n` +
						`Run /mission to see the active phase, or /mission-reset to start fresh before /enter-mission.`,
					"info",
				);
				return;
			}

			if (!description && state) {
				const label = state.completedAt ? "completed" : "paused";
				ctx.ui.notify(
					`Mission "${state.description}" is ${label}. Clear it with /mission-reset then run /enter-mission to plan a new one.`,
					"info",
				);
				return;
			}

			// Description supplied inline — the planning conversation lives in
			// the dashboard; the CLI flow can still kick off a simple mission via
			// the /mission command. Surface a hint instead of branching here so
			// /enter-mission keeps a single "opens the planning console" mental model.
			ctx.ui.notify(
				`/enter-mission opens the planning console for collaborative requirement gathering. ` +
					`To start a one-shot mission with a description, use \`/mission ${description}\` instead.`,
				"info",
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("[pi-mission] /enter-mission failed", { error: message });
			ctx.ui.notify(`Error in /enter-mission: ${message}`, "error");
		}
	};

	pi.registerCommand("enter-mission", {
		description:
			"Start a Factory-style planning conversation. Orchestrator interviews requirements, emits a validation contract, and seeks approval before any feature work.",
		handler: enterMissionHandler,
	});

	pi.registerCommand("missions", {
		description: "Alias of /enter-mission — opens the mission planning console.",
		handler: enterMissionHandler,
	});
}
