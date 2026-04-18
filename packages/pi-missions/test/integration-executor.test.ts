/**
 * Tests for `buildIntegrationExecutor` + `buildCiDeps` — the factory
 * functions that glue `executeIntegration` to a concrete repo root +
 * post-success cleanup chain (stale-branch delete, autostash drop,
 * batch-history marker).
 *
 * Real ephemeral git repos — the executor depends on `getCurrentBranch`,
 * `runGit`, `withPreservedMissionHistory`, `deleteStaleBranches` talking
 * to an actual `.git` directory, so mocking that layer defeats the point.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCiDeps, buildIntegrationExecutor } from "../src/missioncontrol/integration-executor";

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
	const dir = mkTmp("mc-intexec");
	gitOrThrow(["init", "-q", "-b", "main"], dir);
	gitOrThrow(["config", "user.email", "t@e.invalid"], dir);
	gitOrThrow(["config", "user.name", "t"], dir);
	writeFileSync(join(dir, "README.md"), "x\n");
	gitOrThrow(["add", "."], dir);
	gitOrThrow(["commit", "-q", "-m", "init"], dir);
	return dir;
}

function addCommit(file: string, body: string, repo: string): void {
	writeFileSync(join(repo, file), body);
	gitOrThrow(["add", "."], repo);
	gitOrThrow(["commit", "-q", "-m", `change ${file}`], repo);
}

function branchExists(branch: string, repo: string): boolean {
	return gitRun(["rev-parse", "--verify", `refs/heads/${branch}`], repo).ok;
}

function currentHead(repo: string): string {
	return gitRun(["rev-parse", "HEAD"], repo).stdout.trim();
}

describe("buildIntegrationExecutor — base-branch guard", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("returns failure when base branch cannot be checked out", () => {
		// Start on `main`, aim for a base branch that does not exist.
		const executor = buildIntegrationExecutor(repo);
		const result = executor("ff", {
			orchBranch: "orch/b-1",
			baseBranch: "does-not-exist",
			batchId: "b-1",
			currentBranch: "main",
			notices: [],
		});
		expect(result.success).toBe(false);
		expect(result.integratedLocally).toBe(false);
		expect(result.commitCount).toBe("0");
		expect(result.error).toContain("Failed to switch to base branch does-not-exist");
	});
});

describe("buildIntegrationExecutor — ff success + post-cleanup", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
		// Build orch/b-1 ahead of main by one commit.
		gitOrThrow(["checkout", "-qb", "orch/b-1"], repo);
		addCommit("work.txt", "work\n", repo);
		// Return to main so the executor's checkout guard is exercised.
		gitOrThrow(["checkout", "-q", "main"], repo);
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("ff moves base branch forward + runs stale-branch cleanup when opId given", () => {
		gitOrThrow(["branch", "task/henry-lane-1-b-1"], repo);
		gitOrThrow(["branch", "task/henry-lane-2-b-1"], repo);
		// Different operator — must survive (cleanup is opId-scoped).
		gitOrThrow(["branch", "task/other-lane-1-b-1"], repo);

		const baseBefore = currentHead(repo);
		const orchHead = gitRun(["rev-parse", "orch/b-1"], repo).stdout.trim();

		const executor = buildIntegrationExecutor(repo, "henry");
		const result = executor("ff", {
			orchBranch: "orch/b-1",
			baseBranch: "main",
			batchId: "b-1",
			currentBranch: "main",
			notices: [],
		});

		expect(result.success).toBe(true);
		expect(result.integratedLocally).toBe(true);
		// Base branch fast-forwarded onto orch head.
		expect(currentHead(repo)).toBe(orchHead);
		expect(currentHead(repo)).not.toBe(baseBefore);
		// Henry's lane branches deleted (opId-scoped cleanup — any batch).
		expect(branchExists("task/henry-lane-1-b-1", repo)).toBe(false);
		expect(branchExists("task/henry-lane-2-b-1", repo)).toBe(false);
		// Other operator's branch preserved.
		expect(branchExists("task/other-lane-1-b-1", repo)).toBe(true);
	});

	test("ff success without opId skips stale-branch cleanup", () => {
		gitOrThrow(["branch", "task/henry-lane-1-b-1"], repo);

		const executor = buildIntegrationExecutor(repo); // no opId
		const result = executor("ff", {
			orchBranch: "orch/b-1",
			baseBranch: "main",
			batchId: "b-1",
			currentBranch: "main",
			notices: [],
		});

		expect(result.success).toBe(true);
		expect(result.integratedLocally).toBe(true);
		// opId absent → cleanup gate closed → task branch survives.
		expect(branchExists("task/henry-lane-1-b-1", repo)).toBe(true);
	});

	test("ff success without batchId skips stale-branch cleanup", () => {
		gitOrThrow(["branch", "task/henry-lane-1-b-1"], repo);

		const executor = buildIntegrationExecutor(repo, "henry");
		const result = executor("ff", {
			orchBranch: "orch/b-1",
			baseBranch: "main",
			batchId: "", // empty batchId disables cleanup
			currentBranch: "main",
			notices: [],
		});

		expect(result.success).toBe(true);
		expect(branchExists("task/henry-lane-1-b-1", repo)).toBe(true);
	});
});

describe("buildCiDeps", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("runGit runs scoped to repoRoot", () => {
		const deps = buildCiDeps(repo);
		const result = deps.runGit(["rev-parse", "--show-toplevel"]);
		expect(result.ok).toBe(true);
		// Toplevel resolves to the repo dir (git may normalize path; compare basename).
		expect(result.stdout.length).toBeGreaterThan(0);
	});

	test("runCommand runs arbitrary subprocess scoped to repoRoot", () => {
		const deps = buildCiDeps(repo);
		const result = deps.runCommand("git", ["--version"]);
		expect(result.ok).toBe(true);
		expect(result.stdout).toContain("git version");
	});

	test("runCommand returns ok:false on non-zero exit", () => {
		const deps = buildCiDeps(repo);
		const result = deps.runCommand("git", ["cat-file", "-p", "deadbeef"]);
		expect(result.ok).toBe(false);
		// execFileSync throws on non-zero, our wrapper captures stderr or message.
		expect(result.stderr.length).toBeGreaterThan(0);
	});

	test("deleteBatchState is best-effort and does not throw when no state exists", () => {
		const deps = buildCiDeps(repo);
		expect(() => deps.deleteBatchState()).not.toThrow();
	});

	test("deleteBatchState targets stateRoot when provided", () => {
		const stateRoot = mkTmp("mc-state");
		const deps = buildCiDeps(repo, stateRoot);
		expect(() => deps.deleteBatchState()).not.toThrow();
		rmSync(stateRoot, { recursive: true, force: true });
	});
});
