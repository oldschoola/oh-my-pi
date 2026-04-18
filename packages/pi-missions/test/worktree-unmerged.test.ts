/**
 * Tests for `hasUnmergedCommits` + `resolveSavedBranchCollision` +
 * `computeSavedBranchName` on `missioncontrol/worktree.ts`.
 *
 * `hasUnmergedCommits` runs real git against a temp repo (mirrors the
 * integration shape in taskplane). `resolveSavedBranchCollision` is pure —
 * tested against the decision table directly. `computeSavedBranchName` is
 * a trivial name-spacer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGit } from "../src/missioncontrol/git";
import {
	computeSavedBranchName,
	hasUnmergedCommits,
	resolveSavedBranchCollision,
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
	repoRoot = mkdtempSync(join(tmpdir(), "omp-unmerged-"));
	gitExec(["init", "--initial-branch=main", "."]);
	gitExec(["config", "user.email", "test@example.com"]);
	gitExec(["config", "user.name", "Test"]);
	gitExec(["commit", "--allow-empty", "-m", "init"]);
});

afterEach(() => {
	rmSync(repoRoot, { recursive: true, force: true });
});

describe("hasUnmergedCommits", () => {
	test("returns BRANCH_NOT_FOUND when branch missing", () => {
		const r = hasUnmergedCommits("no-such-branch", "main", repoRoot);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("BRANCH_NOT_FOUND");
		expect(r.count).toBe(0);
	});

	test("returns TARGET_BRANCH_MISSING when target missing", () => {
		gitExec(["branch", "feature"]);
		const r = hasUnmergedCommits("feature", "no-such-target", repoRoot);
		expect(r.ok).toBe(false);
		expect(r.code).toBe("TARGET_BRANCH_MISSING");
	});

	test("returns ok with count=0 when branch is a subset of target", () => {
		gitExec(["checkout", "-b", "feature"]);
		gitExec(["checkout", "main"]);
		commitFile("main.txt", "main change", "main change");
		const r = hasUnmergedCommits("feature", "main", repoRoot);
		expect(r.ok).toBe(true);
		expect(r.count).toBe(0);
	});

	test("returns ok with positive count when branch has unmerged commits", () => {
		gitExec(["checkout", "-b", "feature"]);
		commitFile("a.txt", "a", "first feature commit");
		commitFile("b.txt", "b", "second feature commit");
		const r = hasUnmergedCommits("feature", "main", repoRoot);
		expect(r.ok).toBe(true);
		expect(r.count).toBe(2);
	});
});

describe("resolveSavedBranchCollision", () => {
	test("create when existing ref is absent", () => {
		const r = resolveSavedBranchCollision("saved/x", "", "sha1");
		expect(r.action).toBe("create");
		expect(r.savedName).toBe("saved/x");
	});

	test("keep-existing when SHAs match", () => {
		const r = resolveSavedBranchCollision("saved/x", "sha1", "sha1");
		expect(r.action).toBe("keep-existing");
		expect(r.savedName).toBe("saved/x");
	});

	test("create-suffixed when SHAs differ; uses injected timestamp", () => {
		const r = resolveSavedBranchCollision("saved/x", "old", "new", "2026-01-01T00-00-00-000Z");
		expect(r.action).toBe("create-suffixed");
		expect(r.savedName).toBe("saved/x-2026-01-01T00-00-00-000Z");
	});

	test("create-suffixed generates fresh timestamp when omitted", () => {
		const r = resolveSavedBranchCollision("saved/x", "old", "new");
		expect(r.action).toBe("create-suffixed");
		expect(r.savedName).toMatch(/^saved\/x-\d{4}-\d{2}-\d{2}T/); // ISO-ish prefix
		expect(r.savedName.includes(":")).toBe(false); // colons replaced
		expect(r.savedName.includes(".")).toBe(false); // dots replaced
	});
});

describe("computeSavedBranchName", () => {
	test("prefixes any branch name with saved/", () => {
		expect(computeSavedBranchName("task/lane-1-20260308T111750")).toBe("saved/task/lane-1-20260308T111750");
		expect(computeSavedBranchName("feature/my-branch")).toBe("saved/feature/my-branch");
		expect(computeSavedBranchName("main")).toBe("saved/main");
	});
});
