/**
 * Unit tests for milestone-runner (Track #2 integration).
 *
 * Stubs validator spawns + parse via the injectable deps bag so the
 * test exercises the pure orchestration logic without booting agents.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	countFixFeaturesForMilestone,
	type GeneratedFixFeature,
	insertFixFeaturesIntoBatch,
	type MilestoneValidatorOutput,
	promoteToBatch,
	recordTaskOutcome,
	runValidationRound,
	type ValidationRoundDeps,
	type ValidationRoundResult,
	type ValidatorFinding,
} from "../src/missioncontrol";
import type { BatchMilestone, MissionState } from "../src/types";

let sandbox: string;

function seedMission(): MissionState {
	return {
		description: "Runner test",
		mode: "simple",
		phases: [],
		autonomy: "medium",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: new Date(0).toISOString(),
	};
}

function driveMilestoneToValidating(): MissionState {
	let state = promoteToBatch(seedMission(), { taskIds: ["F-001", "F-002"], laneCount: 2, waveSize: 2 });
	state = recordTaskOutcome(state, {
		taskId: "F-001",
		status: "succeeded",
		startTime: 0,
		endTime: 10,
		exitReason: "ok",
		sessionName: "lane-1",
		doneFileFound: true,
	});
	state = recordTaskOutcome(state, {
		taskId: "F-002",
		status: "succeeded",
		startTime: 5,
		endTime: 15,
		exitReason: "ok",
		sessionName: "lane-2",
		doneFileFound: true,
	});
	return state;
}

function currentMs(state: MissionState): BatchMilestone {
	const ms = state.batch?.milestones?.[0];
	if (!ms) throw new Error("milestone missing from seeded state");
	return ms;
}

function output(
	verdict: MilestoneValidatorOutput["verdict"],
	kind: "scrutiny" | "user-testing",
	round = 1,
	findings: ValidatorFinding[] = [],
): MilestoneValidatorOutput {
	return {
		schemaVersion: 1,
		validator: kind,
		milestoneId: "M-001",
		round,
		startedAt: 0,
		completedAt: 1,
		verdict,
		summary: `${kind} ${verdict}`,
		findings,
		lessons: [`${kind}: lesson for round ${round}`],
	};
}

function blockerFinding(id: string, round = 1, validator: "scrutiny" | "user-testing" = "scrutiny"): ValidatorFinding {
	return {
		id,
		validator,
		round,
		severity: "blocker",
		assertionIds: ["VA-001"],
		summary: `Missing ${id}`,
		description: `Blocker for ${id}`,
	};
}

function makeDeps(overrides: Partial<ValidationRoundDeps> = {}): {
	deps: ValidationRoundDeps;
	persists: MissionState[];
} {
	const persists: MissionState[] = [];
	const deps: ValidationRoundDeps = {
		cwd: sandbox,
		persist: async state => {
			// Deep clone so subsequent mutations don't retroactively corrupt
			// the captured snapshot.
			persists.push(JSON.parse(JSON.stringify(state)) as MissionState);
		},
		spawnScrutiny: async () => fakeAgentResult(),
		spawnUserTesting: async () => fakeAgentResult(),
		parseScrutiny: async () => output("pass", "scrutiny"),
		parseUserTesting: async () => output("pass", "user-testing"),
		ingestLessons: async () => 0,
		generateFixFeatures: async opts =>
			opts.findings
				.filter(f => f.severity === "blocker")
				.map((f, i) => makeGeneratedFixFeature(f, opts.milestoneId, (opts.existingFixFeatureCount ?? 0) + i)),
		now: () => 1_000,
		contractPath: join(sandbox, "validation-contract.json"),
		batchStatePath: join(sandbox, "mission-batch.json"),
		stallTimeoutMs: 10_000,
		...overrides,
	};
	return { deps, persists };
}

function fakeAgentResult(): import("../src/missioncontrol").AgentHostResult {
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

function makeGeneratedFixFeature(f: ValidatorFinding, milestoneId: string, index: number): GeneratedFixFeature {
	const num = String(index + 1).padStart(3, "0");
	const milestoneMatch = /-(\d+)$/.exec(milestoneId);
	const mnum = milestoneMatch ? (milestoneMatch[1]?.padStart(3, "0") ?? "000") : "000";
	const taskId = `FIX-${mnum}-${num}`;
	const taskFolder = join(sandbox, "tasks", taskId);
	return {
		taskId,
		taskFolder,
		prompt: `fix for ${f.id}`,
		record: {
			taskId,
			laneNumber: 0,
			sessionName: "",
			status: "pending",
			taskFolder,
			startedAt: null,
			endedAt: null,
			doneFileFound: false,
			exitReason: "",
			milestoneId,
			fulfillsAssertionIds: [...f.assertionIds],
			isFixFeature: true,
			...(f.parentFeatureId ? { parentFeatureId: f.parentFeatureId } : {}),
		},
	};
}

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-milestone-runner-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

describe("insertFixFeaturesIntoBatch", () => {
	test("appends pending TaskOutcomes, new wave, and bumps tasksTotal", () => {
		const state = driveMilestoneToValidating();
		const ff1 = makeGeneratedFixFeature(blockerFinding("F-1"), "M-001", 0);
		const ff2 = makeGeneratedFixFeature(blockerFinding("F-2"), "M-001", 1);
		const next = insertFixFeaturesIntoBatch(state, [ff1, ff2]);
		expect(next.batch?.tasks.map(t => t.taskId)).toEqual(["F-001", "F-002", ff1.taskId, ff2.taskId]);
		expect(next.batch?.waves).toHaveLength(2);
		expect(next.batch?.waves[1]?.taskIds).toEqual([ff1.taskId, ff2.taskId]);
		expect(next.batch?.tasksTotal).toBe(4);
		// Original batch untouched.
		expect(state.batch?.tasks).toHaveLength(2);
	});

	test("empty fix-feature list is a no-op", () => {
		const state = driveMilestoneToValidating();
		const next = insertFixFeaturesIntoBatch(state, []);
		expect(next).toBe(state);
	});
});

describe("countFixFeaturesForMilestone", () => {
	test("counts FIX-<milestone>- prefixed tasks", () => {
		let state = driveMilestoneToValidating();
		const f1 = makeGeneratedFixFeature(blockerFinding("A"), "M-001", 0);
		const f2 = makeGeneratedFixFeature(blockerFinding("B"), "M-001", 1);
		const f3 = makeGeneratedFixFeature(blockerFinding("C"), "M-002", 0);
		state = insertFixFeaturesIntoBatch(state, [f1, f2, f3]);
		expect(countFixFeaturesForMilestone(state.batch!, "M-001")).toBe(2);
		expect(countFixFeaturesForMilestone(state.batch!, "M-002")).toBe(1);
		expect(countFixFeaturesForMilestone(state.batch!, "M-009")).toBe(0);
	});

	test("falls back to 000 prefix for non-standard milestone ids", () => {
		const state = driveMilestoneToValidating();
		expect(countFixFeaturesForMilestone(state.batch!, "foo")).toBe(0);
	});
});

describe("runValidationRound", () => {
	test("bumps round counter on the milestone before spawning", async () => {
		const state = driveMilestoneToValidating();
		const ms = currentMs(state);
		const { deps, persists } = makeDeps();
		await runValidationRound(state, ms, deps);
		// First persist happens right after the bump, before any spawn.
		expect(persists[0]?.batch?.milestones?.[0]?.validationRounds).toBe(1);
	});

	test("happy path: pass marks milestone passed", async () => {
		const state = driveMilestoneToValidating();
		const ms = currentMs(state);
		const { deps } = makeDeps();
		const result = await runValidationRound(state, ms, deps);
		expect(result.kind).toBe("passed");
		expect(result.state.batch?.milestones?.[0]?.status).toBe("passed");
		expect(result.state.batch?.milestones?.[0]?.validationRounds).toBe(1);
	});

	test("fatal fail marks milestone failed immediately", async () => {
		const state = driveMilestoneToValidating();
		const ms = currentMs(state);
		const { deps } = makeDeps({
			parseScrutiny: async () => output("fail", "scrutiny"),
			parseUserTesting: async () => output("pass", "user-testing"),
		});
		const result = await runValidationRound(state, ms, deps);
		expect(result.kind).toBe("failed-fatal");
		expect(result.state.batch?.milestones?.[0]?.status).toBe("failed");
	});

	test("needs-fix generates fix features, appends wave, resets milestone to in_progress", async () => {
		const state = driveMilestoneToValidating();
		const ms = currentMs(state);
		const finding = blockerFinding("F-X");
		const { deps } = makeDeps({
			parseScrutiny: async () => output("needs-fix", "scrutiny", 1, [finding]),
			parseUserTesting: async () => output("pass", "user-testing"),
		});
		const result = (await runValidationRound(state, ms, deps)) as Extract<
			ValidationRoundResult,
			{ kind: "fix-features-generated" }
		>;
		expect(result.kind).toBe("fix-features-generated");
		expect(result.fixFeatures).toHaveLength(1);
		expect(result.state.batch?.milestones?.[0]?.status).toBe("in_progress");
		expect(result.state.batch?.waves).toHaveLength(2);
		expect(result.state.batch?.waves[1]?.taskIds[0]).toBe(result.fixFeatures[0]?.taskId);
		expect(result.state.batch?.tasksTotal).toBe(3);
	});

	test("needs-fix at maxValidationRounds short-circuits to failed-max-rounds", async () => {
		let state = driveMilestoneToValidating();
		// Force the milestone to the last allowed round.
		state = {
			...state,
			batch: {
				...state.batch!,
				milestones: state.batch?.milestones?.map(m => ({
					...m,
					validationRounds: m.maxValidationRounds - 1,
				})),
			},
		};
		const ms = currentMs(state);
		const finding = blockerFinding("F-LAST");
		let fixGenerated = false;
		const { deps } = makeDeps({
			parseScrutiny: async () => output("needs-fix", "scrutiny", ms.maxValidationRounds, [finding]),
			parseUserTesting: async () => output("pass", "user-testing", ms.maxValidationRounds),
			generateFixFeatures: async () => {
				fixGenerated = true;
				return [];
			},
		});
		const result = await runValidationRound(state, ms, deps);
		expect(result.kind).toBe("failed-max-rounds");
		expect(result.state.batch?.milestones?.[0]?.status).toBe("failed");
		expect(result.state.batch?.milestones?.[0]?.validationRounds).toBe(ms.maxValidationRounds);
		expect(fixGenerated).toBe(false);
	});

	test("stall surfaces as structured result without marking milestone failed", async () => {
		const state = driveMilestoneToValidating();
		const ms = currentMs(state);
		const { deps } = makeDeps({
			stallTimeoutMs: 10,
			spawnScrutiny: () => new Promise(() => {}),
			spawnUserTesting: async () => fakeAgentResult(),
		});
		const result = await runValidationRound(state, ms, deps);
		expect(result.kind).toBe("stalled");
		if (result.kind === "stalled") {
			expect(result.validator).toBe("scrutiny");
			expect(result.timeoutMs).toBe(10);
		}
		// Milestone stays in validating; only the round counter bumped.
		expect(result.state.batch?.milestones?.[0]?.status).toBe("validating");
		expect(result.state.batch?.milestones?.[0]?.validationRounds).toBe(1);
	});

	test("stall on user-testing reports which validator hung", async () => {
		const state = driveMilestoneToValidating();
		const ms = currentMs(state);
		const { deps } = makeDeps({
			stallTimeoutMs: 10,
			spawnScrutiny: async () => fakeAgentResult(),
			spawnUserTesting: () => new Promise(() => {}),
		});
		const result = await runValidationRound(state, ms, deps);
		expect(result.kind).toBe("stalled");
		if (result.kind === "stalled") {
			expect(result.validator).toBe("user-testing");
		}
	});

	test("parse failure is surfaced as failed-fatal with a synthetic round record", async () => {
		const state = driveMilestoneToValidating();
		const ms = currentMs(state);
		const { deps } = makeDeps({
			parseScrutiny: async () => {
				throw new Error("boom");
			},
		});
		const result = await runValidationRound(state, ms, deps);
		expect(result.kind).toBe("failed-fatal");
		expect(result.state.batch?.milestones?.[0]?.status).toBe("failed");
		if (result.kind === "failed-fatal") {
			expect(result.round.verdict).toBe("fail");
		}
	});

	test("second round offsets generated fix-feature ids past the first round's count", async () => {
		let state = driveMilestoneToValidating();
		// Seed round 1 fix feature already in the batch.
		const prior = makeGeneratedFixFeature(blockerFinding("F-PRIOR"), "M-001", 0);
		state = insertFixFeaturesIntoBatch(state, [prior]);
		// Bump round to 2 to mirror the lane-runner's post-round-1 state.
		state = {
			...state,
			batch: {
				...state.batch!,
				milestones: state.batch?.milestones?.map(m => ({
					...m,
					validationRounds: 1,
					status: "validating" as const,
				})),
			},
		};
		const ms = currentMs(state);
		const seenCounts: number[] = [];
		const { deps } = makeDeps({
			parseScrutiny: async () => output("needs-fix", "scrutiny", 2, [blockerFinding("F-NEW", 2)]),
			parseUserTesting: async () => output("pass", "user-testing", 2),
			generateFixFeatures: async opts => {
				seenCounts.push(opts.existingFixFeatureCount ?? 0);
				return opts.findings
					.filter(f => f.severity === "blocker")
					.map((f, i) => makeGeneratedFixFeature(f, opts.milestoneId, (opts.existingFixFeatureCount ?? 0) + i));
			},
		});
		const result = await runValidationRound(state, ms, deps);
		expect(seenCounts[0]).toBe(1);
		if (result.kind === "fix-features-generated") {
			expect(result.fixFeatures[0]?.taskId).toBe("FIX-001-002");
		} else {
			throw new Error(`expected fix-features-generated, got ${result.kind}`);
		}
	});

	test("ingests lessons into knowledge library via injected helper", async () => {
		const state = driveMilestoneToValidating();
		const ms = currentMs(state);
		const seen: Array<{ milestoneId: string; author: string; count: number }> = [];
		const { deps } = makeDeps({
			ingestLessons: async (_cwd, milestoneId, author, lessons) => {
				seen.push({ milestoneId, author, count: lessons.length });
				return lessons.length;
			},
		});
		await runValidationRound(state, ms, deps);
		const scrutinyIngest = seen.find(s => s.author === "scrutiny-validator");
		const userTestingIngest = seen.find(s => s.author === "user-testing-validator");
		expect(scrutinyIngest?.milestoneId).toBe("M-001");
		expect(scrutinyIngest?.count).toBe(1);
		expect(userTestingIngest?.count).toBe(1);
	});

	test("writes validator output files to canonical paths before parsing", async () => {
		// Use the real parsers to verify the spawn injects the right output
		// path. The fake spawn writes the file in place.
		const state = driveMilestoneToValidating();
		const ms = currentMs(state);
		const batchId = state.batch?.batchId ?? "";
		const scrutinyPayload = output("pass", "scrutiny");
		const userTestingPayload = output("pass", "user-testing");
		let sawScrutinyPath = "";
		let sawUserTestingPath = "";
		const { deps } = makeDeps({
			parseScrutiny: undefined,
			parseUserTesting: undefined,
			spawnScrutiny: async opts => {
				sawScrutinyPath = opts.outputPath;
				mkdirSync(dirname(opts.outputPath), { recursive: true });
				writeFileSync(opts.outputPath, JSON.stringify(scrutinyPayload));
				return fakeAgentResult();
			},
			spawnUserTesting: async opts => {
				sawUserTestingPath = opts.outputPath;
				mkdirSync(dirname(opts.outputPath), { recursive: true });
				writeFileSync(opts.outputPath, JSON.stringify(userTestingPayload));
				return fakeAgentResult();
			},
		});
		const result = await runValidationRound(state, ms, deps);
		expect(result.kind).toBe("passed");
		expect(sawScrutinyPath).toContain(batchId);
		expect(sawScrutinyPath).toContain("M-001-scrutiny-round1.json");
		expect(sawUserTestingPath).toContain("M-001-user-testing-round1.json");
		expect(existsSync(sawScrutinyPath)).toBe(true);
	});

	test("non-blocker findings with needs-fix verdict still pass when generator returns []", async () => {
		// Cross-field consistency rejects needs-fix without blockers at
		// parse-time; exercise the defensive path in the runner by
		// injecting a generator that returns an empty array even for
		// blockers.
		const state = driveMilestoneToValidating();
		const ms = currentMs(state);
		const finding = blockerFinding("F-X");
		const { deps } = makeDeps({
			parseScrutiny: async () => output("needs-fix", "scrutiny", 1, [finding]),
			parseUserTesting: async () => output("pass", "user-testing"),
			generateFixFeatures: async () => [],
		});
		const result = await runValidationRound(state, ms, deps);
		expect(result.kind).toBe("passed");
		expect(result.state.batch?.milestones?.[0]?.status).toBe("passed");
	});
});

describe("runValidationRound contract-path defaults", () => {
	test("passes default contract + batch state paths into the spawn", async () => {
		const state = driveMilestoneToValidating();
		const ms = currentMs(state);
		let sawContract = "";
		let sawBatchState = "";
		const { deps } = makeDeps({
			contractPath: undefined,
			batchStatePath: undefined,
			spawnScrutiny: async opts => {
				sawContract = opts.contractPath;
				sawBatchState = opts.batchStatePath;
				return fakeAgentResult();
			},
		});
		await runValidationRound(state, ms, deps);
		expect(sawContract).toContain("validation-contract.json");
		expect(sawBatchState).toContain("mission-batch.json");
	});
});

describe("runValidationRound resume reconciliation", () => {
	test("skips spawns for slots marked non-respawn + reuses existing outputs", async () => {
		const state = driveMilestoneToValidating();
		const ms = currentMs(state);
		// Pre-write both validator output files at round 1 as if the prior
		// supervisor had completed the work before crashing.
		const batchId = state.batch?.batchId ?? "";
		const scrutinyPath = join(sandbox, ".omp", "validation", batchId, `${ms.id}-scrutiny-round1.json`);
		const userTestingPath = join(sandbox, ".omp", "validation", batchId, `${ms.id}-user-testing-round1.json`);
		mkdirSync(dirname(scrutinyPath), { recursive: true });
		writeFileSync(scrutinyPath, JSON.stringify(output("pass", "scrutiny")));
		writeFileSync(userTestingPath, JSON.stringify(output("pass", "user-testing")));

		let scrutinySpawns = 0;
		let userTestingSpawns = 0;
		const { deps, persists } = makeDeps({
			// Use real parsers so the on-disk files are the source of truth.
			parseScrutiny: undefined,
			parseUserTesting: undefined,
			spawnScrutiny: async () => {
				scrutinySpawns += 1;
				return fakeAgentResult();
			},
			spawnUserTesting: async () => {
				userTestingSpawns += 1;
				return fakeAgentResult();
			},
			reconciliation: {
				milestoneId: ms.id,
				round: 1,
				slots: [
					{ kind: "scrutiny", outputPath: scrutinyPath, needsRespawn: false },
					{ kind: "user-testing", outputPath: userTestingPath, needsRespawn: false },
				],
			},
		});
		const result = await runValidationRound(state, ms, deps);
		expect(result.kind).toBe("passed");
		// No spawns fired when the reconciliation reused both outputs.
		expect(scrutinySpawns).toBe(0);
		expect(userTestingSpawns).toBe(0);
		// Round number did not bump — reuse mode persists the existing round.
		expect(result.state.batch?.milestones?.[0]?.validationRounds).toBe(1);
		// No pre-spawn persist either, since reconciliation implies the
		// round counter was already written before the crash.
		expect(persists.every(p => p.batch?.milestones?.[0]?.validationRounds === 1)).toBe(true);
	});

	test("partial reconciliation spawns only the missing validator", async () => {
		const state = driveMilestoneToValidating();
		const ms = currentMs(state);
		const batchId = state.batch?.batchId ?? "";
		// Only the scrutiny output survived the crash.
		const scrutinyPath = join(sandbox, ".omp", "validation", batchId, `${ms.id}-scrutiny-round1.json`);
		const userTestingPath = join(sandbox, ".omp", "validation", batchId, `${ms.id}-user-testing-round1.json`);
		mkdirSync(dirname(scrutinyPath), { recursive: true });
		writeFileSync(scrutinyPath, JSON.stringify(output("pass", "scrutiny")));

		let scrutinySpawns = 0;
		let userTestingSpawns = 0;
		const { deps } = makeDeps({
			parseScrutiny: undefined,
			parseUserTesting: undefined,
			spawnScrutiny: async () => {
				scrutinySpawns += 1;
				return fakeAgentResult();
			},
			spawnUserTesting: async opts => {
				userTestingSpawns += 1;
				mkdirSync(dirname(opts.outputPath), { recursive: true });
				writeFileSync(opts.outputPath, JSON.stringify(output("pass", "user-testing")));
				return fakeAgentResult();
			},
			reconciliation: {
				milestoneId: ms.id,
				round: 1,
				slots: [
					{ kind: "scrutiny", outputPath: scrutinyPath, needsRespawn: false },
					{ kind: "user-testing", outputPath: userTestingPath, needsRespawn: true, parseError: "not found" },
				],
			},
		});
		const result = await runValidationRound(state, ms, deps);
		expect(result.kind).toBe("passed");
		expect(scrutinySpawns).toBe(0);
		expect(userTestingSpawns).toBe(1);
		expect(result.state.batch?.milestones?.[0]?.validationRounds).toBe(1);
	});

	test("reconciliation with all-respawn slots spawns both and reuses existing round", async () => {
		const state = driveMilestoneToValidating();
		const ms = currentMs(state);
		let scrutinySpawns = 0;
		let userTestingSpawns = 0;
		const { deps } = makeDeps({
			spawnScrutiny: async () => {
				scrutinySpawns += 1;
				return fakeAgentResult();
			},
			spawnUserTesting: async () => {
				userTestingSpawns += 1;
				return fakeAgentResult();
			},
			reconciliation: {
				milestoneId: ms.id,
				round: 1,
				slots: [
					{ kind: "scrutiny", outputPath: "/ignored", needsRespawn: true },
					{ kind: "user-testing", outputPath: "/ignored", needsRespawn: true },
				],
			},
		});
		const result = await runValidationRound(state, ms, deps);
		expect(result.kind).toBe("passed");
		expect(scrutinySpawns).toBe(1);
		expect(userTestingSpawns).toBe(1);
		// Round number stays at 1 — reconciliation.round wins over bump.
		expect(result.state.batch?.milestones?.[0]?.validationRounds).toBe(1);
	});
});
