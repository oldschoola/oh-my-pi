// src/state.ts — State persistence with TypeBox validation

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ProposedPhase } from "./detector";
import type { MissionPhase, MissionState, ProgressEvent, SessionEntryLike } from "./types";

// ---------------------------------------------------------------------------
// TypeBox Schemas — runtime validation mirrors the MissionState interface
// ---------------------------------------------------------------------------

const MissionPhaseSchema = Type.Object({
	name: Type.String(),
	emoji: Type.String(),
	status: Type.Union([Type.Literal("pending"), Type.Literal("active"), Type.Literal("done"), Type.Literal("skipped")]),
	startedAt: Type.Optional(Type.String()),
	completedAt: Type.Optional(Type.String()),
});

const ProgressEventSchema = Type.Object({
	timestamp: Type.String(),
	type: Type.Union([
		Type.Literal("phase_start"),
		Type.Literal("phase_complete"),
		Type.Literal("mission_pause"),
		Type.Literal("mission_resume"),
		Type.Literal("mission_redirect"),
		Type.Literal("mission_complete"),
	]),
	detail: Type.String(),
});

const PauseEntrySchema = Type.Object({
	pausedAt: Type.String(),
	resumedAt: Type.String(),
});

export const MissionStateSchema = Type.Object({
	description: Type.String(),
	mode: Type.Union([Type.Literal("simple"), Type.Literal("minimal")]),

	currentPhase: Type.Optional(Type.String()),
	phases: Type.Array(MissionPhaseSchema),
	phasesExpanded: Type.Optional(Type.Boolean()),

	// Shared fields
	autonomy: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("auto")]),
	modelAssignment: Type.Record(Type.String(), Type.String()),

	paused: Type.Boolean(),
	pausedAt: Type.Optional(Type.String()),
	pauseHistory: Type.Array(PauseEntrySchema),

	progressLog: Type.Array(ProgressEventSchema),

	startedAt: Type.String(),
	completedAt: Type.Optional(Type.String()),
});

// ---------------------------------------------------------------------------
// State Persistence
// ---------------------------------------------------------------------------

/**
 * Persist mission state as a custom session entry.
 * Entries are append-only — the latest entry wins on restore.
 */
export function saveMissionState(pi: ExtensionAPI, state: MissionState): void {
	pi.appendEntry("mission-state", { ...state });
}

/**
 * Scan session entries for the most recent valid mission state.
 * Iterates from the end for an early break — the last valid entry is the
 * current state since entries are append-only.
 */
export function restoreMissionState(entries: readonly SessionEntryLike[]): MissionState | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== "mission-state") {
			continue;
		}

		const data = entry.data;

		// A null entry is a "reset" marker — mission was cleared
		if (data === null || data === undefined) {
			return null;
		}

		// Cast via unknown: TypeBox CJS/ESM dual-package types don't unify
		if (Value.Check(MissionStateSchema as unknown as Parameters<typeof Value.Check>[0], data)) {
			return data as MissionState;
		}
		// Corrupted or schema-incompatible entry — skip and keep scanning
	}

	return null;
}

// ---------------------------------------------------------------------------
// Phase & Feature Advancement
// ---------------------------------------------------------------------------

/**
 * Outcome of closing the active phase.
 * - `done`    — the phase finished normally (successful or manually advanced)
 * - `skipped` — the phase was intentionally passed over
 */
export type PhaseOutcome = "done" | "skipped";

/**
 * Result of {@link advancePhase}. `completedPhaseName` is `null` when no phase
 * was active — callers can notify the user without re-scanning `state.phases`.
 */
export interface AdvanceResult {
	state: MissionState;
	completedPhaseName: string | null;
}

/**
 * Close the currently-active phase and activate the next one.
 *
 * When the active phase is the last one, the mission is marked complete
 * (`completedAt` is set, no next phase is activated).
 *
 * Returns a shallow-cloned state with the updated phase list alongside the
 * name of the phase that just closed so callers can log / notify without
 * re-scanning `state.phases`. If no phase was active, returns the state
 * untouched and `completedPhaseName: null`.
 */
export function advancePhase(state: MissionState, outcome: PhaseOutcome = "done"): AdvanceResult {
	const now = new Date().toISOString();
	const phases = state.phases.map(p => ({ ...p }));
	const activeIdx = phases.findIndex(p => p.status === "active");
	if (activeIdx === -1) {
		return { state, completedPhaseName: null };
	}

	const completedPhaseName = phases[activeIdx].name;

	phases[activeIdx].status = outcome;
	phases[activeIdx].completedAt = now;

	const next: Partial<MissionState> = { phases };
	if (activeIdx + 1 < phases.length) {
		phases[activeIdx + 1].status = "active";
		phases[activeIdx + 1].startedAt = now;
		next.currentPhase = phases[activeIdx + 1].name;
	} else {
		next.completedAt = now;
	}

	return { state: { ...state, ...next }, completedPhaseName };
}

/**
 * Close the entire mission: mark the active phase `done` (if any), mark all
 * pending phases `skipped`, and stamp `completedAt`. Returns a shallow-cloned
 * state — callers persist via `saveMissionState`.
 *
 * Used by both `/mission-done` and the Mission Control `onDone` callback.
 */
export function completeMission(state: MissionState): MissionState {
	const now = new Date().toISOString();
	const phases = state.phases.map(p => {
		if (p.status === "active") return { ...p, status: "done" as const, completedAt: now };
		if (p.status === "pending") return { ...p, status: "skipped" as const };
		return { ...p };
	});
	return { ...state, phases, completedAt: now };
}

// ---------------------------------------------------------------------------
// Pause / Resume
// ---------------------------------------------------------------------------

/**
 * Enter paused state. Returns a shallow-cloned state with `paused: true` and
 * a fresh `pausedAt`. Callers persist via `saveMissionState`.
 */
export function pauseMission(state: MissionState): MissionState {
	const now = new Date().toISOString();
	return { ...state, paused: true, pausedAt: now };
}

/**
 * Leave paused state. Closes the open pause window by pushing a
 * `{ pausedAt, resumedAt }` entry into `pauseHistory` if `pausedAt` was set.
 * Returns a shallow-cloned state; callers persist via `saveMissionState`.
 */
export function resumeMission(state: MissionState): MissionState {
	const now = new Date().toISOString();
	const pauseEntry = state.pausedAt ? { pausedAt: state.pausedAt, resumedAt: now } : undefined;
	return {
		...state,
		paused: false,
		pausedAt: undefined,
		pauseHistory: pauseEntry ? [...state.pauseHistory, pauseEntry] : state.pauseHistory,
	};
}

// ---------------------------------------------------------------------------
// Progress Logging
// ---------------------------------------------------------------------------

/**
 * Append an event to the mission's progress log. Returns a shallow-cloned
 * state with the extended log — callers persist via `saveMissionState`.
 */
export function addProgressEvent(state: MissionState, type: ProgressEvent["type"], detail: string): MissionState {
	return {
		...state,
		progressLog: [...state.progressLog, { timestamp: new Date().toISOString(), type, detail }],
	};
}

// ---------------------------------------------------------------------------
// Adaptive — phase list expansion
// ---------------------------------------------------------------------------

/**
 * Replace the pending tail of the phase list with the adaptive proposal.
 *
 * The currently-active phase (typically the seed `Plan`) stays as-is so its
 * `startedAt` and any running work are preserved. Anything after it in the
 * list (usually nothing for the adaptive seed) is discarded and replaced
 * with the proposed phases — all new phases start `pending`.
 *
 * Sets `phasesExpanded` so callers can skip future expansions. Callers are
 * responsible for persisting the returned state.
 */
export function expandPhases(state: MissionState, proposed: ProposedPhase[]): MissionState {
	if (proposed.length === 0) return state;

	const activeIdx = state.phases.findIndex(p => p.status === "active");
	if (activeIdx === -1) return state;

	const kept = state.phases.slice(0, activeIdx + 1).map(p => ({ ...p }));
	const appended: MissionPhase[] = proposed.map(p => ({
		name: p.name,
		emoji: p.emoji,
		status: "pending" as const,
	}));

	return {
		...state,
		phases: [...kept, ...appended],
		phasesExpanded: true,
	};
}
