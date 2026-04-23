// src/planner.ts — Interactive mission planning questionnaire

import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_AUTONOMY, MISSION_TEMPLATES } from "./config";
import { loadModelDefaults, saveModelDefaults, showRoleModelAssigner } from "./role-assigner";
import type {
	AutonomyLevel,
	MissionPhase,
	MissionState,
	MissionTemplate,
	ModelAssignment,
	ProgressEvent,
} from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map user-facing mode label → template key */
const MODE_OPTIONS: { label: string; key: string }[] = [
	{ label: "Adaptive — phase list generated from the plan's complexity", key: "adaptive" },
	{ label: "Standard (6 phases: Architect → Verify)", key: "standard" },
	{ label: "Minimal (3 phases: Plan → Build → Verify)", key: "minimal" },
];

const AUTONOMY_OPTIONS: { label: string; value: AutonomyLevel }[] = [
	{ label: "Auto — Run to completion, fix errors autonomously", value: "auto" },
	{ label: "High — Run to completion, only pause on errors", value: "high" },
	{ label: "Medium — Pause at phase boundaries and decision points", value: "medium" },
	{ label: "Low — Pause after each phase for review", value: "low" },
];

/** Get a template by key */
function getTemplate(key: string): MissionTemplate {
	return MISSION_TEMPLATES[key];
}

/** Build MissionPhase[] from a template's phase definitions, first one active */
function buildPhases(templateKey: string): MissionPhase[] {
	const template = getTemplate(templateKey);
	if (!template.phases) return [];

	return template.phases.map((p, i) => ({
		name: p.name,
		emoji: p.emoji,
		status: i === 0 ? ("active" as const) : ("pending" as const),
		...(i === 0 ? { startedAt: new Date().toISOString() } : {}),
	}));
}

// ---------------------------------------------------------------------------
// Main planner flow
// ---------------------------------------------------------------------------

/**
 * Run the interactive mission planning questionnaire.
 *
 * Flow:
 *   1. Choose mode (Standard / Minimal)
 *   2. Assign models per role group — required on first run, saved for later
 *   3. Choose autonomy level
 *   4. Optional constraints
 *   5. Build MissionState
 *
 * Returns `null` if the user cancels at any required step.
 */
export async function runMissionPlanner(
	ctx: ExtensionCommandContext,
	description: string,
): Promise<MissionState | null> {
	// ── Step 1: Mode selection ──────────────────────────────────────────────
	const modeLabels = MODE_OPTIONS.map(o => o.label);
	const modeChoice = await ctx.ui.select("Mission mode", modeLabels);
	if (!modeChoice) return null;

	const selected = MODE_OPTIONS.find(o => o.label === modeChoice);
	if (!selected) return null;
	const templateKey = selected.key;
	const template = getTemplate(templateKey);
	const _mode = template.mode;

	// ── Step 2: Model assignment ──────────────────────────────────
	// Always show the assigner. Saved defaults (if any) pre-populate each tab
	// so the user can press Esc to confirm their last picks, or switch models
	// for this mission. No silent-skip path — stale defaults that quietly
	// resurrect deprecated models was the old bug.
	const saved = await loadModelDefaults();
	const assignment = await showRoleModelAssigner(ctx, templateKey, saved ?? undefined);
	if (assignment === null) return null; // User cancelled

	const modelAssignment: ModelAssignment = assignment;

	// Persist for future missions (best-effort; won't crash on I/O errors)
	if (Object.keys(assignment).length > 0) {
		await saveModelDefaults(assignment);
	}

	// ── Step 3: Autonomy level ──────────────────────────────────────────────
	const autonomyLabels = AUTONOMY_OPTIONS.map(o => o.label);
	const autonomyChoice = await ctx.ui.select("Autonomy level", autonomyLabels);
	if (!autonomyChoice) return null;

	const autonomy: AutonomyLevel = AUTONOMY_OPTIONS.find(o => o.label === autonomyChoice)?.value ?? DEFAULT_AUTONOMY;

	// ── Step 4: Constraints (optional) ──────────────────────────────────────
	const constraints =
		(await ctx.ui.input("Any constraints or boundaries?", "e.g. don't modify auth module (optional)")) ?? "";

	// ── Step 5: Build MissionState ──────────────────────────────────────────
	return buildStateFromConfig({
		description,
		templateKey,
		autonomy,
		modelAssignment,
		constraints,
	});
}

// ---------------------------------------------------------------------------
// Non-interactive state builder (shared with /mission-gui)
// ---------------------------------------------------------------------------

export interface MissionStateConfig {
	description: string;
	templateKey: string;
	autonomy: AutonomyLevel;
	modelAssignment: ModelAssignment;
	constraints?: string;
}

/**
 * Construct a fresh MissionState from a fully-resolved config. Shared by the
 * interactive planner and the /mission-gui browser flow; contains no I/O and
 * no ctx-dependent branching.
 */
export function buildStateFromConfig(config: MissionStateConfig): MissionState {
	const template = getTemplate(config.templateKey);
	const now = new Date().toISOString();
	const phases = buildPhases(config.templateKey);

	const initialEvent: ProgressEvent = {
		timestamp: now,
		type: "phase_start",
		detail:
			phases.length > 0
				? `Mission started — entering phase "${phases[0].name}"`
				: `Mission started in ${template.name} mode`,
	};

	const constraints = config.constraints?.trim() ?? "";
	return {
		description: config.description,
		mode: template.mode,
		templateKey: config.templateKey,
		currentPhase: phases.length > 0 ? phases[0].name : undefined,
		phases,
		autonomy: config.autonomy,
		modelAssignment: config.modelAssignment,
		paused: false,
		pauseHistory: [],
		progressLog: [initialEvent],
		startedAt: now,
		constraints: constraints.length > 0 ? constraints : undefined,
	};
}
