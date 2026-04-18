/**
 * Integration tests for `preserveFailedLaneProgress` +
 * `preserveSkippedLaneProgress` on `missioncontrol/worktree.ts`.
 *
 * Drives a real temp git repo through the full preservation pipeline:
 * build a lane branch with commits, mark task outcomes as failed/stalled/
 * skipped, then assert saved branches are created, branches are deduped
 * per lane, and unsafeBranches is populated when preservation fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedTask } from "../src/missioncontrol/discovery";
import { runGit } from "../src/missioncontrol/git";
import type { AllocatedLane, AllocatedTask, LaneTaskOutcome } from "../src/missioncontrol/types";
import {
	computePartialProgressBranchName,
	preserveFailedLaneProgress,
	preserveSkippedLaneProgress,
	type ResolveRepoContext,
} from "../src/missioncontrol/worktree";

let repoRoot: string;

function gitExec(args: string[]): void {
	const r = runGit(args, repoRoot);
	if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function commitFile(name: string, contents: string, message: string): void {
	writeFileSync(join(repoRoot, name), contents, "utf-8");
	gitExec(["add", name]);
	gitExec(["commit", "-m", message]);
}

beforeEach(() => {
	repoRoot = mkdtempSync(join(tmpdir(), "omp-preserve-"));
	gitExec(["init", "--initial-branch=main", "."]);
	gitExec(["config", "user.email", "test@example.com"]);
	gitExec(["config", "user.name", "Test"]);
	gitExec(["commit", "--allow-empty", "-m", "init"]);
});

afterEach(() => {
	rmSync(repoRoot, { recursive: true, force: true });
});

const OP = "henry";
const BATCH = "20260101T000000";

function mkTask(taskId: string): ParsedTask {
	return {
		taskId,
		taskName: taskId,
		folderPath: "",
		promptPath: "",
		prompt: "",
		dependencies: [],
		size: "M",
	};
}

function mkAllocated(taskId: string): AllocatedTask {
	return { taskId, order: 0, task: mkTask(taskId), estimatedMinutes: 10 };
}

function mkLane(branch: string, tasks: AllocatedTask[], repoId?: string): AllocatedLane {
	return {
		laneNumber: 1,
		laneId: "lane-1",
		laneSessionId: "session-1",
		worktreePath: "/tmp/lane-1",
		branch,
		tasks,
		strategy: "round-robin",
		estimatedLoad: 1,
		estimatedMinutes: 10,
		repoId,
	};
}

function mkOutcome(taskId: string, status: LaneTaskOutcome["status"]): LaneTaskOutcome {
	return {
		taskId,
		status,
		startTime: null,
		endTime: null,
		exitReason: "test",
		sessionName: `mission-lane-${taskId}`,
		doneFileFound: false,
		laneNumber: 1,
	};
}

function resolverFor(targetBranch = "main"): ResolveRepoContext {
	return () => ({ repoRoot, targetBranch });
}

describe("preserveFailedLaneProgress", () => {
	test("creates saved branches for failed tasks with unmerged commits", () => {
		gitExec(["checkout", "-b", "task/lane-1"]);
		commitFile("a.txt", "a", "feature commit");

		const lanes = [mkLane("task/lane-1", [mkAllocated("TP-001")])];
		const outcomes = [mkOutcome("TP-001", "failed")];

		const r = preserveFailedLaneProgress(lanes, outcomes, OP, BATCH, resolverFor());

		expect(r.results).toHaveLength(1);
		expect(r.results[0]?.saved).toBe(true);
		expect(r.preservedBranches.size).toBe(1);
		expect(r.preservedBranches.has(computePartialProgressBranchName(OP, "TP-001", BATCH))).toBe(true);
		expect(r.unsafeBranches.size).toBe(0);
	});

	test("treats stalled tasks as failed-for-preservation", () => {
		gitExec(["checkout", "-b", "task/lane-1"]);
		commitFile("a.txt", "a", "feature commit");

		const lanes = [mkLane("task/lane-1", [mkAllocated("TP-001")])];
		const outcomes = [mkOutcome("TP-001", "stalled")];

		const r = preserveFailedLaneProgress(lanes, outcomes, OP, BATCH, resolverFor());
		expect(r.results).toHaveLength(1);
		expect(r.results[0]?.saved).toBe(true);
	});

	test("skips successful outcomes", () => {
		gitExec(["checkout", "-b", "task/lane-1"]);
		commitFile("a.txt", "a", "feature commit");

		const lanes = [mkLane("task/lane-1", [mkAllocated("TP-001")])];
		const outcomes = [mkOutcome("TP-001", "succeeded")];

		const r = preserveFailedLaneProgress(lanes, outcomes, OP, BATCH, resolverFor());
		expect(r.results).toHaveLength(0);
		expect(r.preservedBranches.size).toBe(0);
	});

	test("dedups a single lane that hosts multiple failed tasks", () => {
		gitExec(["checkout", "-b", "task/lane-1"]);
		commitFile("a.txt", "a", "feature commit");

		const lanes = [mkLane("task/lane-1", [mkAllocated("TP-001"), mkAllocated("TP-002")])];
		const outcomes = [mkOutcome("TP-001", "failed"), mkOutcome("TP-002", "failed")];

		const r = preserveFailedLaneProgress(lanes, outcomes, OP, BATCH, resolverFor());
		// Only one savePartialProgress call → one result, one saved branch
		expect(r.results).toHaveLength(1);
		expect(r.preservedBranches.size).toBe(1);
	});

	test("records error result when task is not in any allocated lane", () => {
		const lanes: AllocatedLane[] = [];
		const outcomes = [mkOutcome("TP-GHOST", "failed")];

		const r = preserveFailedLaneProgress(lanes, outcomes, OP, BATCH, resolverFor());
		expect(r.results).toHaveLength(1);
		expect(r.results[0]?.saved).toBe(false);
		expect(r.results[0]?.error).toContain("not found in allocated lanes");
		expect(r.preservedBranches.size).toBe(0);
	});

	test("returns saved=false cleanly when lane has zero unmerged commits (no unsafeBranches)", () => {
		gitExec(["checkout", "-b", "task/lane-1"]); // fast-forward, no new commits

		const lanes = [mkLane("task/lane-1", [mkAllocated("TP-001")])];
		const outcomes = [mkOutcome("TP-001", "failed")];

		const r = preserveFailedLaneProgress(lanes, outcomes, OP, BATCH, resolverFor());
		expect(r.results[0]?.saved).toBe(false);
		expect(r.results[0]?.commitCount).toBe(0);
		expect(r.unsafeBranches.size).toBe(0); // no commits = safe to reset
	});

	test("marks branch unsafe when preservation fails but commits exist", () => {
		gitExec(["checkout", "-b", "task/lane-1"]);
		commitFile("a.txt", "a", "feature commit");

		const lanes = [mkLane("task/lane-1", [mkAllocated("TP-001")])];
		const outcomes = [mkOutcome("TP-001", "failed")];

		// Resolver points at a nonexistent target branch → hasUnmergedCommits fails
		const badResolver: ResolveRepoContext = () => ({ repoRoot, targetBranch: "no-such-target" });

		const r = preserveFailedLaneProgress(lanes, outcomes, OP, BATCH, badResolver);
		expect(r.results[0]?.saved).toBe(false);
		expect(r.results[0]?.error).toBeTruthy();
		expect(r.unsafeBranches.has("task/lane-1")).toBe(true);
	});

	test("includes repoId in saved branch name (workspace mode)", () => {
		gitExec(["checkout", "-b", "task/lane-1"]);
		commitFile("a.txt", "a", "feature commit");

		const lanes = [mkLane("task/lane-1", [mkAllocated("TP-001")], "web")];
		const outcomes = [mkOutcome("TP-001", "failed")];

		const r = preserveFailedLaneProgress(lanes, outcomes, OP, BATCH, resolverFor());
		expect(r.preservedBranches.has(computePartialProgressBranchName(OP, "TP-001", BATCH, "web"))).toBe(true);
	});
});

describe("preserveSkippedLaneProgress", () => {
	test("preserves only skipped tasks", () => {
		gitExec(["checkout", "-b", "task/lane-1"]);
		commitFile("a.txt", "a", "feature commit");

		const lanes = [mkLane("task/lane-1", [mkAllocated("TP-001"), mkAllocated("TP-002")])];
		const outcomes = [mkOutcome("TP-001", "failed"), mkOutcome("TP-002", "skipped")];

		const r = preserveSkippedLaneProgress(lanes, outcomes, OP, BATCH, resolverFor());

		// Only the skipped task goes through preservation.
		// (Both share the same lane branch, but 'failed' is filtered out first,
		// so the lane is only processed once — for the skipped task.)
		expect(r.results).toHaveLength(1);
		expect(r.results[0]?.taskId).toBe("TP-002");
		expect(r.preservedBranches.size).toBe(1);
		expect(r.preservedBranches.has(computePartialProgressBranchName(OP, "TP-002", BATCH))).toBe(true);
	});

	test("ignores non-skipped outcomes entirely", () => {
		gitExec(["checkout", "-b", "task/lane-1"]);
		commitFile("a.txt", "a", "feature commit");

		const lanes = [mkLane("task/lane-1", [mkAllocated("TP-001")])];
		const outcomes = [mkOutcome("TP-001", "failed")];

		const r = preserveSkippedLaneProgress(lanes, outcomes, OP, BATCH, resolverFor());
		expect(r.results).toHaveLength(0);
		expect(r.preservedBranches.size).toBe(0);
	});
});
