/**
 * Tests for `missioncontrol/engine-worker.ts`.
 *
 * Pure serialization helpers — verify Map/entries round-trip, null
 * passthroughs, and that `applySerializedState` only touches worker-
 * tracked fields (preserves `pauseSignal`, `dependencyGraph`, etc.).
 */

import { describe, expect, test } from "bun:test";

import {
	applySerializedState,
	deserializeWorkspaceConfig,
	type SerializedBatchState,
	type SerializedWorkspaceConfig,
	serializeBatchForWorker,
	serializeWorkspaceConfig,
} from "../src/missioncontrol/engine-worker";
import {
	freshMissionBatchState,
	type MissionBatchRuntimeState,
	type WorkspaceConfig,
} from "../src/missioncontrol/types";

function makeWorkspaceConfig(): WorkspaceConfig {
	return {
		mode: "workspace",
		repos: new Map([
			["api", { id: "api", path: "/ws/api", defaultBranch: "main" }],
			["web", { id: "web", path: "/ws/web" }],
		]),
		routing: {
			tasksRoot: "/ws/tasks",
			defaultRepo: "api",
			taskPacketRepo: "api",
			strict: true,
		},
		configPath: "/ws/.omp/mission-workspace.yaml",
	};
}

describe("serializeWorkspaceConfig", () => {
	test("null/undefined → null", () => {
		expect(serializeWorkspaceConfig(null)).toBeNull();
		expect(serializeWorkspaceConfig(undefined)).toBeNull();
	});

	test("converts repos Map to array of entries preserving order", () => {
		const serialized = serializeWorkspaceConfig(makeWorkspaceConfig());
		expect(serialized).not.toBeNull();
		expect(serialized?.mode).toBe("workspace");
		expect(serialized?.repos).toEqual([
			["api", { id: "api", path: "/ws/api", defaultBranch: "main" }],
			["web", { id: "web", path: "/ws/web" }],
		]);
		expect(serialized?.routing).toEqual({
			tasksRoot: "/ws/tasks",
			defaultRepo: "api",
			taskPacketRepo: "api",
			strict: true,
		});
		expect(serialized?.configPath).toBe("/ws/.omp/mission-workspace.yaml");
	});
});

describe("deserializeWorkspaceConfig", () => {
	test("null/undefined → null", () => {
		expect(deserializeWorkspaceConfig(null)).toBeNull();
		expect(deserializeWorkspaceConfig(undefined)).toBeNull();
	});

	test("reconstructs Map from entries", () => {
		const original = makeWorkspaceConfig();
		const serialized = serializeWorkspaceConfig(original);
		const round = deserializeWorkspaceConfig(serialized);
		expect(round).not.toBeNull();
		expect(round?.mode).toBe("workspace");
		expect(round?.repos instanceof Map).toBe(true);
		expect(round?.repos.get("api")).toEqual({ id: "api", path: "/ws/api", defaultBranch: "main" });
		expect(round?.repos.get("web")).toEqual({ id: "web", path: "/ws/web" });
		expect(round?.routing).toEqual(original.routing);
		expect(round?.configPath).toBe(original.configPath);
	});

	test("round-trip is shape-preserving", () => {
		const original = makeWorkspaceConfig();
		const serialized = serializeWorkspaceConfig(original) as SerializedWorkspaceConfig;
		const round = deserializeWorkspaceConfig(serialized);
		expect(round?.repos.size).toBe(original.repos.size);
		for (const [id, repo] of original.repos.entries()) {
			expect(round?.repos.get(id)).toEqual(repo);
		}
	});
});

describe("serializeBatchForWorker", () => {
	test("produces snapshot with all display fields", () => {
		const state = freshMissionBatchState();
		state.phase = "executing";
		state.batchId = "b-1";
		state.baseBranch = "main";
		state.orchBranch = "mission/b-1";
		state.currentWaveIndex = 2;
		state.totalWaves = 5;
		state.totalTasks = 10;
		state.succeededTasks = 4;
		state.failedTasks = 1;
		state.skippedTasks = 0;
		state.blockedTasks = 0;
		state.startedAt = 1_700_000_000;
		state.endedAt = null;
		state.errors = ["oops"];

		const s = serializeBatchForWorker(state);
		expect(s.phase).toBe("executing");
		expect(s.batchId).toBe("b-1");
		expect(s.baseBranch).toBe("main");
		expect(s.orchBranch).toBe("mission/b-1");
		expect(s.mode).toBe("repo");
		expect(s.currentWaveIndex).toBe(2);
		expect(s.totalWaves).toBe(5);
		expect(s.totalTasks).toBe(10);
		expect(s.succeededTasks).toBe(4);
		expect(s.failedTasks).toBe(1);
		expect(s.errors).toEqual(["oops"]);
		expect(s.currentLanes).toEqual([]);
	});

	test("defensively copies errors array", () => {
		const state = freshMissionBatchState();
		state.errors = ["a"];
		const s = serializeBatchForWorker(state);
		state.errors.push("b");
		expect(s.errors).toEqual(["a"]);
	});
});

describe("applySerializedState", () => {
	test("updates tracked fields without mutating pauseSignal or dependencyGraph", () => {
		const state = freshMissionBatchState();
		const originalPauseSignal = state.pauseSignal;

		const serialized: SerializedBatchState = {
			phase: "merging",
			batchId: "b-42",
			baseBranch: "main",
			orchBranch: "mission/b-42",
			mode: "workspace",
			currentWaveIndex: 1,
			totalWaves: 3,
			totalTasks: 7,
			succeededTasks: 5,
			failedTasks: 1,
			skippedTasks: 1,
			blockedTasks: 0,
			startedAt: 1_700_000_000,
			endedAt: 1_700_000_999,
			errors: ["boom"],
			currentLanes: [],
		};

		applySerializedState(state, serialized);

		expect(state.phase).toBe("merging");
		expect(state.batchId).toBe("b-42");
		expect(state.mode).toBe("workspace");
		expect(state.succeededTasks).toBe(5);
		expect(state.errors).toEqual(["boom"]);
		expect(state.pauseSignal).toBe(originalPauseSignal);
		expect(state.dependencyGraph).toBeNull();
	});

	test("defensively copies errors so later mutations don't leak", () => {
		const state: MissionBatchRuntimeState = freshMissionBatchState();
		const errors = ["e1"];
		const serialized: SerializedBatchState = {
			phase: "failed",
			batchId: "b-2",
			baseBranch: "main",
			orchBranch: "",
			mode: "repo",
			currentWaveIndex: 0,
			totalWaves: 0,
			totalTasks: 0,
			succeededTasks: 0,
			failedTasks: 0,
			skippedTasks: 0,
			blockedTasks: 0,
			startedAt: 0,
			endedAt: null,
			errors,
			currentLanes: [],
		};
		applySerializedState(state, serialized);
		errors.push("e2");
		expect(state.errors).toEqual(["e1"]);
	});

	test("treats missing currentLanes as empty array", () => {
		const state = freshMissionBatchState();
		const serialized = {
			phase: "idle",
			batchId: "",
			baseBranch: "",
			orchBranch: "",
			mode: "repo",
			currentWaveIndex: -1,
			totalWaves: 0,
			totalTasks: 0,
			succeededTasks: 0,
			failedTasks: 0,
			skippedTasks: 0,
			blockedTasks: 0,
			startedAt: 0,
			endedAt: null,
			errors: [],
			// currentLanes intentionally omitted
		} as unknown as SerializedBatchState;
		applySerializedState(state, serialized);
		expect(state.currentLanes).toEqual([]);
	});
});
