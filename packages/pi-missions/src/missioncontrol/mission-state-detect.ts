/**
 * Pure project-state detector for `/mission` no-args routing.
 *
 * Ported from `taskplane/extensions/taskplane/extension.ts:1494-1643`
 * (`detectOrchState`). All filesystem / git / task-discovery I/O is
 * injected by the caller via `MissionStateDetectionDeps`, so this module
 * remains pure and unit-testable without touching disk.
 *
 * Precedence (first match wins):
 *   1. Active batch (non-terminal phase)   → `active-batch`
 *   2. Completed batch with live orch br.  → `completed-batch`
 *   2b. Orch branches exist, no state      → `completed-batch` (fallback)
 *   3. No MissionControl config            → `no-config` (onboarding)
 *   4. Pending tasks discovered            → `pending-tasks`
 *   5. Otherwise                           → `no-tasks`
 *
 * Active batch is checked before onboarding so an orphaned
 * `mission-batch.json` surfaces even when config was deleted.
 */

import { isBatchTerminal } from "./supervisor";
import type { MissionStateDetection, MissionStateDetectionDeps } from "./types";

/**
 * Detect the current project state for `/mission` no-args routing.
 *
 * Evaluates state in the strict precedence order documented on
 * `MissionProjectState`. The first matching condition wins — no further
 * checks run.
 *
 * @param deps - Injected dependencies (all I/O lives here)
 * @returns Detection result with state + supervisor-prompt context copy
 */
export function detectMissionState(deps: MissionStateDetectionDeps): MissionStateDetection {
	// ── 1. Active batch (non-terminal phase) → status report ─────
	try {
		const batchState = deps.loadBatchState();
		if (batchState && !isBatchTerminal(batchState.phase)) {
			const startedAt = batchState.startedAt ?? 0;
			const elapsed = batchState.endedAt
				? Math.round((batchState.endedAt - startedAt) / 1000)
				: Math.round((Date.now() - startedAt) / 1000);
			const waveIndex = batchState.currentWaveIndex ?? 0;
			const waveCount = batchState.taskLevelWaveCount ?? batchState.totalWaves ?? "?";

			return {
				state: "active-batch",
				batchId: batchState.batchId,
				batchPhase: batchState.phase,
				contextMessage:
					`Batch ${batchState.batchId} is currently ${batchState.phase}. ` +
					`Wave ${waveIndex + 1}/${waveCount}, ` +
					`${batchState.succeededTasks ?? 0} succeeded, ` +
					`${batchState.failedTasks ?? 0} failed, ` +
					`${batchState.skippedTasks ?? 0} skipped / ` +
					`${batchState.totalTasks ?? "?"} total. ` +
					`Elapsed: ${elapsed}s.`,
			};
		}

		// ── 2. Completed batch + live orch branch → offer integration ──
		// Validate the orch branch still exists — stale state can reference
		// a branch that was already deleted.
		if (batchState && batchState.phase === "completed" && batchState.orchBranch) {
			const existingBranches = deps.listOrchBranches();
			if (existingBranches.includes(batchState.orchBranch)) {
				return {
					state: "completed-batch",
					batchId: batchState.batchId,
					orchBranch: batchState.orchBranch,
					contextMessage:
						`Your last batch (${batchState.batchId}) completed — ` +
						`${batchState.succeededTasks ?? 0}/${batchState.totalTasks ?? "?"} tasks succeeded. ` +
						`The orch branch \`${batchState.orchBranch}\` is ready to integrate. ` +
						`Want me to create a PR to ${batchState.baseBranch}, or integrate directly?`,
				};
			}
			// Branch was deleted — fall through to remaining checks.
		}
	} catch {
		// Batch state unreadable — fall through to check for orch branches.
	}

	// ── 2b. No batch state but orch branches exist → offer integration ──
	// Covers the case where `mission-batch.json` was deleted but an orch
	// branch remains pending integration.
	const orchBranches = deps.listOrchBranches();
	if (orchBranches.length > 0) {
		const branchList = orchBranches.map(b => `\`${b}\``).join(", ");
		return {
			state: "completed-batch",
			orchBranch: orchBranches[0],
			contextMessage:
				orchBranches.length === 1
					? `I found an orch branch (${branchList}) that hasn't been integrated yet. ` +
						`Want me to integrate it, or would you like to start fresh?`
					: `I found ${orchBranches.length} orch branches (${branchList}) that haven't been integrated. ` +
						`Would you like to integrate one, or start fresh?`,
		};
	}

	// ── 3. No config exists → onboarding ─────────────────────────
	if (!deps.hasConfig()) {
		return {
			state: "no-config",
			contextMessage:
				"Welcome to MissionControl! I don't see a configuration for this project yet. " +
				"Let me help you get set up. I'll analyze your project structure, help you " +
				"define task areas, check your git branching strategy, and generate the config files.",
		};
	}

	// ── 4. Pending tasks exist → offer to start batch ────────────
	const pendingCount = deps.countPendingTasks();
	if (pendingCount > 0) {
		return {
			state: "pending-tasks",
			pendingTaskCount: pendingCount,
			contextMessage:
				`Welcome back! You have ${pendingCount} pending task${pendingCount === 1 ? "" : "s"} ready to run. ` +
				`Want me to start the batch, or would you like to review the plan first?`,
		};
	}

	// ── 5. No pending tasks → help create tasks ──────────────────
	return {
		state: "no-tasks",
		contextMessage:
			"No pending tasks right now. Here's what I can help with:\n" +
			"• Create tasks from a spec or design doc\n" +
			"• Pull in GitHub Issues\n" +
			"• Write a new spec for something you want to build\n" +
			"• Run a project health check\n" +
			"What interests you?",
	};
}
