/**
 * Tests for `missioncontrol/abort.ts`.
 *
 * Covers pure selection + planning helpers, wrap-up file I/O against a
 * temp dir, kill-session dedup, and the end-to-end `executeAbort` flow
 * against stubbed killers + persistence.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	discoverAbortSessionNames,
	executeAbort,
	killOrchSessions,
	planAbortActions,
	selectAbortTargetSessions,
	waitForSessionExit,
	writeWrapUpFiles,
} from "../src/missioncontrol/abort";
import type { ParsedTask } from "../src/missioncontrol/discovery";
import type {
	AbortTargetSession,
	AllocatedLane,
	MissionBatchRuntimeState,
	PersistedBatchState,
	PersistedLaneRecord,
	PersistedTaskRecord,
} from "../src/missioncontrol/types";
import { freshMissionBatchState } from "../src/missioncontrol/types";

// ── Fixtures ─────────────────────────────────────────────────────────

function mkTempRoot(): string {
	const dir = join(tmpdir(), `mc-abort-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function mkParsedTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
	return {
		taskId: "t-1",
		taskName: "t-1-example",
		folderPath: "/repo/tasks/t-1",
		promptPath: "/repo/tasks/t-1/PROMPT.md",
		prompt: "",
		dependencies: [],
		size: "M",
		taskFolder: "/repo/tasks/t-1",
		...overrides,
	};
}

function mkAllocatedLane(overrides: Partial<AllocatedLane> = {}): AllocatedLane {
	const task = mkParsedTask();
	return {
		laneNumber: 1,
		laneId: "lane-1",
		laneSessionId: "mission-lane-1",
		worktreePath: "/tmp/wt/lane-1",
		branch: "mission/lane-1",
		strategy: "round-robin",
		estimatedLoad: 0,
		estimatedMinutes: 60,
		tasks: [
			{
				taskId: task.taskId,
				order: 0,
				task,
				estimatedMinutes: 60,
			},
		],
		...overrides,
	};
}

function mkLaneRecord(overrides: Partial<PersistedLaneRecord> = {}): PersistedLaneRecord {
	return {
		laneNumber: 1,
		laneId: "lane-1",
		laneSessionId: "mission-lane-1",
		worktreePath: "/tmp/wt/lane-1",
		branch: "mission/lane-1",
		taskIds: ["t-1"],
		...overrides,
	};
}

function mkTaskRecord(overrides: Partial<PersistedTaskRecord> = {}): PersistedTaskRecord {
	return {
		taskId: "t-1",
		laneNumber: 1,
		sessionName: "mission-lane-1",
		status: "running",
		taskFolder: "/repo/tasks/t-1",
		startedAt: null,
		endedAt: null,
		doneFileFound: false,
		exitReason: "",
		...overrides,
	};
}

function mkPersistedBatch(overrides: Partial<PersistedBatchState> = {}): PersistedBatchState {
	return {
		batchId: "b-test",
		phase: "paused",
		lanes: [mkLaneRecord()],
		tasks: [mkTaskRecord()],
		wavePlan: [],
		...overrides,
	};
}

function mkRuntimeBatch(overrides: Partial<MissionBatchRuntimeState> = {}): MissionBatchRuntimeState {
	return {
		...freshMissionBatchState(),
		batchId: "b-test",
		currentLanes: [mkAllocatedLane()],
		...overrides,
	};
}

// ── planAbortActions ─────────────────────────────────────────────────

describe("planAbortActions", () => {
	test("hard mode returns single kill-all step", () => {
		const actions = planAbortActions("hard");
		expect(actions).toEqual([{ type: "kill-all" }]);
	});

	test("graceful mode returns wrap-up, poll-wait, kill-remaining", () => {
		const actions = planAbortActions("graceful", 5_000, 500);
		expect(actions).toEqual([
			{ type: "write-wrapup" },
			{ type: "poll-wait", gracePeriodMs: 5_000, pollIntervalMs: 500 },
			{ type: "kill-remaining" },
		]);
	});

	test("graceful mode defaults to 60s grace / 2s poll", () => {
		const actions = planAbortActions("graceful");
		expect(actions[1]).toEqual({ type: "poll-wait", gracePeriodMs: 60_000, pollIntervalMs: 2_000 });
	});
});

// ── discoverAbortSessionNames ────────────────────────────────────────

describe("discoverAbortSessionNames", () => {
	test("returns empty list when no sources populated", () => {
		const names = discoverAbortSessionNames("mission", null, []);
		expect(names).toEqual([]);
	});

	test("dedupes across runtime + persisted sources", () => {
		const runtime = [mkAllocatedLane({ laneSessionId: "mission-lane-1" })];
		const persisted = mkPersistedBatch({
			lanes: [mkLaneRecord({ laneSessionId: "mission-lane-1" })],
			tasks: [mkTaskRecord({ sessionName: "mission-lane-1" })],
		});
		const names = discoverAbortSessionNames("mission", persisted, runtime);
		expect(names).toEqual(["mission-lane-1"]);
	});

	test("filters out sessions that do not start with prefix", () => {
		const persisted = mkPersistedBatch({
			tasks: [mkTaskRecord({ sessionName: "orch-lane-1" })],
			lanes: [mkLaneRecord({ laneSessionId: "mission-lane-2" })],
		});
		const names = discoverAbortSessionNames("mission", persisted, []);
		expect(names).toEqual(["mission-lane-2"]);
	});

	test("trims whitespace before inserting", () => {
		const runtime = [mkAllocatedLane({ laneSessionId: "  mission-lane-3  " })];
		const names = discoverAbortSessionNames("mission", null, runtime);
		expect(names).toEqual(["mission-lane-3"]);
	});

	test("ignores null / empty session names", () => {
		const persisted = mkPersistedBatch({
			tasks: [mkTaskRecord({ sessionName: "" })],
			lanes: [mkLaneRecord({ laneSessionId: "mission-lane-1" })],
		});
		const names = discoverAbortSessionNames("mission", persisted, []);
		expect(names).toEqual(["mission-lane-1"]);
	});
});

// ── selectAbortTargetSessions ────────────────────────────────────────

describe("selectAbortTargetSessions", () => {
	test("filters to prefix-lane and prefix-merge names", () => {
		const input = [
			"mission-lane-1",
			"mission-merge-1",
			"mission-other",
			"random-lane-99",
			"mission-repo-a-lane-2",
			"mission-repo-b-merge-1",
		];
		const targets = selectAbortTargetSessions(input, null, [], "/repo", "mission");
		expect(targets.map(t => t.sessionName)).toEqual([
			"mission-lane-1",
			"mission-merge-1",
			"mission-repo-a-lane-2",
			"mission-repo-b-merge-1",
		]);
	});

	test("enriches from runtime lane when available", () => {
		const lane = mkAllocatedLane({
			laneSessionId: "mission-lane-1",
			worktreePath: "/tmp/wt/lane-1",
		});
		const [target] = selectAbortTargetSessions(["mission-lane-1"], null, [lane], "/repo", "mission");
		expect(target?.laneId).toBe("lane-1");
		expect(target?.taskId).toBe("t-1");
		expect(target?.worktreePath).toBe("/tmp/wt/lane-1");
	});

	test("prefers runtime data over persisted for overlapping sessions", () => {
		const runtime = [mkAllocatedLane({ laneId: "runtime-lane-1", laneSessionId: "mission-lane-1" })];
		const persisted = mkPersistedBatch({
			lanes: [mkLaneRecord({ laneId: "persisted-lane-1", laneSessionId: "mission-lane-1" })],
		});
		const [target] = selectAbortTargetSessions(["mission-lane-1"], persisted, runtime, "/repo", "mission");
		expect(target?.laneId).toBe("runtime-lane-1");
	});

	test("uses persisted laneId when runtime does not cover session", () => {
		const persisted = mkPersistedBatch({
			lanes: [mkLaneRecord({ laneId: "persisted-lane-1", laneSessionId: "mission-lane-1" })],
		});
		const [target] = selectAbortTargetSessions(["mission-lane-1"], persisted, [], "/repo", "mission");
		expect(target?.laneId).toBe("persisted-lane-1");
	});

	test("returns 'unknown' laneId when neither source has session", () => {
		const [target] = selectAbortTargetSessions(["mission-lane-42"], null, [], "/repo", "mission");
		expect(target?.laneId).toBe("unknown");
		expect(target?.taskId).toBeNull();
	});

	test("resolves taskFolderInWorktree when task folder under repoRoot", () => {
		const repoRoot = "/repo";
		const lane = mkAllocatedLane({
			laneSessionId: "mission-lane-1",
			worktreePath: "/tmp/wt/lane-1",
			tasks: [
				{
					taskId: "t-1",
					order: 0,
					task: mkParsedTask({ taskFolder: "/repo/tasks/t-1" }),
					estimatedMinutes: 60,
				},
			],
		});
		const [target] = selectAbortTargetSessions(["mission-lane-1"], null, [lane], repoRoot, "mission");
		expect(target?.taskFolderInWorktree?.replace(/\\/g, "/")).toBe("/tmp/wt/lane-1/tasks/t-1");
	});
});

// ── writeWrapUpFiles ─────────────────────────────────────────────────

describe("writeWrapUpFiles", () => {
	test("writes .task-wrap-up to resolved folder", async () => {
		const root = mkTempRoot();
		try {
			const folder = join(root, "tasks", "t-1");
			mkdirSync(folder, { recursive: true });
			const targets: AbortTargetSession[] = [
				{
					sessionName: "mission-lane-1",
					laneId: "lane-1",
					taskId: "t-1",
					taskFolderInWorktree: folder,
					worktreePath: root,
				},
			];

			const results = await writeWrapUpFiles(targets);
			expect(results).toEqual([{ sessionName: "mission-lane-1", written: true, error: null }]);

			const wrap = Bun.file(join(folder, ".task-wrap-up"));
			expect(await wrap.exists()).toBe(true);
			expect(await wrap.text()).toMatch(/^Abort requested at /);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("skips worker/reviewer child sessions silently", async () => {
		const targets: AbortTargetSession[] = [
			{
				sessionName: "mission-lane-1-worker",
				laneId: "lane-1",
				taskId: "t-1",
				taskFolderInWorktree: null,
				worktreePath: null,
			},
			{
				sessionName: "mission-lane-1-reviewer",
				laneId: "lane-1",
				taskId: "t-1",
				taskFolderInWorktree: null,
				worktreePath: null,
			},
			{
				sessionName: "mission-merge-1",
				laneId: "merge-1",
				taskId: null,
				taskFolderInWorktree: null,
				worktreePath: null,
			},
		];
		const results = await writeWrapUpFiles(targets);
		expect(results.every(r => r.error === null && r.written === false)).toBe(true);
	});

	test("reports error for missing task folder on lane session", async () => {
		const targets: AbortTargetSession[] = [
			{
				sessionName: "mission-lane-1",
				laneId: "lane-1",
				taskId: "t-1",
				taskFolderInWorktree: null,
				worktreePath: "/tmp/wt/lane-1",
			},
		];
		const [result] = await writeWrapUpFiles(targets);
		expect(result?.written).toBe(false);
		expect(result?.error).toBe("No task folder resolved");
	});

	test("reports error when folder path does not exist on disk", async () => {
		const root = mkTempRoot();
		try {
			const missing = join(root, "does-not-exist");
			const targets: AbortTargetSession[] = [
				{
					sessionName: "mission-lane-1",
					laneId: "lane-1",
					taskId: "t-1",
					taskFolderInWorktree: missing,
					worktreePath: root,
				},
			];
			const [result] = await writeWrapUpFiles(targets);
			expect(result?.written).toBe(false);
			expect(result?.error).toContain("does not exist");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// ── killOrchSessions ─────────────────────────────────────────────────

describe("killOrchSessions", () => {
	test("returns killed=true for every input session", () => {
		const results = killOrchSessions(["mission-lane-1", "mission-merge-1"]);
		expect(results).toEqual([
			{ sessionName: "mission-lane-1", killed: true, error: null },
			{ sessionName: "mission-merge-1", killed: true, error: null },
		]);
	});

	test("dedupes base-session kills across worker / reviewer suffixes", () => {
		// Two child suffixes for the same base session should not blow up;
		// each entry in the output still reports the input session name.
		const results = killOrchSessions(["mission-lane-1-worker", "mission-lane-1-reviewer", "mission-lane-1"]);
		expect(results.map(r => r.sessionName)).toEqual([
			"mission-lane-1-worker",
			"mission-lane-1-reviewer",
			"mission-lane-1",
		]);
		expect(results.every(r => r.killed)).toBe(true);
	});
});

// ── waitForSessionExit ───────────────────────────────────────────────

describe("waitForSessionExit", () => {
	test("returns immediately for empty session list", async () => {
		const result = await waitForSessionExit([], 1_000, 100);
		expect(result).toEqual({ exited: [], remaining: [] });
	});

	test("returns immediately for zero grace period", async () => {
		const result = await waitForSessionExit(["mission-lane-1"], 0, 100);
		expect(result).toEqual({ exited: [], remaining: ["mission-lane-1"] });
	});

	test("waits the full grace window and reports remaining", async () => {
		const start = Date.now();
		const result = await waitForSessionExit(["mission-lane-1"], 40, 10);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(35);
		expect(result.exited).toEqual([]);
		expect(result.remaining).toEqual(["mission-lane-1"]);
	});
});

// ── executeAbort (end-to-end) ────────────────────────────────────────

describe("executeAbort", () => {
	test("hard mode: sets phase stopped, kills targets, returns result", async () => {
		const batch = mkRuntimeBatch({
			currentLanes: [mkAllocatedLane({ laneSessionId: "mission-lane-1", worktreePath: "/tmp/wt/lane-1" })],
		});
		const persisted = mkPersistedBatch();
		const result = await executeAbort("hard", "mission", "/repo", batch, persisted, 0, 10);

		expect(batch.phase).toBe("stopped");
		expect(batch.endedAt).not.toBeNull();
		expect(result.mode).toBe("hard");
		expect(result.sessionsFound).toBeGreaterThanOrEqual(1);
		expect(result.sessionsKilled).toBe(result.sessionsFound);
		expect(result.stateDeleted).toBe(true);
		expect(result.wrapUpFailures).toBe(0);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("graceful mode: writes wrap-up (or records error), then kills remaining", async () => {
		const batch = mkRuntimeBatch({
			currentLanes: [
				mkAllocatedLane({
					laneSessionId: "mission-lane-1",
					worktreePath: "/tmp/nonexistent-wt/lane-1",
				}),
			],
		});
		const result = await executeAbort("graceful", "mission", "/repo", batch, mkPersistedBatch(), 10, 5);

		expect(result.mode).toBe("graceful");
		expect(result.laneResults.length).toBeGreaterThanOrEqual(1);
		// Wrap-up fails (no such folder); the mode-specific error is recorded.
		expect(result.wrapUpFailures).toBeGreaterThanOrEqual(1);
		expect(result.errors.some(e => e.code === "ABORT_WRAPUP_WRITE_FAILED")).toBe(true);
		expect(result.stateDeleted).toBe(true);
	});

	test("returns empty lane results when no targets discovered", async () => {
		const batch = mkRuntimeBatch({ currentLanes: [] });
		const persisted = mkPersistedBatch({ lanes: [], tasks: [] });
		const result = await executeAbort("hard", "mission", "/repo", batch, persisted, 0, 10);
		expect(result.sessionsFound).toBe(0);
		expect(result.laneResults).toEqual([]);
		expect(result.stateDeleted).toBe(true);
	});
});
