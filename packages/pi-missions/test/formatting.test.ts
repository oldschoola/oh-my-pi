import { describe, expect, test } from "bun:test";
import type { ParsedTask } from "../src/missioncontrol/discovery";
import {
	buildDashboardViewModel,
	computeMissionSummaryCounts,
	formatDependencyGraph,
	formatElapsedTime,
	formatWavePlan,
} from "../src/missioncontrol/formatting";
import type { LaneAssignment, MonitorState, WaveComputationResult } from "../src/missioncontrol/types";
import { freshMissionBatchState, SIZE_DURATION_MINUTES } from "../src/missioncontrol/types";

const mkTask = (id: string, deps: string[] = [], size = "M"): ParsedTask => ({
	taskId: id,
	taskName: `Task ${id}`,
	folderPath: `/tmp/${id}`,
	promptPath: `/tmp/${id}/PROMPT.md`,
	prompt: "",
	dependencies: deps,
	size,
	taskFolder: `/tmp/${id}`,
});

const mkAssignment = (id: string, lane: number): LaneAssignment => ({
	taskId: id,
	lane,
	task: mkTask(id),
});

describe("formatDependencyGraph", () => {
	test("no dependencies → shows independent tasks", () => {
		const pending = new Map<string, ParsedTask>([
			["A-1", mkTask("A-1")],
			["A-2", mkTask("A-2")],
		]);
		const out = formatDependencyGraph(pending, new Set());
		expect(out).toContain("Dependency Graph");
		expect(out).toContain("all tasks are independent");
		expect(out).toContain("Independent");
		expect(out).toContain("A-1");
		expect(out).toContain("A-2");
	});

	test("renders upstream + downstream edges", () => {
		const pending = new Map<string, ParsedTask>([
			["A-1", mkTask("A-1")],
			["A-2", mkTask("A-2", ["A-1"])],
		]);
		const out = formatDependencyGraph(pending, new Set());
		expect(out).toContain("A-2 → A-1");
		expect(out).toContain("A-1"); // downstream target
		expect(out).toContain("← A-2");
	});

	test("marks completed deps with check", () => {
		const pending = new Map<string, ParsedTask>([["A-2", mkTask("A-2", ["A-1"])]]);
		const out = formatDependencyGraph(pending, new Set(["A-1"]));
		expect(out).toContain("complete");
	});

	test("filter to single task", () => {
		const pending = new Map<string, ParsedTask>([
			["A-1", mkTask("A-1")],
			["A-2", mkTask("A-2", ["A-1"])],
			["A-3", mkTask("A-3", ["A-2"])],
		]);
		const out = formatDependencyGraph(pending, new Set(), "A-2");
		expect(out).toContain("Dependencies for A-2");
		expect(out).toContain("Upstream");
		expect(out).toContain("Downstream");
	});

	test("filter missing task → error", () => {
		const out = formatDependencyGraph(new Map(), new Set(), "MISSING");
		expect(out).toContain("not found");
	});
});

describe("formatWavePlan", () => {
	test("empty waves", () => {
		const result: WaveComputationResult = { waves: [], errors: [] };
		expect(formatWavePlan(result, { S: 1, M: 2, L: 4 })).toContain("No waves");
	});

	test("renders errors", () => {
		const result: WaveComputationResult = {
			waves: [],
			errors: [{ code: "DUPLICATE_ID", message: "dup A-1" }],
		};
		const out = formatWavePlan(result, { S: 1, M: 2, L: 4 });
		expect(out).toContain("Computation Errors");
		expect(out).toContain("[DUPLICATE_ID]");
	});

	test("single wave, parallel lanes", () => {
		const result: WaveComputationResult = {
			waves: [
				{
					waveNumber: 1,
					tasks: [mkAssignment("A-1", 1), mkAssignment("A-2", 2)],
				},
			],
			errors: [],
		};
		const out = formatWavePlan(result, { S: 1, M: 2, L: 4 });
		expect(out).toContain("Wave 1: 2 task(s) across 2 lane(s) [parallel]");
		expect(out).toContain("Lane 1");
		expect(out).toContain("Lane 2");
		expect(out).toContain("Total estimated duration");
	});

	test("serial note when lane has multiple tasks", () => {
		const result: WaveComputationResult = {
			waves: [
				{
					waveNumber: 1,
					tasks: [mkAssignment("A-1", 1), mkAssignment("A-2", 1)],
				},
			],
			errors: [],
		};
		const out = formatWavePlan(result, { S: 1, M: 2, L: 4 });
		expect(out).toContain("(serial)");
	});

	test("cites size-duration model", () => {
		const result: WaveComputationResult = {
			waves: [{ waveNumber: 1, tasks: [mkAssignment("A-1", 1)] }],
			errors: [],
		};
		const out = formatWavePlan(result, { S: 1, M: 2, L: 4 });
		expect(out).toContain(`S=${SIZE_DURATION_MINUTES.S}m`);
	});
});

describe("computeMissionSummaryCounts", () => {
	test("base state → zero counts", () => {
		const batch = freshMissionBatchState();
		const c = computeMissionSummaryCounts(batch);
		expect(c.completed).toBe(0);
		expect(c.running).toBe(0);
		expect(c.failed).toBe(0);
		expect(c.total).toBe(0);
	});

	test("monitor running task → running count", () => {
		const batch = freshMissionBatchState();
		batch.totalTasks = 3;
		const monitor: MonitorState = {
			lanes: [
				{
					laneId: "lane-1",
					laneNumber: 1,
					sessionName: "s",
					sessionAlive: true,
					currentTaskId: "A-1",
					currentTaskSnapshot: {
						taskId: "A-1",
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
						observedAt: 0,
						parseError: null,
						iteration: 0,
						reviewCounter: 0,
					},
					completedTasks: [],
					failedTasks: [],
					remainingTasks: [],
				},
			],
			tasksDone: 0,
			tasksFailed: 0,
			tasksTotal: 3,
			waveNumber: 1,
			pollCount: 0,
			lastPollTime: 0,
			allTerminal: false,
		};
		const c = computeMissionSummaryCounts(batch, monitor);
		expect(c.running).toBe(1);
	});

	test("batch succeeded/failed propagate", () => {
		const batch = freshMissionBatchState();
		batch.totalTasks = 5;
		batch.succeededTasks = 2;
		batch.failedTasks = 1;
		const c = computeMissionSummaryCounts(batch);
		expect(c.completed).toBe(2);
		expect(c.failed).toBe(1);
		expect(c.queued).toBe(2);
	});
});

describe("formatElapsedTime", () => {
	test("zero start → 0s", () => {
		expect(formatElapsedTime(0)).toBe("0s");
	});

	test("negative elapsed → 0s", () => {
		expect(formatElapsedTime(Date.now() + 10_000, Date.now())).toBe("0s");
	});

	test("seconds only", () => {
		expect(formatElapsedTime(1000, 4000)).toBe("3s");
	});

	test("minutes + seconds", () => {
		expect(formatElapsedTime(1, 134_001)).toBe("2m 14s");
	});

	test("hours + minutes + seconds", () => {
		expect(formatElapsedTime(1, 3_930_001)).toBe("1h 5m 30s");
	});
});

describe("buildDashboardViewModel", () => {
	test("idle batch → zero summary", () => {
		const batch = freshMissionBatchState();
		const vm = buildDashboardViewModel(batch);
		expect(vm.summary.total).toBe(0);
		expect(vm.laneCards).toEqual([]);
		expect(vm.waveProgress).toBe("0/0");
	});

	test("waveProgress reflects currentWaveIndex + totalWaves", () => {
		const batch = freshMissionBatchState();
		batch.totalWaves = 3;
		batch.currentWaveIndex = 1;
		const vm = buildDashboardViewModel(batch);
		expect(vm.waveProgress).toBe("2/3");
	});

	test("stale monitor data (TP-170) → lane cards derived from currentLanes", () => {
		const batch = freshMissionBatchState();
		batch.currentLanes = [
			{
				laneId: "lane-1",
				laneSessionId: "lane-sess-1",
				laneNumber: 1,
				tasks: [],
				worktreePath: "",
				branch: "br",
				strategy: "round-robin",
				estimatedLoad: 0,
				estimatedMinutes: 0,
			},
		];
		const staleMonitor: MonitorState = {
			lanes: [
				{
					laneId: "lane-99",
					laneNumber: 99,
					sessionName: "stale",
					sessionAlive: false,
					currentTaskId: null,
					currentTaskSnapshot: null,
					completedTasks: [],
					failedTasks: [],
					remainingTasks: [],
				},
			],
			tasksDone: 0,
			tasksFailed: 0,
			tasksTotal: 0,
			waveNumber: 0,
			pollCount: 0,
			lastPollTime: 0,
			allTerminal: false,
		};
		const vm = buildDashboardViewModel(batch, staleMonitor);
		expect(vm.laneCards).toHaveLength(1);
		expect(vm.laneCards[0]?.laneNumber).toBe(1);
		expect(vm.laneCards[0]?.status).toBe("running");
	});
});
