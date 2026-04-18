import { describe, expect, test } from "bun:test";

import {
	seedPendingOutcomesForAllocatedLanes,
	syncTaskOutcomesFromMonitor,
	upsertTaskOutcome,
} from "../src/missioncontrol/persistence";
import type {
	AllocatedLane,
	LaneMonitorSnapshot,
	LaneTaskOutcome,
	LaneTaskOutcomeTelemetry,
	MonitorState,
	TaskMonitorSnapshot,
} from "../src/missioncontrol/types";

function mkOutcome(overrides: Partial<LaneTaskOutcome> & { taskId: string }): LaneTaskOutcome {
	return {
		status: "pending",
		startTime: null,
		endTime: null,
		exitReason: "",
		sessionName: "",
		doneFileFound: false,
		...overrides,
	};
}

function mkTelemetry(overrides: Partial<LaneTaskOutcomeTelemetry> = {}): LaneTaskOutcomeTelemetry {
	return {
		inputTokens: 10,
		outputTokens: 20,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0.01,
		toolCalls: 1,
		durationMs: 1000,
		...overrides,
	};
}

function mkAllocatedLane(laneNumber: number, laneSessionId: string, taskIds: string[]): AllocatedLane {
	return {
		laneNumber,
		laneId: `lane-${laneNumber}`,
		laneSessionId,
		worktreePath: `/tmp/worktree-${laneNumber}`,
		branch: `branch-${laneNumber}`,
		tasks: taskIds.map((taskId, i) => ({
			taskId,
			order: i,
			estimatedMinutes: 10,
			task: {
				taskId,
				taskName: taskId.toLowerCase(),
				folderPath: `/tasks/${taskId}`,
				promptPath: `/tasks/${taskId}/PROMPT.md`,
				prompt: "",
				dependencies: [],
				size: "M",
			},
		})),
		strategy: "affinity-first",
		estimatedLoad: 0,
		estimatedMinutes: 0,
	};
}

function mkLaneSnapshot(overrides: Partial<LaneMonitorSnapshot> & { laneNumber: number }): LaneMonitorSnapshot {
	return {
		laneId: `lane-${overrides.laneNumber}`,
		sessionName: `orch-batch-lane-${overrides.laneNumber}`,
		sessionAlive: true,
		currentTaskId: null,
		currentTaskSnapshot: null,
		completedTasks: [],
		failedTasks: [],
		remainingTasks: [],
		...overrides,
	};
}

function mkTaskSnap(overrides: Partial<TaskMonitorSnapshot> & { taskId: string }): TaskMonitorSnapshot {
	return {
		status: "running",
		currentStepName: null,
		currentStepNumber: null,
		totalSteps: 0,
		totalChecked: 0,
		totalItems: 0,
		sessionAlive: true,
		doneFileFound: false,
		stallReason: null,
		lastHeartbeat: null,
		observedAt: 1_000,
		parseError: null,
		iteration: 0,
		reviewCounter: 0,
		...overrides,
	};
}

function mkMonitor(lanes: LaneMonitorSnapshot[], lastPollTime = 5_000): MonitorState {
	return {
		lanes,
		tasksDone: 0,
		tasksFailed: 0,
		tasksTotal: 0,
		waveNumber: 1,
		pollCount: 1,
		lastPollTime,
		allTerminal: false,
	};
}

describe("upsertTaskOutcome", () => {
	test("inserts when taskId absent, returns true", () => {
		const outcomes: LaneTaskOutcome[] = [];
		const changed = upsertTaskOutcome(outcomes, mkOutcome({ taskId: "T-1", status: "running" }));
		expect(changed).toBe(true);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]?.status).toBe("running");
	});

	test("returns false when identical outcome is re-upserted", () => {
		const outcomes: LaneTaskOutcome[] = [mkOutcome({ taskId: "T-1", status: "running" })];
		const changed = upsertTaskOutcome(outcomes, mkOutcome({ taskId: "T-1", status: "running" }));
		expect(changed).toBe(false);
	});

	test("returns true and updates in place when status transitions", () => {
		const outcomes: LaneTaskOutcome[] = [mkOutcome({ taskId: "T-1", status: "running" })];
		const changed = upsertTaskOutcome(outcomes, mkOutcome({ taskId: "T-1", status: "succeeded", endTime: 500 }));
		expect(changed).toBe(true);
		expect(outcomes[0]?.status).toBe("succeeded");
		expect(outcomes[0]?.endTime).toBe(500);
	});

	test("inherits laneNumber from prior when next lacks it", () => {
		const outcomes: LaneTaskOutcome[] = [mkOutcome({ taskId: "T-1", status: "running", laneNumber: 3 })];
		upsertTaskOutcome(outcomes, mkOutcome({ taskId: "T-1", status: "succeeded" }));
		expect(outcomes[0]?.laneNumber).toBe(3);
	});

	test("inherits telemetry from prior when next lacks it", () => {
		const tele = mkTelemetry();
		const outcomes: LaneTaskOutcome[] = [mkOutcome({ taskId: "T-1", status: "running", telemetry: tele })];
		upsertTaskOutcome(outcomes, mkOutcome({ taskId: "T-1", status: "succeeded" }));
		expect(outcomes[0]?.telemetry).toEqual(tele);
	});

	test("next telemetry wins over prior when provided", () => {
		const prior = mkTelemetry({ costUsd: 0.01 });
		const next = mkTelemetry({ costUsd: 0.99 });
		const outcomes: LaneTaskOutcome[] = [mkOutcome({ taskId: "T-1", status: "running", telemetry: prior })];
		const changed = upsertTaskOutcome(outcomes, mkOutcome({ taskId: "T-1", status: "running", telemetry: next }));
		expect(changed).toBe(true);
		expect(outcomes[0]?.telemetry?.costUsd).toBe(0.99);
	});

	test("partialProgressCommits change triggers updated flag", () => {
		const outcomes: LaneTaskOutcome[] = [mkOutcome({ taskId: "T-1", partialProgressCommits: 0 })];
		const changed = upsertTaskOutcome(outcomes, mkOutcome({ taskId: "T-1", partialProgressCommits: 3 }));
		expect(changed).toBe(true);
		expect(outcomes[0]?.partialProgressCommits).toBe(3);
	});
});

describe("seedPendingOutcomesForAllocatedLanes", () => {
	test("seeds pending entries for all lane tasks when outcomes empty", () => {
		const lanes = [mkAllocatedLane(1, "orch-batch-lane-1-worker", ["T-1", "T-2"])];
		const outcomes: LaneTaskOutcome[] = [];
		const changed = seedPendingOutcomesForAllocatedLanes(lanes, outcomes);
		expect(changed).toBe(true);
		expect(outcomes.map(o => o.taskId).sort()).toEqual(["T-1", "T-2"]);
		expect(outcomes.every(o => o.status === "pending")).toBe(true);
		expect(outcomes[0]?.sessionName).toBe("orch-batch-lane-1-worker");
		expect(outcomes[0]?.laneNumber).toBe(1);
	});

	test("no-ops when every task already has an outcome", () => {
		const lanes = [mkAllocatedLane(1, "s-1", ["T-1"])];
		const outcomes: LaneTaskOutcome[] = [mkOutcome({ taskId: "T-1", status: "running" })];
		const changed = seedPendingOutcomesForAllocatedLanes(lanes, outcomes);
		expect(changed).toBe(false);
		expect(outcomes[0]?.status).toBe("running");
	});

	test("only seeds missing ones, leaving existing outcomes alone", () => {
		const lanes = [mkAllocatedLane(1, "s-1", ["T-1", "T-2"])];
		const outcomes: LaneTaskOutcome[] = [mkOutcome({ taskId: "T-1", status: "running", laneNumber: 1 })];
		const changed = seedPendingOutcomesForAllocatedLanes(lanes, outcomes);
		expect(changed).toBe(true);
		const ids = outcomes.map(o => o.taskId).sort();
		expect(ids).toEqual(["T-1", "T-2"]);
		expect(outcomes.find(o => o.taskId === "T-1")?.status).toBe("running");
		expect(outcomes.find(o => o.taskId === "T-2")?.status).toBe("pending");
	});

	test("empty lanes array is a no-op", () => {
		const outcomes: LaneTaskOutcome[] = [];
		expect(seedPendingOutcomesForAllocatedLanes([], outcomes)).toBe(false);
		expect(outcomes).toEqual([]);
	});
});

describe("syncTaskOutcomesFromMonitor", () => {
	test("seeds pending for remainingTasks without existing outcome", () => {
		const monitor = mkMonitor([mkLaneSnapshot({ laneNumber: 1, remainingTasks: ["T-1"] })]);
		const outcomes: LaneTaskOutcome[] = [];
		const changed = syncTaskOutcomesFromMonitor(monitor, outcomes);
		expect(changed).toBe(true);
		expect(outcomes[0]?.status).toBe("pending");
		expect(outcomes[0]?.sessionName).toBe("orch-batch-lane-1");
	});

	test("does not downgrade terminal outcomes back to pending", () => {
		const monitor = mkMonitor([mkLaneSnapshot({ laneNumber: 1, remainingTasks: ["T-1"] })]);
		const outcomes: LaneTaskOutcome[] = [mkOutcome({ taskId: "T-1", status: "succeeded", endTime: 100 })];
		const changed = syncTaskOutcomesFromMonitor(monitor, outcomes);
		expect(changed).toBe(false);
		expect(outcomes[0]?.status).toBe("succeeded");
	});

	test("marks completedTasks succeeded with doneFileFound=true", () => {
		const monitor = mkMonitor([mkLaneSnapshot({ laneNumber: 1, completedTasks: ["T-1"] })], 5_000);
		const outcomes: LaneTaskOutcome[] = [];
		syncTaskOutcomesFromMonitor(monitor, outcomes);
		expect(outcomes[0]?.status).toBe("succeeded");
		expect(outcomes[0]?.doneFileFound).toBe(true);
		expect(outcomes[0]?.endTime).toBe(5_000);
	});

	test("completed endTime is preserved when already set (no poll-tick spam)", () => {
		const monitor = mkMonitor([mkLaneSnapshot({ laneNumber: 1, completedTasks: ["T-1"] })], 9_999);
		const outcomes: LaneTaskOutcome[] = [
			mkOutcome({
				taskId: "T-1",
				status: "succeeded",
				endTime: 500,
				doneFileFound: true,
				sessionName: "orch-batch-lane-1",
				exitReason: ".DONE file created by task-runner",
				laneNumber: 1,
			}),
		];
		const changed = syncTaskOutcomesFromMonitor(monitor, outcomes);
		// prior outcome already matches merged next in every field → no change.
		expect(changed).toBe(false);
		expect(outcomes[0]?.endTime).toBe(500);
	});

	test("marks failedTasks failed with doneFileFound=false", () => {
		const monitor = mkMonitor([mkLaneSnapshot({ laneNumber: 1, failedTasks: ["T-1"] })], 7_777);
		const outcomes: LaneTaskOutcome[] = [];
		syncTaskOutcomesFromMonitor(monitor, outcomes);
		expect(outcomes[0]?.status).toBe("failed");
		expect(outcomes[0]?.doneFileFound).toBe(false);
		expect(outcomes[0]?.endTime).toBe(7_777);
	});

	test("currentTaskSnapshot 'running' creates/updates running outcome with null endTime", () => {
		const monitor = mkMonitor([
			mkLaneSnapshot({
				laneNumber: 2,
				currentTaskId: "T-42",
				currentTaskSnapshot: mkTaskSnap({ taskId: "T-42", status: "running", observedAt: 3_000 }),
			}),
		]);
		const outcomes: LaneTaskOutcome[] = [];
		syncTaskOutcomesFromMonitor(monitor, outcomes);
		expect(outcomes[0]?.status).toBe("running");
		expect(outcomes[0]?.endTime).toBeNull();
		expect(outcomes[0]?.startTime).toBe(3_000);
	});

	test("currentTaskSnapshot 'stalled' is terminal and gets observedAt as endTime", () => {
		const monitor = mkMonitor([
			mkLaneSnapshot({
				laneNumber: 1,
				currentTaskId: "T-1",
				currentTaskSnapshot: mkTaskSnap({
					taskId: "T-1",
					status: "stalled",
					observedAt: 2_500,
					stallReason: "no progress",
				}),
			}),
		]);
		const outcomes: LaneTaskOutcome[] = [];
		syncTaskOutcomesFromMonitor(monitor, outcomes);
		expect(outcomes[0]?.status).toBe("stalled");
		expect(outcomes[0]?.endTime).toBe(2_500);
		expect(outcomes[0]?.exitReason).toBe("no progress");
	});

	test("currentTaskSnapshot 'unknown' falls back to existing status (or 'running' if none)", () => {
		const monitor = mkMonitor([
			mkLaneSnapshot({
				laneNumber: 1,
				currentTaskId: "T-1",
				currentTaskSnapshot: mkTaskSnap({ taskId: "T-1", status: "unknown", observedAt: 100 }),
			}),
		]);
		const outcomes: LaneTaskOutcome[] = [mkOutcome({ taskId: "T-1", status: "running" })];
		syncTaskOutcomesFromMonitor(monitor, outcomes);
		expect(outcomes[0]?.status).toBe("running");
	});

	test("empty monitor (no lanes) is a no-op", () => {
		const outcomes: LaneTaskOutcome[] = [];
		expect(syncTaskOutcomesFromMonitor(mkMonitor([]), outcomes)).toBe(false);
		expect(outcomes).toEqual([]);
	});
});
