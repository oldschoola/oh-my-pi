/**
 * Tests for `listWorktrees` — scans `git worktree list --porcelain` output
 * and classifies each entry by the three mission naming conventions
 * (nested batch-scoped, legacy flat primary, legacy plain-`op` fallback).
 *
 * Uses a real ephemeral git repo so we exercise the parseWorktreeList
 * integration alongside the regex classification logic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { listWorktrees } from "../src/missioncontrol/worktree";

function mkTmp(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function git(args: string[], cwd: string): void {
	const result = Bun.spawnSync({ cmd: ["git", ...args], cwd });
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr);
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
}

function initRepo(): string {
	const dir = mkTmp("mc-list-wt");
	git(["init", "-q", "-b", "main"], dir);
	git(["config", "user.email", "test@example.invalid"], dir);
	git(["config", "user.name", "Test"], dir);
	writeFileSync(join(dir, "README.md"), "x\n");
	git(["add", "."], dir);
	git(["commit", "-q", "-m", "init"], dir);
	return dir;
}

function addWorktree(repo: string, relPath: string, branch: string): string {
	const fullPath = resolve(repo, relPath);
	mkdirSync(resolve(fullPath, ".."), { recursive: true });
	git(["worktree", "add", "-q", "-b", branch, fullPath], repo);
	return fullPath;
}

describe("listWorktrees", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("returns empty array when no worktrees match", () => {
		const result = listWorktrees("mission-wt", repo, "henry");
		expect(result).toEqual([]);
	});

	test("matches nested batch-scoped `opId-batchId/lane-N`", () => {
		const opId = "henry";
		const batchId = "b-1";
		const wt1 = addWorktree(repo, `.worktrees/${opId}-${batchId}/lane-1`, "t/henry-lane-1-b-1");
		const wt2 = addWorktree(repo, `.worktrees/${opId}-${batchId}/lane-2`, "t/henry-lane-2-b-1");

		const result = listWorktrees("mission-wt", repo, opId, batchId);
		expect(result).toEqual([
			{ path: resolve(wt1), branch: "t/henry-lane-1-b-1", laneNumber: 1 },
			{ path: resolve(wt2), branch: "t/henry-lane-2-b-1", laneNumber: 2 },
		]);
	});

	test("with batchId omitted, nested pattern still matches any container for this opId", () => {
		addWorktree(repo, ".worktrees/henry-b-1/lane-1", "t/henry-lane-1-b-1");
		addWorktree(repo, ".worktrees/henry-b-2/lane-1", "t/henry-lane-1-b-2");

		const result = listWorktrees("mission-wt", repo, "henry");
		expect(result).toHaveLength(2);
		expect(result.every(r => r.laneNumber === 1)).toBe(true);
	});

	test("batchId filters out other batches' nested worktrees", () => {
		addWorktree(repo, ".worktrees/henry-b-1/lane-1", "t/henry-lane-1-b-1");
		addWorktree(repo, ".worktrees/henry-b-2/lane-1", "t/henry-lane-1-b-2");

		const result = listWorktrees("mission-wt", repo, "henry", "b-1");
		expect(result).toHaveLength(1);
		expect(result[0]?.branch).toBe("t/henry-lane-1-b-1");
	});

	test("matches legacy flat `prefix-opId-N` when no batchId", () => {
		const wt = addWorktree(repo, ".worktrees/mission-wt-henry-3", "legacy-3");
		const result = listWorktrees("mission-wt", repo, "henry");
		expect(result).toEqual([{ path: resolve(wt), branch: "legacy-3", laneNumber: 3 }]);
	});

	test("batchId supplied → legacy flat matches are skipped", () => {
		addWorktree(repo, ".worktrees/mission-wt-henry-3", "legacy-3");
		const result = listWorktrees("mission-wt", repo, "henry", "b-1");
		expect(result).toEqual([]);
	});

	test("plain-`op` fallback matches `prefix-N` only when opId === 'op'", () => {
		const wt = addWorktree(repo, ".worktrees/mission-wt-5", "legacy-plain-5");
		const asOp = listWorktrees("mission-wt", repo, "op");
		expect(asOp).toEqual([{ path: resolve(wt), branch: "legacy-plain-5", laneNumber: 5 }]);

		const asHenry = listWorktrees("mission-wt", repo, "henry");
		expect(asHenry).toEqual([]);
	});

	test("sorts ascending by laneNumber across mixed patterns", () => {
		addWorktree(repo, ".worktrees/henry-b-1/lane-7", "t/henry-lane-7-b-1");
		addWorktree(repo, ".worktrees/mission-wt-henry-2", "legacy-2");
		addWorktree(repo, ".worktrees/henry-b-1/lane-4", "t/henry-lane-4-b-1");

		const result = listWorktrees("mission-wt", repo, "henry");
		expect(result.map(r => r.laneNumber)).toEqual([2, 4, 7]);
	});

	test("ignores nested `lane-N` whose parent does not match container pattern", () => {
		addWorktree(repo, ".worktrees/unrelated-dir/lane-1", "unrelated-lane");
		const result = listWorktrees("mission-wt", repo, "henry");
		expect(result).toEqual([]);
	});

	test("rejects lane-0 (must be >= 1)", () => {
		addWorktree(repo, ".worktrees/henry-b-1/lane-0", "t/henry-lane-0-b-1");
		const result = listWorktrees("mission-wt", repo, "henry", "b-1");
		expect(result).toEqual([]);
	});
});
