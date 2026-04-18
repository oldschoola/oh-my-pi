/**
 * Tests for `missioncontrol/resume.ts` pure helpers.
 *
 * Covers repo-root collection, lane reconstruction, done-marker scanning,
 * eligibility matrix, segment-frontier reconstruction, task reconciliation,
 * merge-status lookups, wave-plan expansion, resume-point categorization,
 * and filesystem-backed pre-resume diagnostics.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ParsedTask } from "../src/missioncontrol/discovery";
import {
	buildResumeRuntimeWavePlan,
	checkResumeEligibility,
	collectAllRepoRoots,
	collectDoneTaskIdsForResume,
	collectRepoRoots,
	computeResumePoint,
	getMergeStatusForWave,
	reconcileTaskStates,
	reconstructAllocatedLanes,
	reconstructSegmentFrontier,
	resolveRepoIdFromRoot,
	runPreResumeDiagnostics,
} from "../src/missioncontrol/resume";
import type {
	PersistedBatchState,
	PersistedLaneRecord,
	PersistedSegmentRecord,
	PersistedTaskRecord,
	ReconciledTaskState,
	WorkspaceConfig,
	WorkspaceRepoConfig,
} from "../src/missioncontrol/types";

// ── Fixtures ─────────────────────────────────────────────────────────

function mkTmp(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function mkLane(overrides: Partial<PersistedLaneRecord> = {}): PersistedLaneRecord {
	return {
		laneNumber: 1,
		laneId: "lane-1",
		laneSessionId: "mission-lane-1",
		worktreePath: "",
		branch: "mission/lane-1",
		taskIds: ["t-1"],
		...overrides,
	};
}

function mkTask(overrides: Partial<PersistedTaskRecord> = {}): PersistedTaskRecord {
	return {
		taskId: "t-1",
		laneNumber: 1,
		sessionName: "mission-lane-1",
		status: "pending",
		taskFolder: "",
		startedAt: null,
		endedAt: null,
		doneFileFound: false,
		exitReason: "",
		...overrides,
	};
}

function mkSegment(overrides: Partial<PersistedSegmentRecord> = {}): PersistedSegmentRecord {
	return {
		segmentId: "t-1::api",
		taskId: "t-1",
		repoId: "api",
		status: "pending",
		laneId: "lane-1",
		sessionName: "mission-lane-1",
		worktreePath: "",
		branch: "mission/lane-1",
		startedAt: null,
		endedAt: null,
		retries: 0,
		dependsOnSegmentIds: [],
		exitReason: "",
		...overrides,
	};
}

function mkBatch(overrides: Partial<PersistedBatchState> = {}): PersistedBatchState {
	return {
		batchId: "b-1",
		phase: "paused",
		lanes: [mkLane()],
		tasks: [mkTask()],
		wavePlan: [["t-1"]],
		...overrides,
	};
}

function mkWorkspace(entries: Array<[string, string]>): WorkspaceConfig {
	const repos = new Map<string, WorkspaceRepoConfig>();
	for (const [id, path] of entries) {
		repos.set(id, { id, path });
	}
	const firstId = entries[0]?.[0] ?? "";
	return {
		mode: "workspace",
		repos,
		routing: { tasksRoot: "tasks", defaultRepo: firstId, taskPacketRepo: firstId },
		configPath: "",
	};
}

// ── collectRepoRoots ─────────────────────────────────────────────────

describe("collectRepoRoots", () => {
	test("repo mode returns just default root", () => {
		const batch = mkBatch({ lanes: [mkLane({ repoId: undefined })] });
		expect(collectRepoRoots(batch, "/repo")).toEqual(["/repo"]);
	});

	test("workspace mode dedupes by repoId", () => {
		const ws = mkWorkspace([
			["api", "/ws/api"],
			["web", "/ws/web"],
		]);
		const batch = mkBatch({
			lanes: [
				mkLane({ laneNumber: 1, repoId: "api" }),
				mkLane({ laneNumber: 2, repoId: "api" }),
				mkLane({ laneNumber: 3, repoId: "web" }),
			],
			tasks: [],
		});
		const roots = collectRepoRoots(batch, "/ws", ws).sort();
		expect(roots).toEqual(["/ws", "/ws/api", "/ws/web"]);
	});

	test("always includes default root even when all lanes have repoId", () => {
		const ws = mkWorkspace([["api", "/ws/api"]]);
		const batch = mkBatch({ lanes: [mkLane({ repoId: "api" })], tasks: [] });
		expect(collectRepoRoots(batch, "/ws/default", ws).sort()).toEqual(["/ws/api", "/ws/default"]);
	});
});

// ── resolveRepoIdFromRoot ────────────────────────────────────────────

describe("resolveRepoIdFromRoot", () => {
	test("returns undefined without workspace config", () => {
		expect(resolveRepoIdFromRoot("/any")).toBeUndefined();
	});

	test("reverse-looks up matching repoId", () => {
		const ws = mkWorkspace([
			["api", "/ws/api"],
			["web", "/ws/web"],
		]);
		expect(resolveRepoIdFromRoot("/ws/web", ws)).toBe("web");
		expect(resolveRepoIdFromRoot("/ws/unknown", ws)).toBeUndefined();
	});
});

// ── reconstructAllocatedLanes ────────────────────────────────────────

describe("reconstructAllocatedLanes", () => {
	test("rebuilds lane metadata with null stub when no persisted tasks given", () => {
		const lanes = reconstructAllocatedLanes([mkLane()]);
		expect(lanes).toHaveLength(1);
		expect(lanes[0].laneId).toBe("lane-1");
		expect(lanes[0].worktreePath).toBe("");
		expect(lanes[0].tasks).toHaveLength(1);
		expect(lanes[0].tasks[0].taskId).toBe("t-1");
	});

	test("preserves repoId when set", () => {
		const lanes = reconstructAllocatedLanes([mkLane({ repoId: "api" })]);
		expect(lanes[0].repoId).toBe("api");
	});

	test("omits repoId when undefined (exact-property preservation)", () => {
		const lanes = reconstructAllocatedLanes([mkLane({ repoId: undefined })]);
		expect("repoId" in lanes[0]).toBe(false);
	});

	test("carries forward repoId/resolvedRepoId/taskFolder onto stub task", () => {
		const lane = mkLane({ taskIds: ["t-1"] });
		const task = mkTask({
			taskId: "t-1",
			taskFolder: "/repo/tasks/t-1",
			repoId: "api",
			resolvedRepoId: "api",
			segmentIds: ["t-1::api", "t-1::web"],
			activeSegmentId: "t-1::api",
			packetRepoId: "web",
			packetTaskPath: "/repo/packet/t-1",
		});
		const lanes = reconstructAllocatedLanes([lane], [task]);
		const stub = lanes[0].tasks[0].task as unknown as Partial<ParsedTask>;
		expect(stub.taskFolder).toBe("/repo/tasks/t-1");
		expect(stub.promptRepoId).toBe("api");
		expect(stub.resolvedRepoId).toBe("api");
		expect(stub.segmentIds).toEqual(["t-1::api", "t-1::web"]);
		expect(stub.activeSegmentId).toBe("t-1::api");
		expect(stub.packetRepoId).toBe("web");
		expect(stub.packetTaskPath).toBe("/repo/packet/t-1");
	});

	test("always emits taskFolder (empty string) even when persisted value is empty", () => {
		const lanes = reconstructAllocatedLanes([mkLane()], [mkTask({ taskFolder: "" })]);
		const stub = lanes[0].tasks[0].task as unknown as Partial<ParsedTask>;
		expect(stub.taskFolder).toBe("");
	});
});

// ── collectAllRepoRoots ──────────────────────────────────────────────

describe("collectAllRepoRoots", () => {
	test("dedupes across multiple lane sources", () => {
		const ws = mkWorkspace([
			["api", "/ws/api"],
			["web", "/ws/web"],
		]);
		const roots = collectAllRepoRoots(
			[[{ repoId: "api" }], [{ repoId: "web" }, { repoId: "api" }], [{ repoId: undefined }]],
			"/ws",
			ws,
		).sort();
		expect(roots).toEqual(["/ws", "/ws/api", "/ws/web"]);
	});

	test("returns just default root when all sources empty", () => {
		expect(collectAllRepoRoots([], "/repo")).toEqual(["/repo"]);
	});
});

// ── collectDoneTaskIdsForResume ──────────────────────────────────────

describe("collectDoneTaskIdsForResume", () => {
	test("finds .DONE in archive when original folder does not have one", () => {
		const dir = mkTmp("mc-resume-done");
		try {
			const archiveFolder = join(dir, "tasks", "archive", "t-1");
			mkdirSync(archiveFolder, { recursive: true });
			writeFileSync(join(archiveFolder, ".DONE"), "");

			const batch = mkBatch({
				tasks: [mkTask({ taskId: "t-1", taskFolder: join(dir, "tasks", "t-1") })],
			});
			const done = collectDoneTaskIdsForResume(batch, dir);
			expect(done.has("t-1")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns empty set when no markers anywhere", () => {
		const dir = mkTmp("mc-resume-done-empty");
		try {
			const batch = mkBatch({ tasks: [mkTask({ taskFolder: join(dir, "tasks", "t-1") })] });
			expect(collectDoneTaskIdsForResume(batch, dir).size).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ── checkResumeEligibility ───────────────────────────────────────────

describe("checkResumeEligibility", () => {
	const eligiblePhases = ["paused", "executing", "merging"] as const;
	const forceOnlyPhases = ["stopped", "failed"] as const;
	const neverEligiblePhases = ["completed", "idle", "launching", "planning"] as const;

	for (const phase of eligiblePhases) {
		test(`phase=${phase} is always eligible`, () => {
			expect(checkResumeEligibility(mkBatch({ phase }), false).eligible).toBe(true);
			expect(checkResumeEligibility(mkBatch({ phase }), true).eligible).toBe(true);
		});
	}

	for (const phase of forceOnlyPhases) {
		test(`phase=${phase} requires --force`, () => {
			expect(checkResumeEligibility(mkBatch({ phase }), false).eligible).toBe(false);
			expect(checkResumeEligibility(mkBatch({ phase }), true).eligible).toBe(true);
		});
	}

	for (const phase of neverEligiblePhases) {
		test(`phase=${phase} is never eligible`, () => {
			expect(checkResumeEligibility(mkBatch({ phase }), false).eligible).toBe(false);
			expect(checkResumeEligibility(mkBatch({ phase }), true).eligible).toBe(false);
		});
	}

	test("unknown phase returns ineligible with helpful reason", () => {
		const result = checkResumeEligibility(mkBatch({ phase: "bogus" as never }), false);
		expect(result.eligible).toBe(false);
		expect(result.reason).toContain('unknown phase "bogus"');
	});
});

// ── reconstructSegmentFrontier ───────────────────────────────────────

describe("reconstructSegmentFrontier", () => {
	test("no-op when task has no segments", () => {
		const batch = mkBatch({ tasks: [mkTask({ segmentIds: undefined })] });
		expect(reconstructSegmentFrontier(batch).size).toBe(0);
		expect(batch.tasks[0].status).toBe("pending");
	});

	test("marks task succeeded when all segments succeeded", () => {
		const batch = mkBatch({
			tasks: [mkTask({ segmentIds: ["seg-a", "seg-b"], activeSegmentId: "seg-b", status: "running" })],
			segments: [
				mkSegment({ segmentId: "seg-a", status: "succeeded" }),
				mkSegment({ segmentId: "seg-b", status: "succeeded", dependsOnSegmentIds: ["seg-a"] }),
			],
		});
		reconstructSegmentFrontier(batch);
		expect(batch.tasks[0].status).toBe("succeeded");
		expect(batch.tasks[0].activeSegmentId).toBeNull();
	});

	test("marks task running when a segment is running", () => {
		const batch = mkBatch({
			tasks: [mkTask({ segmentIds: ["seg-a", "seg-b"], status: "pending" })],
			segments: [
				mkSegment({ segmentId: "seg-a", status: "running" }),
				mkSegment({ segmentId: "seg-b", status: "pending", dependsOnSegmentIds: ["seg-a"] }),
			],
		});
		reconstructSegmentFrontier(batch);
		expect(batch.tasks[0].status).toBe("running");
		expect(batch.tasks[0].activeSegmentId).toBe("seg-a");
	});

	test("marks task failed when any segment failed", () => {
		const batch = mkBatch({
			tasks: [mkTask({ segmentIds: ["seg-a", "seg-b"], status: "running" })],
			segments: [
				mkSegment({ segmentId: "seg-a", status: "succeeded" }),
				mkSegment({ segmentId: "seg-b", status: "failed", dependsOnSegmentIds: ["seg-a"] }),
			],
		});
		reconstructSegmentFrontier(batch);
		expect(batch.tasks[0].status).toBe("failed");
	});

	test("preserves skipped status when segments are failed", () => {
		const batch = mkBatch({
			tasks: [mkTask({ segmentIds: ["seg-a"], status: "skipped" })],
			segments: [mkSegment({ segmentId: "seg-a", status: "failed" })],
		});
		reconstructSegmentFrontier(batch);
		expect(batch.tasks[0].status).toBe("skipped");
	});

	test("pending with ready-dep selection picks unblocked segment", () => {
		const batch = mkBatch({
			tasks: [mkTask({ segmentIds: ["seg-a", "seg-b", "seg-c"], status: "pending" })],
			segments: [
				mkSegment({ segmentId: "seg-a", status: "succeeded" }),
				mkSegment({ segmentId: "seg-b", status: "pending", dependsOnSegmentIds: ["seg-a"] }),
				mkSegment({ segmentId: "seg-c", status: "pending", dependsOnSegmentIds: ["seg-b"] }),
			],
		});
		const frontier = reconstructSegmentFrontier(batch);
		expect(batch.tasks[0].activeSegmentId).toBe("seg-b");
		expect(frontier.get("t-1")?.nextSegmentId).toBe("seg-b");
	});
});

// ── reconcileTaskStates ──────────────────────────────────────────────

describe("reconcileTaskStates", () => {
	const empty = new Set<string>();

	test(".DONE beats alive session → mark-complete", () => {
		const batch = mkBatch({ tasks: [mkTask({ status: "running" })] });
		const result = reconcileTaskStates(batch, new Set(["mission-lane-1"]), new Set(["t-1"]));
		expect(result[0].action).toBe("mark-complete");
		expect(result[0].liveStatus).toBe("succeeded");
	});

	test("alive session + no .DONE → reconnect", () => {
		const batch = mkBatch({ tasks: [mkTask({ status: "running" })] });
		const result = reconcileTaskStates(batch, new Set(["mission-lane-1"]), empty);
		expect(result[0].action).toBe("reconnect");
	});

	test("terminal persisted status → skip", () => {
		const batch = mkBatch({ tasks: [mkTask({ status: "succeeded" })] });
		const result = reconcileTaskStates(batch, empty, empty);
		expect(result[0].action).toBe("skip");
	});

	test("dead session + worktree exists → re-execute", () => {
		const batch = mkBatch({ tasks: [mkTask({ status: "running" })] });
		const result = reconcileTaskStates(batch, empty, empty, new Set(["t-1"]));
		expect(result[0].action).toBe("re-execute");
	});

	test("never-started pending task (no session) → pending", () => {
		const batch = mkBatch({
			tasks: [mkTask({ status: "pending", sessionName: "" })],
		});
		const result = reconcileTaskStates(batch, empty, empty);
		expect(result[0].action).toBe("pending");
	});

	test("pending with dead session + no worktree → pending (TP-037 bug #102b)", () => {
		const batch = mkBatch({ tasks: [mkTask({ status: "pending" })] });
		const result = reconcileTaskStates(batch, empty, empty);
		expect(result[0].action).toBe("pending");
	});

	test("running + dead session + no .DONE + no worktree → mark-failed", () => {
		const batch = mkBatch({ tasks: [mkTask({ status: "running" })] });
		const result = reconcileTaskStates(batch, empty, empty);
		expect(result[0].action).toBe("mark-failed");
	});
});

// ── getMergeStatusForWave ────────────────────────────────────────────

describe("getMergeStatusForWave", () => {
	test("reverse scan — latest entry wins for same wave index", () => {
		const merges = [
			{ waveIndex: 0, status: "failed" as const },
			{ waveIndex: 0, status: "succeeded" as const },
			{ waveIndex: 1, status: "failed" as const },
		];
		expect(getMergeStatusForWave(merges, 0)).toBe("succeeded");
		expect(getMergeStatusForWave(merges, 1)).toBe("failed");
	});

	test("returns null when wave has no merge entry", () => {
		expect(getMergeStatusForWave([{ waveIndex: 0, status: "succeeded" }], 7)).toBeNull();
	});

	test("empty results → null", () => {
		expect(getMergeStatusForWave([], 0)).toBeNull();
	});
});

// ── buildResumeRuntimeWavePlan ───────────────────────────────────────

describe("buildResumeRuntimeWavePlan", () => {
	test("returns base plan when no segments defined", () => {
		const batch = mkBatch({ wavePlan: [["t-1", "t-2"], ["t-3"]], tasks: [] });
		expect(buildResumeRuntimeWavePlan(batch)).toEqual([["t-1", "t-2"], ["t-3"]]);
	});

	test("inserts continuation rounds after last-occurrence wave for each task", () => {
		const batch = mkBatch({
			wavePlan: [["t-1", "t-2"]],
			tasks: [
				mkTask({ taskId: "t-1", segmentIds: ["t-1::a", "t-1::b", "t-1::c"] }),
				mkTask({ taskId: "t-2", segmentIds: ["t-2::a", "t-2::b"] }),
			],
		});
		const plan = buildResumeRuntimeWavePlan(batch);
		// Wave 0 scheduled both tasks once; t-1 needs 2 more, t-2 needs 1 more.
		// Continuation rounds are concurrent where possible.
		expect(plan[0]).toEqual(["t-1", "t-2"]);
		expect(plan[1]).toEqual(["t-1", "t-2"]); // round 2 — both still have segments
		expect(plan[2]).toEqual(["t-1"]); // round 3 — only t-1 remains
		expect(plan.length).toBe(3);
	});

	test("appends dangling segments (task not in wave plan at all)", () => {
		const batch = mkBatch({
			wavePlan: [["t-1"]],
			tasks: [mkTask({ taskId: "t-1" }), mkTask({ taskId: "t-2", segmentIds: ["t-2::a", "t-2::b"] })],
		});
		const plan = buildResumeRuntimeWavePlan(batch);
		expect(plan).toEqual([["t-1"], ["t-2"], ["t-2"]]);
	});
});

// ── computeResumePoint ───────────────────────────────────────────────

describe("computeResumePoint", () => {
	function reconciled(overrides: Partial<ReconciledTaskState>): ReconciledTaskState {
		return {
			taskId: "t-1",
			persistedStatus: "pending",
			liveStatus: "pending",
			sessionAlive: false,
			doneFileFound: false,
			worktreeExists: false,
			action: "pending",
			...overrides,
		};
	}

	test("all waves terminal + merges succeeded → resumeWaveIndex past end, no retries", () => {
		const batch = mkBatch({
			wavePlan: [["t-1"], ["t-2"]],
			tasks: [mkTask({ taskId: "t-1", status: "succeeded" }), mkTask({ taskId: "t-2", status: "succeeded" })],
			mergeResults: [
				{ waveIndex: 0, status: "succeeded", failedLane: null, failureReason: null },
				{ waveIndex: 1, status: "succeeded", failedLane: null, failureReason: null },
			],
		});
		const point = computeResumePoint(batch, [
			reconciled({ taskId: "t-1", action: "skip", liveStatus: "succeeded", persistedStatus: "succeeded" }),
			reconciled({ taskId: "t-2", action: "skip", liveStatus: "succeeded", persistedStatus: "succeeded" }),
		]);
		expect(point.resumeWaveIndex).toBe(2);
		expect(point.completedTaskIds).toEqual(["t-1", "t-2"]);
		expect(point.mergeRetryWaveIndexes).toEqual([]);
		expect(point.pendingTaskIds).toEqual([]);
	});

	test("TP-037: succeeded wave with failed merge flags merge-retry and sets resumeWaveIndex", () => {
		const batch = mkBatch({
			wavePlan: [["t-1"], ["t-2"]],
			tasks: [mkTask({ taskId: "t-1", status: "succeeded" }), mkTask({ taskId: "t-2", status: "succeeded" })],
			mergeResults: [
				{ waveIndex: 0, status: "failed", failedLane: 1, failureReason: "conflict" },
				{ waveIndex: 1, status: "succeeded", failedLane: null, failureReason: null },
			],
		});
		const point = computeResumePoint(batch, [
			reconciled({ taskId: "t-1", action: "mark-complete", liveStatus: "succeeded", persistedStatus: "succeeded" }),
			reconciled({ taskId: "t-2", action: "mark-complete", liveStatus: "succeeded", persistedStatus: "succeeded" }),
		]);
		expect(point.resumeWaveIndex).toBe(0);
		expect(point.mergeRetryWaveIndexes).toEqual([0]);
	});

	test("stops at first incomplete wave", () => {
		const batch = mkBatch({
			wavePlan: [["t-1"], ["t-2"]],
			tasks: [mkTask({ taskId: "t-1", status: "succeeded" }), mkTask({ taskId: "t-2", status: "pending" })],
		});
		const point = computeResumePoint(batch, [
			reconciled({ taskId: "t-1", action: "skip", liveStatus: "succeeded", persistedStatus: "succeeded" }),
			reconciled({ taskId: "t-2", action: "pending" }),
		]);
		expect(point.resumeWaveIndex).toBe(1);
		expect(point.pendingTaskIds).toEqual(["t-2"]);
		expect(point.completedTaskIds).toEqual(["t-1"]);
	});

	test("categorizes reconnect and re-execute tasks separately", () => {
		const batch = mkBatch({
			wavePlan: [["t-rc", "t-re", "t-fail", "t-new"]],
			tasks: [
				mkTask({ taskId: "t-rc", status: "running" }),
				mkTask({ taskId: "t-re", status: "running" }),
				mkTask({ taskId: "t-fail", status: "running" }),
				mkTask({ taskId: "t-new", status: "pending", sessionName: "" }),
			],
		});
		const point = computeResumePoint(batch, [
			reconciled({ taskId: "t-rc", action: "reconnect" }),
			reconciled({ taskId: "t-re", action: "re-execute" }),
			reconciled({ taskId: "t-fail", action: "mark-failed" }),
			reconciled({ taskId: "t-new", action: "pending" }),
		]);
		expect(point.reconnectTaskIds).toEqual(["t-rc"]);
		expect(point.reExecuteTaskIds).toEqual(["t-re"]);
		expect(point.failedTaskIds).toEqual(["t-fail"]);
		expect(point.pendingTaskIds).toContain("t-new");
	});

	test("failure-only wave does not flag merge retry", () => {
		const batch = mkBatch({
			wavePlan: [["t-1"]],
			tasks: [mkTask({ taskId: "t-1", status: "failed" })],
			mergeResults: [],
		});
		const point = computeResumePoint(batch, [
			reconciled({ taskId: "t-1", action: "mark-failed", liveStatus: "failed", persistedStatus: "failed" }),
		]);
		expect(point.mergeRetryWaveIndexes).toEqual([]);
		expect(point.failedTaskIds).toEqual(["t-1"]);
	});
});

// ── runPreResumeDiagnostics ──────────────────────────────────────────

describe("runPreResumeDiagnostics", () => {
	test("state coherence always passes", () => {
		const dir = mkTmp("mc-resume-diag-state");
		try {
			const result = runPreResumeDiagnostics(mkBatch({ orchBranch: "" }), dir, dir);
			expect(result.checks[0]).toEqual(expect.objectContaining({ check: "state-coherence", passed: true }));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("branch-consistency check fails when mission branch missing", () => {
		const dir = mkTmp("mc-resume-diag-branch");
		try {
			Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: dir });
			// No mission branch exists — diagnostic should flag it.
			const batch = mkBatch({ orchBranch: "mission/nonexistent", lanes: [] });
			const result = runPreResumeDiagnostics(batch, dir, dir);
			const branchCheck = result.checks.find(c => c.check.startsWith("branch-consistency"));
			expect(branchCheck?.passed).toBe(false);
			expect(result.passed).toBe(false);
			expect(result.summary).toContain("Pre-resume diagnostics failed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("worktree-health flags missing .git marker as corrupted", () => {
		const dir = mkTmp("mc-resume-diag-wt");
		try {
			Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: dir });
			const wtDir = join(dir, "wt-1");
			mkdirSync(wtDir, { recursive: true });
			// No .git marker written → corrupted.
			const batch = mkBatch({
				orchBranch: "",
				lanes: [mkLane({ laneNumber: 1, worktreePath: wtDir })],
			});
			const result = runPreResumeDiagnostics(batch, dir, dir);
			const wtCheck = result.checks.find(c => c.check === "worktree-health:lane-1");
			expect(wtCheck?.passed).toBe(false);
			expect(wtCheck?.detail).toContain("lacks .git marker");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("worktree-health accepts absent worktree (will be re-created)", () => {
		const dir = mkTmp("mc-resume-diag-absent");
		try {
			Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: dir });
			const batch = mkBatch({
				orchBranch: "",
				lanes: [mkLane({ laneNumber: 1, worktreePath: join(dir, "missing-wt") })],
			});
			const result = runPreResumeDiagnostics(batch, dir, dir);
			const wtCheck = result.checks.find(c => c.check === "worktree-health:lane-1");
			expect(wtCheck?.passed).toBe(true);
			expect(wtCheck?.detail).toContain("absent");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("all checks pass → passed=true + friendly summary", () => {
		const dir = mkTmp("mc-resume-diag-ok");
		try {
			Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: dir });
			const batch = mkBatch({ orchBranch: "", lanes: [] });
			const result = runPreResumeDiagnostics(batch, dir, dir);
			expect(result.passed).toBe(true);
			expect(result.summary).toContain("passed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
