/**
 * Tests for `/mission-integrate` cleanup helpers:
 *   - `computeIntegrateCleanupResult` — pure report builder
 *   - `collectRepoCleanupFindings`    — per-repo git/fs scanner
 *
 * The pure helper is tested with hand-built finding fixtures. The scanner
 * is exercised against ephemeral git repos so we cover the real `runGit`
 * + `listWorktrees` + `resolveWorktreeBasePath` integration.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { collectRepoCleanupFindings } from "../src/missioncontrol/integrate-cleanup";
import { computeIntegrateCleanupResult } from "../src/missioncontrol/messages";
import {
	DEFAULT_ORCHESTRATOR_CONFIG,
	type IntegrateCleanupRepoFindings,
	type OrchestratorConfig,
} from "../src/missioncontrol/types";

function mkFindings(over: Partial<IntegrateCleanupRepoFindings> = {}): IntegrateCleanupRepoFindings {
	return {
		repoRoot: "/repo",
		repoId: undefined,
		staleWorktrees: [],
		staleLaneBranches: [],
		staleOrchBranches: [],
		staleAutostashEntries: [],
		nonEmptyWorktreeContainers: [],
		...over,
	};
}

describe("computeIntegrateCleanupResult", () => {
	test("all repos clean → info + empty dirtyRepos + clean report", () => {
		const result = computeIntegrateCleanupResult([mkFindings(), mkFindings({ repoRoot: "/r2", repoId: "web" })]);
		expect(result.clean).toBe(true);
		expect(result.notifyLevel).toBe("info");
		expect(result.dirtyRepos).toEqual([]);
		expect(result.report).toContain("🧹 Cleanup verified");
	});

	test("empty input → treated as clean", () => {
		const result = computeIntegrateCleanupResult([]);
		expect(result.clean).toBe(true);
	});

	test("filters clean repos out of dirtyRepos", () => {
		const dirty = mkFindings({ repoRoot: "/r1", staleLaneBranches: ["task/h-lane-1"] });
		const clean = mkFindings({ repoRoot: "/r2", repoId: "web" });
		const result = computeIntegrateCleanupResult([clean, dirty]);
		expect(result.clean).toBe(false);
		expect(result.dirtyRepos).toHaveLength(1);
		expect(result.dirtyRepos[0]?.repoRoot).toBe("/r1");
	});

	test("default repoId formats as '(default)' in details and 'default' in recovery", () => {
		const findings = mkFindings({ staleWorktrees: ["/wt/a"] });
		const result = computeIntegrateCleanupResult([findings]);
		expect(result.report).toContain("(default): 1 stale worktree(s)");
		expect(result.report).toContain("# repo: default");
	});

	test("labels each category + renders recovery commands", () => {
		const findings = mkFindings({
			repoId: "api",
			staleWorktrees: ["/wt/1"],
			staleLaneBranches: ["task/h-lane-1", "saved/task/h-lane-1"],
			staleOrchBranches: ["orch/h-b1"],
			staleAutostashEntries: ["2"],
			nonEmptyWorktreeContainers: ["/repo/.worktrees"],
		});
		const result = computeIntegrateCleanupResult([findings]);
		expect(result.clean).toBe(false);
		expect(result.notifyLevel).toBe("warning");
		expect(result.report).toContain("api: 1 stale worktree(s), 2 lane branch(es), 1 mission branch(es)");
		expect(result.report).toContain("1 autostash entr(ies)");
		expect(result.report).toContain("1 non-empty .worktrees/ container(s)");
		expect(result.report).toContain('git worktree remove --force "/wt/1"  # repo: api');
		expect(result.report).toContain('git branch -D "task/h-lane-1"  # repo: api');
		expect(result.report).toContain('git branch -D "orch/h-b1"  # repo: api');
		expect(result.report).toContain('git stash drop "2"  # repo: api');
	});

	test("dirty without autostash entries still formats correctly", () => {
		const findings = mkFindings({ staleLaneBranches: ["task/h-lane-1"] });
		const result = computeIntegrateCleanupResult([findings]);
		expect(result.report).toContain("Manual cleanup:");
		expect(result.report).toContain('git branch -D "task/h-lane-1"');
		expect(result.report).not.toContain("git stash drop");
	});
});

// ── collectRepoCleanupFindings ─────────────────────────────────────────

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
	const dir = mkTmp("mc-cleanup");
	gitOrThrow(["init", "-q", "-b", "main"], dir);
	gitOrThrow(["config", "user.email", "t@e.invalid"], dir);
	gitOrThrow(["config", "user.name", "t"], dir);
	writeFileSync(join(dir, "README.md"), "x\n");
	gitOrThrow(["add", "."], dir);
	gitOrThrow(["commit", "-q", "-m", "init"], dir);
	return dir;
}

function siblingConfig(): OrchestratorConfig {
	return {
		...DEFAULT_ORCHESTRATOR_CONFIG,
		orchestrator: { ...DEFAULT_ORCHESTRATOR_CONFIG.orchestrator, worktree_location: "sibling" },
	};
}

describe("collectRepoCleanupFindings", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("empty repo (minus primary worktree) → no findings", () => {
		const findings = collectRepoCleanupFindings(
			repo,
			undefined,
			"henry",
			"b-1",
			"mission-wt",
			"orch/henry-b-1",
			DEFAULT_ORCHESTRATOR_CONFIG,
		);
		expect(findings.staleWorktrees).toEqual([]);
		expect(findings.staleLaneBranches).toEqual([]);
		expect(findings.staleOrchBranches).toEqual([]);
		expect(findings.staleAutostashEntries).toEqual([]);
		expect(findings.nonEmptyWorktreeContainers).toEqual([]);
	});

	test("reports lane worktree inside batch container", () => {
		const wtPath = resolve(repo, ".worktrees", "henry-b-1", "lane-1");
		mkdirSync(resolve(wtPath, ".."), { recursive: true });
		gitOrThrow(["worktree", "add", "-q", "-b", "task/henry-lane-1-b-1", wtPath], repo);

		const findings = collectRepoCleanupFindings(
			repo,
			undefined,
			"henry",
			"b-1",
			"mission-wt",
			"orch/henry-b-1",
			DEFAULT_ORCHESTRATOR_CONFIG,
		);
		expect(findings.staleWorktrees).toHaveLength(1);
		expect(findings.staleWorktrees[0]).toContain("lane-1");
		// `git branch --list` marks checked-out branches with `+`; the
		// source regex (`^\*?\s+`) only strips `*` + whitespace, so the
		// `+` prefix survives verbatim. Matches the taskplane port 1:1.
		expect(findings.staleLaneBranches.some(b => b.includes("task/henry-lane-1-b-1"))).toBe(true);
	});

	test("reports saved/task/* branches alongside live lane branches", () => {
		gitOrThrow(["branch", "task/henry-lane-2-b-1"], repo);
		gitOrThrow(["branch", "saved/task/henry-lane-2-b-1"], repo);

		const findings = collectRepoCleanupFindings(
			repo,
			undefined,
			"henry",
			"b-1",
			"mission-wt",
			"orch/henry-b-1",
			DEFAULT_ORCHESTRATOR_CONFIG,
		);
		expect(findings.staleLaneBranches).toContain("task/henry-lane-2-b-1");
		expect(findings.staleLaneBranches).toContain("saved/task/henry-lane-2-b-1");
	});

	test("detects the mission branch by default", () => {
		gitOrThrow(["branch", "orch/henry-b-1"], repo);
		const findings = collectRepoCleanupFindings(
			repo,
			undefined,
			"henry",
			"b-1",
			"mission-wt",
			"orch/henry-b-1",
			DEFAULT_ORCHESTRATOR_CONFIG,
		);
		expect(findings.staleOrchBranches).toEqual(["orch/henry-b-1"]);
	});

	test("skipOrchBranch=true suppresses mission-branch detection", () => {
		gitOrThrow(["branch", "orch/henry-b-1"], repo);
		const findings = collectRepoCleanupFindings(
			repo,
			undefined,
			"henry",
			"b-1",
			"mission-wt",
			"orch/henry-b-1",
			DEFAULT_ORCHESTRATOR_CONFIG,
			{ skipOrchBranch: true },
		);
		expect(findings.staleOrchBranches).toEqual([]);
	});

	test("captures integrate-autostash and merge-agent-autostash stash indices", () => {
		writeFileSync(join(repo, "dirty.txt"), "a\n");
		gitOrThrow(["stash", "push", "-u", "-m", "orch-integrate-autostash-b-1 snapshot"], repo);
		writeFileSync(join(repo, "dirty2.txt"), "a\n");
		gitOrThrow(["stash", "push", "-u", "-m", "merge-agent-autostash-w3-b-1"], repo);
		writeFileSync(join(repo, "dirty3.txt"), "a\n");
		gitOrThrow(["stash", "push", "-u", "-m", "unrelated-stash"], repo);

		const findings = collectRepoCleanupFindings(
			repo,
			undefined,
			"henry",
			"b-1",
			"mission-wt",
			"orch/henry-b-1",
			DEFAULT_ORCHESTRATOR_CONFIG,
		);
		// Stash order after 3 pushes: {0}=unrelated (top, unmatched),
		// {1}=merge-agent (match), {2}=orch-integrate (match).
		expect(findings.staleAutostashEntries.sort()).toEqual(["1", "2"]);
	});

	test("empty batchId skips autostash scan", () => {
		writeFileSync(join(repo, "dirty.txt"), "a\n");
		gitOrThrow(["stash", "push", "-u", "-m", "orch-integrate-autostash- snapshot"], repo);
		const findings = collectRepoCleanupFindings(
			repo,
			undefined,
			"henry",
			"",
			"mission-wt",
			"orch/henry-",
			DEFAULT_ORCHESTRATOR_CONFIG,
		);
		expect(findings.staleAutostashEntries).toEqual([]);
	});

	test("reports non-empty .worktrees/ container under subdirectory layout", () => {
		const base = resolve(repo, ".worktrees");
		mkdirSync(base, { recursive: true });
		writeFileSync(join(base, "leftover"), "x\n");

		const findings = collectRepoCleanupFindings(
			repo,
			undefined,
			"henry",
			"b-1",
			"mission-wt",
			"orch/henry-b-1",
			DEFAULT_ORCHESTRATOR_CONFIG,
		);
		expect(findings.nonEmptyWorktreeContainers).toEqual([base]);
	});

	test("sibling layout never reports the container — base path is the repo parent", () => {
		const findings = collectRepoCleanupFindings(
			repo,
			undefined,
			"henry",
			"b-1",
			"mission-wt",
			"orch/henry-b-1",
			siblingConfig(),
		);
		expect(findings.nonEmptyWorktreeContainers).toEqual([]);
	});

	test("propagates the caller-provided repoId verbatim", () => {
		const findings = collectRepoCleanupFindings(
			repo,
			"web",
			"henry",
			"b-1",
			"mission-wt",
			"orch/henry-b-1",
			DEFAULT_ORCHESTRATOR_CONFIG,
		);
		expect(findings.repoId).toBe("web");
		expect(findings.repoRoot).toBe(repo);
	});
});
