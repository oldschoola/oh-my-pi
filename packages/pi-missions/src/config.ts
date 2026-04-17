// src/config.ts — Mission configuration templates and defaults

import type { AutonomyLevel, MissionTemplate, PhaseRole, PhaseTemplate } from "./types";

// ---------------------------------------------------------------------------
// Phase templates
// ---------------------------------------------------------------------------

/** Standard 6-phase mission (architect → verify) */
export const DEFAULT_SIMPLE_PHASES: PhaseTemplate[] = [
	{
		name: "Architect",
		emoji: "📐",
		instructions: [
			"Analyze the codebase and understand the domain",
			"Produce a detailed implementation plan with file assignments",
			"List all files to create/modify with clear descriptions",
			"STOP and present the plan for approval before proceeding",
		],
	},
	{
		name: "Review Plan",
		emoji: "👁️",
		instructions: [
			"Present the plan clearly to the user",
			"Wait for explicit approval (user says 'approve', 'go', 'lgtm', etc.)",
			"If the user requests changes, revise the plan and re-present",
			"Do NOT proceed to implementation without approval",
		],
	},
	{
		name: "Implement",
		emoji: "🔨",
		instructions: [
			"Execute the plan — run independent tasks in parallel when possible",
			"Use subagents or parallel tool calls for concurrent work",
			"Follow the project's architecture patterns and code style",
			"Commit work incrementally",
		],
	},
	{
		name: "Test",
		emoji: "🧪",
		instructions: [
			"Write tests for all new/changed code",
			"Cover edge cases, error conditions, and boundary values",
			"Run the test suite and fix any failures",
		],
	},
	{
		name: "Audit",
		emoji: "🔍",
		instructions: [
			"Review all changes for bugs, logic errors, and security issues",
			"Check for performance concerns and code style violations",
			"Verify error handling is complete",
			"Fix any issues found",
		],
	},
	{
		name: "Verify",
		emoji: "✅",
		instructions: [
			"Run the full test suite and linter",
			"Ensure all tests pass and no lint errors",
			"Report the final status",
		],
	},
];

/** Minimal 3-phase mission for quick tasks */
export const DEFAULT_MINIMAL_PHASES: PhaseTemplate[] = [
	{
		name: "Plan",
		emoji: "📋",
		instructions: [
			"Briefly outline the approach",
			"Identify files to create or modify",
			"Present the plan for approval",
		],
	},
	{
		name: "Build",
		emoji: "🔨",
		instructions: [
			"Implement the plan and write tests",
			"Follow existing patterns and code style",
			"Commit work incrementally",
		],
	},
	{
		name: "Verify",
		emoji: "✅",
		instructions: ["Run tests and linter", "Quick review for obvious issues", "Report the final status"],
	},
];

/**
 * Adaptive seed: a single planning phase. The agent proposes the rest of
 * the phase list during the plan, scaled to the work's complexity, and the
 * extension expands `mission.phases` from the proposed list when detected.
 */
export const DEFAULT_ADAPTIVE_SEED_PHASES: PhaseTemplate[] = [
	{
		name: "Plan",
		emoji: "📐",
		instructions: [
			"Analyze the codebase and produce a plan scaled to the work.",
			"Decide how many phases this mission actually needs — small changes 1–3, medium 3–10, large/complex 10–50+, detailed refactors 50–100+. Do not pad or artificially compress.",
			"At the end of your plan, append a `## Proposed Phases` section that lists each phase with an emoji, name, and short description (the protocol shows the exact format).",
			"Stop and present the plan for approval before implementing (low/medium autonomy) — on high/auto autonomy, announce phase completion immediately so phase expansion runs.",
		],
	},
];

// ---------------------------------------------------------------------------
// Mission templates
// ---------------------------------------------------------------------------

export const MISSION_TEMPLATES: Record<string, MissionTemplate> = {
	adaptive: {
		name: "Adaptive",
		description: "Plan phase decides how many phases this mission needs based on complexity",
		mode: "simple",
		phases: DEFAULT_ADAPTIVE_SEED_PHASES,
	},
	standard: {
		name: "Standard",
		description: "6-phase linear mission: architect, review, implement, test, audit, verify",
		mode: "simple",
		phases: DEFAULT_SIMPLE_PHASES,
	},
	minimal: {
		name: "Minimal",
		description: "3-phase quick mission: plan, build, verify",
		mode: "minimal",
		phases: DEFAULT_MINIMAL_PHASES,
	},
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_AUTONOMY: AutonomyLevel = "auto";

// ---------------------------------------------------------------------------
// Phase → role mapping (for model assignment)
// ---------------------------------------------------------------------------

export const PHASE_ROLE_MAP: Record<string, PhaseRole> = {
	Architect: "planner",
	"Review Plan": "reviewer",
	Plan: "planner",
	Implement: "coder",
	Build: "coder",
	Test: "tester",
	Audit: "auditor",
	Verify: "verifier",
};

/**
 * Resolve a {@link PhaseRole} for an arbitrary phase name. First tries the
 * exact `PHASE_ROLE_MAP` keys (built-in templates), then falls back to
 * keyword matching so adaptive-mode phases proposed by the LLM still get
 * a sensible role + protocol injection. Returns `"coder"` as the default
 * because adaptive phases past planning are usually implementation work.
 */
export function resolvePhaseRole(name: string): PhaseRole {
	const exact = PHASE_ROLE_MAP[name];
	if (exact) return exact;

	const lower = name.toLowerCase();
	if (/(verify|verification)/.test(lower)) return "verifier";
	if (/(test|qa|spec|coverage)/.test(lower)) return "tester";
	if (/(audit|security|lint|review code)/.test(lower)) return "auditor";
	if (/(review|approve|sign[- ]?off)/.test(lower)) return "reviewer";
	if (/(plan|design|architect|spec|analy[sz]e)/.test(lower)) return "planner";
	return "coder";
}
