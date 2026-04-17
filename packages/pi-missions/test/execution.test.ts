/**
 * Tests for `missioncontrol/execution.ts` pure helpers.
 *
 * Covers log-tail readers (sync + async), STATUS.md parsing (sync + async,
 * direct + resolved), file-existence probe, transitive-dependent graph
 * walk, execution-unit construction, agent-id derivation, reviewer env,
 * runtime state root, and the trivial `.DONE` path wrapper. Heavy
 * orchestration paths (`monitorLanes`, `executeWave`, `executeLaneV2`)
 * are deferred.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AllocatedLane, AllocatedTask, DependencyGraph, ParsedTask } from "../src/missioncontrol";
import {
	buildAgentIdFromLane,
	buildExecutionUnit,
	buildReviewerEnv,
	computeTransitiveDependents,
	fileExistsAsync,
	parseStatusMdAtPath,
	parseWorktreeStatusMd,
	parseWorktreeStatusMdAsync,
	readLaneLogTail,
	readLaneLogTailAsync,
	readTaskStatusTail,
	readTaskStatusTailAsync,
	resolveLaneLogPath,
	resolveLaneLogRelativePath,
	resolveRuntimeStateRoot,
	resolveTaskDonePath,
} from "../src/missioncontrol/execution";
import { ExecutionError } from "../src/missioncontrol/types";

function makeTmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function makeLane(overrides: Partial<AllocatedLane> = {}): AllocatedLane {
	return {
		laneNumber: 1,
		laneId: "lane-1",
		laneSessionId: "mission-henry-lane-1",
		worktreePath: "/wt",
		branch: "task/henry-lane-1-b-1",
		tasks: [],
		strategy: "round-robin",
		estimatedLoad: 1,
		estimatedMinutes: 30,
		...overrides,
	} as AllocatedLane;
}

function makeParsedTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
	return {
		taskId: "T-1",
		taskName: "first",
		folderPath: "/repo/tasks/T-1",
		promptPath: "/repo/tasks/T-1/PROMPT.md",
		prompt: "do stuff",
		dependencies: [],
		size: "M",
		taskFolder: "/repo/tasks/T-1",
		...overrides,
	};
}

function makeAllocatedTask(
	overrides: Partial<AllocatedTask> = {},
	taskOverrides: Partial<ParsedTask> = {},
): AllocatedTask {
	return {
		taskId: "T-1",
		order: 0,
		task: makeParsedTask(taskOverrides),
		estimatedMinutes: 15,
		...overrides,
	};
}

describe("lane log paths", () => {
	test("resolveLaneLogPath joins worktree + .omp/mission-logs", () => {
		const lane = makeLane({ worktreePath: "/wt/henry-b-1/lane-1" });
		const task = makeAllocatedTask();
		const logPath = resolveLaneLogPath(lane, task);
		expect(logPath).toContain(join(".omp", "mission-logs"));
		expect(logPath).toContain("mission-henry-lane-1-T-1.log");
	});

	test("resolveLaneLogRelativePath returns forward-slash relative form", () => {
		const lane = makeLane();
		const task = makeAllocatedTask();
		const rel = resolveLaneLogRelativePath(lane, task);
		expect(rel).toBe(".omp/mission-logs/mission-henry-lane-1-T-1.log");
		expect(rel.includes("\\")).toBe(false);
	});
});

describe("fileExistsAsync + tail readers", () => {
	test("fileExistsAsync true/false", async () => {
		const dir = makeTmp("mc-exec-exists-");
		const f = join(dir, "x.txt");
		writeFileSync(f, "hi");
		try {
			expect(await fileExistsAsync(f)).toBe(true);
			expect(await fileExistsAsync(join(dir, "nope"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("readLaneLogTail returns last N lines and trims to maxChars", () => {
		const dir = makeTmp("mc-exec-tail-");
		const f = join(dir, "log.txt");
		try {
			writeFileSync(f, "a\nb\nc\nd\ne");
			expect(readLaneLogTail(f, 3)).toBe("c\nd\ne");
			// Truncation by maxChars keeps the tail slice:
			const big = "x".repeat(2000);
			writeFileSync(f, big);
			const trimmed = readLaneLogTail(f, 40, 100);
			expect(trimmed.length).toBe(100);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("readLaneLogTailAsync mirrors sync behaviour", async () => {
		const dir = makeTmp("mc-exec-tail-async-");
		const f = join(dir, "log.txt");
		try {
			writeFileSync(f, "one\ntwo\nthree");
			expect(await readLaneLogTailAsync(f, 2)).toBe("two\nthree");
			expect(await readLaneLogTailAsync(join(dir, "missing"))).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("readTaskStatusTail + Async return empty for missing file", async () => {
		expect(readTaskStatusTail("/nowhere/STATUS.md")).toBe("");
		expect(await readTaskStatusTailAsync("/nowhere/STATUS.md")).toBe("");
	});
});

describe("parseWorktreeStatusMd + async variants", () => {
	const sample = [
		"# Task T-1",
		"",
		"**Review Counter:** 2",
		"**Iteration:** 3",
		"",
		"### Step 1: Architect",
		"**Status:** ✅ complete",
		"- [x] thing one",
		"- [x] thing two",
		"",
		"### Step 2: Implement",
		"**Status:** 🟨 in progress",
		"- [x] subtask",
		"- [ ] pending",
		"",
		"### Step 3: Test",
		"**Status:** not started",
		"- [ ] a",
		"- [ ] b",
		"",
	].join("\n");

	test("parses steps, counters, iteration from a worktree-relative path", () => {
		const repoRoot = makeTmp("mc-exec-repo-");
		const worktree = makeTmp("mc-exec-wt-");
		try {
			const taskFolder = join(repoRoot, "tasks", "T-1");
			// Place STATUS.md inside the worktree under the same relative path
			const wtTaskFolder = join(worktree, "tasks", "T-1");
			mkdirSync(wtTaskFolder, { recursive: true });
			writeFileSync(join(wtTaskFolder, "STATUS.md"), sample);

			const { parsed, error } = parseWorktreeStatusMd(taskFolder, worktree, repoRoot);
			expect(error).toBeNull();
			expect(parsed).not.toBeNull();
			expect(parsed?.reviewCounter).toBe(2);
			expect(parsed?.iteration).toBe(3);
			expect(parsed?.steps).toHaveLength(3);
			expect(parsed?.steps[0]?.status).toBe("complete");
			expect(parsed?.steps[0]?.totalChecked).toBe(2);
			expect(parsed?.steps[0]?.totalItems).toBe(2);
			expect(parsed?.steps[1]?.status).toBe("in-progress");
			expect(parsed?.steps[1]?.totalChecked).toBe(1);
			expect(parsed?.steps[2]?.status).toBe("not-started");
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
			rmSync(worktree, { recursive: true, force: true });
		}
	});

	test("returns error when STATUS.md missing", () => {
		const repoRoot = makeTmp("mc-exec-repo-miss-");
		const worktree = makeTmp("mc-exec-wt-miss-");
		try {
			const { parsed, error } = parseWorktreeStatusMd(join(repoRoot, "tasks", "Z"), worktree, repoRoot);
			expect(parsed).toBeNull();
			expect(error).toContain("STATUS.md not found");
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
			rmSync(worktree, { recursive: true, force: true });
		}
	});

	test("async variants — direct path + resolved path", async () => {
		const dir = makeTmp("mc-exec-md-async-");
		const statusPath = join(dir, "STATUS.md");
		writeFileSync(statusPath, sample);
		try {
			const direct = await parseStatusMdAtPath(statusPath);
			expect(direct.error).toBeNull();
			expect(direct.parsed?.reviewCounter).toBe(2);

			// Resolve through parseWorktreeStatusMdAsync — repoRoot matches dir to keep the path in-tree
			const resolved = await parseWorktreeStatusMdAsync(dir, dir, dir);
			expect(resolved.parsed?.steps.length).toBe(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveTaskDonePath", () => {
	test("returns worktree-relative .DONE path when task folder inside repo", () => {
		const donePath = resolveTaskDonePath("/repo/tasks/T-1", "/wt", "/repo");
		expect(donePath.endsWith(join("tasks", "T-1", ".DONE"))).toBe(true);
	});
});

describe("computeTransitiveDependents", () => {
	function makeGraph(dependents: Record<string, string[]>): DependencyGraph {
		return {
			dependencies: new Map(),
			dependents: new Map(Object.entries(dependents)),
			nodes: new Set(),
		};
	}

	test("walks BFS to transitive closure", () => {
		const graph = makeGraph({
			A: ["B", "C"],
			B: ["D"],
			C: ["D", "E"],
			D: ["F"],
		});
		const blocked = computeTransitiveDependents(new Set(["A"]), graph);
		expect([...blocked].sort()).toEqual(["B", "C", "D", "E", "F"]);
	});

	test("never re-adds failed task IDs", () => {
		const graph = makeGraph({ A: ["B"], B: ["A"] });
		const blocked = computeTransitiveDependents(new Set(["A"]), graph);
		expect(blocked.has("A")).toBe(false);
		expect(blocked.has("B")).toBe(true);
	});

	test("returns empty set when no dependents", () => {
		const graph = makeGraph({});
		expect(computeTransitiveDependents(new Set(["X"]), graph).size).toBe(0);
	});
});

describe("buildExecutionUnit", () => {
	test("builds worktree-scoped unit when packet home == execution repo", () => {
		const lane = makeLane({ worktreePath: "/wt", repoId: "api" } as Partial<AllocatedLane>);
		const task = makeAllocatedTask(
			{},
			{
				taskFolder: "/repo/tasks/T-1",
				packetRepoId: "api",
				packetTaskPath: "/other/repo/tasks/T-1",
			},
		);
		const unit = buildExecutionUnit(lane, task, "/repo");
		expect(unit.executionRepoId).toBe("api");
		expect(unit.packetHomeRepoId).toBe("api");
		// Same-repo: packet paths land in the worktree regardless of packetTaskPath
		expect(unit.packet.statusPath).toContain("STATUS.md");
		expect(unit.packet.donePath).toContain(".DONE");
		expect(unit.worktreePath).toBe("/wt");
		expect(unit.segmentId).toBeNull();
		expect(unit.id).toBe("T-1");
	});

	test("uses absolute packetTaskPath when packet home differs from execution repo", () => {
		const lane = makeLane({ worktreePath: "/wt", repoId: "api" } as Partial<AllocatedLane>);
		const task = makeAllocatedTask(
			{},
			{
				taskFolder: "/repo/tasks/T-1",
				packetRepoId: "frontend",
				packetTaskPath: "/other/repo/tasks/T-9",
			},
		);
		const unit = buildExecutionUnit(lane, task, "/repo");
		expect(unit.packetHomeRepoId).toBe("frontend");
		expect(unit.packet.statusPath).toContain("/other/repo/tasks/T-9");
	});

	test("uses segmentId as id when present", () => {
		const lane = makeLane();
		const task = makeAllocatedTask({}, { taskFolder: "/repo/tasks/T-1", activeSegmentId: "T-1::seg-a" });
		expect(buildExecutionUnit(lane, task, "/repo").id).toBe("T-1::seg-a");
	});

	test("throws EXEC_MISSING_TASK_FOLDER when taskFolder is empty", () => {
		const lane = makeLane();
		const task = makeAllocatedTask({}, { taskFolder: "" });
		expect(() => buildExecutionUnit(lane, task, "/repo")).toThrow(ExecutionError);
	});
});

describe("buildAgentIdFromLane", () => {
	test("worker role suffixes the lane session id", () => {
		const lane = makeLane({ laneSessionId: "mission-henry-lane-1" });
		expect(buildAgentIdFromLane(lane, "worker")).toBe("mission-henry-lane-1-worker");
	});

	test("lane-runner role returns bare lane session id", () => {
		const lane = makeLane({ laneSessionId: "mission-henry-lane-2" });
		expect(buildAgentIdFromLane(lane, "lane-runner")).toBe("mission-henry-lane-2");
	});

	test("merger role strips lane suffix and appends merge index", () => {
		const lane = makeLane({ laneSessionId: "mission-henry-lane-3" });
		expect(buildAgentIdFromLane(lane, "merger", 2)).toBe("mission-henry-merge-2");
	});
});

describe("resolveRuntimeStateRoot", () => {
	test("prefers workspace root when provided", () => {
		expect(resolveRuntimeStateRoot("/repo", "/workspace")).toBe("/workspace");
	});

	test("falls back to repo root", () => {
		expect(resolveRuntimeStateRoot("/repo")).toBe("/repo");
	});
});

describe("buildReviewerEnv", () => {
	test("emits only defined keys with MISSION_ prefix", () => {
		expect(buildReviewerEnv({ model: "claude-opus-4-7", thinking: "high" })).toEqual({
			MISSION_REVIEWER_MODEL: "claude-opus-4-7",
			MISSION_REVIEWER_THINKING: "high",
		});
	});

	test("returns empty object for null/undefined/empty config", () => {
		expect(buildReviewerEnv()).toEqual({});
		expect(buildReviewerEnv(null)).toEqual({});
		expect(buildReviewerEnv({})).toEqual({});
	});
});
