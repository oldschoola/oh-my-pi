import { describe, expect, test } from "bun:test";

import {
	type AllocatedLane,
	BATCH_STATE_SCHEMA_VERSION,
	type LaneTaskOutcome,
	type MergeWaveResult,
	type MissionBatchRuntimeState,
	serializeBatchState,
} from "../src/missioncontrol";

function mkState(overrides: Partial<MissionBatchRuntimeState> = {}): MissionBatchRuntimeState {
	return {
		phase: "executing",
		batchId: "b-1",
		baseBranch: "main",
		orchBranch: "orch/b-1",
		mode: "repo",
		pauseSignal: { paused: false },
		waveResults: [],
		currentWaveIndex: 0,
		totalWaves: 1,
		blockedTaskIds: new Set<string>(),
		startedAt: 1700000000000,
		endedAt: null,
		totalTasks: 1,
		succeededTasks: 0,
		failedTasks: 0,
		skippedTasks: 0,
		blockedTasks: 0,
		errors: [],
		currentLanes: [],
		dependencyGraph: null,
		mergeResults: [],
		...overrides,
	};
}

function mkLane(overrides: Partial<AllocatedLane> = {}): AllocatedLane {
	return {
		laneNumber: 1,
		laneId: "lane-1",
		laneSessionId: "session-1",
		worktreePath: "/tmp/wt-1",
		branch: "orch/b-1/lane-1",
		strategy: "round-robin",
		estimatedLoad: 1,
		estimatedMinutes: 10,
		tasks: [
			{
				taskId: "TP-001",
				order: 0,
				estimatedMinutes: 10,
				task: {
					taskId: "TP-001",
					taskName: "first",
					folderPath: "/tmp/tasks/TP-001",
					promptPath: "/tmp/tasks/TP-001/PROMPT.md",
					prompt: "",
					dependencies: [],
					size: "M",
				},
			},
		],
		...overrides,
	};
}

function mkOutcome(overrides: Partial<LaneTaskOutcome> = {}): LaneTaskOutcome {
	return {
		taskId: "TP-001",
		status: "succeeded",
		startTime: 1700000001000,
		endTime: 1700000002000,
		exitReason: "done",
		sessionName: "session-1",
		doneFileFound: true,
		laneNumber: 1,
		...overrides,
	};
}

describe("serializeBatchState — shape", () => {
	test("writes schemaVersion = BATCH_STATE_SCHEMA_VERSION", () => {
		const json = serializeBatchState(mkState(), [["TP-001"]], [mkLane()], []);
		const parsed = JSON.parse(json);
		expect(parsed.schemaVersion).toBe(BATCH_STATE_SCHEMA_VERSION);
	});

	test("includes all batch-level counts + mode + branches", () => {
		const json = serializeBatchState(
			mkState({ totalTasks: 3, succeededTasks: 2, failedTasks: 1, mode: "workspace" }),
			[["TP-001"]],
			[mkLane()],
			[],
		);
		const parsed = JSON.parse(json);
		expect(parsed.phase).toBe("executing");
		expect(parsed.batchId).toBe("b-1");
		expect(parsed.baseBranch).toBe("main");
		expect(parsed.orchBranch).toBe("orch/b-1");
		expect(parsed.mode).toBe("workspace");
		expect(parsed.totalTasks).toBe(3);
		expect(parsed.succeededTasks).toBe(2);
		expect(parsed.failedTasks).toBe(1);
	});

	test("defaults orchBranch to empty string + mode to repo when missing", () => {
		const state = {
			...mkState(),
			orchBranch: undefined as unknown as string,
			mode: undefined as unknown as import("../src/missioncontrol/types").WorkspaceMode,
		};
		const json = serializeBatchState(state, [[]], [], []);
		const parsed = JSON.parse(json);
		expect(parsed.orchBranch).toBe("");
		expect(parsed.mode).toBe("repo");
	});

	test("updatedAt is a number close to now", () => {
		const before = Date.now();
		const json = serializeBatchState(mkState(), [[]], [], []);
		const after = Date.now();
		const parsed = JSON.parse(json);
		expect(parsed.updatedAt).toBeGreaterThanOrEqual(before);
		expect(parsed.updatedAt).toBeLessThanOrEqual(after);
	});

	test("output is pretty-printed JSON (2-space indent)", () => {
		const json = serializeBatchState(mkState(), [[]], [], []);
		expect(json).toContain('\n  "phase"');
	});
});

describe("serializeBatchState — task records", () => {
	test("task IDs sourced from wavePlan + outcomes, sorted", () => {
		const json = serializeBatchState(
			mkState(),
			[["TP-002", "TP-001"]],
			[],
			[mkOutcome({ taskId: "TP-003", laneNumber: 2 })],
		);
		const parsed = JSON.parse(json);
		const ids = parsed.tasks.map((t: { taskId: string }) => t.taskId);
		expect(ids).toEqual(["TP-001", "TP-002", "TP-003"]);
	});

	test("task record inherits laneNumber from allocated lane", () => {
		const json = serializeBatchState(mkState(), [["TP-001"]], [mkLane({ laneNumber: 7 })], []);
		const parsed = JSON.parse(json);
		expect(parsed.tasks[0].laneNumber).toBe(7);
	});

	test("falls back to outcome.laneNumber when no allocated lane", () => {
		const json = serializeBatchState(mkState(), [["TP-001"]], [], [mkOutcome({ laneNumber: 5 })]);
		const parsed = JSON.parse(json);
		expect(parsed.tasks[0].laneNumber).toBe(5);
	});

	test("pending default when no outcome — status pending, endedAt null", () => {
		const json = serializeBatchState(mkState(), [["TP-001"]], [mkLane()], []);
		const parsed = JSON.parse(json);
		expect(parsed.tasks[0].status).toBe("pending");
		expect(parsed.tasks[0].startedAt).toBeNull();
		expect(parsed.tasks[0].endedAt).toBeNull();
		expect(parsed.tasks[0].doneFileFound).toBe(false);
	});

	test("outcome enriches status + timestamps + doneFileFound", () => {
		const json = serializeBatchState(
			mkState(),
			[["TP-001"]],
			[mkLane()],
			[mkOutcome({ status: "succeeded", startTime: 10, endTime: 20, doneFileFound: true })],
		);
		const parsed = JSON.parse(json);
		expect(parsed.tasks[0].status).toBe("succeeded");
		expect(parsed.tasks[0].startedAt).toBe(10);
		expect(parsed.tasks[0].endedAt).toBe(20);
		expect(parsed.tasks[0].doneFileFound).toBe(true);
	});

	test("v2 repo-aware fields serialized from ParsedTask", () => {
		const lane = mkLane();
		lane.tasks[0]!.task.promptRepoId = "api";
		lane.tasks[0]!.task.resolvedRepoId = "api-monorepo";
		const json = serializeBatchState(mkState(), [["TP-001"]], [lane], []);
		const parsed = JSON.parse(json);
		expect(parsed.tasks[0].repoId).toBe("api");
		expect(parsed.tasks[0].resolvedRepoId).toBe("api-monorepo");
	});

	test("v4 segment fields serialized from ParsedTask", () => {
		const lane = mkLane();
		lane.tasks[0]!.task.packetRepoId = "api";
		lane.tasks[0]!.task.packetTaskPath = "/packets/TP-001";
		lane.tasks[0]!.task.segmentIds = ["TP-001::api", "TP-001::web"];
		lane.tasks[0]!.task.activeSegmentId = "TP-001::api";
		const json = serializeBatchState(mkState(), [["TP-001"]], [lane], []);
		const parsed = JSON.parse(json);
		expect(parsed.tasks[0].packetRepoId).toBe("api");
		expect(parsed.tasks[0].packetTaskPath).toBe("/packets/TP-001");
		expect(parsed.tasks[0].segmentIds).toEqual(["TP-001::api", "TP-001::web"]);
		expect(parsed.tasks[0].activeSegmentId).toBe("TP-001::api");
	});

	test("partial progress fields round-trip from outcome", () => {
		const json = serializeBatchState(
			mkState(),
			[["TP-001"]],
			[mkLane()],
			[mkOutcome({ partialProgressCommits: 3, partialProgressBranch: "lane-1-pp" })],
		);
		const parsed = JSON.parse(json);
		expect(parsed.tasks[0].partialProgressCommits).toBe(3);
		expect(parsed.tasks[0].partialProgressBranch).toBe("lane-1-pp");
	});

	test("exitDiagnostic passed through from outcome", () => {
		const diag = { category: "spawn_failure", exitCode: 1, detail: "pipe closed" } as const;
		const json = serializeBatchState(
			mkState(),
			[["TP-001"]],
			[mkLane()],
			[mkOutcome({ exitDiagnostic: diag as never })],
		);
		const parsed = JSON.parse(json);
		expect(parsed.tasks[0].exitDiagnostic).toEqual(diag);
	});

	test("sessionName falls back to lane.laneSessionId when outcome has none", () => {
		const json = serializeBatchState(
			mkState(),
			[["TP-001"]],
			[mkLane({ laneSessionId: "fallback-session" })],
			[mkOutcome({ sessionName: "" })],
		);
		const parsed = JSON.parse(json);
		expect(parsed.tasks[0].sessionName).toBe("fallback-session");
	});
});

describe("serializeBatchState — lane records", () => {
	test("lane record mirrors AllocatedLane + taskIds[]", () => {
		const json = serializeBatchState(mkState(), [["TP-001"]], [mkLane()], []);
		const parsed = JSON.parse(json);
		expect(parsed.lanes).toEqual([
			{
				laneNumber: 1,
				laneId: "lane-1",
				laneSessionId: "session-1",
				worktreePath: "/tmp/wt-1",
				branch: "orch/b-1/lane-1",
				taskIds: ["TP-001"],
			},
		]);
	});

	test("repoId serialized when lane has one", () => {
		const json = serializeBatchState(mkState(), [["TP-001"]], [mkLane({ repoId: "api" })], []);
		const parsed = JSON.parse(json);
		expect(parsed.lanes[0].repoId).toBe("api");
	});
});

describe("serializeBatchState — merge results", () => {
	test("clamps sentinel waveIndex -1 to 0 (no negative indexes)", () => {
		const mr: MergeWaveResult = {
			waveIndex: -1,
			status: "succeeded",
			laneResults: [],
			failedLane: null,
			failureReason: null,
			totalDurationMs: 0,
		};
		const json = serializeBatchState(mkState({ mergeResults: [mr] }), [[]], [], []);
		const parsed = JSON.parse(json);
		expect(parsed.mergeResults[0].waveIndex).toBe(0);
	});

	test("normalizes 1-based runtime waveIndex to 0-based persisted waveIndex", () => {
		const mr: MergeWaveResult = {
			waveIndex: 3,
			status: "succeeded",
			laneResults: [],
			failedLane: null,
			failureReason: null,
			totalDurationMs: 0,
		};
		const json = serializeBatchState(mkState({ mergeResults: [mr] }), [[]], [], []);
		const parsed = JSON.parse(json);
		expect(parsed.mergeResults[0].waveIndex).toBe(2);
	});

	test("per-repo merge outcomes flatten laneResults to laneNumbers[]", () => {
		const mr: MergeWaveResult = {
			waveIndex: 1,
			status: "succeeded",
			laneResults: [],
			failedLane: null,
			failureReason: null,
			totalDurationMs: 0,
			repoResults: [
				{
					repoId: "api",
					status: "succeeded",
					failedLane: null,
					failureReason: null,
					laneResults: [
						{
							laneNumber: 1,
							laneId: "a",
							sourceBranch: "s",
							targetBranch: "t",
							result: null,
							error: null,
							durationMs: 0,
						},
						{
							laneNumber: 2,
							laneId: "b",
							sourceBranch: "s",
							targetBranch: "t",
							result: null,
							error: null,
							durationMs: 0,
						},
					],
				},
			],
		};
		const json = serializeBatchState(mkState({ mergeResults: [mr] }), [[]], [], []);
		const parsed = JSON.parse(json);
		expect(parsed.mergeResults[0].repoResults[0]).toEqual({
			repoId: "api",
			status: "succeeded",
			laneNumbers: [1, 2],
			failedLane: null,
			failureReason: null,
		});
	});

	test("omits repoResults when empty", () => {
		const mr: MergeWaveResult = {
			waveIndex: 1,
			status: "succeeded",
			laneResults: [],
			failedLane: null,
			failureReason: null,
			totalDurationMs: 0,
		};
		const json = serializeBatchState(mkState({ mergeResults: [mr] }), [[]], [], []);
		const parsed = JSON.parse(json);
		expect(parsed.mergeResults[0].repoResults).toBeUndefined();
	});
});

describe("serializeBatchState — resilience + diagnostics + segments", () => {
	test("fills defaults when runtime state lacks resilience/diagnostics", () => {
		const json = serializeBatchState(mkState(), [[]], [], []);
		const parsed = JSON.parse(json);
		expect(parsed.resilience).toEqual({
			resumeForced: false,
			retryCountByScope: {},
			lastFailureClass: null,
			repairHistory: [],
		});
		expect(parsed.diagnostics).toEqual({ taskExits: {}, batchCost: 0 });
		expect(parsed.segments).toEqual([]);
	});

	test("preserves runtime resilience state", () => {
		const resilience = {
			resumeForced: true,
			retryCountByScope: { "TP-001:w0:l1": 2 },
			lastFailureClass: "process_crash" as const,
			repairHistory: [],
		};
		const json = serializeBatchState(mkState({ resilience }), [[]], [], []);
		const parsed = JSON.parse(json);
		expect(parsed.resilience).toEqual(resilience);
	});
});

describe("serializeBatchState — lastError + errors", () => {
	test("no errors → lastError is null + errors: []", () => {
		const json = serializeBatchState(mkState(), [[]], [], []);
		const parsed = JSON.parse(json);
		expect(parsed.lastError).toBeNull();
		expect(parsed.errors).toEqual([]);
	});

	test("errors populated → lastError wraps most recent", () => {
		const json = serializeBatchState(mkState({ errors: ["first", "latest"] }), [[]], [], []);
		const parsed = JSON.parse(json);
		expect(parsed.lastError).toEqual({ code: "BATCH_ERROR", message: "latest" });
		expect(parsed.errors).toEqual(["first", "latest"]);
	});

	test("errors array is a copy (not the live reference)", () => {
		const state = mkState({ errors: ["a"] });
		const json = serializeBatchState(state, [[]], [], []);
		state.errors.push("b");
		const parsed = JSON.parse(json);
		expect(parsed.errors).toEqual(["a"]);
	});
});

describe("serializeBatchState — blockedTaskIds", () => {
	test("serialized as array from runtime Set", () => {
		const state = mkState({ blockedTaskIds: new Set(["TP-002", "TP-001"]) });
		const json = serializeBatchState(state, [[]], [], []);
		const parsed = JSON.parse(json);
		expect(parsed.blockedTaskIds.sort()).toEqual(["TP-001", "TP-002"]);
	});
});

describe("serializeBatchState — task-level wave metadata (TP-166)", () => {
	test("taskLevelWaveCount and roundToTaskWave persisted when set", () => {
		const json = serializeBatchState(mkState({ taskLevelWaveCount: 2, roundToTaskWave: [0, 1] }), [[]], [], []);
		const parsed = JSON.parse(json);
		expect(parsed.taskLevelWaveCount).toBe(2);
		expect(parsed.roundToTaskWave).toEqual([0, 1]);
	});

	test("omitted when not set", () => {
		const json = serializeBatchState(mkState(), [[]], [], []);
		const parsed = JSON.parse(json);
		expect(parsed).not.toHaveProperty("taskLevelWaveCount");
		expect(parsed).not.toHaveProperty("roundToTaskWave");
	});
});

describe("serializeBatchState — _extraFields round-trip", () => {
	test("preserves unknown top-level fields from prior load", () => {
		const state = mkState();
		state._extraFields = { futureField: { nested: 42 }, someFlag: true };
		const json = serializeBatchState(state, [[]], [], []);
		const parsed = JSON.parse(json);
		expect(parsed.futureField).toEqual({ nested: 42 });
		expect(parsed.someFlag).toBe(true);
	});

	test("never overwrites known fields with _extraFields values", () => {
		const state = mkState({ batchId: "b-real" });
		state._extraFields = { batchId: "b-stomped" };
		const json = serializeBatchState(state, [[]], [], []);
		const parsed = JSON.parse(json);
		expect(parsed.batchId).toBe("b-real");
	});
});
