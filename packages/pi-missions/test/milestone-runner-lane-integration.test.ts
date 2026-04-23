/**
 * End-to-end test: lane-runner drives the milestone validator loop.
 *
 * Seeds a batch with one feature, stubs the agent spawn (via the
 * existing `OMP_MISSION_STUB_AGENT=1` env flag in `adapter.ts`), and
 * injects fake validator spawns + parsers through `LaneRunnerDeps.validation`.
 * The fakes script a 2-round validation:
 *
 *   round 1 → needs-fix (one blocker) → generator produces FIX-001-001
 *   round 2 → pass
 *
 * Assertions verify that:
 *   - The original feature succeeds.
 *   - A fix feature was injected + ran to success.
 *   - Two validator rounds executed.
 *   - The milestone ends in `"passed"` and the batch phase reaches
 *     `"complete"`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	beginBatch,
	type GeneratedFixFeature,
	type GenerateFixFeaturesOptions,
	type MilestoneValidatorOutput,
	promoteToBatch,
	startLaneRunner,
	type ValidatorFinding,
} from "../src/missioncontrol";
import { DEFAULT_MISSIONCONTROL_CONFIG } from "../src/missioncontrol/types";
import type { MissionState } from "../src/types";

const originalStubFlag = process.env.OMP_MISSION_STUB_AGENT;

let sandbox: string;

function baseMission(): MissionState {
	return {
		description: "lane-runner + milestone validator loop",
		mode: "simple",
		phases: [],
		autonomy: "auto",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: new Date().toISOString(),
	};
}

function scrutinyOutput(
	verdict: MilestoneValidatorOutput["verdict"],
	round: number,
	findings: ValidatorFinding[] = [],
): MilestoneValidatorOutput {
	return {
		schemaVersion: 1,
		validator: "scrutiny",
		milestoneId: "M-001",
		round,
		startedAt: 0,
		completedAt: 1,
		verdict,
		summary: `scrutiny round ${round}`,
		findings,
		lessons: [`scrutiny insight ${round}`],
	};
}

function userTestingOutput(verdict: MilestoneValidatorOutput["verdict"], round: number): MilestoneValidatorOutput {
	return {
		schemaVersion: 1,
		validator: "user-testing",
		milestoneId: "M-001",
		round,
		startedAt: 0,
		completedAt: 1,
		verdict,
		summary: `user-testing round ${round}`,
		findings: [],
		lessons: [`user-testing insight ${round}`],
	};
}

function blockerFinding(id: string, round: number): ValidatorFinding {
	return {
		id,
		validator: "scrutiny",
		round,
		severity: "blocker",
		assertionIds: ["VA-001"],
		summary: `missing ${id}`,
		description: `Blocker for ${id}`,
	};
}

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-lane-integration-"));
	mkdirSync(join(sandbox, ".omp"), { recursive: true });
	process.env.OMP_MISSION_STUB_AGENT = "1";
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
	if (originalStubFlag === undefined) delete process.env.OMP_MISSION_STUB_AGENT;
	else process.env.OMP_MISSION_STUB_AGENT = originalStubFlag;
});

describe("lane-runner milestone validator loop", () => {
	test("round 1 needs-fix → fix feature → round 2 pass → batch complete", async () => {
		let state: MissionState = promoteToBatch(
			baseMission(),
			{ taskIds: ["F-001", "F-002"], laneCount: 2, waveSize: 2 },
			DEFAULT_MISSIONCONTROL_CONFIG,
		);
		state = beginBatch(state);

		const parseCalls: Array<{ kind: "scrutiny" | "user-testing"; round: number }> = [];
		const generateCalls: GenerateFixFeaturesOptions[] = [];

		const runner = startLaneRunner({
			cwd: sandbox,
			getMission: () => state,
			setMission: next => {
				state = next;
			},
			persist: async () => {
				// No-op — test doesn't need disk verification; the in-memory
				// state is the source of truth.
			},
			config: DEFAULT_MISSIONCONTROL_CONFIG,
			validation: {
				stallTimeoutMs: 60_000,
				spawnScrutiny: async () => fakeAgentResult(),
				spawnUserTesting: async () => fakeAgentResult(),
				parseScrutiny: async path => {
					const round = roundFromPath(path);
					parseCalls.push({ kind: "scrutiny", round });
					if (round === 1) return scrutinyOutput("needs-fix", 1, [blockerFinding("F-BLOCK", 1)]);
					return scrutinyOutput("pass", round);
				},
				parseUserTesting: async path => {
					const round = roundFromPath(path);
					parseCalls.push({ kind: "user-testing", round });
					return userTestingOutput("pass", round);
				},
				ingestLessons: async () => 0,
				generateFixFeatures: async opts => {
					generateCalls.push(opts);
					return opts.findings
						.filter(f => f.severity === "blocker")
						.map((f, i) => stubFixFeature(f, opts.milestoneId, (opts.existingFixFeatureCount ?? 0) + i));
				},
			},
		});

		const deadline = Date.now() + 10_000;
		while (runner.running && Date.now() < deadline) {
			if (state.batch?.phase === "complete") break;
			if (state.batch?.phase === "error" || state.batch?.phase === "aborted") break;
			await new Promise(r => setTimeout(r, 25));
		}
		await runner.stop();

		expect(state.batch?.phase).toBe("complete");
		expect(state.batch?.tasksComplete).toBe(3);
		expect(state.batch?.tasks.map(t => t.taskId)).toEqual(["F-001", "F-002", "FIX-001-001"]);
		expect(state.batch?.milestones?.[0]?.status).toBe("passed");
		expect(state.batch?.milestones?.[0]?.validationRounds).toBe(2);

		// Round 1 parsed both outputs; round 2 parsed both outputs.
		const rounds = new Set(parseCalls.map(c => c.round));
		expect(rounds).toEqual(new Set([1, 2]));
		expect(parseCalls.filter(c => c.round === 1)).toHaveLength(2);
		expect(parseCalls.filter(c => c.round === 2)).toHaveLength(2);

		// One fix-feature generation attempt (round 1 only).
		expect(generateCalls).toHaveLength(1);
		expect(generateCalls[0]?.existingFixFeatureCount).toBe(0);
	});

	test("max validation rounds exhaustion marks milestone failed", async () => {
		let state: MissionState = promoteToBatch(
			baseMission(),
			{ taskIds: ["F-001", "F-002"], laneCount: 2, waveSize: 2 },
			DEFAULT_MISSIONCONTROL_CONFIG,
		);
		// Force maxValidationRounds to 1 so the second needs-fix attempt
		// exhausts the budget.
		if (state.batch?.milestones) {
			state = {
				...state,
				batch: {
					...state.batch,
					milestones: state.batch.milestones.map(m => ({ ...m, maxValidationRounds: 1 })),
				},
			};
		}
		state = beginBatch(state);

		const runner = startLaneRunner({
			cwd: sandbox,
			getMission: () => state,
			setMission: next => {
				state = next;
			},
			persist: async () => {},
			config: DEFAULT_MISSIONCONTROL_CONFIG,
			validation: {
				stallTimeoutMs: 60_000,
				spawnScrutiny: async () => fakeAgentResult(),
				spawnUserTesting: async () => fakeAgentResult(),
				parseScrutiny: async path =>
					scrutinyOutput("needs-fix", roundFromPath(path), [blockerFinding("F-BLOCK", roundFromPath(path))]),
				parseUserTesting: async path => userTestingOutput("pass", roundFromPath(path)),
				ingestLessons: async () => 0,
				generateFixFeatures: async opts =>
					opts.findings
						.filter(f => f.severity === "blocker")
						.map((f, i) => stubFixFeature(f, opts.milestoneId, (opts.existingFixFeatureCount ?? 0) + i)),
			},
		});

		const deadline = Date.now() + 10_000;
		while (runner.running && Date.now() < deadline) {
			if (
				state.batch?.milestones?.[0]?.status === "failed" ||
				state.batch?.phase === "complete" ||
				state.batch?.phase === "aborted"
			)
				break;
			await new Promise(r => setTimeout(r, 25));
		}
		await runner.stop();

		expect(state.batch?.milestones?.[0]?.status).toBe("failed");
		expect(state.batch?.milestones?.[0]?.validationRounds).toBe(1);
	});

	test("initialMilestoneReconciliations is consumed on first tick and not reused", async () => {
		let state: MissionState = promoteToBatch(
			baseMission(),
			{ taskIds: ["F-001", "F-002"], laneCount: 2, waveSize: 2 },
			DEFAULT_MISSIONCONTROL_CONFIG,
		);
		// Seed the milestone state as if the prior supervisor had already
		// bumped the round counter before crashing.
		if (state.batch?.milestones) {
			state = {
				...state,
				batch: {
					...state.batch,
					milestones: state.batch.milestones.map(m => ({ ...m, validationRounds: 1 })),
				},
			};
		}
		state = beginBatch(state);

		const batchId = state.batch?.batchId ?? "";
		const scrutinyPath = join(sandbox, ".omp", "validation", batchId, "M-001-scrutiny-round1.json");
		const userTestingPath = join(sandbox, ".omp", "validation", batchId, "M-001-user-testing-round1.json");
		mkdirSync(dirname(scrutinyPath), { recursive: true });
		writeFileSync(scrutinyPath, JSON.stringify(scrutinyOutput("pass", 1)));
		writeFileSync(userTestingPath, JSON.stringify(userTestingOutput("pass", 1)));

		let scrutinySpawnCount = 0;
		let userTestingSpawnCount = 0;

		const runner = startLaneRunner({
			cwd: sandbox,
			getMission: () => state,
			setMission: next => {
				state = next;
			},
			persist: async () => {},
			config: DEFAULT_MISSIONCONTROL_CONFIG,
			initialMilestoneReconciliations: [
				{
					milestoneId: "M-001",
					round: 1,
					slots: [
						{ kind: "scrutiny", outputPath: scrutinyPath, needsRespawn: false },
						{ kind: "user-testing", outputPath: userTestingPath, needsRespawn: false },
					],
				},
			],
			validation: {
				stallTimeoutMs: 60_000,
				spawnScrutiny: async () => {
					scrutinySpawnCount += 1;
					return fakeAgentResult();
				},
				spawnUserTesting: async () => {
					userTestingSpawnCount += 1;
					return fakeAgentResult();
				},
				ingestLessons: async () => 0,
			},
		});

		const deadline = Date.now() + 10_000;
		while (runner.running && Date.now() < deadline) {
			if (state.batch?.phase === "complete") break;
			if (state.batch?.phase === "error" || state.batch?.phase === "aborted") break;
			await new Promise(r => setTimeout(r, 25));
		}
		await runner.stop();

		expect(state.batch?.phase).toBe("complete");
		expect(state.batch?.milestones?.[0]?.status).toBe("passed");
		// No spawns — reconciliation reused both outputs on the first tick.
		expect(scrutinySpawnCount).toBe(0);
		expect(userTestingSpawnCount).toBe(0);
		// Round counter didn't bump past the reconciliation's round=1.
		expect(state.batch?.milestones?.[0]?.validationRounds).toBe(1);
	});
});

function fakeAgentResult(): import("../src/missioncontrol").AgentHostResult {
	return {
		exitCode: 0,
		signal: null,
		durationMs: 0,
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

function stubFixFeature(f: ValidatorFinding, milestoneId: string, index: number): GeneratedFixFeature {
	const num = String(index + 1).padStart(3, "0");
	const match = /-(\d+)$/.exec(milestoneId);
	const mnum = match ? (match[1]?.padStart(3, "0") ?? "000") : "000";
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
		},
	};
}

function roundFromPath(path: string): number {
	const m = /-round(\d+)\.json$/.exec(path);
	if (!m?.[1]) return 0;
	return Number(m[1]);
}
