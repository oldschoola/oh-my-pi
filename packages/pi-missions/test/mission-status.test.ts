/**
 * Unit tests for `buildMissionStatusReport`.
 *
 * Covers:
 *  - null mission → warning with usage hint
 *  - mission without batch → warning with usage hint
 *  - batch with no tasks/lanes → header + elapsed only
 *  - batch with mixed task statuses → correct tally across all TaskStatus values
 *  - batch with lanes → sorted lane lines (idle vs running, with stepProgress)
 *  - batch with errors → error count line rendered
 *  - endTime short-circuits elapsed calc (vs Date.now())
 *  - wave display clamps `currentWave` to `totalWaves - 1` when overrun
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import * as missioncontrol from "../src/missioncontrol";
import { buildMissionStatusReport } from "../src/missioncontrol";
import type { BatchState, LaneStatus, MissionState, TaskOutcome, TaskStatus } from "../src/types";

function mkMission(batch?: Partial<BatchState>): MissionState {
	const base: MissionState = {
		description: "demo",
		mode: "simple",
		templateKey: "adaptive",
		phases: [],
		autonomy: "medium",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: new Date().toISOString(),
	};
	if (!batch) return base;
	return {
		...base,
		kind: "batch",
		batch: {
			batchId: "b1",
			phase: "running",
			waves: [],
			currentWave: 0,
			laneCount: 0,
			laneStatuses: [],
			tasks: [],
			tasksTotal: 0,
			tasksComplete: 0,
			tasksFailed: 0,
			startTime: Date.now(),
			errors: [],
			...batch,
		},
	};
}

function outcome(taskId: string, status: TaskStatus): TaskOutcome {
	return {
		taskId,
		status,
		startTime: null,
		endTime: null,
		exitReason: "",
		sessionName: "",
		doneFileFound: status === "succeeded",
	};
}

function lane(lane: number, taskId: string | null, status: LaneStatus["status"], stepProgress = ""): LaneStatus {
	return { lane, taskId, status, stepProgress, iteration: 0, elapsed: 0, sessionName: "" };
}

describe("buildMissionStatusReport — no batch", () => {
	test("null mission → warning with usage hint", async () => {
		const r = await buildMissionStatusReport(null);
		expect(r.level).toBe("warning");
		expect(r.message).toContain("No batch is running");
		expect(r.message).toContain("/mission-batch");
	});

	test("mission without batch field → warning", async () => {
		const r = await buildMissionStatusReport(mkMission());
		expect(r.level).toBe("warning");
		expect(r.message).toContain("No batch is running");
	});
});

describe("buildMissionStatusReport — batch header", () => {
	test("renders batch id + phase", async () => {
		const r = await buildMissionStatusReport(mkMission({ batchId: "b-42", phase: "running" }));
		expect(r.level).toBe("info");
		expect(r.message).toContain("📊 Batch b-42 — running");
	});

	test("empty batch renders zero tallies + one wave", async () => {
		const r = await buildMissionStatusReport(mkMission({}));
		expect(r.message).toContain("Wave: 1/1");
		expect(r.message).toContain("0 succeeded, 0 failed, 0 skipped, 0 stalled / 0 total");
	});

	test("elapsed uses endTime when set", async () => {
		const start = 1_000_000_000;
		const r = await buildMissionStatusReport(mkMission({ startTime: start, endTime: start + 45_000 }));
		expect(r.message).toContain("Elapsed: 45s");
	});

	test("elapsed falls back to Date.now() when endTime missing", async () => {
		const start = Date.now() - 10_000;
		const r = await buildMissionStatusReport(mkMission({ startTime: start }));
		expect(r.message).toMatch(/Elapsed: \d+s/);
	});

	test("clamps currentWave to totalWaves - 1 when overrun", async () => {
		const r = await buildMissionStatusReport(
			mkMission({
				currentWave: 99,
				waves: [
					{ wave: 0, taskIds: ["A"] },
					{ wave: 1, taskIds: ["B"] },
				],
			}),
		);
		expect(r.message).toContain("Wave: 2/2");
	});
});

describe("buildMissionStatusReport — task tally", () => {
	test("counts each TaskStatus accurately", async () => {
		const r = await buildMissionStatusReport(
			mkMission({
				tasksTotal: 6,
				tasks: [
					outcome("T1", "succeeded"),
					outcome("T2", "succeeded"),
					outcome("T3", "failed"),
					outcome("T4", "skipped"),
					outcome("T5", "stalled"),
					outcome("T6", "running"),
				],
			}),
		);
		expect(r.message).toContain("2 succeeded, 1 failed, 1 skipped, 1 stalled / 6 total");
	});

	test("pending + running do not surface in the counts line", async () => {
		const r = await buildMissionStatusReport(
			mkMission({
				tasksTotal: 2,
				tasks: [outcome("T1", "pending"), outcome("T2", "running")],
			}),
		);
		expect(r.message).toContain("0 succeeded, 0 failed, 0 skipped, 0 stalled / 2 total");
	});
});

describe("buildMissionStatusReport — lanes", () => {
	test("omits Lanes section when empty", async () => {
		const r = await buildMissionStatusReport(mkMission({}));
		expect(r.message).not.toContain("Lanes:");
	});

	test("sorts lanes ascending by lane number", async () => {
		const r = await buildMissionStatusReport(
			mkMission({
				laneStatuses: [lane(3, "T3", "running"), lane(1, "T1", "complete"), lane(2, null, "idle")],
			}),
		);
		const idx1 = r.message.indexOf("Lane 1");
		const idx2 = r.message.indexOf("Lane 2");
		const idx3 = r.message.indexOf("Lane 3");
		expect(idx1).toBeGreaterThan(-1);
		expect(idx1).toBeLessThan(idx2);
		expect(idx2).toBeLessThan(idx3);
	});

	test("idle lane renders 'idle' label", async () => {
		const r = await buildMissionStatusReport(mkMission({ laneStatuses: [lane(1, null, "idle")] }));
		expect(r.message).toContain("Lane 1: idle");
	});

	test("active lane renders taskId + status + stepProgress", async () => {
		const r = await buildMissionStatusReport(mkMission({ laneStatuses: [lane(1, "T1", "running", "2 of 5 steps")] }));
		expect(r.message).toContain("Lane 1: T1 (running) · 2 of 5 steps");
	});

	test("active lane without stepProgress omits the separator", async () => {
		const r = await buildMissionStatusReport(mkMission({ laneStatuses: [lane(1, "T1", "running")] }));
		expect(r.message).toContain("Lane 1: T1 (running)");
		expect(r.message).not.toContain("Lane 1: T1 (running) ·");
	});
});

describe("buildMissionStatusReport — errors", () => {
	test("omits Errors line when zero", async () => {
		const r = await buildMissionStatusReport(mkMission({}));
		expect(r.message).not.toContain("Errors:");
	});

	test("renders error count", async () => {
		const r = await buildMissionStatusReport(mkMission({ errors: ["boom", "crash", "splat"] }));
		expect(r.message).toContain("Errors: 3");
	});
});

afterEach(() => {
	mock.restore();
});

describe("buildMissionStatusReport — disk fallback", () => {
	test("formats persisted state when mission is null but cwd + disk state exist", async () => {
		const persisted = {
			schemaVersion: 4,
			phase: "running",
			batchId: "b-disk",
			baseBranch: "main",
			orchBranch: "orch/b-disk",
			mode: "repo" as const,
			startedAt: Date.now() - 30_000,
			updatedAt: Date.now(),
			endedAt: null,
			currentWaveIndex: 0,
			totalWaves: 1,
			totalTasks: 1,
			succeededTasks: 0,
			failedTasks: 0,
			skippedTasks: 0,
			blockedTasks: 0,
			blockedTaskIds: [],
			lanes: [{ laneNumber: 1 } as unknown as import("../src/missioncontrol/types").PersistedLaneRecord],
			tasks: [
				{
					taskId: "TP-001",
					laneNumber: 1,
					sessionName: "mission-lane-1",
					status: "running" as const,
					taskFolder: "tasks/TP-001",
					startedAt: Date.now(),
					endedAt: null,
					doneFileFound: false,
					exitReason: "",
				},
			],
			wavePlan: [["TP-001"]],
			mergeResults: [],
			errors: [],
		} as unknown as import("../src/missioncontrol/types").PersistedBatchState;
		spyOn(missioncontrol, "loadBatchState").mockResolvedValue(persisted);

		const report = await buildMissionStatusReport(null, { cwd: "/fake" });
		expect(report.level).toBe("info");
		expect(report.message).toContain("Batch b-disk");
		expect(report.message).toContain("(disk)");
		expect(report.message).toContain("TP-001");
	});

	test("returns warning when disk has no batch state either", async () => {
		spyOn(missioncontrol, "loadBatchState").mockResolvedValue(null);
		const report = await buildMissionStatusReport(null, { cwd: "/fake" });
		expect(report.level).toBe("warning");
		expect(report.message).toContain("No batch is running");
	});

	test("swallows loadBatchState errors and falls through to the warning", async () => {
		spyOn(missioncontrol, "loadBatchState").mockRejectedValue(new Error("disk read failed"));
		const report = await buildMissionStatusReport(null, { cwd: "/fake" });
		expect(report.level).toBe("warning");
		expect(report.message).toContain("No batch is running");
	});
});
