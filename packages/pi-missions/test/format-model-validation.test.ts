/**
 * Unit tests for `formatModelValidation` — pure display-only formatter
 * for the output of `validateModelAvailability`.
 *
 * Covers: inherit rows, found rows, not-found rows with failure footer,
 * padding width, footer suppression when everything passes, and the
 * renamed fix-hint copy (mission.json / /mission-settings).
 */

import { describe, expect, test } from "bun:test";

import { formatModelValidation, type ModelCheckResult } from "../src/missioncontrol/formatting";

describe("formatModelValidation", () => {
	test("all-inherit rows render with arrow + resolved session default", () => {
		const input: ModelCheckResult[] = [
			{ role: "Worker", modelStr: "(inherit)", status: "inherit", resolvedName: "anthropic/claude-opus-4-7" },
			{ role: "Reviewer", modelStr: "(inherit)", status: "inherit", resolvedName: "anthropic/claude-opus-4-7" },
		];
		const out = formatModelValidation(input);
		expect(out).toContain("Model Configuration:");
		expect(out).toContain("✅ Worker       inherit → anthropic/claude-opus-4-7");
		expect(out).toContain("✅ Reviewer     inherit → anthropic/claude-opus-4-7");
		expect(out).not.toContain("NOT FOUND");
		expect(out).not.toContain("Fix:");
	});

	test("found rows render modelStr + arrow + resolved", () => {
		const input: ModelCheckResult[] = [
			{ role: "Merger", modelStr: "sonnet-4", status: "found", resolvedName: "anthropic/claude-sonnet-4-6" },
		];
		const out = formatModelValidation(input);
		expect(out).toContain("✅ Merger       sonnet-4 → anthropic/claude-sonnet-4-6");
		expect(out).not.toContain("Fix:");
	});

	test("not-found rows render NOT FOUND marker and trigger fix footer", () => {
		const input: ModelCheckResult[] = [{ role: "Worker", modelStr: "bogus-model", status: "not-found" }];
		const out = formatModelValidation(input);
		expect(out).toContain("❌ Worker       bogus-model — NOT FOUND in model registry");
		expect(out).toContain("Fix: update the model in .omp/mission.json or /mission-settings");
		expect(out).toContain("remove the override to inherit the session model");
	});

	test("mixed pass + fail rows include every row and a single footer", () => {
		const input: ModelCheckResult[] = [
			{ role: "Worker", modelStr: "sonnet", status: "found", resolvedName: "anthropic/sonnet" },
			{ role: "Reviewer", modelStr: "", status: "inherit", resolvedName: "anthropic/opus" },
			{ role: "Merger", modelStr: "missing-1", status: "not-found" },
			{ role: "Supervisor", modelStr: "missing-2", status: "not-found" },
		];
		const out = formatModelValidation(input);
		expect(out).toContain("✅ Worker");
		expect(out).toContain("✅ Reviewer");
		expect(out).toContain("❌ Merger");
		expect(out).toContain("❌ Supervisor");
		const footers = out.split("\n").filter(l => l.startsWith("  Fix:"));
		expect(footers).toHaveLength(1);
	});

	test("role column padded to width 12 for alignment", () => {
		const input: ModelCheckResult[] = [
			{ role: "Worker", modelStr: "a", status: "found", resolvedName: "x" },
			{ role: "Supervisor", modelStr: "b", status: "found", resolvedName: "y" },
		];
		const out = formatModelValidation(input);
		const workerLine = out.split("\n").find(l => l.includes("Worker"));
		const supervisorLine = out.split("\n").find(l => l.includes("Supervisor"));
		expect(workerLine).toContain("Worker       a →");
		expect(supervisorLine).toContain("Supervisor   b →");
	});

	test("empty results yields header-only output with no footer", () => {
		const out = formatModelValidation([]);
		expect(out).toBe("Model Configuration:");
	});

	test("fix hint references new mission filename, not legacy taskplane paths", () => {
		const input: ModelCheckResult[] = [{ role: "Worker", modelStr: "x", status: "not-found" }];
		const out = formatModelValidation(input);
		expect(out).toContain(".omp/mission.json");
		expect(out).toContain("/mission-settings");
		expect(out).not.toContain("taskplane-config.json");
		expect(out).not.toContain("/taskplane-settings");
	});
});
