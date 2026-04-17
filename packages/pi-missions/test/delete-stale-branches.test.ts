/**
 * Tests for `deleteBranchBestEffort` + `deleteStaleBranches` — the
 * stale-branch cleanup invoked at the tail of `/mission-integrate`.
 *
 * Real ephemeral git repos: we want the actual `rev-parse` / `branch -D`
 * interaction observable, not a mocked git stub.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deleteBranchBestEffort, deleteStaleBranches } from "../src/missioncontrol/worktree";

function mkTmp(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function gitRun(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
	const result = Bun.spawnSync({ cmd: ["git", ...args], cwd });
	const decoder = new TextDecoder();
	return { ok: result.exitCode === 0, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}

function gitOrThrow(args: string[], cwd: string): void {
	const r = gitRun(args, cwd);
	if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function initRepo(): string {
	const dir = mkTmp("mc-delbr");
	gitOrThrow(["init", "-q", "-b", "main"], dir);
	gitOrThrow(["config", "user.email", "t@e.invalid"], dir);
	gitOrThrow(["config", "user.name", "t"], dir);
	writeFileSync(join(dir, "README.md"), "x\n");
	gitOrThrow(["add", "."], dir);
	gitOrThrow(["commit", "-q", "-m", "init"], dir);
	return dir;
}

function branchExists(branch: string, repo: string): boolean {
	return gitRun(["rev-parse", "--verify", `refs/heads/${branch}`], repo).ok;
}

describe("deleteBranchBestEffort", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("missing branch → idempotent success", () => {
		expect(deleteBranchBestEffort("not-there", repo)).toBe(true);
	});

	test("existing branch → deleted + returns true", () => {
		gitOrThrow(["branch", "to-delete"], repo);
		expect(branchExists("to-delete", repo)).toBe(true);
		expect(deleteBranchBestEffort("to-delete", repo)).toBe(true);
		expect(branchExists("to-delete", repo)).toBe(false);
	});

	test("unmerged branch still force-deleted", () => {
		gitOrThrow(["checkout", "-qb", "unmerged"], repo);
		writeFileSync(join(repo, "new.txt"), "new\n");
		gitOrThrow(["add", "."], repo);
		gitOrThrow(["commit", "-q", "-m", "work"], repo);
		gitOrThrow(["checkout", "-q", "main"], repo);

		expect(deleteBranchBestEffort("unmerged", repo)).toBe(true);
		expect(branchExists("unmerged", repo)).toBe(false);
	});
});

describe("deleteStaleBranches", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("no matching branches → empty result lists", () => {
		const result = deleteStaleBranches(repo, "henry", "b-1");
		expect(result.deletedTaskBranches).toEqual([]);
		expect(result.deletedSavedBranches).toEqual([]);
		expect(result.failedDeletes).toEqual([]);
	});

	test("deletes task/{opId}-lane-* branches", () => {
		gitOrThrow(["branch", "task/henry-lane-1-b-1"], repo);
		gitOrThrow(["branch", "task/henry-lane-2-b-1"], repo);
		// Another operator's branch should NOT be deleted.
		gitOrThrow(["branch", "task/other-lane-1-b-1"], repo);

		const result = deleteStaleBranches(repo, "henry", "b-1");
		expect(result.deletedTaskBranches.sort()).toEqual(["task/henry-lane-1-b-1", "task/henry-lane-2-b-1"]);
		expect(branchExists("task/other-lane-1-b-1", repo)).toBe(true);
	});

	test("deletes saved/task/{opId}-lane-* branches", () => {
		gitOrThrow(["branch", "saved/task/henry-lane-3-b-1"], repo);
		const result = deleteStaleBranches(repo, "henry", "b-1");
		expect(result.deletedSavedBranches).toContain("saved/task/henry-lane-3-b-1");
		expect(branchExists("saved/task/henry-lane-3-b-1", repo)).toBe(false);
	});

	test("deletes saved/{opId}-*-{batchId} partial-progress branches only for current batch", () => {
		gitOrThrow(["branch", "saved/henry-TP-001-b-1"], repo);
		gitOrThrow(["branch", "saved/henry-TP-002-b-1"], repo);
		// Different batch — must be preserved.
		gitOrThrow(["branch", "saved/henry-TP-003-b-OTHER"], repo);

		const result = deleteStaleBranches(repo, "henry", "b-1");
		expect(result.deletedSavedBranches).toContain("saved/henry-TP-001-b-1");
		expect(result.deletedSavedBranches).toContain("saved/henry-TP-002-b-1");
		expect(result.deletedSavedBranches).not.toContain("saved/henry-TP-003-b-OTHER");
		expect(branchExists("saved/henry-TP-003-b-OTHER", repo)).toBe(true);
	});

	test("does not double-delete saved/task/* via the saved/{opId}-* pass", () => {
		// saved/task/* ends with -b-1 so the second pass would match it
		// too — the implementation must skip startsWith("saved/task/").
		gitOrThrow(["branch", "saved/task/henry-lane-1-b-1"], repo);
		const result = deleteStaleBranches(repo, "henry", "b-1");
		// Deleted once via pass #2, not again via pass #3.
		const count = result.deletedSavedBranches.filter(b => b === "saved/task/henry-lane-1-b-1").length;
		expect(count).toBe(1);
	});

	test("aggregates across all three scopes in a single call", () => {
		gitOrThrow(["branch", "task/henry-lane-1-b-1"], repo);
		gitOrThrow(["branch", "saved/task/henry-lane-1-b-1"], repo);
		gitOrThrow(["branch", "saved/henry-TP-001-b-1"], repo);

		const result = deleteStaleBranches(repo, "henry", "b-1");
		expect(result.deletedTaskBranches).toHaveLength(1);
		expect(result.deletedSavedBranches).toHaveLength(2);
		expect(result.failedDeletes).toEqual([]);
	});
});
