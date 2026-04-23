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

import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { registerAgentBridge } from "./agent-bridge";
import { registerMissionCommands } from "./commands";
import { resolvePhaseRole } from "./config";
import { detectMilestonePhases, detectPhaseTransition, detectProposedPhases } from "./detector";
import { bindMissionServer } from "./mission-server-binding";
import type { PersistedBatchState } from "./missioncontrol";
import {
	buildIntegrationExecutor,
	buildMissionDepsReport,
	buildMissionPlanReport,
	createEngine,
	formatMissionSessions,
	getCurrentBranch,
	listMissionSessions,
	loadBatchState,
	MISSION_MESSAGES,
	parseIntegrateArgs,
	parseResumeArgs,
	resolveIntegrationContext,
	resolveOperatorId,
	reviewerExtension,
	runGit,
} from "./missioncontrol";
import { maybeSwitchModel } from "./model-switch";
import { buildMissionProtocol, buildMissionStatus } from "./protocol";
import {
	addProgressEvent,
	advancePhase,
	expandPhases,
	restoreMissionState,
	saveMissionState,
	writeMissionToDisk,
} from "./state";
import registerSupervisorTools from "./supervisor-tools";
import { redactEvent } from "./telemetry/redaction";
import type { SidecarEvent } from "./telemetry/sidecar";
import type { MissionState } from "./types";
import { extractRawTextFromMessage, extractTextFromMessage } from "./utils";
import { clearRetryStatus, type MissionWidgetCtx, setRetryStatus, updateWidget } from "./widget";

// ---------------------------------------------------------------------------
// Simple-mission telemetry accumulator
//
// Batch missions get per-lane telemetry written by `missioncontrol/agent-host.ts`.
// Simple missions run inside the coding-agent's main turn loop where no such
// writer exists — so we tally usage from `message_end` + `tool_execution_start`
// and mirror the same on-disk `exit-summary.json` shape the dashboard consumes.
//
// Mission ID "active-session" matches the filename `state.ts` writes for the
// active simple mission, so the dashboard resolves telemetry through the same
// handle it already uses to render the mission row.
// ---------------------------------------------------------------------------

const ACTIVE_SIMPLE_MISSION_ID = "active-session";
const SIDECAR_EVENT_CAP = 500;

interface TelemetryAccumulator {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	toolCalls: number;
	lastToolCall: string | null;
	contextPct: number | null;
	retries: number;
	retryActive: boolean;
	lastRetryError: string | null;
	compactions: number;
	startTime: number;
}

function emptyTelemetry(): TelemetryAccumulator {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		toolCalls: 0,
		lastToolCall: null,
		contextPct: null,
		retries: 0,
		retryActive: false,
		lastRetryError: null,
		compactions: 0,
		startTime: Date.now(),
	};
}

let telemetry: TelemetryAccumulator = emptyTelemetry();

/**
 * Zero the accumulator, reset the start timestamp, and truncate the worker.jsonl
 * sidecar. Called from `commands.ts` whenever a new mission begins so per-mission
 * totals and event feed don’t inherit carryover from a prior run in the same process.
 */
export function resetTelemetry(cwd?: string): void {
	telemetry = emptyTelemetry();
	if (cwd) {
		// Truncate worker.jsonl so the EventFeed starts clean. The exit-summary.json
		// file is overwritten on the next message_end, so no explicit reset needed.
		void Bun.write(workerSidecarPath(cwd), "").catch(err =>
			logger.error("[pi-mission] sidecar reset failed", {
				error: err instanceof Error ? err.message : String(err),
			}),
		);
	}
}

function telemetryDir(cwd: string): string {
	return path.join(cwd, ".omp", "mission-telemetry", ACTIVE_SIMPLE_MISSION_ID);
}

function workerSidecarPath(cwd: string): string {
	return path.join(telemetryDir(cwd), "worker.jsonl");
}

/**
 * Mirror the current accumulator to `.omp/mission-telemetry/<id>/exit-summary.json`.
 * Shape matches `agent-host.ts` so the dashboard’s single mapper in
 * `dashboard-api.ts` handles both writers. Best-effort — write failures are
 * logged and swallowed so telemetry never blocks mission progress.
 */
async function writeSimpleMissionTelemetry(cwd: string): Promise<void> {
	const totalTokens =
		telemetry.inputTokens + telemetry.outputTokens + telemetry.cacheReadTokens + telemetry.cacheWriteTokens;
	const summary = {
		tokens:
			totalTokens > 0
				? {
						input: telemetry.inputTokens,
						output: telemetry.outputTokens,
						cacheRead: telemetry.cacheReadTokens,
						cacheWrite: telemetry.cacheWriteTokens,
					}
				: null,
		cost: telemetry.costUsd > 0 ? telemetry.costUsd : null,
		toolCalls: telemetry.toolCalls,
		durationSec: Math.round((Date.now() - telemetry.startTime) / 1000),
		lastToolCall: telemetry.lastToolCall,
		contextPct: telemetry.contextPct,
		retries: telemetry.retries,
		retryActive: telemetry.retryActive,
		lastRetryError: telemetry.lastRetryError,
		compactions: telemetry.compactions,
	};
	await Bun.write(path.join(telemetryDir(cwd), "exit-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

/**
 * Append a redacted event to `worker.jsonl` for the EventFeed. Caps the file at
 * SIDECAR_EVENT_CAP lines — older entries roll off the front so long missions don’t
 * grow unbounded. Best-effort; failures are logged.
 */
async function appendWorkerEvent(cwd: string, event: SidecarEvent): Promise<void> {
	const filePath = workerSidecarPath(cwd);
	const existing = Bun.file(filePath);
	let prior = "";
	try {
		prior = await existing.text();
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	const redacted = redactEvent(event);
	const line = `${JSON.stringify({ ...redacted, ts: Date.now() })}\n`;
	const combined = prior + line;
	const lines = combined.split("\n");
	const trimmed =
		lines.length - 1 > SIDECAR_EVENT_CAP
			? `${lines.slice(lines.length - 1 - SIDECAR_EVENT_CAP).join("\n")}`
			: combined;
	await Bun.write(filePath, trimmed);
}

function logSidecarError(err: unknown): void {
	logger.error("[pi-mission] sidecar append failed", {
		error: err instanceof Error ? err.message : String(err),
	});
}

function accumulateAssistantUsage(message: { role: string; usage?: unknown } | undefined): boolean {
	if (!message || message.role !== "assistant") return false;
	const usage = message.usage as
		| { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } | number }
		| undefined;
	if (!usage) return false;
	telemetry.inputTokens += usage.input ?? 0;
	telemetry.outputTokens += usage.output ?? 0;
	telemetry.cacheReadTokens += usage.cacheRead ?? 0;
	telemetry.cacheWriteTokens += usage.cacheWrite ?? 0;
	const cost = usage.cost;
	if (typeof cost === "number") {
		telemetry.costUsd += cost;
	} else if (cost && typeof cost === "object" && typeof cost.total === "number") {
		telemetry.costUsd += cost.total;
	}
	// Any successful message_end implicitly resolves an active retry.
	telemetry.retryActive = false;
	return true;
}

/**
 * Summarise `event.args` into a short, human-readable preview. Non-string args
 * are skipped — `read`, `edit`, `bash`, `grep`, `find` all pass a primary string
 * as their first value, which is what operators care about in the dashboard.
 */
function toolArgPreview(args: unknown, maxLen = 80): string | null {
	if (typeof args === "string") {
		return args.length > maxLen ? `${args.slice(0, maxLen)}…` : args;
	}
	if (args && typeof args === "object") {
		for (const value of Object.values(args as Record<string, unknown>)) {
			if (typeof value === "string" && value.length > 0) {
				return value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export default function missionExtension(pi: ExtensionAPI): void {
	let mission: MissionState | null = null;
	let lastCtx: MissionWidgetCtx | null = null;

	const getState = () => mission;
	const setState = (s: MissionState | null) => {
		mission = s;
	};
	const getCtx = () => lastCtx;

	// -------------------------------------------------------------------
	// Session lifecycle — restore persisted state on any session change
	// -------------------------------------------------------------------

	/** Shared restore logic for all session lifecycle events. */
	function restoreFromSession(ctx: Pick<ExtensionContext, "ui" | "sessionManager">, source: string): void {
		lastCtx = ctx;
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
			if (!mission) return;

			// Accumulate simple-mission telemetry first so token/cost numbers keep
			// advancing even while the phase-detection logic below early-returns
			// for paused/completed missions.
			if (!mission.completedAt) {
				const usageAccumulated = accumulateAssistantUsage(event.message);
				// Capture the live context window utilisation — the TelemetryPanel
				// surfaces this so operators see “worker is about to compact” before
				// it happens.
				const ctxUsage = ctx.getContextUsage();
				if (ctxUsage && typeof ctxUsage.percent === "number") {
					telemetry.contextPct = ctxUsage.percent;
				}
				if (usageAccumulated) {
					const cwd = ctx.cwd;
					writeSimpleMissionTelemetry(cwd).catch(err =>
						logger.error("[pi-mission] telemetry write failed", {
							error: err instanceof Error ? err.message : String(err),
						}),
					);
					if (event.message.role === "assistant") {
						appendWorkerEvent(cwd, {
							type: "message_end",
							role: event.message.role,
							text: extractTextFromMessage(event.message).slice(0, 400),
							usage: event.message.usage ?? null,
							contextPct: telemetry.contextPct,
						}).catch(logSidecarError);
					}
				}
			}

			if (mission.completedAt || mission.paused) return;
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
				writeMissionToDisk(ctx.cwd, mission).catch(err =>
					logger.error("[pi-mission] disk mirror failed", {
						error: err instanceof Error ? err.message : String(err),
					}),
				);

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
							{ deliverAs: "followUp" },
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
	// Tool-call counter for simple-mission telemetry.
	// Batch runs have `agent-host.ts` doing this job; simple runs need the
	// same signal so the dashboard Tool Calls stat advances in real time.
	// -------------------------------------------------------------------

	pi.on("tool_execution_start", async (event, ctx) => {
		try {
			if (!mission || mission.completedAt) return;
			telemetry.toolCalls += 1;
			const preview = toolArgPreview(event.args);
			if (event.toolName) {
				telemetry.lastToolCall = preview ? `${event.toolName} ${preview}` : event.toolName;
			}
			writeSimpleMissionTelemetry(ctx.cwd).catch(err =>
				logger.error("[pi-mission] telemetry write failed", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
			appendWorkerEvent(ctx.cwd, {
				type: "tool_execution_start",
				toolName: event.toolName,
				argsPreview: preview,
			}).catch(logSidecarError);
		} catch (err) {
			logger.error("[pi-mission] tool_execution_start failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	// tool_execution_end — fires when a tool finishes. Surface its error status
	// on the event feed so operators see failed tool calls without opening the
	// TUI.
	pi.on("tool_execution_end", async (event, ctx) => {
		try {
			if (!mission || mission.completedAt) return;
			appendWorkerEvent(ctx.cwd, {
				type: "tool_execution_end",
				toolName: event.toolName,
				isError: event.isError,
			}).catch(logSidecarError);
		} catch (err) {
			logger.error("[pi-mission] tool_execution_end failed", {
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
			// Mirror retry into the telemetry accumulator + sidecar so the dashboard
			// can render a retry badge alongside the in-TUI widget.
			telemetry.retries += 1;
			telemetry.retryActive = true;
			telemetry.lastRetryError = event.errorMessage || null;
			writeSimpleMissionTelemetry(ctx.cwd).catch(err =>
				logger.error("[pi-mission] telemetry write failed", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
			appendWorkerEvent(ctx.cwd, {
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			}).catch(logSidecarError);
		} catch (err) {
			logger.error("[pi-mission] auto_retry_start failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	pi.on("auto_retry_end", async (event, ctx) => {
		try {
			if (!mission) return;
			clearRetryStatus(ctx, mission);
			telemetry.retryActive = false;
			writeSimpleMissionTelemetry(ctx.cwd).catch(err =>
				logger.error("[pi-mission] telemetry write failed", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
			appendWorkerEvent(ctx.cwd, {
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
			}).catch(logSidecarError);
		} catch (err) {
			logger.error("[pi-mission] auto_retry_end failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	// Auto-compaction — fired whenever the agent reclaims context. Bump the
	// counter so operators see how many compactions a mission consumed.
	pi.on("auto_compaction_start", async (event, ctx) => {
		try {
			if (!mission || mission.completedAt) return;
			telemetry.compactions += 1;
			writeSimpleMissionTelemetry(ctx.cwd).catch(err =>
				logger.error("[pi-mission] telemetry write failed", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
			appendWorkerEvent(ctx.cwd, {
				type: "auto_compaction_start",
				reason: event.reason,
				action: event.action,
			}).catch(logSidecarError);
		} catch (err) {
			logger.error("[pi-mission] auto_compaction_start failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

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

	// -------------------------------------------------------------------
	// Register all /mission* commands
	// -------------------------------------------------------------------

	registerMissionCommands(pi, getState, setState, process.cwd(), engine.handlers.batch);

	// Wire the dashboard server's HTTP hooks + default GUI bridge.
	bindMissionServer({
		pi,
		cwd: process.cwd(),
		getState,
		setState,
		getCtx,
		engineHandlers: {
			pause: engine.handlers.pause,
			resume: engine.handlers.resume,
		},
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
		description: "Resume a paused batch mission (/mission-batch-resume [--force])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsed = parseResumeArgs(args);
			if ("error" in parsed) {
				ctx.ui.notify(parsed.error, "info");
				return;
			}
			const current = getState();
			if (!current?.batch) {
				ctx.ui.notify("No batch mission to resume.", "warning");
				return;
			}
			if (!parsed.force && current.batch.phase !== "paused") {
				ctx.ui.notify(`Batch is not paused (phase: ${current.batch.phase}). Use --force to override.`, "info");
				return;
			}
			const next = await engine.handlers.resume({ force: parsed.force });
			if (next) updateWidget(ctx, next);
			ctx.ui.notify(parsed.force ? "Batch mission resumed (forced)." : "Batch mission resumed.", "info");
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

	pi.registerCommand("mission-plan", {
		description: "Preview wave plan: /mission-plan <areas|all> [--refresh]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				const report = buildMissionPlanReport(process.cwd(), args, getState());
				ctx.ui.notify(report.message, report.level);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`/mission-plan failed: ${msg}`, "error");
			}
		},
	});

	pi.registerCommand("mission-resume", {
		description: "Resume a paused or interrupted batch mission (/mission-resume [--force])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsed = parseResumeArgs(args);
			if ("error" in parsed) {
				ctx.ui.notify(parsed.error, "info");
				return;
			}
			const current = getState();
			if (!current?.batch) {
				ctx.ui.notify("No batch mission to resume.", "warning");
				return;
			}
			if (!parsed.force && current.batch.phase !== "paused") {
				ctx.ui.notify(`Batch is not paused (phase: ${current.batch.phase}). Use --force to override.`, "info");
				return;
			}
			const next = await engine.handlers.resume({ force: parsed.force });
			if (next) updateWidget(ctx, next);
			ctx.ui.notify(parsed.force ? "Batch mission resumed (forced)." : "Batch mission resumed.", "info");
		},
	});

	pi.registerCommand("mission-integrate", {
		description:
			"Integrate a completed batch into the working branch (/mission-integrate [--merge|--pr] [--force] [<mission-branch>])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			if (trimmed === "--help" || trimmed === "-h") {
				ctx.ui.notify(
					"Usage: /mission-integrate [<mission-branch>] [--merge] [--pr] [--force]\n\n" +
						"Integrate a completed batch into your working branch.\n\n" +
						"Modes:\n" +
						"  (default)   Fast-forward merge (cleanest history)\n" +
						"  --merge     Create a real merge commit\n" +
						"  --pr        Push mission branch and open a pull request\n\n" +
						"Options:\n" +
						"  --force     Skip branch safety check\n" +
						"  <branch>    Mission branch name (auto-detected from batch state if omitted)\n\n" +
						"Examples:\n" +
						"  /mission-integrate                          Auto-detect and fast-forward\n" +
						"  /mission-integrate --merge                  Auto-detect with merge commit\n" +
						"  /mission-integrate orch/batch-1 --pr        Specific branch, create PR\n" +
						"  /mission-integrate --force                  Skip branch safety check",
					"info",
				);
				return;
			}

			const parsed = parseIntegrateArgs(args);
			if ("error" in parsed) {
				ctx.ui.notify(`${parsed.error}\n\nRun /mission-integrate --help for usage.`, "error");
				return;
			}

			const cwd = ctx.cwd ?? process.cwd();

			let batchState: PersistedBatchState | null = null;
			try {
				batchState = await loadBatchState(cwd);
			} catch (err) {
				ctx.ui.notify(
					`Failed to load batch state: ${err instanceof Error ? err.message : String(err)}\n\n` +
						"You can still integrate by naming the branch: /mission-integrate <mission-branch>",
					"error",
				);
				return;
			}

			const resolution = resolveIntegrationContext(parsed, {
				loadBatchState: () => batchState,
				getCurrentBranch: () => getCurrentBranch(cwd),
				listOrchBranches: () => {
					const result = runGit(["branch", "--list", "orch/*"], cwd);
					if (!result.ok) return [];
					return result.stdout
						.split("\n")
						.map((b: string) => b.replace(/^\*?\s+/, "").trim())
						.filter(Boolean);
				},
				orchBranchExists: (branch: string) => runGit(["rev-parse", "--verify", `refs/heads/${branch}`], cwd).ok,
			});

			if ("error" in resolution) {
				ctx.ui.notify(resolution.error, resolution.severity === "info" ? "info" : "error");
				return;
			}

			const opId = resolveOperatorId();
			const executor = buildIntegrationExecutor(cwd, opId, cwd);
			const result = executor(parsed.mode, resolution);

			if (result.success) {
				ctx.ui.notify(result.message || "Integration complete.", "info");
			} else {
				ctx.ui.notify(result.error ?? result.message ?? "Integration failed.", "error");
			}
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

	// Worker-side agent bridge — self-gates on MISSION_AGENT_ID +
	// MISSION_OUTBOX_DIR env vars, so this is a no-op outside lane-runner
	// spawned worker/reviewer/merger agent processes.
	registerAgentBridge(pi);

	// Supervisor-side orch_* tools — referenced by the supervisor prompt
	// templates. Self-gate on NOT being a worker process (MISSION_AGENT_ID
	// is only set on lane-runner-spawned workers).
	if (!process.env.MISSION_AGENT_ID) {
		registerSupervisorTools(pi, getState, setState, process.cwd(), engine);
	}
}
