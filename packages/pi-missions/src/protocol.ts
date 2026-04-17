// src/protocol.ts — System prompt generation for pi-mission
//
// The "brain" of the extension: transforms mission state into rich,
// contextual system prompt protocols that guide the AI through each phase
// of work. Inspired by Factory.ai's orchestration patterns.

import { DEFAULT_MINIMAL_PHASES, DEFAULT_SIMPLE_PHASES, resolvePhaseRole } from "./config";
import AUDIT_PROTOCOL from "./prompts/audit-protocol.md" with { type: "text" };
import AUTONOMY_AUTO from "./prompts/autonomy-auto.md" with { type: "text" };
import AUTONOMY_HIGH from "./prompts/autonomy-high.md" with { type: "text" };
import AUTONOMY_LOW from "./prompts/autonomy-low.md" with { type: "text" };
import AUTONOMY_MEDIUM from "./prompts/autonomy-medium.md" with { type: "text" };
import FEATURE_EXECUTION_PROTOCOL from "./prompts/feature-execution-protocol.md" with { type: "text" };
import PLANNING_PROTOCOL from "./prompts/planning-protocol.md" with { type: "text" };
import REVIEWER_PROTOCOL from "./prompts/reviewer-protocol.md" with { type: "text" };
import TESTER_PROTOCOL from "./prompts/tester-protocol.md" with { type: "text" };
import VERIFY_PROTOCOL from "./prompts/verify-protocol.md" with { type: "text" };
import type { AutonomyLevel, MissionState, PhaseRole } from "./types";
import { getPhaseIcon } from "./utils";

// Re-export protocol strings so callers can still reference them.
export { AUDIT_PROTOCOL, FEATURE_EXECUTION_PROTOCOL, PLANNING_PROTOCOL, VERIFY_PROTOCOL };

// ---------------------------------------------------------------------------
// Phase instruction lookup
// ---------------------------------------------------------------------------

/** Map phase name → instructions from the default templates */
const PHASE_INSTRUCTIONS: Record<string, string[]> = {};
for (const p of [...DEFAULT_SIMPLE_PHASES, ...DEFAULT_MINIMAL_PHASES]) {
	PHASE_INSTRUCTIONS[p.name] = p.instructions;
}

function getPhaseInstructions(phaseName: string): string[] {
	return PHASE_INSTRUCTIONS[phaseName] ?? [];
}

// ---------------------------------------------------------------------------
// Protocol Builders
// ---------------------------------------------------------------------------

/**
 * Generate the full mission protocol injected into the system prompt.
 *
 * - Simple/minimal mode: phase-based protocol with current phase instructions
 * Paused: appends pause notice.
 */
export function buildMissionProtocol(state: MissionState): string {
	const sections: string[] = [];

	sections.push(buildSimpleModeProtocol(state));

	// Append pause notice if the mission is paused
	if (state.paused) {
		sections.push(buildPauseNotice(state));
	}

	return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Simple / Minimal mode protocol
// ---------------------------------------------------------------------------

function buildSimpleModeProtocol(state: MissionState): string {
	const activePhase = state.phases.find(p => p.status === "active");
	const completedCount = state.phases.filter(p => p.status === "done").length;
	const totalCount = state.phases.length;

	const lines: string[] = [
		`# 🎯 Active Mission: ${state.description}`,
		"",
		`**Mode:** ${state.mode === "minimal" ? "Minimal" : "Standard"} | **Progress:** ${completedCount}/${totalCount} phases | **Autonomy:** ${state.autonomy}`,
		"",
		"## Mission Phases",
		"",
	];

	// Phase list with status icons
	for (let i = 0; i < state.phases.length; i++) {
		const phase = state.phases[i];
		const icon = getPhaseIcon(phase.status);
		const marker = phase.status === "active" ? " ← YOU ARE HERE" : "";
		lines.push(`${icon} **Phase ${i + 1}: ${phase.emoji} ${phase.name}**${marker}`);
	}

	// Current phase instructions
	if (activePhase) {
		const instructions = getPhaseInstructions(activePhase.name);
		const roleName = resolvePhaseRole(activePhase.name);

		lines.push("");
		lines.push(`## Current Phase: ${activePhase.emoji} ${activePhase.name}`);
		lines.push("");
		lines.push(`**Your role:** ${roleName}`);
		lines.push("");

		if (instructions.length > 0) {
			lines.push("### Instructions");
			lines.push("");
			for (const instr of instructions) {
				lines.push(`- ${instr}`);
			}
		}

		// Inject the specialized protocol for the current role
		lines.push("");
		lines.push(getProtocolForRole(roleName));
	}

	// Autonomy-level guidance
	lines.push("");
	lines.push(buildAutonomyGuidance(state.autonomy));

	// Phase transition guidance
	lines.push("");
	lines.push("## Phase Transitions");
	lines.push("");
	lines.push("When you complete the current phase, announce it clearly so the system can advance:");
	lines.push(
		`- Say: "Phase ${state.phases.findIndex(p => p.status === "active") + 1} complete" or "${activePhase?.name ?? "current"} phase complete"`,
	);
	lines.push(
		'- **IMPORTANT**: You MUST explicitly say "[Phase Name] complete" or "Phase [N] complete" when finishing a phase. Without this, the progress tracker cannot advance.',
	);
	lines.push(
		'- Phrases that work: "Plan complete", "Phase 1 complete", "I\'ve completed the plan", "Done with the plan", "That concludes the plan"',
	);
	lines.push("- Do NOT skip phases or work on a future phase before the current one is done.");
	lines.push("- If the current phase requires user approval (e.g., plan review), STOP and wait.");

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Status builder
// ---------------------------------------------------------------------------

/**
 * Build a compact status summary for system prompt injection.
 *
 * Shows mission description, current position, and progress at a glance.
 */
export function buildMissionStatus(state: MissionState): string {
	const lines: string[] = [`**Mission:** ${state.description}`];

	if (state.paused) {
		lines.push("**Status:** ⏸️ PAUSED");
	} else if (state.completedAt) {
		lines.push("**Status:** ✅ COMPLETE");
	} else {
		lines.push("**Status:** 🔄 IN PROGRESS");
	}

	const done = state.phases.filter(p => p.status === "done").length;
	const modeLabel = state.mode === "minimal" ? "Minimal" : "Standard";
	lines.push(`**Mode:** ${modeLabel}`);
	lines.push(`**Progress:** ${done}/${state.phases.length} phases`);

	if (state.currentPhase) {
		const phase = state.phases.find(p => p.name === state.currentPhase);
		lines.push(`**Current phase:** ${phase?.emoji ?? "📋"} ${state.currentPhase}`);
	}

	// Phase list
	lines.push("");
	for (const p of state.phases) {
		const icon = getPhaseIcon(p.status);
		lines.push(`${icon} ${p.emoji} ${p.name}`);
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the specialized protocol for the current phase role.
 * Injects the detailed protocol template so the agent knows exactly
 * what is expected in this phase.
 */
const PROTOCOL_BY_ROLE: Record<PhaseRole, string> = {
	planner: PLANNING_PROTOCOL,
	auditor: AUDIT_PROTOCOL,
	verifier: VERIFY_PROTOCOL,
	coder: FEATURE_EXECUTION_PROTOCOL,
	reviewer: REVIEWER_PROTOCOL,
	tester: TESTER_PROTOCOL,
};

function getProtocolForRole(role: PhaseRole): string {
	return PROTOCOL_BY_ROLE[role];
}

/**
 * Build autonomy-level instructions that control how much the agent
 * can do without pausing for user confirmation.
 */
function buildAutonomyGuidance(autonomy: AutonomyLevel): string {
	switch (autonomy) {
		case "low":
			return AUTONOMY_LOW;
		case "medium":
			return AUTONOMY_MEDIUM;
		case "high":
			return AUTONOMY_HIGH;
		case "auto":
			return AUTONOMY_AUTO;
	}
}

/**
 * Build the pause notice appended when a mission is paused.
 */
function buildPauseNotice(state: MissionState): string {
	const lines = [
		"---",
		"",
		"## ⏸️ Mission PAUSED",
		"",
		"This mission is currently **paused**. Do not proceed with any mission work.",
		"",
		"- Wait for the user to resume the mission (via `/mission resume`)",
		"- You may answer questions about the mission status or plan",
		"- You may discuss changes to the plan",
		"- Do NOT implement, test, review, or modify any code for this mission",
	];

	if (state.pausedAt) {
		lines.push("");
		lines.push(`*Paused at: ${state.pausedAt}*`);
	}

	return lines.join("\n");
}
