/**
 * Tests for the Chunk C worktree bulk-ops surface:
 *   - createLaneWorktrees
 *   - ensureLaneWorktrees
 *   - removeAllWorktrees
 *   - safeResetWorktree
 *   - forceCleanupWorktree
 *
 * Real ephemeral git repos — these orchestrate createWorktree /
 * resetWorktree / removeWorktree (all git-side) and the rollback,
 * container-cleanup, and dirty-recovery semantics are only observable
 * against a real repo.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DEFAULT_ORCHESTRATOR_CONFIG, type OrchestratorConfig } from "../src/missioncontrol/types";
import {
	createLaneWorktrees,
	createWorktree,
	ensureLaneWorktrees,
	forceCleanupWorktree,
	generateBatchContainerPath,
	removeAllWorktrees,
	safeResetWorktree,
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
	const dir = mkTmp("mc-bulk");
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

const BATCH_ID = "20260417T101010";
const OP_ID = "henry";

function mkConfig(): OrchestratorConfig {
	return {
		...DEFAULT_ORCHESTRATOR_CONFIG,
		orchestrator: {
			...DEFAULT_ORCHESTRATOR_CONFIG.orchestrator,
			operator_id: OP_ID,
		},
	};
}

describe("createLaneWorktrees", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("creates N lane worktrees sequentially", () => {
		const result = createLaneWorktrees(3, BATCH_ID, mkConfig(), repo, "main");
		expect(result.success).toBe(true);
		expect(result.worktrees).toHaveLength(3);
		expect(result.errors).toHaveLength(0);
		expect(result.rolledBack).toBe(false);

		expect(result.worktrees[0].laneNumber).toBe(1);
		expect(result.worktrees[1].laneNumber).toBe(2);
		expect(result.worktrees[2].laneNumber).toBe(3);

		for (const wt of result.worktrees) {
			expect(existsSync(wt.path)).toBe(true);
			expect(branchExists(wt.branch, repo)).toBe(true);
		}
	});

	test("rolls back previously created worktrees on mid-batch failure", () => {
		// Pre-create branch for lane 2 to force WORKTREE_BRANCH_EXISTS on the
		// second iteration — lane 1 will succeed, lane 2 will fail.
		const existingBranch = `task/${OP_ID}-lane-2-${BATCH_ID}`;
		gitOrThrow(["branch", existingBranch], repo);

		const result = createLaneWorktrees(3, BATCH_ID, mkConfig(), repo, "main");
		expect(result.success).toBe(false);
		expect(result.worktrees).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].laneNumber).toBe(2);
		expect(result.errors[0].code).toBe("WORKTREE_BRANCH_EXISTS");
		expect(result.rolledBack).toBe(true);
		expect(result.rollbackErrors).toHaveLength(0);

		// Lane 1's worktree + branch gone (rolled back).
		expect(branchExists(`task/${OP_ID}-lane-1-${BATCH_ID}`, repo)).toBe(false);
	});
});

describe("ensureLaneWorktrees", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("creates missing lanes from scratch", () => {
		const result = ensureLaneWorktrees([1, 2], BATCH_ID, mkConfig(), repo, "main");
		expect(result.success).toBe(true);
		expect(result.worktrees).toHaveLength(2);
		expect(result.worktrees.map(w => w.laneNumber)).toEqual([1, 2]);
	});

	test("reuses existing lane via safeReset when target HEAD changed", () => {
		const config = mkConfig();
		const first = createWorktree(
			{ laneNumber: 1, batchId: BATCH_ID, baseBranch: "main", prefix: "mission-wt", opId: OP_ID, config },
			repo,
		);
		const originalPath = first.path;

		// Advance main so resetWorktree has a different target than the lane HEAD.
		writeFileSync(join(repo, "f.txt"), "y\n");
		gitOrThrow(["add", "."], repo);
		gitOrThrow(["commit", "-q", "-m", "advance"], repo);
		const newMainHead = gitRun(["rev-parse", "main"], repo).stdout.trim();

		const result = ensureLaneWorktrees([1], BATCH_ID, config, repo, "main");
		expect(result.success).toBe(true);
		expect(result.worktrees).toHaveLength(1);
		expect(resolve(result.worktrees[0].path)).toBe(resolve(originalPath));

		const reusedHead = gitRun(["rev-parse", "HEAD"], result.worktrees[0].path).stdout.trim();
		expect(reusedHead).toBe(newMainHead);
	});

	test("deduplicates + sorts laneNumbers in output", () => {
		const result = ensureLaneWorktrees([2, 1, 2], BATCH_ID, mkConfig(), repo, "main");
		expect(result.success).toBe(true);
		expect(result.worktrees.map(w => w.laneNumber)).toEqual([1, 2]);
	});
});

describe("removeAllWorktrees", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("removes every lane in a batch + cleans empty container", () => {
		const config = mkConfig();
		createLaneWorktrees(2, BATCH_ID, config, repo, "main");

		const containerPath = generateBatchContainerPath(OP_ID, BATCH_ID, repo, config);
		expect(existsSync(containerPath)).toBe(true);

		const result = removeAllWorktrees("mission-wt", repo, OP_ID, undefined, BATCH_ID, config);
		expect(result.totalAttempted).toBe(2);
		expect(result.removed).toHaveLength(2);
		expect(result.failed).toHaveLength(0);

		// Container + base worktrees dir should be gone (empty after removal).
		expect(existsSync(containerPath)).toBe(false);
	});

	test("preserves lane branch with unmerged commits as saved/<branch>", () => {
		const config = mkConfig();
		const { worktrees } = createLaneWorktrees(1, BATCH_ID, config, repo, "main");
		const wt = worktrees[0];

		// Make a commit inside the lane that's NOT on main.
		writeFileSync(join(wt.path, "lane.txt"), "lane\n");
		gitOrThrow(["add", "."], wt.path);
		gitOrThrow(["commit", "-q", "-m", "lane work"], wt.path);

		const result = removeAllWorktrees("mission-wt", repo, OP_ID, "main", BATCH_ID, config);
		expect(result.removed).toHaveLength(1);
		expect(result.preserved).toHaveLength(1);
		expect(result.preserved[0].branch).toBe(wt.branch);
		expect(result.preserved[0].savedBranch).toBe(`saved/${wt.branch}`);
		expect(branchExists(`saved/${wt.branch}`, repo)).toBe(true);
		expect(branchExists(wt.branch, repo)).toBe(false);
	});

	test("no-op when no matching worktrees exist", () => {
		const result = removeAllWorktrees("mission-wt", repo, OP_ID, undefined, BATCH_ID, mkConfig());
		expect(result.totalAttempted).toBe(0);
		expect(result.removed).toHaveLength(0);
		expect(result.failed).toHaveLength(0);
	});
});

describe("safeResetWorktree", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("succeeds on a clean worktree when target advances", () => {
		const config = mkConfig();
		const { worktrees } = createLaneWorktrees(1, BATCH_ID, config, repo, "main");
		const wt = worktrees[0];

		writeFileSync(join(repo, "advance.txt"), "x\n");
		gitOrThrow(["add", "."], repo);
		gitOrThrow(["commit", "-q", "-m", "advance"], repo);

		const result = safeResetWorktree(wt, "main", repo);
		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
	});

	test("recovers from WORKTREE_DIRTY via checkout + clean retry", () => {
		const config = mkConfig();
		const { worktrees } = createLaneWorktrees(1, BATCH_ID, config, repo, "main");
		const wt = worktrees[0];

		// Dirty the worktree: modify tracked file + add untracked file.
		writeFileSync(join(wt.path, "README.md"), "dirty\n");
		writeFileSync(join(wt.path, "stray.txt"), "untracked\n");

		// Advance main so reset has a new target.
		writeFileSync(join(repo, "advance.txt"), "x\n");
		gitOrThrow(["add", "."], repo);
		gitOrThrow(["commit", "-q", "-m", "advance"], repo);

		const result = safeResetWorktree(wt, "main", repo);
		expect(result.success).toBe(true);
		// Dirty files discarded.
		expect(existsSync(join(wt.path, "stray.txt"))).toBe(false);
	});
});

describe("forceCleanupWorktree", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("removes the worktree dir, deletes branch, and cleans empty container", () => {
		const config = mkConfig();
		const { worktrees } = createLaneWorktrees(1, BATCH_ID, config, repo, "main");
		const wt = worktrees[0];

		expect(existsSync(wt.path)).toBe(true);
		expect(branchExists(wt.branch, repo)).toBe(true);

		forceCleanupWorktree(wt, repo, BATCH_ID);

		expect(existsSync(wt.path)).toBe(false);
		expect(branchExists(wt.branch, repo)).toBe(false);

		const containerPath = generateBatchContainerPath(OP_ID, BATCH_ID, repo, config);
		expect(existsSync(containerPath)).toBe(false);
	});

	test("no-op on missing worktree directory (still prunes + tries branch delete)", () => {
		const config = mkConfig();
		const { worktrees } = createLaneWorktrees(1, BATCH_ID, config, repo, "main");
		const wt = worktrees[0];

		// Externally nuke the worktree dir so forceCleanup sees a missing path.
		rmSync(wt.path, { recursive: true, force: true });

		// Does not throw; cleans up git state.
		forceCleanupWorktree(wt, repo, BATCH_ID);

		expect(existsSync(wt.path)).toBe(false);
		expect(branchExists(wt.branch, repo)).toBe(false);
	});

	test("leaves non-empty container intact", () => {
		const config = mkConfig();
		const { worktrees } = createLaneWorktrees(2, BATCH_ID, config, repo, "main");
		const wt1 = worktrees[0];

		forceCleanupWorktree(wt1, repo, BATCH_ID);

		// Container still holds lane-2 — must not be removed.
		const containerPath = generateBatchContainerPath(OP_ID, BATCH_ID, repo, config);
		expect(existsSync(containerPath)).toBe(true);
		expect(readdirSync(containerPath)).toContain("lane-2");
	});
});
