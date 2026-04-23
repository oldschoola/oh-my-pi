/**
 * Fix B: runtime resume must feed {@link reconcileMilestoneValidators}
 * output into the lane-runner via `initialMilestoneReconciliations`.
 *
 * Seeds a PersistedBatchState v5 with one milestone in `"validating"`
 * plus the expected validator output JSONs on disk, then drives a
 * spy-lane-runner through `engine.handlers.resume` and asserts the
 * reconciliation arrives with both slots marked `needsRespawn: false`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { saveBatchState, validationOutputPath } from "../src/missioncontrol";
import type { LaneRunnerDeps, LaneRunnerHandle } from "../src/missioncontrol/lane-runner";
import { createEngine } from "../src/missioncontrol/runtime";
import { DEFAULT_MISSIONCONTROL_CONFIG } from "../src/missioncontrol/types";
import type { BatchState, MissionState } from "../src/types";

let sandbox: string;

function baseMission(): MissionState {
	return {
		description: "resume-reconciliation",
		mode: "simple",
		phases: [],
		autonomy: "auto",
		modelAssignment: {},
		paused: true,
		pauseHistory: [],
		progressLog: [],
		startedAt: new Date().toISOString(),
	};
}

function withBatch(state: MissionState, batch: BatchState): MissionState {
	return { ...state, batch };
}

function pausedBatch(batchId: string): BatchState {
	return {
		batchId,
		phase: "paused",
		waves: [{ wave: 0, taskIds: [] }],
		currentWave: 0,
		laneCount: 1,
		laneStatuses: [
			{
				lane: 1,
				status: "idle",
				taskId: null,
				stepProgress: "",
				iteration: 0,
				elapsed: 0,
				sessionName: "lane-1",
			},
		],
		tasks: [],
		tasksTotal: 0,
		tasksComplete: 0,
		tasksFailed: 0,
		startTime: Date.now(),
		errors: [],
	};
}

function writeValidatorOutput(batchId: string, milestoneId: string, round: number, kind: "scrutiny" | "user-testing") {
	const target = validationOutputPath(sandbox, batchId, milestoneId, round, kind);
	mkdirSync(dirname(target), { recursive: true });
	const payload = {
		schemaVersion: 1,
		validator: kind,
		milestoneId,
		round,
		startedAt: 0,
		completedAt: 1,
		verdict: "pass",
		summary: `${kind} round ${round}`,
		findings: [],
		lessons: [],
	};
	writeFileSync(target, JSON.stringify(payload), "utf-8");
}

async function seedPersistedBatch(batchId: string): Promise<void> {
	const persisted = {
		schemaVersion: 5,
		phase: "paused",
		batchId,
		baseBranch: "main",
		orchBranch: "",
		mode: "repo",
		startedAt: 100,
		updatedAt: 200,
		endedAt: null,
		currentWaveIndex: 0,
		totalWaves: 0,
		totalTasks: 0,
		succeededTasks: 0,
		failedTasks: 0,
		skippedTasks: 0,
		blockedTasks: 0,
		blockedTaskIds: [],
		lanes: [],
		tasks: [],
		wavePlan: [],
		mergeResults: [],
		errors: [],
		resilience: {
			resumeForced: false,
			retryCountByScope: {},
			lastFailureClass: null,
			repairHistory: [],
		},
		diagnostics: { taskExits: {}, batchCost: 0 },
		segments: [],
		lastError: null,
		milestones: [
			{
				id: "M-001",
				name: "M-001",
				featureIds: [],
				assertionIds: [],
				status: "validating",
				validationRounds: 1,
				maxValidationRounds: 4,
			},
		],
	};
	await saveBatchState(JSON.stringify(persisted, null, 2), sandbox);
}

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-resume-reconcile-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

describe("runtime resume reconciliation", () => {
	test("hands completed validator slots to the lane-runner on resume", async () => {
		const batchId = "batch-resume-A";
		await seedPersistedBatch(batchId);
		writeValidatorOutput(batchId, "M-001", 1, "scrutiny");
		writeValidatorOutput(batchId, "M-001", 1, "user-testing");

		let capturedDeps: LaneRunnerDeps | null = null;
		const runnerHandle: LaneRunnerHandle = {
			get running() {
				return false;
			},
			async stop() {},
		};
		const fakeStart = (deps: LaneRunnerDeps): LaneRunnerHandle => {
			capturedDeps = deps;
			return runnerHandle;
		};

		let state: MissionState = withBatch(baseMission(), pausedBatch(batchId));
		const engine = createEngine(
			{
				cwd: sandbox,
				getMission: () => state,
				setMission: next => {
					if (next) state = next;
				},
				startLaneRunner: fakeStart,
			},
			DEFAULT_MISSIONCONTROL_CONFIG,
		);

		const resumed = await engine.handlers.resume();
		expect(resumed?.batch?.phase).toBe("running");

		expect(capturedDeps).not.toBeNull();
		const deps = capturedDeps as unknown as LaneRunnerDeps;
		const reconciliations = deps.initialMilestoneReconciliations ?? [];
		expect(reconciliations).toHaveLength(1);
		const rec = reconciliations[0];
		expect(rec?.milestoneId).toBe("M-001");
		expect(rec?.round).toBe(1);
		expect(rec?.slots.map(s => s.kind).sort()).toEqual(["scrutiny", "user-testing"]);
		expect(rec?.slots.every(s => !s.needsRespawn)).toBe(true);
	});

	test("passes empty reconciliations when no persisted v5 state is on disk", async () => {
		let capturedDeps: LaneRunnerDeps | null = null;
		const runnerHandle: LaneRunnerHandle = {
			get running() {
				return false;
			},
			async stop() {},
		};
		const fakeStart = (deps: LaneRunnerDeps): LaneRunnerHandle => {
			capturedDeps = deps;
			return runnerHandle;
		};

		let state: MissionState = withBatch(baseMission(), pausedBatch("batch-no-disk"));
		const engine = createEngine(
			{
				cwd: sandbox,
				getMission: () => state,
				setMission: next => {
					if (next) state = next;
				},
				startLaneRunner: fakeStart,
			},
			DEFAULT_MISSIONCONTROL_CONFIG,
		);

		await engine.handlers.resume();
		expect(capturedDeps).not.toBeNull();
		expect((capturedDeps as unknown as LaneRunnerDeps).initialMilestoneReconciliations ?? []).toEqual([]);
	});
});
