/**
 * Integration tests for `savePartialProgress` on `missioncontrol/worktree.ts`.
 *
 * Uses a real temp git repo — builds two branches (`main`, `task/lane`),
 * commits ahead on the lane, and asserts the saved branch is created with
 * the expected `saved/{opId}-{taskId}-{batchId}` name, at the lane SHA.
 * Also covers idempotency, collision-with-different-SHA (timestamp suffix),
 * missing lane branch, and "nothing to save" (zero commits ahead).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGit } from "../src/missioncontrol/git";
import { computePartialProgressBranchName, savePartialProgress } from "../src/missioncontrol/worktree";

let repoRoot: string;

function gitExec(args: string[]): void {
	const r = runGit(args, repoRoot);
	if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function revParse(ref: string): string {
	const r = runGit(["rev-parse", "--verify", ref], repoRoot);
	if (!r.ok) throw new Error(`rev-parse ${ref} failed: ${r.stderr}`);
	return r.stdout.trim();
}

function commitFile(name: string, contents: string, message: string): void {
	writeFileSync(join(repoRoot, name), contents, "utf-8");
	gitExec(["add", name]);
	gitExec(["commit", "-m", message]);
}

beforeEach(() => {
	repoRoot = mkdtempSync(join(tmpdir(), "omp-save-partial-"));
	gitExec(["init", "--initial-branch=main", "."]);
	gitExec(["config", "user.email", "test@example.com"]);
	gitExec(["config", "user.name", "Test"]);
	gitExec(["commit", "--allow-empty", "-m", "init"]);
});

afterEach(() => {
	rmSync(repoRoot, { recursive: true, force: true });
});

const OP = "henry";
const TASK = "TP-001";
const BATCH = "20260101T000000";

describe("savePartialProgress", () => {
	test("creates saved branch when lane has unmerged commits", () => {
		gitExec(["checkout", "-b", "task/lane-1"]);
		commitFile("a.txt", "a", "feature commit");
		const laneSHA = revParse("refs/heads/task/lane-1");

		const result = savePartialProgress("task/lane-1", "main", OP, TASK, BATCH, repoRoot);

		expect(result.saved).toBe(true);
		expect(result.commitCount).toBe(1);
		expect(result.taskId).toBe(TASK);
		expect(result.savedBranch).toBe(computePartialProgressBranchName(OP, TASK, BATCH));
		// saved branch should point at the lane SHA
		expect(revParse(`refs/heads/${result.savedBranch}`)).toBe(laneSHA);
	});

	test("includes repoId in saved branch name when given", () => {
		gitExec(["checkout", "-b", "task/lane-1"]);
		commitFile("a.txt", "a", "feature commit");

		const result = savePartialProgress("task/lane-1", "main", OP, TASK, BATCH, repoRoot, "web");
		expect(result.savedBranch).toBe(computePartialProgressBranchName(OP, TASK, BATCH, "web"));
		expect(result.savedBranch).toContain("-web-");
	});

	test("returns saved=false with no error when lane has no unmerged commits", () => {
		gitExec(["checkout", "-b", "task/lane-1"]); // fast-forward to main
		const result = savePartialProgress("task/lane-1", "main", OP, TASK, BATCH, repoRoot);
		expect(result.saved).toBe(false);
		expect(result.commitCount).toBe(0);
		expect(result.error).toBeUndefined();
	});

	test("returns saved=false with error when lane branch missing", () => {
		const result = savePartialProgress("no-such-branch", "main", OP, TASK, BATCH, repoRoot);
		expect(result.saved).toBe(false);
		expect(result.commitCount).toBe(0);
		expect(result.error).toContain("not found");
	});

	test("idempotent: second call when SHA unchanged keeps existing saved branch", () => {
		gitExec(["checkout", "-b", "task/lane-1"]);
		commitFile("a.txt", "a", "feature commit");

		const first = savePartialProgress("task/lane-1", "main", OP, TASK, BATCH, repoRoot);
		expect(first.saved).toBe(true);
		const firstSavedSHA = revParse(`refs/heads/${first.savedBranch}`);

		const second = savePartialProgress("task/lane-1", "main", OP, TASK, BATCH, repoRoot);
		expect(second.saved).toBe(true);
		expect(second.savedBranch).toBe(first.savedBranch); // unchanged name
		expect(revParse(`refs/heads/${second.savedBranch}`)).toBe(firstSavedSHA); // unchanged SHA
	});

	test("creates suffixed branch when saved ref exists but points at a different SHA", () => {
		gitExec(["checkout", "-b", "task/lane-1"]);
		commitFile("a.txt", "a", "first feature commit");
		const firstResult = savePartialProgress("task/lane-1", "main", OP, TASK, BATCH, repoRoot);
		expect(firstResult.saved).toBe(true);

		// Add a new commit on the lane so its SHA moves forward
		commitFile("b.txt", "b", "second feature commit");

		const secondResult = savePartialProgress("task/lane-1", "main", OP, TASK, BATCH, repoRoot);
		expect(secondResult.saved).toBe(true);
		expect(secondResult.savedBranch).not.toBe(firstResult.savedBranch);
		// Suffix format: base + "-" + timestamp (colons/dots replaced with hyphens)
		expect(secondResult.savedBranch?.startsWith(`${firstResult.savedBranch}-`)).toBe(true);
		// Original preserved branch untouched
		const firstSavedSHA = revParse(`refs/heads/${firstResult.savedBranch}`);
		expect(firstSavedSHA).toBeTruthy();
		// New saved branch matches new lane SHA
		const laneSHA = revParse("refs/heads/task/lane-1");
		expect(revParse(`refs/heads/${secondResult.savedBranch}`)).toBe(laneSHA);
	});
});
