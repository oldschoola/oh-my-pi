/**
 * Unit tests for fix-features generator (Track A4).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildFixFeatureId,
	generateFixFeatures,
	renderTemplate,
	slugify,
	type ValidatorFinding,
} from "../src/missioncontrol";

let sandbox: string;
let templatePath: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-fix-features-"));
	templatePath = join(sandbox, "fix-template.md");
	writeFileSync(
		templatePath,
		[
			"# Task: {{fixFeatureId}} — Fix: {{summary}}",
			"",
			"## Milestone: {{milestoneId}}",
			"## Fulfills: {{assertionIds}}",
			"## Parent Feature: {{parentFeatureId}}",
			"## Fix Feature: true",
			"",
			"severity={{severity}} round={{validationRound}} validator={{validatorKind}}",
			"",
			"{{findingDescription}}",
			"",
			"Evidence: {{findingEvidence}}",
			"Strategy: {{resolutionStrategy}}",
			"Validator output: {{validatorOutputPath}}",
			"Parent folder: {{parentFeatureFolder}}",
			"",
			"File scope:",
			"{{fileScope}}",
			"",
			"Created: {{createdAt}}",
			"",
		].join("\n"),
		"utf-8",
	);
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function blocker(overrides: Partial<ValidatorFinding> = {}): ValidatorFinding {
	return {
		id: "F-001",
		validator: "scrutiny",
		round: 1,
		severity: "blocker",
		assertionIds: ["VA-001"],
		parentFeatureId: "F-100",
		summary: "Missing hello file",
		description: "`hello-mission.md` was not created.",
		evidence: "ls reported: no such file",
		resolutionStrategy: "Create the file per the contract.",
		filePaths: ["hello-mission.md"],
		validatorOutputPath: "/v/output.json",
		parentFeatureFolder: "/tasks/F-100",
		...overrides,
	};
}

describe("slugify", () => {
	test("lowercases and hyphenates", () => {
		expect(slugify("Missing Hello File!")).toBe("missing-hello-file");
	});

	test("collapses repeat separators", () => {
		expect(slugify("a    b---c")).toBe("a-b-c");
	});

	test("respects max length", () => {
		expect(slugify("abcdefghij", 5)).toBe("abcde");
	});

	test("returns fallback 'fix' when input yields empty slug", () => {
		expect(slugify("!!!")).toBe("fix");
	});
});

describe("buildFixFeatureId", () => {
	test("uses zero-padded milestone + finding numbers", () => {
		expect(buildFixFeatureId("M-001", 0)).toBe("FIX-001-001");
		expect(buildFixFeatureId("M-042", 4)).toBe("FIX-042-005");
	});

	test("falls back to 000 milestone when id does not match convention", () => {
		expect(buildFixFeatureId("foo", 0)).toBe("FIX-000-001");
	});
});

describe("renderTemplate", () => {
	test("replaces present placeholders", () => {
		expect(renderTemplate("Hello {{name}}!", { name: "World" })).toBe("Hello World!");
	});

	test("replaces absent placeholders with empty string", () => {
		expect(renderTemplate("{{missing}} value", {})).toBe(" value");
	});

	test("ignores non-placeholder braces", () => {
		expect(renderTemplate("a {not a var} b", {})).toBe("a {not a var} b");
	});
});

describe("generateFixFeatures", () => {
	test("returns empty when no blocker findings", async () => {
		const out = await generateFixFeatures({
			cwd: sandbox,
			milestoneId: "M-001",
			findings: [blocker({ severity: "warning" }), blocker({ severity: "info" })],
			templatePath,
		});
		expect(out).toEqual([]);
	});

	test("produces one task folder per blocker", async () => {
		const tasksDir = join(sandbox, "tasks");
		const out = await generateFixFeatures({
			cwd: sandbox,
			milestoneId: "M-001",
			findings: [
				blocker({ id: "F-001", summary: "First blocker" }),
				blocker({ id: "F-002", summary: "Second blocker", assertionIds: ["VA-001", "VA-002"] }),
			],
			templatePath,
			tasksDir,
		});

		expect(out).toHaveLength(2);
		const [a, b] = out;
		expect(a?.taskId).toBe("FIX-001-001");
		expect(b?.taskId).toBe("FIX-001-002");
		expect(existsSync(join(a!.taskFolder, "PROMPT.md"))).toBe(true);
		expect(existsSync(join(b!.taskFolder, "PROMPT.md"))).toBe(true);
	});

	test("persisted records carry milestone and fix metadata", async () => {
		const [result] = await generateFixFeatures({
			cwd: sandbox,
			milestoneId: "M-002",
			findings: [blocker({ assertionIds: ["VA-009"], parentFeatureId: "F-900" })],
			templatePath,
			tasksDir: join(sandbox, "tasks"),
		});
		expect(result?.record.milestoneId).toBe("M-002");
		expect(result?.record.fulfillsAssertionIds).toEqual(["VA-009"]);
		expect(result?.record.parentFeatureId).toBe("F-900");
		expect(result?.record.isFixFeature).toBe(true);
		expect(result?.record.status).toBe("pending");
	});

	test("prompt contents reference the cited finding", async () => {
		const [result] = await generateFixFeatures({
			cwd: sandbox,
			milestoneId: "M-001",
			findings: [
				blocker({
					summary: "Missing route",
					description: "/api/users returns 404.",
					evidence: "curl /api/users → 404",
					assertionIds: ["VA-017"],
				}),
			],
			templatePath,
			tasksDir: join(sandbox, "tasks"),
		});
		expect(result?.prompt).toContain("FIX-001-001");
		expect(result?.prompt).toContain("Missing route");
		expect(result?.prompt).toContain("VA-017");
		expect(result?.prompt).toContain("curl /api/users → 404");
	});

	test("file scope placeholder falls back when no file paths cited", async () => {
		const [result] = await generateFixFeatures({
			cwd: sandbox,
			milestoneId: "M-001",
			findings: [blocker({ filePaths: undefined })],
			templatePath,
			tasksDir: join(sandbox, "tasks"),
		});
		expect(result?.prompt).toContain("Determined during execution");
	});

	test("existingFixFeatureCount offsets generated IDs", async () => {
		const [r1, r2] = await generateFixFeatures({
			cwd: sandbox,
			milestoneId: "M-003",
			findings: [blocker({ summary: "a" }), blocker({ summary: "b" })],
			templatePath,
			tasksDir: join(sandbox, "tasks"),
			existingFixFeatureCount: 5,
		});
		expect(r1?.taskId).toBe("FIX-003-006");
		expect(r2?.taskId).toBe("FIX-003-007");
	});
});
