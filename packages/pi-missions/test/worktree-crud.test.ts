/**
 * Tests for the Chunk B worktree mutators:
 *   - createWorktree
 *   - resetWorktree
 *   - removeWorktree
 *   - ensureBranchDeleted
 *   - preserveBranch
 *
 * Real ephemeral git repos — worktree CRUD is git-side behavior and the
 * pre-check / post-check semantics are only observable against a real
 * git repo + real worktrees.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeError } from "../src/missioncontrol/types";
import {
	createWorktree,
	ensureBranchDeleted,
	preserveBranch,
	removeWorktree,
	resetWorktree,
} from "../src/missioncontrol/worktree";

function mkTmp(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function gitRun(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
	const result = Bun.spawnSync({ cmd: ["git", ...args], cwd });
	const decoder = new TextDecoder();
	return {
		ok: result.exitCode === 0,
		stdout: decoder.decode(result.stdout),
		stderr: decoder.decode(result.stderr),
	};
}

function gitOrThrow(args: string[], cwd: string): void {
	const r = gitRun(args, cwd);
	if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function initRepo(): string {
	const dir = mkTmp("mc-crud");
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

function commitNew(repo: string, file: string, content: string, message: string): void {
	writeFileSync(join(repo, file), content);
	gitOrThrow(["add", "."], repo);
	gitOrThrow(["commit", "-q", "-m", message], repo);
}

const CREATE_OPTS = {
	laneNumber: 1,
	batchId: "20260308T111750",
	baseBranch: "main",
	prefix: "mission-wt",
	opId: "henry",
};

describe("createWorktree", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("creates a worktree + branch off baseBranch HEAD", () => {
		const info = createWorktree(CREATE_OPTS, repo);
		expect(info.laneNumber).toBe(1);
		expect(info.branch).toBe("task/henry-lane-1-20260308T111750");
		expect(existsSync(info.path)).toBe(true);
		expect(branchExists(info.branch, repo)).toBe(true);

		const head = gitRun(["rev-parse", "HEAD"], info.path);
		const baseHead = gitRun(["rev-parse", "main"], repo);
		expect(head.stdout.trim()).toBe(baseHead.stdout.trim());
	});

	test("throws WORKTREE_INVALID_BASE when baseBranch missing", () => {
		expect(() => createWorktree({ ...CREATE_OPTS, baseBranch: "nope" }, repo)).toThrow(WorktreeError);
		try {
			createWorktree({ ...CREATE_OPTS, baseBranch: "nope" }, repo);
		} catch (err) {
			expect((err as WorktreeError).code).toBe("WORKTREE_INVALID_BASE");
		}
	});

	test("throws WORKTREE_BRANCH_EXISTS when lane branch already exists", () => {
		gitOrThrow(["branch", "task/henry-lane-1-20260308T111750"], repo);
		try {
			createWorktree(CREATE_OPTS, repo);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(WorktreeError);
			expect((err as WorktreeError).code).toBe("WORKTREE_BRANCH_EXISTS");
		}
	});

	test("throws WORKTREE_PATH_NOT_EMPTY when target path is non-empty non-worktree", () => {
		// Precompute target path and plant a file in it
		const info = createWorktree(CREATE_OPTS, repo);
		// Remove the created worktree, leaving directory behind with a file
		gitOrThrow(["worktree", "remove", "--force", info.path], repo);
		gitOrThrow(["branch", "-D", info.branch], repo);
		mkdirSync(info.path, { recursive: true });
		writeFileSync(join(info.path, "stray.txt"), "x\n");
		try {
			createWorktree(CREATE_OPTS, repo);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(WorktreeError);
			expect((err as WorktreeError).code).toBe("WORKTREE_PATH_NOT_EMPTY");
		}
	});
});

describe("resetWorktree", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("repoints lane branch to target branch HEAD, preserving lane branch name", () => {
		const info = createWorktree(CREATE_OPTS, repo);

		// Advance main by one commit (target to reset to)
		commitNew(repo, "two.txt", "two\n", "second");
		const newHead = gitRun(["rev-parse", "main"], repo).stdout.trim();

		const out = resetWorktree(info, "main", repo);
		expect(out.branch).toBe(info.branch);
		expect(out.laneNumber).toBe(info.laneNumber);

		const wtHead = gitRun(["rev-parse", "HEAD"], out.path).stdout.trim();
		expect(wtHead).toBe(newHead);

		const wtBranch = gitRun(["rev-parse", "--abbrev-ref", "HEAD"], out.path).stdout.trim();
		expect(wtBranch).toBe(info.branch);
	});

	test("throws WORKTREE_DIRTY when worktree has uncommitted changes", () => {
		const info = createWorktree(CREATE_OPTS, repo);
		writeFileSync(join(info.path, "dirty.txt"), "uncommitted\n");
		try {
			resetWorktree(info, "main", repo);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(WorktreeError);
			expect((err as WorktreeError).code).toBe("WORKTREE_DIRTY");
		}
	});

	test("throws WORKTREE_NOT_FOUND when worktree path missing", () => {
		const info = createWorktree(CREATE_OPTS, repo);
		rmSync(info.path, { recursive: true, force: true });
		try {
			resetWorktree(info, "main", repo);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(WorktreeError);
			expect((err as WorktreeError).code).toBe("WORKTREE_NOT_FOUND");
		}
	});

	test("throws WORKTREE_INVALID_BASE when target branch missing", () => {
		const info = createWorktree(CREATE_OPTS, repo);
		try {
			resetWorktree(info, "nope", repo);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(WorktreeError);
			expect((err as WorktreeError).code).toBe("WORKTREE_INVALID_BASE");
		}
	});
});

describe("preserveBranch", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("no-branch → ok + action 'no-branch'", () => {
		const result = preserveBranch("not-there", "main", repo);
		expect(result.ok).toBe(true);
		expect(result.action).toBe("no-branch");
	});

	test("fully-merged → ok + action 'fully-merged', no saved ref created", () => {
		gitOrThrow(["branch", "merged"], repo);
		const result = preserveBranch("merged", "main", repo);
		expect(result.ok).toBe(true);
		expect(result.action).toBe("fully-merged");
		expect(result.unmergedCount).toBe(0);
		expect(branchExists("saved/merged", repo)).toBe(false);
	});

	test("unmerged commits → preserved, saved/<branch> created", () => {
		gitOrThrow(["checkout", "-qb", "feature"], repo);
		commitNew(repo, "feat.txt", "f\n", "feature commit");
		gitOrThrow(["checkout", "-q", "main"], repo);

		const result = preserveBranch("feature", "main", repo);
		expect(result.ok).toBe(true);
		expect(result.action).toBe("preserved");
		expect(result.savedBranch).toBe("saved/feature");
		expect(result.unmergedCount).toBe(1);
		expect(branchExists("saved/feature", repo)).toBe(true);

		// Original branch NOT deleted by preserveBranch (that's ensureBranchDeleted's job)
		expect(branchExists("feature", repo)).toBe(true);
	});

	test("already-preserved at same SHA → ok + action 'already-preserved' (idempotent)", () => {
		gitOrThrow(["checkout", "-qb", "feature"], repo);
		commitNew(repo, "feat.txt", "f\n", "feature commit");
		gitOrThrow(["checkout", "-q", "main"], repo);

		preserveBranch("feature", "main", repo); // first call
		const second = preserveBranch("feature", "main", repo); // second call
		expect(second.ok).toBe(true);
		expect(second.action).toBe("already-preserved");
	});

	test("target branch missing → error + code 'TARGET_BRANCH_MISSING'", () => {
		gitOrThrow(["checkout", "-qb", "feature"], repo);
		commitNew(repo, "feat.txt", "f\n", "feature commit");
		gitOrThrow(["checkout", "-q", "main"], repo);

		const result = preserveBranch("feature", "does-not-exist", repo);
		expect(result.ok).toBe(false);
		expect(result.action).toBe("error");
		expect(result.code).toBe("TARGET_BRANCH_MISSING");
	});
});

describe("ensureBranchDeleted", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("fully merged branch → deleted + not preserved", () => {
		gitOrThrow(["branch", "merged"], repo);
		const result = ensureBranchDeleted("merged", repo, "/fake/path", "main");
		expect(result.deleted).toBe(true);
		expect(result.preserved).toBe(false);
		expect(branchExists("merged", repo)).toBe(false);
	});

	test("unmerged branch + target provided → preserved + original deleted", () => {
		gitOrThrow(["checkout", "-qb", "feature"], repo);
		commitNew(repo, "feat.txt", "f\n", "feature commit");
		gitOrThrow(["checkout", "-q", "main"], repo);

		const result = ensureBranchDeleted("feature", repo, "/fake/path", "main");
		expect(result.preserved).toBe(true);
		expect(result.deleted).toBe(true);
		expect(result.savedBranch).toBe("saved/feature");
		expect(branchExists("saved/feature", repo)).toBe(true);
		expect(branchExists("feature", repo)).toBe(false);
	});

	test("missing target branch → skips deletion (safe default)", () => {
		gitOrThrow(["checkout", "-qb", "feature"], repo);
		commitNew(repo, "feat.txt", "f\n", "feature commit");
		gitOrThrow(["checkout", "-q", "main"], repo);

		const result = ensureBranchDeleted("feature", repo, "/fake/path", "nope");
		expect(result.deleted).toBe(false);
		expect(result.preserved).toBe(false);
		expect(branchExists("feature", repo)).toBe(true); // still present
	});

	test("no targetBranch → unconditional delete", () => {
		gitOrThrow(["branch", "any-branch"], repo);
		const result = ensureBranchDeleted("any-branch", repo, "/fake/path");
		expect(result.deleted).toBe(true);
		expect(result.preserved).toBe(false);
		expect(branchExists("any-branch", repo)).toBe(false);
	});
});

describe("removeWorktree", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("removes a clean worktree + deletes merged lane branch", () => {
		const info = createWorktree(CREATE_OPTS, repo);
		expect(existsSync(info.path)).toBe(true);

		const result = removeWorktree(info, repo, "main");
		expect(result.removed).toBe(true);
		expect(result.alreadyRemoved).toBe(false);
		expect(result.branchDeleted).toBe(true);
		expect(result.branchPreserved).toBe(false);
		expect(existsSync(info.path)).toBe(false);
		expect(branchExists(info.branch, repo)).toBe(false);
	});

	test("preserves lane branch with unmerged commits, still removes worktree", () => {
		const info = createWorktree(CREATE_OPTS, repo);

		// Commit work in the worktree so lane branch diverges from main
		writeFileSync(join(info.path, "lane-work.txt"), "lane\n");
		gitOrThrow(["add", "."], info.path);
		gitOrThrow(["commit", "-q", "-m", "lane work"], info.path);

		const result = removeWorktree(info, repo, "main");
		expect(result.removed).toBe(true);
		expect(result.branchPreserved).toBe(true);
		expect(result.savedBranch).toBe(`saved/${info.branch}`);
		expect(result.unmergedCount).toBe(1);
		expect(branchExists(`saved/${info.branch}`, repo)).toBe(true);
		expect(branchExists(info.branch, repo)).toBe(false);
		expect(existsSync(info.path)).toBe(false);
	});

	test("already-removed worktree → alreadyRemoved:true, no-op", () => {
		const info = createWorktree(CREATE_OPTS, repo);
		gitOrThrow(["worktree", "remove", "--force", info.path], repo);
		gitOrThrow(["branch", "-D", info.branch], repo);

		const result = removeWorktree(info, repo, "main");
		expect(result.removed).toBe(false);
		expect(result.alreadyRemoved).toBe(true);
		expect(result.branchDeleted).toBe(true); // branch already gone
	});

	test("without targetBranch, unconditionally deletes lane branch", () => {
		const info = createWorktree(CREATE_OPTS, repo);

		// Commit to lane so it has unmerged commits
		writeFileSync(join(info.path, "lane.txt"), "x\n");
		gitOrThrow(["add", "."], info.path);
		gitOrThrow(["commit", "-q", "-m", "lane"], info.path);

		const result = removeWorktree(info, repo);
		expect(result.removed).toBe(true);
		expect(result.branchDeleted).toBe(true);
		expect(result.branchPreserved).toBe(false);
		expect(branchExists(info.branch, repo)).toBe(false);
	});
});
