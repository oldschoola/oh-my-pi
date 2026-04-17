/**
 * /mission-integrate per-repo cleanup scanner.
 *
 * Ported from `taskplane/extensions/taskplane/extension.ts:690-782`.
 * Pure over git stdout + filesystem reads — the caller aggregates findings
 * across workspace repos and feeds them into
 * `computeIntegrateCleanupResult` (pure, in `messages.ts`) to build the
 * user-facing report.
 *
 * Acceptance-check surfaces:
 *   1. Stale lane worktrees still registered under `git worktree list`
 *   2. Lane branches: `task/{opId}-lane-*` + `saved/task/{opId}-lane-*`
 *   3. The specific mission branch still existing — skipped via
 *      `skipOrchBranch` in PR mode so the branch survives for the PR.
 *   4. Batch-scoped autostash entries (both `orch-integrate-autostash-*`
 *      and `merge-agent-autostash-w*-*` subjects). The
 *      `orch-integrate-autostash-` prefix is preserved verbatim for
 *      cross-version compat with stashes created before the mission
 *      rename.
 *   5. Non-empty `.worktrees/` containers (subdirectory layout only —
 *      sibling layout has no container directory to detect).
 *
 * Every git/fs call is wrapped in try/catch — best-effort scanning,
 * never a hard error, because the caller runs this after a successful
 * integrate and must not mask the user's primary outcome.
 */

import { existsSync, readdirSync } from "node:fs";

import { runGit } from "./git";
import type { IntegrateCleanupRepoFindings, OrchestratorConfig } from "./types";
import { escapeRegex, listWorktrees, resolveWorktreeBasePath } from "./worktree";

/**
 * Scan a single repo for residual mission artifacts.
 *
 * @param repoRoot - Absolute path to the repo being inspected.
 * @param repoId - Workspace repo ID (undefined for single-repo mode).
 * @param opId - Operator identifier used to scope lane/mission branches.
 * @param batchId - Batch identifier used to scope autostash subjects.
 * @param worktreePrefix - Configured worktree prefix (e.g. `mission-wt`).
 * @param orchBranch - Mission branch name whose existence we want to check.
 * @param orchConfig - Full orchestrator config — only `worktree_location` is consulted.
 * @param options.skipOrchBranch - Suppress the mission-branch existence check.
 */
export function collectRepoCleanupFindings(
	repoRoot: string,
	repoId: string | undefined,
	opId: string,
	batchId: string,
	worktreePrefix: string,
	orchBranch: string,
	orchConfig: OrchestratorConfig,
	options?: { skipOrchBranch?: boolean },
): IntegrateCleanupRepoFindings {
	const findings: IntegrateCleanupRepoFindings = {
		repoRoot,
		repoId,
		staleWorktrees: [],
		staleLaneBranches: [],
		staleOrchBranches: [],
		staleAutostashEntries: [],
		nonEmptyWorktreeContainers: [],
	};

	try {
		const wts = listWorktrees(worktreePrefix, repoRoot, opId, batchId);
		findings.staleWorktrees = wts.map(wt => wt.path);
	} catch {
		/* best effort — git worktree list may fail in unusual states */
	}

	try {
		const branchResult = runGit(["branch", "--list", `task/${opId}-lane-*`], repoRoot);
		if (branchResult.ok && branchResult.stdout.trim()) {
			findings.staleLaneBranches = branchResult.stdout
				.split("\n")
				.map(b => b.replace(/^\*?\s+/, "").trim())
				.filter(Boolean);
		}
		const savedBranchResult = runGit(["branch", "--list", `saved/task/${opId}-lane-*`], repoRoot);
		if (savedBranchResult.ok && savedBranchResult.stdout.trim()) {
			const savedBranches = savedBranchResult.stdout
				.split("\n")
				.map(b => b.replace(/^\*?\s+/, "").trim())
				.filter(Boolean);
			findings.staleLaneBranches.push(...savedBranches);
		}
	} catch {
		/* best effort */
	}

	if (!options?.skipOrchBranch) {
		try {
			const orchCheck = runGit(["rev-parse", "--verify", `refs/heads/${orchBranch}`], repoRoot);
			if (orchCheck.ok) {
				findings.staleOrchBranches = [orchBranch];
			}
		} catch {
			/* best effort */
		}
	}

	if (batchId) {
		try {
			const stashList = runGit(["stash", "list", "--format=%gd %s"], repoRoot);
			if (stashList.ok && stashList.stdout.trim()) {
				const integrateSubstring = `orch-integrate-autostash-${batchId}`;
				const mergePattern = new RegExp(`merge-agent-autostash-w\\d+-${escapeRegex(batchId)}`);
				for (const line of stashList.stdout.trim().split("\n")) {
					const match = line.match(/^stash@\{(\d+)\}\s+(.*)$/);
					if (!match) continue;
					const subject = match[2];
					if (subject.includes(integrateSubstring) || mergePattern.test(subject)) {
						findings.staleAutostashEntries.push(match[1]);
					}
				}
			}
		} catch {
			/* best effort */
		}
	}

	if (orchConfig.orchestrator.worktree_location !== "sibling") {
		try {
			const basePath = resolveWorktreeBasePath(repoRoot, orchConfig);
			if (existsSync(basePath)) {
				const entries = readdirSync(basePath);
				if (entries.length > 0) {
					findings.nonEmptyWorktreeContainers = [basePath];
				}
			}
		} catch {
			/* best effort */
		}
	}

	return findings;
}
