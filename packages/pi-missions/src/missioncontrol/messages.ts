/**
 * User-facing message templates (MISSION_MESSAGES).
 *
 * Ported from taskplane `extensions/taskplane/messages.ts` lines 14–163.
 * Only the pure string-template object is kept — the merge-retry policy and
 * repo-outcome helpers that follow the object in taskplane depend on
 * heavy unported types and land with the merge module.
 *
 * Renames applied:
 *   taskplane → missioncontrol / mission
 *   /orch          → /mission-batch
 *   /orch-pause    → /mission-batch-pause
 *   /orch-resume   → /mission-batch-resume
 *   /orch-abort    → /mission-abort
 *   /orch-status   → /mission-status
 *   /orch-sessions → /mission-list
 *   /orch-integrate→ /mission-integrate
 *   .pi/batch-state.json → .omp/mission-batch.json
 *   orchestrator session → mission session
 *   orch branch → mission branch
 */

import type { AbortMode, IntegrateCleanupRepoFindings, IntegrateCleanupResult } from "./types";

export const MISSION_MESSAGES = {
	// /mission-batch
	batchStarting: (batchId: string, waves: number, tasks: number) =>
		`🚀 Starting batch ${batchId}: ${waves} wave(s), ${tasks} task(s)`,
	waveStart: (waveNum: number, totalWaves: number, tasks: number, lanes: number) =>
		`\n🌊 Wave ${waveNum}/${totalWaves}: ${tasks} task(s) across ${lanes} lane(s)`,
	waveComplete: (waveNum: number, succeeded: number, failed: number, skipped: number, elapsedSec: number) =>
		`✅ Wave ${waveNum} complete: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped (${elapsedSec}s)`,
	mergeStart: (waveNum: number, laneCount: number) =>
		`🔀 [Wave ${waveNum}] Merging ${laneCount} lane(s) into target branch...`,
	mergeLaneSuccess: (laneNum: number, commit: string, durationSec: number) =>
		`  ✅ Lane ${laneNum} merged (${commit.slice(0, 8)}, ${durationSec}s)`,
	mergeLaneConflictResolved: (laneNum: number, conflictCount: number, durationSec: number) =>
		`  ⚡ Lane ${laneNum} merged with ${conflictCount} auto-resolved conflict(s) (${durationSec}s)`,
	mergeLaneFailed: (laneNum: number, reason: string) => `  ❌ Lane ${laneNum} merge failed: ${reason}`,
	mergeComplete: (waveNum: number, mergedCount: number, totalSec: number) =>
		`🔀 [Wave ${waveNum}] Merge complete: ${mergedCount} lane(s) merged (${totalSec}s)`,
	mergeFailed: (waveNum: number, laneNum: number, reason: string) =>
		`❌ [Wave ${waveNum}] Merge failed at lane ${laneNum}: ${reason}`,
	mergeSkipped: (waveNum: number) => `📝 [Wave ${waveNum}] No successful lanes to merge`,
	worktreeReset: (waveNum: number, lanes: number) =>
		`🔄 Resetting ${lanes} worktree(s) to target branch HEAD after wave ${waveNum}`,
	batchComplete: (
		batchId: string,
		succeeded: number,
		failed: number,
		skipped: number,
		blocked: number,
		elapsedSec: number,
		missionBranch?: string,
		baseBranch?: string,
	) => {
		const lines = [
			`\n🏁 Batch ${batchId} complete: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped, ${blocked} blocked (${elapsedSec}s)`,
		];
		if (failed > 0 || blocked > 0) {
			lines.push("");
			if (blocked > 0) {
				lines.push(`   ${blocked} task(s) were blocked because upstream tasks failed.`);
			}
			lines.push("   Next steps:");
			lines.push("   • /mission-status        — review what failed and why");
			lines.push("   • /mission-batch-resume  — retry from the failed wave");
			lines.push("   • /mission-abort         — clean up and start fresh");
		}
		if (missionBranch && succeeded > 0) {
			lines.push("");
			lines.push("   ┌─────────────────────────────────────────────────┐");
			lines.push(`   │  Your changes are on branch: ${missionBranch}`);
			lines.push(`   │  Your ${baseBranch || "working"} branch was not modified.`);
			if (baseBranch) {
				lines.push(`   │  Preview: git log ${baseBranch}..${missionBranch}`);
			}
			lines.push("   │");
			lines.push("   │  👉 To bring changes into your working branch:");
			lines.push("   │");
			lines.push("   │    /mission-integrate        — merge directly (recommended)");
			lines.push("   │    /mission-integrate --pr   — create a pull request");
			lines.push("   └─────────────────────────────────────────────────┘");
		}
		return lines.join("\n");
	},
	batchFailed: (batchId: string, reason: string) => `\n❌ Batch ${batchId} failed: ${reason}`,
	batchStopped: (batchId: string, policy: string) => `\n⛔ Batch ${batchId} stopped by ${policy} policy`,

	// /mission-batch-pause
	pauseNoBatch: () => "No active batch is running. Use /mission-batch <areas|all> to start.",
	pauseAlreadyPaused: (batchId: string) => `Batch ${batchId} is already paused.`,
	pauseActivated: (batchId: string) =>
		`⏸️  Pausing batch ${batchId}... lanes will stop after their current tasks complete.`,

	// /mission-list
	sessionsNone: () => "No active mission sessions found.",
	sessionsHeader: (count: number) => `🖥️  ${count} mission session(s):`,

	// /mission-batch — orphan detection
	orphanDetectionResume: (batchId: string, sessionCount: number) =>
		`🔄 Found ${sessionCount} running mission session(s) from batch ${batchId}.\n` +
		`   Use /mission-batch-resume to continue, or /mission-abort to clean up.`,
	orphanDetectionAbort: (sessionCount: number) =>
		`⚠️ Found ${sessionCount} orphan mission session(s) without usable state.\n` +
		`   Use /mission-abort to clean up before starting a new batch.`,
	orphanDetectionCleanup: () => `🧹 Cleaned up stale batch state file. Starting fresh.`,

	// /mission-batch-resume
	resumeStarting: (batchId: string, phase: string) => `🔄 Resuming batch ${batchId} (was: ${phase})...`,
	resumeReconciled: (
		batchId: string,
		completed: number,
		pending: number,
		failed: number,
		reconnecting: number,
		reExecuting: number = 0,
	) =>
		`📊 Batch ${batchId} reconciliation: ${completed} completed, ${pending} pending, ${failed} failed, ${reconnecting} reconnecting` +
		(reExecuting > 0 ? `, ${reExecuting} re-executing` : ""),
	resumeSkippedWaves: (skippedCount: number) => `⏭️  Skipping ${skippedCount} completed wave(s)`,
	resumeReconnecting: (sessionCount: number) => `🔗 Reconnecting to ${sessionCount} alive session(s)...`,
	resumeNoState: () =>
		`❌ No batch to resume. No mission-batch.json file found.\n` +
		`   Use /mission-batch <areas|all> to start a new batch.`,
	resumeInvalidState: (error: string) =>
		`❌ Cannot resume: batch state file is invalid.\n` +
		`   Error: ${error}\n` +
		`   Delete .omp/mission-batch.json and start a new batch.`,
	resumePhaseNotResumable: (batchId: string, phase: string, reason: string) =>
		`❌ Cannot resume batch ${batchId} (phase: ${phase}).\n   ${reason}`,
	resumeComplete: (
		batchId: string,
		succeeded: number,
		failed: number,
		skipped: number,
		blocked: number,
		elapsedSec: number,
	) =>
		`\n🏁 Resumed batch ${batchId} complete: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped, ${blocked} blocked (${elapsedSec}s total)`,

	// /mission-batch-resume --force
	forceResumeStarting: (batchId: string, phase: string) =>
		`⚠️ Force-resuming batch ${batchId} from ${phase} state. Running pre-resume diagnostics...`,
	forceResumeDiagnosticsFailed: (batchId: string) =>
		`❌ Cannot force-resume batch ${batchId}: pre-resume diagnostics failed.\n` +
		`   Fix the issues above, then retry /mission-batch-resume --force.`,

	// /mission-abort
	abortGracefulStarting: (batchId: string, sessionCount: number) =>
		`⏳ Graceful abort of batch ${batchId}: signaling ${sessionCount} session(s) to checkpoint and exit...`,
	abortGracefulWaiting: (_batchId: string, graceSec: number) =>
		`⏳ Waiting up to ${graceSec}s for sessions to checkpoint and exit...`,
	abortGracefulForceKill: (count: number) => `⚠️ Force-killing ${count} session(s) that did not exit within timeout`,
	abortGracefulComplete: (batchId: string, graceful: number, forceKilled: number, durationSec: number) =>
		`✅ Graceful abort complete for batch ${batchId}: ${graceful} exited gracefully, ${forceKilled} force-killed (${durationSec}s)`,
	abortHardStarting: (batchId: string, sessionCount: number) =>
		`⚡ Hard abort of batch ${batchId}: killing ${sessionCount} session(s) immediately...`,
	abortHardComplete: (batchId: string, killed: number, durationSec: number) =>
		`✅ Hard abort complete for batch ${batchId}: ${killed} session(s) killed (${durationSec}s)`,
	abortPartialFailure: (failureCount: number) => `⚠️ ${failureCount} error(s) during abort (see details above)`,
	abortNoBatch: () => `No active batch to abort. Use /mission-batch <areas|all> to start a batch.`,
	abortComplete: (mode: AbortMode, sessionsKilled: number) =>
		`🏁 Abort (${mode}) complete: ${sessionsKilled} session(s) terminated. Worktrees and branches preserved.`,

	// /mission-batch merge — repo-scoped partial summary
	mergePartialRepoSummary: (waveNum: number, repoLines: string[]) =>
		`⚠️ [Wave ${waveNum}] Merge partially succeeded — repo outcomes diverged:\n${repoLines.join("\n")}`,

	// /mission-integrate — post-batch integration guidance
	integrationAutoSuccess: (missionBranch: string, baseBranch: string) =>
		`✅ Auto-integrated: ${baseBranch} fast-forwarded to ${missionBranch}.`,
	integrationAutoFailed: (missionBranch: string, baseBranch: string, reason: string) =>
		`⚠️ Auto-integration skipped: ${reason}\n` +
		`   Mission branch ${missionBranch} preserved. Integrate manually:\n` +
		`   git log ${baseBranch}..${missionBranch}\n` +
		`   git merge ${missionBranch}`,
	integrationManual: (missionBranch: string, baseBranch: string, mergedTaskCount: number) => {
		const lines = [
			`ℹ️ Batch complete. Mission branch ${missionBranch} has ${mergedTaskCount} merged task(s).`,
			`   Review and integrate:`,
			`   git log ${baseBranch}..${missionBranch}`,
			`   git merge ${missionBranch}`,
		];
		return lines.join("\n");
	},
} as const;

/**
 * Compute the /mission-integrate cleanup verdict from per-repo findings.
 *
 * Pure — no I/O. The acceptance criteria:
 *   1. No lane worktrees remain registered under any workspace repo.
 *   2. No lane branches remain (`task/{opId}-lane-*`).
 *   3. No mission branches remain (`orch/{opId}-{batchId}`) — skipped
 *      in PR mode where callers intentionally preserve the branch.
 *   4. No batch-scoped autostash entries remain.
 *   5. No non-empty `.worktrees/` containers remain.
 */
export function computeIntegrateCleanupResult(repoFindings: IntegrateCleanupRepoFindings[]): IntegrateCleanupResult {
	const dirtyRepos = repoFindings.filter(
		r =>
			r.staleWorktrees.length > 0 ||
			r.staleLaneBranches.length > 0 ||
			r.staleOrchBranches.length > 0 ||
			r.staleAutostashEntries.length > 0 ||
			r.nonEmptyWorktreeContainers.length > 0,
	);

	if (dirtyRepos.length === 0) {
		return {
			clean: true,
			notifyLevel: "info",
			dirtyRepos: [],
			report: "🧹 Cleanup verified: no stale worktrees, branches, or autostash entries remain.",
		};
	}

	const details: string[] = [];
	for (const repo of dirtyRepos) {
		const label = repo.repoId ?? "(default)";
		const issues: string[] = [];
		if (repo.staleWorktrees.length > 0) {
			issues.push(`${repo.staleWorktrees.length} stale worktree(s)`);
		}
		if (repo.staleLaneBranches.length > 0) {
			issues.push(`${repo.staleLaneBranches.length} lane branch(es)`);
		}
		if (repo.staleOrchBranches.length > 0) {
			issues.push(`${repo.staleOrchBranches.length} mission branch(es)`);
		}
		if (repo.staleAutostashEntries.length > 0) {
			issues.push(`${repo.staleAutostashEntries.length} autostash entr(ies)`);
		}
		if (repo.nonEmptyWorktreeContainers.length > 0) {
			issues.push(`${repo.nonEmptyWorktreeContainers.length} non-empty .worktrees/ container(s)`);
		}
		details.push(`  ${label}: ${issues.join(", ")}`);
	}

	const recovery: string[] = [];
	for (const repo of dirtyRepos) {
		const label = repo.repoId ?? "default";
		for (const wt of repo.staleWorktrees) {
			recovery.push(`  git worktree remove --force "${wt}"  # repo: ${label}`);
		}
		for (const br of repo.staleLaneBranches) {
			recovery.push(`  git branch -D "${br}"  # repo: ${label}`);
		}
		for (const br of repo.staleOrchBranches) {
			recovery.push(`  git branch -D "${br}"  # repo: ${label}`);
		}
		for (const entry of repo.staleAutostashEntries) {
			recovery.push(`  git stash drop "${entry}"  # repo: ${label}`);
		}
	}

	const report =
		`⚠️ Cleanup incomplete — residual artifacts found:\n${details.join("\n")}` +
		(recovery.length > 0 ? `\n  Manual cleanup:\n${recovery.join("\n")}` : "");

	return {
		clean: false,
		notifyLevel: "warning",
		dirtyRepos,
		report,
	};
}
