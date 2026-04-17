/**
 * MissionControl integration executor factory + CI deps factory.
 *
 * Ports:
 *   - `buildIntegrationExecutor` — builds the `IntegrationExecutor`
 *     callback wired into the supervisor auto-integrate path and the
 *     `/mission-integrate` handler. Ensures HEAD is on the base branch
 *     before executing, runs `executeIntegration` inside
 *     `withPreservedMissionHistory`, and — on a successful ff/merge
 *     landing — fires four best-effort post-cleanup steps: stale-branch
 *     delete, autostash drop, post-integrate artifact cleanup, and a
 *     batch-history `integratedAt` marker.
 *   - `buildCiDeps` — builds the `CiDeps` bundle consumed by the
 *     programmatic CI-poll + PR-merge path (supervisor R002-2).
 *
 * Pi-missions adaptation: the taskplane originals call a synchronous
 * `deleteBatchState` + `updateBatchHistoryIntegration`. The oh-my-pi
 * equivalents are async (`Promise<void>`). The executor swallows the
 * returned promises (fire-and-forget) since both are strictly
 * best-effort — matches the source's `try { … } catch { … }` semantics.
 */

import { execFileSync } from "node:child_process";
import { cleanupPostIntegrate } from "./cleanup";
import { executeIntegration } from "./execute-integration";
import { getCurrentBranch, runGit } from "./git";
import { deleteBatchState, updateBatchHistoryIntegration } from "./persistence";
import { dropBatchAutostash, withPreservedMissionHistory } from "./post-integration";
import type { CiDeps, IntegrationExecDeps, IntegrationExecutor, IntegrationResult } from "./types";
import { deleteStaleBranches } from "./worktree";

function runCommand(cmd: string, cmdArgs: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync(cmd, cmdArgs, {
			encoding: "utf-8",
			timeout: 60_000,
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		return { ok: true, stdout, stderr: "" };
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		return {
			ok: false,
			stdout: (e.stdout ?? "").toString().trim(),
			stderr: (e.stderr ?? e.message ?? "unknown error").toString().trim(),
		};
	}
}

function fireAndForgetDelete(stateRoot: string): void {
	try {
		void deleteBatchState(stateRoot).catch(() => {
			/* best effort */
		});
	} catch {
		/* best effort */
	}
}

/**
 * Build an `IntegrationExecutor` bound to a repo root + optional
 * operator id + state root. The executor:
 *   1. Ensures HEAD is on `context.baseBranch` (checks out if not).
 *   2. Calls `executeIntegration` inside `withPreservedMissionHistory`
 *      so a transient batch-history read error never destroys the file.
 *   3. On a successful ff/merge landing — four best-effort cleanups:
 *      stale branch deletion, autostash drop, post-integrate artifact
 *      cleanup, and a batch-history `integratedAt` marker write.
 *
 * All cleanup failures are swallowed — integration success is sticky
 * once the base branch has moved.
 */
export function buildIntegrationExecutor(repoRoot: string, opId?: string, stateRoot?: string): IntegrationExecutor {
	return (mode, context) => {
		const currentBranch = getCurrentBranch(repoRoot);
		if (currentBranch && currentBranch !== context.baseBranch) {
			const checkoutResult = runGit(["checkout", context.baseBranch], repoRoot);
			if (!checkoutResult.ok) {
				const failure: IntegrationResult = {
					success: false,
					integratedLocally: false,
					commitCount: "0",
					message: "",
					error: `Failed to switch to base branch ${context.baseBranch}: ${checkoutResult.stderr}`,
				};
				return failure;
			}
		}

		const effectiveStateRoot = stateRoot ?? repoRoot;
		const deps: IntegrationExecDeps = {
			runGit: (gitArgs: string[]) => runGit(gitArgs, repoRoot),
			runCommand: (cmd: string, cmdArgs: string[]) => runCommand(cmd, cmdArgs, repoRoot),
			deleteBatchState: () => fireAndForgetDelete(effectiveStateRoot),
		};

		const result = withPreservedMissionHistory(effectiveStateRoot, () =>
			executeIntegration(mode, { ...context, currentBranch: context.baseBranch }, deps),
		);

		if (result.success && result.integratedLocally && context.batchId && opId) {
			try {
				deleteStaleBranches(repoRoot, opId, context.batchId);
				dropBatchAutostash(repoRoot, context.batchId);
			} catch {
				/* best effort — don't fail integration for cleanup errors */
			}

			try {
				cleanupPostIntegrate(effectiveStateRoot, context.batchId);
			} catch {
				/* best effort */
			}

			try {
				void updateBatchHistoryIntegration(effectiveStateRoot, context.batchId, Date.now()).catch(() => {
					/* best effort */
				});
			} catch {
				/* best effort */
			}
		}

		return result;
	};
}

/**
 * Build a `CiDeps` bundle bound to a repo root + optional state root.
 * Feeds the supervisor's programmatic CI poll + PR merge path — the
 * bundle only needs a generic subprocess runner, a git runner, and a
 * best-effort state deleter.
 */
export function buildCiDeps(repoRoot: string, stateRoot?: string): CiDeps {
	const effectiveStateRoot = stateRoot ?? repoRoot;
	return {
		runCommand: (cmd: string, cmdArgs: string[]) => runCommand(cmd, cmdArgs, repoRoot),
		runGit: (gitArgs: string[]) => runGit(gitArgs, repoRoot),
		deleteBatchState: () => fireAndForgetDelete(effectiveStateRoot),
	};
}
