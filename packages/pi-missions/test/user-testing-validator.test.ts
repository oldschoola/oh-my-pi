/**
 * Tests for user-testing validator spawn + parse + round merge + union
 * helpers (Track C).
 *
 * Reuses the same injectable-spawn pattern as Track B so we avoid booting
 * the real RPC coding agent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
	AgentHostOptions,
	AgentHostResult,
	MilestoneValidatorOutput,
	spawnHostedAgent,
	ValidatorFinding,
} from "../src/missioncontrol";
import {
	combineValidatorVerdicts,
	MILESTONE_VALIDATOR_SCHEMA_VERSION,
	mergeValidatorRound,
	parseUserTestingValidatorResult,
	renderUserTestingPrompt,
	StateFileError,
	spawnUserTestingValidator,
	unionFindings,
	unionLessons,
} from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-ut-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function fakeResult(): AgentHostResult {
	return {
		exitCode: 0,
		signal: null,
		durationMs: 1,
		killed: false,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		toolCalls: 0,
		lastTool: "",
		contextUsage: null,
		error: null,
		agentEnded: true,
	};
}

function captureSpawn(): {
	spawn: typeof spawnHostedAgent;
	captured: { options: AgentHostOptions | null };
} {
	const captured: { options: AgentHostOptions | null } = { options: null };
	const spawn: typeof spawnHostedAgent = opts => {
		captured.options = opts;
		return { promise: Promise.resolve(fakeResult()), kill: () => {} };
	};
	return { spawn, captured };
}

function writeOutput(name: string, payload: unknown): string {
	const full = join(sandbox, name);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, JSON.stringify(payload), "utf-8");
	return full;
}

function baseOutput(overrides: Partial<MilestoneValidatorOutput> = {}): MilestoneValidatorOutput {
	return {
		schemaVersion: MILESTONE_VALIDATOR_SCHEMA_VERSION,
		validator: "user-testing",
		milestoneId: "M-001",
		round: 1,
		startedAt: 1000,
		completedAt: 2000,
		verdict: "pass",
		summary: "All behavioral assertions reproduce.",
		findings: [],
		lessons: ["TAB toggle works in the browser harness."],
		...overrides,
	};
}

function finding(overrides: Partial<ValidatorFinding> = {}): ValidatorFinding {
	return {
		id: "UT-M-001-R1-001",
		validator: "user-testing",
		round: 1,
		severity: "blocker",
		assertionIds: ["VA-001"],
		summary: "s",
		description: "d",
		...overrides,
	};
}

describe("renderUserTestingPrompt", () => {
	test("interpolates every placeholder (same shape as scrutiny)", () => {
		const rendered = renderUserTestingPrompt(
			"id={{milestoneId}} r={{round}} c={{contractPath}} b={{batchStatePath}} o={{outputPath}}",
			{
				milestoneId: "M-007",
				round: 3,
				contractPath: "/c.json",
				batchStatePath: "/s.json",
				outputPath: "/o.json",
			},
		);
		expect(rendered).toBe("id=M-007 r=3 c=/c.json b=/s.json o=/o.json");
	});
});

describe("spawnUserTestingValidator", () => {
	test("sets validator kind env + prompt + output dir", async () => {
		const outputPath = join(sandbox, "validation", "b-1", "M-001-user-testing-round1.json");
		expect(existsSync(dirname(outputPath))).toBe(false);
		const { spawn, captured } = captureSpawn();

		await spawnUserTestingValidator({
			cwd: sandbox,
			batchId: "b-1",
			milestoneId: "M-001",
			round: 1,
			outputPath,
			contractPath: "/c.json",
			batchStatePath: "/s.json",
			spawn,
			loadTemplate: async () => "exercise {{milestoneId}}",
			now: () => 500,
		});

		expect(existsSync(dirname(outputPath))).toBe(true);
		const opts = captured.options;
		expect(opts?.env?.MISSION_VALIDATOR_KIND).toBe("user-testing");
		expect(opts?.env?.MISSION_VALIDATOR_MILESTONE).toBe("M-001");
		expect(opts?.env?.MISSION_VALIDATOR_ROUND).toBe("1");
		expect(opts?.env?.MISSION_VALIDATOR_OUTPUT_PATH).toBe(outputPath);
		expect(opts?.prompt).toContain("exercise M-001");
	});

	test("auto-generates a user-testing agent id when not supplied", async () => {
		const { spawn, captured } = captureSpawn();
		await spawnUserTestingValidator({
			cwd: sandbox,
			batchId: "b-1",
			milestoneId: "M-003",
			round: 2,
			outputPath: join(sandbox, "out.json"),
			contractPath: "/c.json",
			batchStatePath: "/s.json",
			spawn,
			loadTemplate: async () => "stub",
			now: () => 777,
		});
		expect(captured.options?.agentId).toBe("user-testing-M-003-r2-777");
	});

	test("scrutiny + user-testing spawns are independent and concurrent", async () => {
		const calls: string[] = [];
		const spawn: typeof spawnHostedAgent = opts => {
			calls.push(opts.env?.MISSION_VALIDATOR_KIND ?? "unknown");
			return { promise: Promise.resolve(fakeResult()), kill: () => {} };
		};
		const base = {
			cwd: sandbox,
			batchId: "b-1",
			milestoneId: "M-001",
			round: 1,
			contractPath: "/c.json",
			batchStatePath: "/s.json",
			spawn,
			loadTemplate: async () => "stub",
			now: () => 1,
		};
		await Promise.all([
			import("../src/missioncontrol").then(m =>
				m.spawnScrutinyValidator({ ...base, outputPath: join(sandbox, "scr.json") }),
			),
			spawnUserTestingValidator({ ...base, outputPath: join(sandbox, "ut.json") }),
		]);
		expect(calls).toContain("scrutiny");
		expect(calls).toContain("user-testing");
	});
});

describe("parseUserTestingValidatorResult", () => {
	test("accepts user-testing output", async () => {
		const path = writeOutput("out.json", baseOutput());
		const result = await parseUserTestingValidatorResult(path);
		expect(result.validator).toBe("user-testing");
	});

	test("rejects scrutiny output", async () => {
		const path = writeOutput("out.json", baseOutput({ validator: "scrutiny" }));
		await expect(parseUserTestingValidatorResult(path)).rejects.toThrow(/scrutiny/);
	});
});

describe("combineValidatorVerdicts", () => {
	test("fail dominates", () => {
		expect(combineValidatorVerdicts("fail", "pass")).toBe("fail");
		expect(combineValidatorVerdicts("pass", "fail")).toBe("fail");
		expect(combineValidatorVerdicts("needs-fix", "fail")).toBe("fail");
	});

	test("needs-fix dominates pass", () => {
		expect(combineValidatorVerdicts("needs-fix", "pass")).toBe("needs-fix");
		expect(combineValidatorVerdicts("pass", "needs-fix")).toBe("needs-fix");
	});

	test("pass + pass = pass", () => {
		expect(combineValidatorVerdicts("pass", "pass")).toBe("pass");
	});
});

describe("unionFindings", () => {
	test("preserves order (scrutiny first, user-testing after)", () => {
		const s1 = finding({ id: "SCR-001", validator: "scrutiny" });
		const s2 = finding({ id: "SCR-002", validator: "scrutiny" });
		const u1 = finding({ id: "UT-001" });
		const merged = unionFindings([s1, s2], [u1]);
		expect(merged.map(f => f.id)).toEqual(["SCR-001", "SCR-002", "UT-001"]);
	});

	test("drops exact duplicates by id", () => {
		const a = finding({ id: "SCR-001" });
		const b = finding({ id: "SCR-001", summary: "different" });
		const merged = unionFindings([a], [b]);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toBe(a);
	});

	test("empty arrays return empty union", () => {
		expect(unionFindings([], [])).toEqual([]);
	});
});

describe("unionLessons", () => {
	test("preserves order and dedupes", () => {
		const merged = unionLessons(["alpha", "beta"], ["beta", "gamma"]);
		expect(merged).toEqual(["alpha", "beta", "gamma"]);
	});

	test("trims whitespace and skips empties", () => {
		const merged = unionLessons(["  alpha  ", ""], ["alpha", " "]);
		expect(merged).toEqual(["alpha"]);
	});
});

describe("mergeValidatorRound", () => {
	function scr(overrides: Partial<MilestoneValidatorOutput> = {}): MilestoneValidatorOutput {
		return { ...baseOutput({ validator: "scrutiny" }), ...overrides };
	}
	function ut(overrides: Partial<MilestoneValidatorOutput> = {}): MilestoneValidatorOutput {
		return { ...baseOutput({ validator: "user-testing" }), ...overrides };
	}

	test("merges two passes into a pass", () => {
		const round = mergeValidatorRound(scr(), ut());
		expect(round.verdict).toBe("pass");
		expect(round.findings).toEqual([]);
		expect(round.milestoneId).toBe("M-001");
		expect(round.round).toBe(1);
	});

	test("needs-fix in either run produces needs-fix", () => {
		const sFindings = [finding({ id: "SCR-001", validator: "scrutiny" })];
		const round = mergeValidatorRound(scr({ verdict: "needs-fix", findings: sFindings }), ut({ verdict: "pass" }));
		expect(round.verdict).toBe("needs-fix");
		expect(round.findings.map(f => f.id)).toEqual(["SCR-001"]);
	});

	test("unions findings from both sources (scrutiny before user-testing)", () => {
		const round = mergeValidatorRound(
			scr({
				verdict: "needs-fix",
				findings: [finding({ id: "SCR-001", validator: "scrutiny" })],
			}),
			ut({
				verdict: "needs-fix",
				findings: [finding({ id: "UT-001" })],
			}),
		);
		expect(round.findings.map(f => f.id)).toEqual(["SCR-001", "UT-001"]);
	});

	test("startedAt is min, completedAt is max across the two runs", () => {
		const round = mergeValidatorRound(
			scr({ startedAt: 100, completedAt: 200 }),
			ut({ startedAt: 150, completedAt: 300 }),
		);
		expect(round.startedAt).toBe(100);
		expect(round.completedAt).toBe(300);
	});

	test("rejects mismatched milestoneId", () => {
		expect(() => mergeValidatorRound(scr({ milestoneId: "M-001" }), ut({ milestoneId: "M-002" }))).toThrow(
			StateFileError,
		);
	});

	test("rejects mismatched round", () => {
		expect(() => mergeValidatorRound(scr({ round: 1 }), ut({ round: 2 }))).toThrow(/round mismatch/);
	});

	test("rejects swapped validator kinds", () => {
		expect(() => mergeValidatorRound(scr({ validator: "user-testing" }), ut({ validator: "scrutiny" }))).toThrow(
			/validator kinds mismatched/,
		);
	});

	test("fail in either run promotes the merged verdict to fail", () => {
		const round = mergeValidatorRound(scr({ verdict: "fail", findings: [] }), ut({ verdict: "pass" }));
		expect(round.verdict).toBe("fail");
	});
});
