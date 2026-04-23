/**
 * Unit tests for parseMilestoneValidatorResult + parseScrutinyValidatorResult
 * (Track B3).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	MILESTONE_VALIDATOR_SCHEMA_VERSION,
	type MilestoneValidatorOutput,
	parseMilestoneValidatorResult,
	parseScrutinyValidatorResult,
	StateFileError,
	validationOutputPath,
} from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-scrutiny-parse-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function writeOutput(filename: string, payload: unknown): string {
	const full = join(sandbox, filename);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, JSON.stringify(payload), "utf-8");
	return full;
}

function base(overrides: Partial<MilestoneValidatorOutput> = {}): MilestoneValidatorOutput {
	return {
		schemaVersion: MILESTONE_VALIDATOR_SCHEMA_VERSION,
		validator: "scrutiny",
		milestoneId: "M-001",
		round: 1,
		startedAt: 1000,
		completedAt: 2000,
		verdict: "pass",
		summary: "Milestone passes all assertions.",
		findings: [],
		lessons: ["Workers consistently follow the test-first pattern."],
		...overrides,
	};
}

describe("validationOutputPath", () => {
	test("builds a stable round-scoped path", () => {
		const p1 = validationOutputPath(sandbox, "batch-1", "M-001", 2, "scrutiny");
		expect(p1.endsWith("M-001-scrutiny-round2.json")).toBe(true);

		const p2 = validationOutputPath(sandbox, "batch-1", "M-001", 2, "user-testing");
		expect(p2.endsWith("M-001-user-testing-round2.json")).toBe(true);
	});
});

describe("parseMilestoneValidatorResult — happy path", () => {
	test("round-trips a pass with zero findings", async () => {
		const path = writeOutput("out.json", base());
		const result = await parseMilestoneValidatorResult(path);
		expect(result.verdict).toBe("pass");
		expect(result.findings).toEqual([]);
		expect(result.lessons).toHaveLength(1);
	});

	test("accepts needs-fix verdict when blockers are present", async () => {
		const path = writeOutput(
			"out.json",
			base({
				verdict: "needs-fix",
				findings: [
					{
						id: "SCR-M-001-R1-001",
						validator: "scrutiny",
						round: 1,
						severity: "blocker",
						assertionIds: ["VA-001"],
						parentFeatureId: "F-001",
						summary: "Missing output",
						description: "The feature's deliverable is absent.",
					},
				],
			}),
		);
		const result = await parseMilestoneValidatorResult(path);
		expect(result.verdict).toBe("needs-fix");
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.severity).toBe("blocker");
	});

	test("preserves optional finding fields", async () => {
		const path = writeOutput(
			"out.json",
			base({
				verdict: "needs-fix",
				findings: [
					{
						id: "SCR-M-001-R1-001",
						validator: "scrutiny",
						round: 1,
						severity: "blocker",
						assertionIds: ["VA-001"],
						parentFeatureId: "F-001",
						summary: "s",
						description: "d",
						evidence: "bash output",
						resolutionStrategy: "add the thing",
						filePaths: ["src/a.ts", "src/b.ts"],
					},
				],
			}),
		);
		const result = await parseMilestoneValidatorResult(path);
		expect(result.findings[0]?.evidence).toBe("bash output");
		expect(result.findings[0]?.resolutionStrategy).toBe("add the thing");
		expect(result.findings[0]?.filePaths).toEqual(["src/a.ts", "src/b.ts"]);
	});
});

describe("parseMilestoneValidatorResult — error paths", () => {
	test("throws STATE_FILE_IO_ERROR when file missing", async () => {
		try {
			await parseMilestoneValidatorResult(join(sandbox, "nope.json"));
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(StateFileError);
			expect((err as StateFileError).code).toBe("STATE_FILE_IO_ERROR");
		}
	});

	test("throws STATE_FILE_PARSE_ERROR on malformed JSON", async () => {
		const full = join(sandbox, "bad.json");
		writeFileSync(full, "{not-json", "utf-8");
		try {
			await parseMilestoneValidatorResult(full);
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(StateFileError);
			expect((err as StateFileError).code).toBe("STATE_FILE_PARSE_ERROR");
		}
	});

	test("rejects non-object top-level", async () => {
		const full = join(sandbox, "arr.json");
		writeFileSync(full, "[]", "utf-8");
		await expect(parseMilestoneValidatorResult(full)).rejects.toThrow(/non-null object/);
	});

	test("rejects unsupported schemaVersion", async () => {
		const path = writeOutput("out.json", { ...base(), schemaVersion: 2 });
		await expect(parseMilestoneValidatorResult(path)).rejects.toThrow(/schemaVersion/);
	});

	test("rejects unknown validator kind", async () => {
		const path = writeOutput("out.json", { ...base(), validator: "unknown" });
		await expect(parseMilestoneValidatorResult(path)).rejects.toThrow(/validator/);
	});

	test("rejects missing milestoneId", async () => {
		const path = writeOutput("out.json", { ...base(), milestoneId: "" });
		await expect(parseMilestoneValidatorResult(path)).rejects.toThrow(/milestoneId/);
	});

	test("rejects zero/negative round", async () => {
		const path = writeOutput("out.json", { ...base(), round: 0 });
		await expect(parseMilestoneValidatorResult(path)).rejects.toThrow(/round/);
	});

	test("rejects unknown verdict", async () => {
		const path = writeOutput("out.json", { ...base(), verdict: "maybe" });
		await expect(parseMilestoneValidatorResult(path)).rejects.toThrow(/verdict/);
	});

	test("rejects finding with unknown severity", async () => {
		const path = writeOutput(
			"out.json",
			base({
				verdict: "needs-fix",
				findings: [
					{
						id: "x",
						validator: "scrutiny",
						round: 1,
						severity: "critical" as unknown as "blocker",
						assertionIds: ["VA-001"],
						summary: "s",
						description: "d",
					},
				],
			}),
		);
		await expect(parseMilestoneValidatorResult(path)).rejects.toThrow(/severity/);
	});

	test("rejects finding with non-array assertionIds", async () => {
		const path = writeOutput(
			"out.json",
			base({
				verdict: "needs-fix",
				findings: [
					{
						id: "x",
						validator: "scrutiny",
						round: 1,
						severity: "blocker",
						assertionIds: "VA-001",
						summary: "s",
						description: "d",
					} as unknown as never,
				],
			}),
		);
		await expect(parseMilestoneValidatorResult(path)).rejects.toThrow(/assertionIds/);
	});

	test("rejects cross-field inconsistency: pass + blocker", async () => {
		const path = writeOutput(
			"out.json",
			base({
				verdict: "pass",
				findings: [
					{
						id: "x",
						validator: "scrutiny",
						round: 1,
						severity: "blocker",
						assertionIds: ["VA-001"],
						summary: "s",
						description: "d",
					},
				],
			}),
		);
		await expect(parseMilestoneValidatorResult(path)).rejects.toThrow(/pass.*blocker/);
	});

	test("rejects cross-field inconsistency: needs-fix without blockers", async () => {
		const path = writeOutput(
			"out.json",
			base({
				verdict: "needs-fix",
				findings: [
					{
						id: "x",
						validator: "scrutiny",
						round: 1,
						severity: "warning",
						assertionIds: ["VA-001"],
						summary: "s",
						description: "d",
					},
				],
			}),
		);
		await expect(parseMilestoneValidatorResult(path)).rejects.toThrow(/needs-fix.*no blockers/);
	});

	test("rejects non-string lessons entries", async () => {
		const path = writeOutput("out.json", { ...base(), lessons: ["ok", 42] as unknown as string[] });
		await expect(parseMilestoneValidatorResult(path)).rejects.toThrow(/lessons/);
	});
});

describe("parseScrutinyValidatorResult", () => {
	test("accepts scrutiny output", async () => {
		const path = writeOutput("out.json", base());
		const result = await parseScrutinyValidatorResult(path);
		expect(result.validator).toBe("scrutiny");
	});

	test("rejects user-testing output", async () => {
		const path = writeOutput("out.json", base({ validator: "user-testing" }));
		await expect(parseScrutinyValidatorResult(path)).rejects.toThrow(/user-testing/);
	});
});
