/**
 * Unit tests for `detectMissionState` — pure state-detection routing
 * for `/mission` no-args invocation.
 *
 * Exercises the 6 decision branches (active-batch, completed-batch with
 * live orch branch, completed-batch fallback via branch list, no-config,
 * pending-tasks, no-tasks) plus two error paths (unreadable state +
 * stale orch-branch reference).
 */

import { describe, expect, test } from "bun:test";

import { detectMissionState } from "../src/missioncontrol/mission-state-detect";
import type { MissionStateDetectionDeps, PersistedBatchState } from "../src/missioncontrol/types";

function makeState(overrides: Partial<PersistedBatchState> = {}): PersistedBatchState {
	return {
		phase: "idle",
		batchId: "batch-001",
		lanes: [],
		tasks: [],
		wavePlan: [],
		...overrides,
	};
}

function makeDeps(overrides: Partial<MissionStateDetectionDeps> = {}): MissionStateDetectionDeps {
	return {
		hasConfig: () => true,
		loadBatchState: () => null,
		listOrchBranches: () => [],
		countPendingTasks: () => 0,
		...overrides,
	};
}

describe("detectMissionState — active batch", () => {
	test("non-terminal phase returns active-batch with progress summary", () => {
		const state = makeState({
			phase: "executing",
			batchId: "b-42",
			startedAt: Date.now() - 30_000,
			currentWaveIndex: 2,
			taskLevelWaveCount: 5,
			succeededTasks: 3,
			failedTasks: 1,
			skippedTasks: 0,
			totalTasks: 10,
		});
		const result = detectMissionState(makeDeps({ loadBatchState: () => state }));
		expect(result.state).toBe("active-batch");
		expect(result.batchId).toBe("b-42");
		expect(result.batchPhase).toBe("executing");
		expect(result.contextMessage).toContain("Batch b-42 is currently executing");
		expect(result.contextMessage).toContain("Wave 3/5");
		expect(result.contextMessage).toContain("3 succeeded, 1 failed, 0 skipped / 10 total");
		expect(result.contextMessage).toMatch(/Elapsed: \d+s\./);
	});

	test("uses endedAt when set (not now) for elapsed", () => {
		const state = makeState({
			phase: "executing",
			startedAt: 1_000,
			endedAt: 61_000,
		});
		const result = detectMissionState(makeDeps({ loadBatchState: () => state }));
		expect(result.contextMessage).toContain("Elapsed: 60s.");
	});

	test("falls back to ? for missing wave/task totals", () => {
		const state = makeState({ phase: "executing", batchId: "b" });
		const result = detectMissionState(makeDeps({ loadBatchState: () => state }));
		expect(result.contextMessage).toContain("Wave 1/?");
		expect(result.contextMessage).toContain("0 succeeded, 0 failed, 0 skipped / ? total");
	});

	test("prefers taskLevelWaveCount over totalWaves", () => {
		const state = makeState({
			phase: "executing",
			taskLevelWaveCount: 7,
			totalWaves: 99,
		});
		const result = detectMissionState(makeDeps({ loadBatchState: () => state }));
		expect(result.contextMessage).toContain("Wave 1/7");
		expect(result.contextMessage).not.toContain("/99");
	});
});

describe("detectMissionState — completed batch", () => {
	test("completed + live orch branch returns completed-batch with PR copy", () => {
		const state = makeState({
			phase: "completed",
			batchId: "done-1",
			orchBranch: "orch/done-1",
			baseBranch: "main",
			succeededTasks: 5,
			totalTasks: 5,
		});
		const result = detectMissionState(
			makeDeps({
				loadBatchState: () => state,
				listOrchBranches: () => ["orch/done-1"],
			}),
		);
		expect(result.state).toBe("completed-batch");
		expect(result.batchId).toBe("done-1");
		expect(result.orchBranch).toBe("orch/done-1");
		expect(result.contextMessage).toContain("5/5 tasks succeeded");
		expect(result.contextMessage).toContain("`orch/done-1`");
		expect(result.contextMessage).toContain("create a PR to main");
	});

	test("completed + missing orch branch falls through (branch deleted)", () => {
		const state = makeState({
			phase: "completed",
			orchBranch: "orch/stale",
		});
		const result = detectMissionState(
			makeDeps({
				loadBatchState: () => state,
				listOrchBranches: () => [],
				hasConfig: () => false,
			}),
		);
		expect(result.state).toBe("no-config");
	});

	test("orch branch fallback: single branch with no state", () => {
		const result = detectMissionState(makeDeps({ listOrchBranches: () => ["orch/unfinished"] }));
		expect(result.state).toBe("completed-batch");
		expect(result.orchBranch).toBe("orch/unfinished");
		expect(result.contextMessage).toContain("I found an orch branch (`orch/unfinished`)");
		expect(result.contextMessage).toContain("integrate it, or would you like to start fresh");
	});

	test("orch branch fallback: multiple branches uses plural copy", () => {
		const result = detectMissionState(makeDeps({ listOrchBranches: () => ["orch/a", "orch/b", "orch/c"] }));
		expect(result.state).toBe("completed-batch");
		expect(result.orchBranch).toBe("orch/a");
		expect(result.contextMessage).toContain("I found 3 orch branches");
		expect(result.contextMessage).toContain("`orch/a`, `orch/b`, `orch/c`");
	});

	test("unreadable state (throw) falls through to orch-branch check", () => {
		const result = detectMissionState(
			makeDeps({
				loadBatchState: () => {
					throw new Error("corrupt state");
				},
				listOrchBranches: () => ["orch/rescue"],
			}),
		);
		expect(result.state).toBe("completed-batch");
		expect(result.orchBranch).toBe("orch/rescue");
	});
});

describe("detectMissionState — no-config onboarding", () => {
	test("no config + no batch + no branches returns no-config", () => {
		const result = detectMissionState(makeDeps({ hasConfig: () => false }));
		expect(result.state).toBe("no-config");
		expect(result.contextMessage).toContain("Welcome to MissionControl!");
		expect(result.contextMessage).not.toContain("Taskplane");
	});

	test("no-config takes precedence over pending-tasks when config absent", () => {
		const result = detectMissionState(
			makeDeps({
				hasConfig: () => false,
				countPendingTasks: () => 4,
			}),
		);
		expect(result.state).toBe("no-config");
	});
});

describe("detectMissionState — pending tasks", () => {
	test("pending count > 0 returns pending-tasks with plural copy", () => {
		const result = detectMissionState(makeDeps({ countPendingTasks: () => 3 }));
		expect(result.state).toBe("pending-tasks");
		expect(result.pendingTaskCount).toBe(3);
		expect(result.contextMessage).toContain("You have 3 pending tasks ready to run");
	});

	test("pending count of 1 uses singular copy", () => {
		const result = detectMissionState(makeDeps({ countPendingTasks: () => 1 }));
		expect(result.state).toBe("pending-tasks");
		expect(result.contextMessage).toContain("You have 1 pending task ready to run");
		expect(result.contextMessage).not.toContain("1 pending tasks");
	});
});

describe("detectMissionState — no-tasks fallback", () => {
	test("fully idle project returns no-tasks with ideation menu", () => {
		const result = detectMissionState(makeDeps());
		expect(result.state).toBe("no-tasks");
		expect(result.contextMessage).toContain("No pending tasks right now");
		expect(result.contextMessage).toContain("Create tasks from a spec");
		expect(result.contextMessage).toContain("What interests you?");
	});
});

describe("detectMissionState — precedence", () => {
	test("active batch beats all other conditions", () => {
		const state = makeState({ phase: "executing" });
		const result = detectMissionState(
			makeDeps({
				loadBatchState: () => state,
				hasConfig: () => false,
				listOrchBranches: () => ["orch/a"],
				countPendingTasks: () => 5,
			}),
		);
		expect(result.state).toBe("active-batch");
	});

	test("completed-batch beats no-config when branch exists", () => {
		const state = makeState({ phase: "completed", orchBranch: "orch/live" });
		const result = detectMissionState(
			makeDeps({
				loadBatchState: () => state,
				listOrchBranches: () => ["orch/live"],
				hasConfig: () => false,
			}),
		);
		expect(result.state).toBe("completed-batch");
	});

	test("orch-branch fallback beats no-config + pending-tasks", () => {
		const result = detectMissionState(
			makeDeps({
				listOrchBranches: () => ["orch/x"],
				hasConfig: () => false,
				countPendingTasks: () => 10,
			}),
		);
		expect(result.state).toBe("completed-batch");
	});
});
