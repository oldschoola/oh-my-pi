// src/widget.ts — Single-line mission status bar rendered above the editor.
//
// Renders a custom `Component` instead of the `Text` helper because the bar
// packs multiple ANSI foreground colors into a single line. `Text` would
// pass that string through `wrapTextWithAnsi`, which can chop mid-SGR and
// leak raw `[38;...m` characters into the terminal. By truncating with
// `truncateToWidth` (ANSI-aware) before applying the background, we keep
// the bar on exactly one row and never produce malformed escape sequences.

import type { ExtensionContext, ExtensionUiComponent, ExtensionUiComponentFactory } from "@oh-my-pi/pi-coding-agent";
import { type Component, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { AutonomyLevel, MissionPhase, MissionState } from "./types";
import { formatDuration, truncate } from "./utils";

// ---------------------------------------------------------------------------
// Shape of the context we consume. Only `ui` is required; contexts without
// `model` (minimal mocks in tests) still render the bar.
// ---------------------------------------------------------------------------

export interface MissionWidgetCtx {
	ui: ExtensionContext["ui"];
	model?: ExtensionContext["model"];
}

// ---------------------------------------------------------------------------
// Internal State
// ---------------------------------------------------------------------------

/** Stored timeout ref so we can cancel auto-clear on reset/new mission. */
let widgetClearTimeout: NodeJS.Timeout | undefined;

/**
 * Auto-retry status for a mission waiting on a transient-error retry.
 * Keyed by `state.startedAt` (unique-per-mission ISO timestamp) so each
 * mission's retry banner is independent — ending a retry on one session
 * does not clear another session's ongoing retry.
 */
interface RetryStatus {
	attempt: number;
	maxAttempts: number;
	/** Monotonic timestamp (ms) when the retry delay will elapse. */
	endsAtMs: number;
	errorMessage: string;
}

const retryStatuses = new Map<string, RetryStatus>();
let retryTickInterval: NodeJS.Timeout | undefined;
let elapsedTickInterval: NodeJS.Timeout | undefined;
let lastCtx: MissionWidgetCtx | null = null;
let lastState: MissionState | null = null;

// ---------------------------------------------------------------------------
// Retry Status API
// ---------------------------------------------------------------------------

export function setRetryStatus(
	ctx: MissionWidgetCtx,
	state: MissionState | null,
	info: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string },
): void {
	if (state) {
		retryStatuses.set(state.startedAt, {
			attempt: info.attempt,
			maxAttempts: info.maxAttempts,
			endsAtMs: Date.now() + info.delayMs,
			errorMessage: info.errorMessage,
		});
		startRetryTicker();
	}
	updateWidget(ctx, state);
}

export function clearRetryStatus(ctx: MissionWidgetCtx, state: MissionState | null): void {
	if (state) {
		retryStatuses.delete(state.startedAt);
	}
	if (retryStatuses.size === 0) {
		stopRetryTicker();
	}
	updateWidget(ctx, state);
}

function startRetryTicker(): void {
	if (retryTickInterval) return;
	retryTickInterval = setInterval(() => {
		if (retryStatuses.size === 0) {
			stopRetryTicker();
			return;
		}
		if (lastCtx) updateWidget(lastCtx, lastState);
	}, 1000);
}

function stopRetryTicker(): void {
	if (retryTickInterval) {
		clearInterval(retryTickInterval);
		retryTickInterval = undefined;
	}
}

// ---------------------------------------------------------------------------
// Elapsed-time ticker — refreshes the bar every 5s for in-flight missions.
// ---------------------------------------------------------------------------

function startElapsedTicker(): void {
	stopElapsedTicker();
	elapsedTickInterval = setInterval(() => {
		const state = lastState;
		if (!state || state.completedAt || state.paused) {
			stopElapsedTicker();
			return;
		}
		if (lastCtx) updateWidget(lastCtx, state);
	}, 5000);
}

function stopElapsedTicker(): void {
	if (elapsedTickInterval) {
		clearInterval(elapsedTickInterval);
		elapsedTickInterval = undefined;
	}
}

// ---------------------------------------------------------------------------
// Widget Timer
// ---------------------------------------------------------------------------

/**
 * Start auto-clear timer for completed missions. Clears any existing timer
 * first, then schedules widget removal after 30s.
 */
export function startWidgetTimer(ctx: MissionWidgetCtx, _state: MissionState, callback?: () => void): NodeJS.Timeout {
	if (widgetClearTimeout) {
		clearTimeout(widgetClearTimeout);
		widgetClearTimeout = undefined;
	}

	const timeout = setTimeout(() => {
		ctx.ui.setWidget("mission", undefined);
		widgetClearTimeout = undefined;
		callback?.();
	}, 30_000);

	widgetClearTimeout = timeout;
	return timeout;
}

// ---------------------------------------------------------------------------
// Main Widget Update
// ---------------------------------------------------------------------------

/**
 * Update the mission progress widget. Renders a single-line styled bar
 * above the editor's status line, matching the `statusLineBg` color so it
 * reads as a second status strip. The bar shows the current phase, a
 * progress bar, elapsed time, and the mission description.
 */
export function updateWidget(ctx: MissionWidgetCtx, state: MissionState | null): void {
	lastCtx = ctx;
	lastState = state;

	if (widgetClearTimeout) {
		clearTimeout(widgetClearTimeout);
		widgetClearTimeout = undefined;
	}

	if (!state) {
		stopElapsedTicker();
		ctx.ui.setWidget("mission", undefined);
		return;
	}

	const factory = buildMissionBarFactory(state);
	ctx.ui.setWidget("mission", factory, { placement: "aboveEditor" });

	if (state.completedAt) {
		retryStatuses.delete(state.startedAt);
		if (retryStatuses.size === 0) stopRetryTicker();
		stopElapsedTicker();
		startWidgetTimer(ctx, state);
	} else if (state.paused) {
		stopElapsedTicker();
	} else {
		// Active, running mission — keep elapsed time ticking.
		startElapsedTicker();
	}
}

// ---------------------------------------------------------------------------
// Bar factory + custom Component
// ---------------------------------------------------------------------------

/** The runtime theme type as exposed to extensions (from ExtensionUIContext). */
type Theme = ExtensionContext["ui"]["theme"];

function buildMissionBarFactory(state: MissionState): ExtensionUiComponentFactory {
	return (_tui, theme): ExtensionUiComponent => new MissionBarComponent(theme, state);
}

class MissionBarComponent implements Component {
	#theme: Theme;
	#state: MissionState;

	constructor(theme: Theme, state: MissionState) {
		this.#theme = theme;
		this.#state = state;
	}

	invalidate(): void {
		// Stateless — content is rebuilt fresh every render() from live inputs.
	}

	render(width: number): string[] {
		// Match the editor's border inset so the bar aligns with the native
		// status line rendered inside the editor's top border. The editor's
		// default `editorPaddingX` is 2, plus 1 for the border character.
		const INSET = 3;
		const innerWidth = Math.max(1, width - INSET * 2);

		const raw = buildMissionLine(this.#theme, this.#state);

		// ANSI-aware truncate — never chops mid-SGR, guaranteeing the line
		// is at most `innerWidth` visible cells.
		const truncated = truncateToWidth(raw, innerWidth);
		const visible = visibleWidth(truncated);
		const pad = padding(Math.max(0, innerWidth - visible));
		const gutter = padding(INSET);

		return [this.#theme.bg("statusLineBg", `${gutter}${truncated}${pad}${gutter}`)];
	}
}

// ---------------------------------------------------------------------------
// Line builder
// ---------------------------------------------------------------------------

/**
 * Build the full bar line as a single ANSI-laden string. The caller is
 * responsible for truncating it to fit the terminal width.
 */
function buildMissionLine(theme: Theme, state: MissionState): string {
	if (state.completedAt) {
		const totalMs = new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime();
		const duration = formatDuration(totalMs);
		return (
			`${theme.fg("success", "✓")} ${theme.bold(theme.fg("success", "DONE"))} ` +
			`${theme.fg("statusLineSep", "│")} ${theme.fg("dim", duration)}`
		);
	}

	if (state.paused) {
		const pauseElapsed = state.pausedAt ? formatDuration(Date.now() - new Date(state.pausedAt).getTime()) : "";
		const pauseInfo = pauseElapsed ? ` (${pauseElapsed})` : "";
		return theme.fg("warning", `⏸ PAUSED${pauseInfo}`);
	}

	const activeIdx = state.phases.findIndex(p => p.status === "active");
	const active = activeIdx >= 0 ? state.phases[activeIdx] : undefined;
	const total = state.phases.length;

	// Retry overlay — the current phase is waiting on a transient failure.
	const retry = retryStatuses.get(state.startedAt);
	if (active && retry) {
		const remainingMs = Math.max(0, retry.endsAtMs - Date.now());
		const remaining = formatDuration(remainingMs);
		const retryText = `⏳ ${active.emoji} ${active.name} — retry ${retry.attempt}/${retry.maxAttempts} in ${remaining}`;
		return theme.fg("warning", retryText);
	}

	// Adaptive seed — show “Planning” until the plan phase expands the
	// phase list. With only the single seed `Plan` active, a `Phase 1/1`
	// label would misrepresent the mission as a one-phase job.
	if (active && state.templateKey === "adaptive" && !state.phasesExpanded) {
		const elapsed = formatDuration(Date.now() - new Date(state.startedAt).getTime());
		return (
			`${theme.fg("accent", "🎯")} ${autonomyBadge(theme, state.autonomy)} ` +
			`${theme.fg("statusLineSep", "│")} ${theme.fg("text", "Planning")}: ` +
			`${theme.fg("statusLineModel", `${active.emoji} ${active.name}`)} ` +
			`${theme.fg("statusLineSep", "│")} ${theme.fg("dim", elapsed)}`
		);
	}
	const elapsed = formatDuration(Date.now() - new Date(state.startedAt).getTime());
	const bar = buildProgressBar(theme, state.phases, 16);

	if (!active) {
		// No active phase — fall back to the mission description since there is
		// no phase label or “next” phase to show.
		const desc = truncate(state.description, 80);
		return (
			`${theme.fg("accent", "🎯")} ${autonomyBadge(theme, state.autonomy)} ` +
			`${theme.fg("statusLineSep", "│")} ${theme.fg("text", desc)} ` +
			`${theme.fg("statusLineSep", "│")} ${bar} ` +
			`${theme.fg("statusLineSep", "│")} ${theme.fg("dim", elapsed)}`
		);
	}

	const phaseLabel = `Phase ${activeIdx + 1}/${total}`;
	const nextPhase = state.phases[activeIdx + 1];
	const nextSegment = nextPhase
		? ` ${theme.fg("statusLineSep", "│")} ${theme.fg("dim", `Next: ${nextPhase.emoji} ${nextPhase.name}`)}`
		: "";
	return (
		`${theme.fg("accent", "🎯")} ${autonomyBadge(theme, state.autonomy)} ` +
		`${theme.fg("statusLineSep", "│")} ${theme.fg("text", phaseLabel)}: ` +
		`${theme.fg("statusLineModel", `${active.emoji} ${active.name}`)} ` +
		`${theme.fg("statusLineSep", "│")} ${bar}${nextSegment} ` +
		`${theme.fg("statusLineSep", "│")} ${theme.fg("dim", elapsed)}`
	);
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

/**
 * Build a fixed-width block-style progress bar. Each phase contributes one
 * or more segments, colored by status.
 */
function buildProgressBar(theme: Theme, phases: MissionPhase[], width: number): string {
	if (phases.length === 0) return "";
	const perPhase = Math.max(1, Math.floor(width / phases.length));
	const parts: string[] = [];
	for (const phase of phases) {
		parts.push(colorSegment(theme, phase.status, "█".repeat(perPhase)));
	}
	return parts.join("");
}

function colorSegment(theme: Theme, status: MissionPhase["status"], text: string): string {
	switch (status) {
		case "done":
			return theme.fg("success", text);
		case "active":
			return theme.fg("accent", text);
		case "skipped":
			return theme.fg("dim", text);
		default:
			return theme.fg("borderMuted", text);
	}
}

// ---------------------------------------------------------------------------
// Autonomy badge
// ---------------------------------------------------------------------------

/**
 * Small label showing the mission's current autonomy level. Colored so that
 * more-autonomous modes read as warmer/brighter, matching their meaning.
 */
function autonomyBadge(theme: Theme, autonomy: AutonomyLevel): string {
	const color: Parameters<Theme["fg"]>[0] =
		autonomy === "auto" ? "success" : autonomy === "high" ? "accent" : autonomy === "medium" ? "text" : "warning";
	return theme.fg(color, autonomy.toUpperCase());
}
