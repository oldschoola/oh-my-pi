import { describe, expect, it } from "bun:test";
import { detectMilestonePhases, detectPhaseTransition, detectProposedPhases } from "../src/detector";
import type { MissionPhase } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function phase(name: string, status: MissionPhase["status"]): MissionPhase {
	return { name, emoji: "📐", status };
}

// ---------------------------------------------------------------------------
// detectPhaseTransition — completion
// ---------------------------------------------------------------------------

describe("detectPhaseTransition (completion)", () => {
	const phases = [phase("Architect", "active"), phase("Implement", "pending"), phase("Verify", "pending")];

	it("detects 'phase 1 complete'", () => {
		const result = detectPhaseTransition("phase 1 complete", phases);
		expect(result).toEqual({ type: "complete", phaseIndex: 0 });
	});

	it("detects 'phase 1 done'", () => {
		expect(detectPhaseTransition("phase 1 done", phases)).toEqual({
			type: "complete",
			phaseIndex: 0,
		});
	});

	it("detects 'architect complete'", () => {
		expect(detectPhaseTransition("architect complete", phases)).toEqual({
			type: "complete",
			phaseIndex: 0,
		});
	});

	it("detects 'architect phase complete'", () => {
		expect(detectPhaseTransition("architect phase complete", phases)).toEqual({
			type: "complete",
			phaseIndex: 0,
		});
	});

	it("detects 'completed phase 1'", () => {
		expect(detectPhaseTransition("completed phase 1", phases)).toEqual({
			type: "complete",
			phaseIndex: 0,
		});
	});

	it("detects 'completed the architect phase'", () => {
		expect(detectPhaseTransition("completed the architect phase", phases)).toEqual({
			type: "complete",
			phaseIndex: 0,
		});
	});

	it("does not match pending phases for completion", () => {
		expect(detectPhaseTransition("implement complete", phases)).toBeNull();
	});

	it("returns null when no match", () => {
		expect(detectPhaseTransition("nothing relevant here", phases)).toBeNull();
	});

	it("is case-insensitive (text already lowercased)", () => {
		expect(detectPhaseTransition("phase 1 complete", phases)).not.toBeNull();
	});

	// --- Broader natural language patterns ---

	it("detects 'i've completed the architect'", () => {
		expect(detectPhaseTransition("i've completed the architect", phases)).toEqual({
			type: "complete",
			phaseIndex: 0,
		});
	});

	it("detects 'i'm done with the architect'", () => {
		expect(detectPhaseTransition("i'm done with the architect", phases)).toEqual({
			type: "complete",
			phaseIndex: 0,
		});
	});

	it("detects 'finished the architect phase'", () => {
		expect(detectPhaseTransition("finished the architect phase", phases)).toEqual({
			type: "complete",
			phaseIndex: 0,
		});
	});

	it("detects 'done with architect'", () => {
		expect(detectPhaseTransition("done with architect", phases)).toEqual({
			type: "complete",
			phaseIndex: 0,
		});
	});

	it("detects 'wrapped up the architect'", () => {
		expect(detectPhaseTransition("wrapped up the architect", phases)).toEqual({
			type: "complete",
			phaseIndex: 0,
		});
	});

	it("detects 'architect is done'", () => {
		expect(detectPhaseTransition("architect is done", phases)).toEqual({
			type: "complete",
			phaseIndex: 0,
		});
	});

	it("detects 'architect is complete'", () => {
		expect(detectPhaseTransition("architect is complete", phases)).toEqual({
			type: "complete",
			phaseIndex: 0,
		});
	});

	it("detects 'that concludes the architect'", () => {
		expect(detectPhaseTransition("that concludes the architect", phases)).toEqual({
			type: "complete",
			phaseIndex: 0,
		});
	});

	it("detects 'that wraps up the architect'", () => {
		expect(detectPhaseTransition("that wraps up the architect", phases)).toEqual({
			type: "complete",
			phaseIndex: 0,
		});
	});
});

// ---------------------------------------------------------------------------
// detectPhaseTransition — transition
// ---------------------------------------------------------------------------

describe("detectPhaseTransition (transition)", () => {
	const phases = [phase("Architect", "done"), phase("Implement", "pending"), phase("Verify", "pending")];

	it("detects 'moving to phase 2'", () => {
		const result = detectPhaseTransition("moving to phase 2", phases);
		expect(result).toEqual({ type: "transition", phaseIndex: 1 });
	});

	it("detects 'starting phase 2'", () => {
		expect(detectPhaseTransition("starting phase 2", phases)).toEqual({
			type: "transition",
			phaseIndex: 1,
		});
	});

	it("detects 'beginning implement'", () => {
		expect(detectPhaseTransition("beginning implement", phases)).toEqual({
			type: "transition",
			phaseIndex: 1,
		});
	});

	it("detects 'starting implement'", () => {
		expect(detectPhaseTransition("starting implement", phases)).toEqual({
			type: "transition",
			phaseIndex: 1,
		});
	});

	it("does not match done phases for completion", () => {
		const withActive = [phase("Architect", "done"), phase("Implement", "active"), phase("Verify", "pending")];
		// Architect is done, not active — completion patterns should not match
		expect(detectPhaseTransition("architect complete", withActive)).toBeNull();
	});

	it("returns null when no match", () => {
		expect(detectPhaseTransition("nothing relevant here", phases)).toBeNull();
	});

	// --- Broader natural language patterns ---

	it("detects 'moving on to the implement'", () => {
		expect(detectPhaseTransition("moving on to the implement", phases)).toEqual({
			type: "transition",
			phaseIndex: 1,
		});
	});

	it('detects "let\'s now start implement"', () => {
		expect(detectPhaseTransition("let's now start implement", phases)).toEqual({
			type: "transition",
			phaseIndex: 1,
		});
	});

	it("detects 'proceeding with the implement'", () => {
		expect(detectPhaseTransition("proceeding with the implement", phases)).toEqual({
			type: "transition",
			phaseIndex: 1,
		});
	});

	it("detects 'next up is the implement'", () => {
		expect(detectPhaseTransition("next up is the implement", phases)).toEqual({
			type: "transition",
			phaseIndex: 1,
		});
	});

	it("detects 'now moving to the implement phase'", () => {
		expect(detectPhaseTransition("now moving to the implement phase", phases)).toEqual({
			type: "transition",
			phaseIndex: 1,
		});
	});
});

// ---------------------------------------------------------------------------
// detectPhaseTransition — regression coverage
// ---------------------------------------------------------------------------

describe("detectPhaseTransition (regression)", () => {
	it("matches 'transitioning to' at the start of the input (no leading space required)", () => {
		const phases = [phase("Architect", "done"), phase("Implement", "pending")];
		expect(detectPhaseTransition("transitioning to the implement", phases)).toEqual({
			type: "transition",
			phaseIndex: 1,
		});
	});

	it("still matches 'transitioning to' after other text", () => {
		const phases = [phase("Architect", "done"), phase("Implement", "pending")];
		expect(detectPhaseTransition("ok, transitioning to implement now", phases)).toEqual({
			type: "transition",
			phaseIndex: 1,
		});
	});

	it("matches multi-word phase names (completion)", () => {
		const phases = [phase("Review Plan", "active"), phase("Implement", "pending")];
		expect(detectPhaseTransition("review plan complete", phases)).toEqual({
			type: "complete",
			phaseIndex: 0,
		});
	});

	it("matches multi-word phase names (transition)", () => {
		const phases = [phase("Review Plan", "pending"), phase("Implement", "pending")];
		expect(detectPhaseTransition("starting review plan", phases)).toEqual({
			type: "transition",
			phaseIndex: 0,
		});
	});
});

// ---------------------------------------------------------------------------
// detectProposedPhases
// ---------------------------------------------------------------------------

describe("detectProposedPhases", () => {
	it("parses a well-formed proposed-phases section with em dashes", () => {
		const text = [
			"## Mission: Build foo",
			"",
			"Some plan content here.",
			"",
			"## Proposed Phases",
			"",
			"1. 🔨 Implement Parser — add JSON parser in src/parse.ts",
			"2. 🧪 Test Parser — unit tests covering edge cases",
			"3. ✅ Verify — run full test suite and lint",
		].join("\n");

		const result = detectProposedPhases(text);
		expect(result).toEqual([
			{ emoji: "🔨", name: "Implement Parser", description: "add JSON parser in src/parse.ts" },
			{ emoji: "🧪", name: "Test Parser", description: "unit tests covering edge cases" },
			{ emoji: "✅", name: "Verify", description: "run full test suite and lint" },
		]);
	});

	it("accepts colon, hyphen, and en-dash separators", () => {
		const text = [
			"## Proposed Phases",
			"1. 🔨 Build: implement the feature",
			"2. 🧪 Test - write tests",
			"3. ✅ Verify – run checks",
		].join("\n");

		const result = detectProposedPhases(text);
		expect(result).toHaveLength(3);
		expect(result?.[0]).toEqual({ emoji: "🔨", name: "Build", description: "implement the feature" });
		expect(result?.[1]).toEqual({ emoji: "🧪", name: "Test", description: "write tests" });
		expect(result?.[2]).toEqual({ emoji: "✅", name: "Verify", description: "run checks" });
	});

	it("returns null when no proposed-phases header is present", () => {
		const text = "## Mission\n\nSome plan with no proposed phases section.";
		expect(detectProposedPhases(text)).toBeNull();
	});

	it("accepts a single proposed phase", () => {
		const text = ["## Proposed Phases", "", "1. 🔨 Implement — do the work"].join("\n");
		const result = detectProposedPhases(text);
		expect(result).toEqual([{ emoji: "🔨", name: "Implement", description: "do the work" }]);
	});

	it("returns null when no phase lines are found under the header", () => {
		const text = ["## Proposed Phases", "", "Just paragraph text with no numbered phases."].join("\n");
		expect(detectProposedPhases(text)).toBeNull();
	});

	it("stops at the next heading after the proposed-phases section", () => {
		const text = [
			"## Proposed Phases",
			"1. 🔨 Build — work",
			"2. ✅ Verify — check",
			"",
			"## Validation Assertions",
			"3. 🧟 this should not be parsed — it's after the next heading",
		].join("\n");

		const result = detectProposedPhases(text);
		expect(result).toHaveLength(2);
		expect(result?.map(p => p.name)).toEqual(["Build", "Verify"]);
	});

	it("skips lines that don't match the phase-line shape", () => {
		const text = [
			"## Proposed Phases",
			"This is a paragraph, not a phase line.",
			"1. 🔨 Build — work",
			"random freeform text",
			"2. ✅ Verify — check",
		].join("\n");

		const result = detectProposedPhases(text);
		expect(result?.map(p => p.name)).toEqual(["Build", "Verify"]);
	});

	it("ignores a proposed Plan phase since the seed already contains it", () => {
		const text = [
			"## Proposed Phases",
			"1. 📐 Plan — redundant, agent already in plan phase",
			"2. 🔨 Build — work",
			"3. ✅ Verify — check",
		].join("\n");

		const result = detectProposedPhases(text);
		expect(result?.map(p => p.name)).toEqual(["Build", "Verify"]);
	});

	it("preserves the original casing of phase names and emojis", () => {
		const text = ["## Proposed Phases", "1. 🔨 ImplementXYZ — do XYZ", "2. ✅ VERIFY-ALL — do verify"].join("\n");

		const result = detectProposedPhases(text);
		expect(result?.[0].name).toBe("ImplementXYZ");
		expect(result?.[1].name).toBe("VERIFY-ALL");
	});
});

// ---------------------------------------------------------------------------
// detectMilestonePhases
// ---------------------------------------------------------------------------

describe("detectMilestonePhases", () => {
	it("parses `### Milestone N: Name` headers as phases", () => {
		const text = [
			"## Mission: Build foo",
			"",
			"### Milestone 1: Parser",
			"Implement the JSON parser.",
			"",
			"### Milestone 2: Tests",
			"Write unit tests.",
			"",
			"### Milestone 3: Verify",
		].join("\n");

		const result = detectMilestonePhases(text);
		expect(result).toEqual([
			{ emoji: "📋", name: "Parser", description: "" },
			{ emoji: "📋", name: "Tests", description: "" },
			{ emoji: "📋", name: "Verify", description: "" },
		]);
	});

	it("returns null when no milestone headers are present", () => {
		const text = ["## Mission", "", "Some plan with no milestones."].join("\n");
		expect(detectMilestonePhases(text)).toBeNull();
	});

	it("accepts a single milestone header", () => {
		const text = ["### Milestone 1: Implement", "Do the work."].join("\n");
		expect(detectMilestonePhases(text)).toEqual([{ emoji: "📋", name: "Implement", description: "" }]);
	});

	it("skips a milestone named just `Plan`", () => {
		const text = ["### Milestone 1: Plan", "### Milestone 2: Implement", "### Milestone 3: Verify"].join("\n");
		expect(detectMilestonePhases(text)?.map(p => p.name)).toEqual(["Implement", "Verify"]);
	});

	it("accepts `### Milestone N — Name` with an em-dash separator", () => {
		const text = ["### Milestone 1 — Parser", "### Milestone 2 — Tests"].join("\n");
		expect(detectMilestonePhases(text)?.map(p => p.name)).toEqual(["Parser", "Tests"]);
	});
});
