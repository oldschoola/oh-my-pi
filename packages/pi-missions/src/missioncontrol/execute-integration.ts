/**
 * Pure integration executor for `/mission-integrate`.
 *
 * Ported from `taskplane/extensions/taskplane/extension.ts:422-624`:
 *   - `executeIntegration` — runs ff/merge/pr mode against a resolved
 *     `IntegrationContext` with git + subprocess effects injected via
 *     `IntegrationExecDeps`.
 *   - `performCleanup` (module-local) — post-integration branch-delete +
 *     state-file teardown, with non-fatal warnings folded into the
 *     success message.
 *
 * Autostash messages written here (`orch-integrate-autostash-${batchId}`)
 * intentionally keep the legacy `orch-` prefix so the already-ported
 * `selectBatchAutostashIndices` matcher still finds them across batches
 * started on older builds.
 *
 * Error copy is rewritten to reference `/mission-integrate` instead of
 * `/orch-integrate`.
 */

import type { IntegrateMode } from "./extension-args";
import type { IntegrationContext, IntegrationExecDeps, IntegrationResult } from "./types";

export function executeIntegration(
	mode: IntegrateMode,
	context: IntegrationContext,
	deps: IntegrationExecDeps,
): IntegrationResult {
	const { orchBranch, currentBranch, batchId } = context;

	// Short-circuit: already-merged case (supervisor may have resolved conflicts manually).
	const alreadyMergedCheck = deps.runGit(["merge-base", "--is-ancestor", orchBranch, "HEAD"]);
	if (alreadyMergedCheck.ok) {
		return performCleanup(deps, orchBranch, {
			success: true,
			integratedLocally: true,
			commitCount: "0",
			message:
				`✅ Already integrated — all task work is present in \`${currentBranch}\`.\n` +
				`\n` +
				`The mission branch was merged manually (e.g., during conflict resolution) before\n` +
				`this command ran. No additional merge was needed.\n` +
				`\n` +
				`🧹 Running cleanup: removing mission branch and clearing batch state.`,
			error: "",
		});
	}

	if (mode === "ff") {
		const stashed = autostashIfDirty(deps, batchId);
		const result = deps.runGit(["merge", "--ff-only", orchBranch]);
		if (stashed) deps.runGit(["stash", "pop"]);

		if (!result.ok) {
			const protectionHint =
				result.stderr.includes("protected") || result.stderr.includes("permission")
					? "\n\n  💡 If the branch is protected, use --pr to create a pull request."
					: "";
			return {
				success: false,
				integratedLocally: false,
				commitCount: "0",
				message: "",
				error:
					"❌ Fast-forward failed — branches have diverged.\n" +
					`${result.stderr}\n\n` +
					"Try:\n" +
					"  /mission-integrate --merge    Create a merge commit\n" +
					`  /mission-integrate --pr       Create a pull request instead${protectionHint}`,
			};
		}

		return performCleanup(deps, orchBranch, {
			success: true,
			integratedLocally: true,
			commitCount: "?",
			message: `✅ Fast-forwarded ${currentBranch} to ${orchBranch}.`,
		});
	}

	if (mode === "merge") {
		const stashed = autostashIfDirty(deps, batchId);
		const result = deps.runGit(["merge", orchBranch, "--no-edit"]);
		if (stashed) deps.runGit(["stash", "pop"]);

		if (!result.ok) {
			const protectionHint =
				result.stderr.includes("protected") || result.stderr.includes("permission")
					? "\n\n  💡 If the branch is protected, use --pr to create a pull request."
					: "";
			return {
				success: false,
				integratedLocally: false,
				commitCount: "0",
				message: "",
				error:
					"❌ Merge failed — there may be conflicts.\n" +
					`${result.stderr}\n\n` +
					"Resolve conflicts manually, or try:\n" +
					`  /mission-integrate --pr       Create a pull request instead${protectionHint}`,
			};
		}

		return performCleanup(deps, orchBranch, {
			success: true,
			integratedLocally: true,
			commitCount: "?",
			message: `✅ Merged ${orchBranch} into ${currentBranch} (merge commit created).`,
		});
	}

	// PR mode
	const pushResult = deps.runGit(["push", "origin", orchBranch]);
	if (!pushResult.ok) {
		return {
			success: false,
			integratedLocally: false,
			commitCount: "0",
			message: "",
			error:
				`❌ Failed to push ${orchBranch} to origin.\n` +
				`${pushResult.stderr}\n\n` +
				"Check your remote configuration and try again.",
		};
	}

	const prTitle = batchId ? `Integrate mission batch ${batchId}` : `Integrate ${orchBranch}`;
	const ghResult = deps.runCommand("gh", [
		"pr",
		"create",
		"--base",
		currentBranch,
		"--head",
		orchBranch,
		"--title",
		prTitle,
		"--fill",
	]);
	if (!ghResult.ok) {
		return {
			success: false,
			integratedLocally: false,
			commitCount: "0",
			message: "",
			error:
				"❌ Branch pushed but PR creation failed.\n" +
				`${ghResult.stderr}\n\n` +
				`The branch ${orchBranch} is on origin — create the PR manually.`,
		};
	}

	const prUrl = ghResult.stdout.trim();
	return {
		success: true,
		integratedLocally: false,
		commitCount: "0",
		message: `✅ Pull request created for ${orchBranch} → ${currentBranch}.\n${prUrl ? `   ${prUrl}\n` : ""}\nThe mission branch has been kept (needed for the PR).`,
	};
}

/**
 * Stash dirty working tree before a merge. Workspace-mode STATUS.md edits
 * and other unversioned artifacts would otherwise block `--ff-only`.
 * Stash subject embeds the batchId so `selectBatchAutostashIndices` can
 * pick it up for cleanup on the supervisor path.
 */
function autostashIfDirty(deps: IntegrationExecDeps, batchId: string): boolean {
	const statusCheck = deps.runGit(["status", "--porcelain"]);
	if (!statusCheck.ok || !statusCheck.stdout.trim()) return false;
	deps.runGit(["stash", "push", "--include-untracked", "-m", `orch-integrate-autostash-${batchId}`]);
	return true;
}

/**
 * Post-integration cleanup: delete local mission branch and batch state
 * file. Any failure is downgraded to a warning appended to the result's
 * `message` — integration never fails because of cleanup.
 */
function performCleanup(deps: IntegrationExecDeps, orchBranch: string, result: IntegrationResult): IntegrationResult {
	const warnings: string[] = [];

	const branchDelete = deps.runGit(["branch", "-D", orchBranch]);
	if (!branchDelete.ok) {
		warnings.push(`⚠️ Could not delete local branch ${orchBranch}: ${branchDelete.stderr}`);
	}

	try {
		deps.deleteBatchState();
	} catch (err: unknown) {
		warnings.push(`⚠️ Could not clean up batch state: ${(err as Error).message}`);
	}

	if (warnings.length > 0) {
		result.message += `\n${warnings.join("\n")}`;
	}

	return result;
}
