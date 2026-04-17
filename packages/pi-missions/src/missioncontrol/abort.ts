/**
 * Mission abort logic (graceful + hard).
 *
 * Ported from `taskplane/extensions/taskplane/abort.ts` (502 LOC).
 * Pure target-selection and action-planning helpers stay verbatim;
 * orchestration glue swaps taskplane's sync Node I/O for Bun-native
 * I/O and delegates agent kills to the Runtime V2 `killers` stub
 * module (real impls land with the execution + merge ports).
 *
 * Identifier renames: default session prefix `orch` → `mission`,
 * log contexts mirror taskplane (`abort`), wrap-up signal filename
 * stays `.task-wrap-up` (consumed by workers via contract).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { killAllMergeAgentsV2, killMergeAgentV2, killV2LaneAgents } from "./killers";
import { execLog } from "./log";
import { deleteBatchState, persistRuntimeState } from "./persistence";
import { resolveCanonicalTaskPaths } from "./task-paths";
import type {
	AbortActionStep,
	AbortErrorCode,
	AbortLaneResult,
	AbortMode,
	AbortResult,
	AbortTargetSession,
	AllocatedLane,
	MissionBatchRuntimeState,
	PersistedBatchState,
	PersistedLaneRecord,
} from "./types";

// ── Abort pure functions ─────────────────────────────────────────────

/**
 * Select and enrich target sessions for abort.
 *
 * Filters sessions to only `<prefix>-lane-*` and `<prefix>-merge-*`
 * patterns (plus workspace-mode `<prefix>-<repoId>-lane-*` variants),
 * then enriches with task folder + worktree info from persisted or
 * runtime state.
 *
 * Pure — no side effects.
 */
export function selectAbortTargetSessions(
	allSessionNames: string[],
	persistedState: PersistedBatchState | null,
	runtimeLanes: AllocatedLane[],
	repoRoot: string,
	prefix: string = "mission",
): AbortTargetSession[] {
	const targetNames = allSessionNames.filter(name => {
		const prefixWithDash = `${prefix}-`;
		if (!name.startsWith(prefixWithDash)) return false;
		const suffix = name.slice(prefixWithDash.length);
		if (suffix.startsWith("lane-") || suffix.startsWith("merge-")) return true;
		if (/-lane-\d/.test(suffix) || /-merge-\d/.test(suffix)) return true;
		return false;
	});

	// Workspace-aware laneId: source from persisted lane records, keyed
	// by lane session ID (not reconstructed from laneNumber).
	const persistedLaneLookup = new Map<string, PersistedLaneRecord>();
	if (persistedState?.lanes) {
		for (const lane of persistedState.lanes) {
			persistedLaneLookup.set(lane.laneSessionId, lane);
		}
	}

	const persistedLookup = new Map<string, { laneId: string; taskId: string; taskFolder: string }>();
	if (persistedState) {
		for (const task of persistedState.tasks) {
			if (task.sessionName) {
				const laneRecord = persistedLaneLookup.get(task.sessionName);
				const laneId = laneRecord?.laneId ?? `lane-${task.laneNumber}`;
				persistedLookup.set(task.sessionName, {
					laneId,
					taskId: task.taskId,
					taskFolder: task.taskFolder,
				});
			}
		}
	}

	const runtimeLookup = new Map<
		string,
		{ laneId: string; taskId: string | null; worktreePath: string; taskFolder: string | null }
	>();
	for (const lane of runtimeLanes) {
		const currentTask = lane.tasks.length > 0 ? lane.tasks[0] : null;
		runtimeLookup.set(lane.laneSessionId, {
			laneId: lane.laneId,
			taskId: currentTask?.taskId || null,
			worktreePath: lane.worktreePath,
			// Guard against null task stubs from lane reconstruction.
			taskFolder: currentTask?.task?.taskFolder || null,
		});
	}

	return targetNames.map(sessionName => {
		const runtime = runtimeLookup.get(sessionName);
		const persisted = persistedLookup.get(sessionName);

		const laneId = runtime?.laneId || persisted?.laneId || "unknown";
		const taskId = runtime?.taskId || persisted?.taskId || null;
		const worktreePath = runtime?.worktreePath || null;
		const taskFolder = runtime?.taskFolder || persisted?.taskFolder || null;

		let taskFolderInWorktree: string | null = null;
		if (taskFolder && worktreePath && repoRoot) {
			const resolved = resolveCanonicalTaskPaths(taskFolder, worktreePath, repoRoot);
			taskFolderInWorktree = resolved.taskFolderResolved;
		}

		return {
			sessionName,
			laneId,
			taskId,
			taskFolderInWorktree,
			worktreePath,
		};
	});
}

/** Plan the ordered list of abort actions based on mode. Pure. */
export function planAbortActions(
	mode: AbortMode,
	gracePeriodMs: number = 60_000,
	pollIntervalMs: number = 2_000,
): AbortActionStep[] {
	if (mode === "hard") {
		return [{ type: "kill-all" }];
	}
	return [{ type: "write-wrapup" }, { type: "poll-wait", gracePeriodMs, pollIntervalMs }, { type: "kill-remaining" }];
}

/**
 * Discover abort target session names from Runtime V2 state sources.
 *
 * Sources (deduped): in-memory runtime lanes, persisted lane records,
 * and persisted task records. Names are trimmed and filtered to the
 * configured prefix.
 */
export function discoverAbortSessionNames(
	prefix: string,
	persistedState: PersistedBatchState | null,
	runtimeLanes: AllocatedLane[],
): string[] {
	const names = new Set<string>();
	const prefixWithDash = `${prefix}-`;
	const add = (name: string | null | undefined): void => {
		if (!name) return;
		const trimmed = name.trim();
		if (!trimmed?.startsWith(prefixWithDash)) return;
		names.add(trimmed);
	};

	for (const lane of runtimeLanes) {
		add(lane.laneSessionId);
	}

	if (persistedState?.lanes) {
		for (const lane of persistedState.lanes) {
			add(lane.laneSessionId);
		}
	}

	if (persistedState?.tasks) {
		for (const task of persistedState.tasks) {
			add(task.sessionName);
		}
	}

	return [...names];
}

// ── Abort orchestration functions ────────────────────────────────────

/**
 * Write wrap-up signal files to each lane's task folder.
 *
 * Writes `.task-wrap-up` inside each target's resolved worktree task
 * folder. Continues on partial failure — aggregates per-target errors.
 * Merge sessions and worker/reviewer child sessions are skipped (they
 * have no task folder).
 */
export async function writeWrapUpFiles(
	targets: AbortTargetSession[],
): Promise<Array<{ sessionName: string; written: boolean; error: string | null }>> {
	const timestamp = new Date().toISOString();
	const content = `Abort requested at ${timestamp}`;
	const results: Array<{ sessionName: string; written: boolean; error: string | null }> = [];

	for (const target of targets) {
		if (!target.taskFolderInWorktree) {
			if (
				target.sessionName.endsWith("-worker") ||
				target.sessionName.endsWith("-reviewer") ||
				target.sessionName.includes("merge")
			) {
				results.push({ sessionName: target.sessionName, written: false, error: null });
			} else {
				results.push({ sessionName: target.sessionName, written: false, error: "No task folder resolved" });
			}
			continue;
		}

		try {
			// Directory existence — Bun.file() models a file handle, not a
			// directory entry, so fall through to node:fs.existsSync for
			// the folder probe (cross-platform, no I/O side effects).
			if (!existsSync(target.taskFolderInWorktree)) {
				results.push({
					sessionName: target.sessionName,
					written: false,
					error: `Task folder does not exist: ${target.taskFolderInWorktree}`,
				});
				continue;
			}

			const primaryPath = join(target.taskFolderInWorktree, ".task-wrap-up");
			await Bun.write(primaryPath, content);
			results.push({ sessionName: target.sessionName, written: true, error: null });
		} catch (err) {
			results.push({
				sessionName: target.sessionName,
				written: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return results;
}

/**
 * Wait for graceful shutdown window to elapse.
 *
 * Runtime V2 no longer relies on TMUX session liveness as an abort
 * signal. The grace window lets workers observe `.task-wrap-up` and
 * exit naturally before forced cleanup. Always returns all sessions
 * as remaining (workers report their own exit via registry; the
 * engine's exit-intercept event is the authoritative signal).
 */
export async function waitForSessionExit(
	sessionNames: string[],
	gracePeriodMs: number,
	pollIntervalMs: number,
): Promise<{ exited: string[]; remaining: string[] }> {
	if (sessionNames.length === 0 || gracePeriodMs <= 0) {
		return { exited: [], remaining: [...sessionNames] };
	}

	const deadline = Date.now() + gracePeriodMs;
	while (Date.now() < deadline) {
		const sleepMs = Math.max(1, Math.min(pollIntervalMs, deadline - Date.now()));
		await new Promise(r => setTimeout(r, sleepMs));
	}

	return { exited: [], remaining: [...sessionNames] };
}

/**
 * Kill mission Runtime V2 agents.
 *
 * Kills lane worker/reviewer agents and merge agents by process handle.
 * Session names are normalized to base lane/merge IDs so child suffixes
 * (-worker, -reviewer) do not trigger duplicate cleanup attempts.
 */
export function killOrchSessions(
	sessionNames: string[],
	options?: { stateRoot?: string; batchId?: string },
): Array<{ sessionName: string; killed: boolean; error: string | null }> {
	const results: Array<{ sessionName: string; killed: boolean; error: string | null }> = [];
	const killedBaseSessions = new Set<string>();

	for (const name of sessionNames) {
		const baseSessionName = name.replace(/-(worker|reviewer)$/, "");
		if (!killedBaseSessions.has(baseSessionName)) {
			killV2LaneAgents(baseSessionName, {
				stateRoot: options?.stateRoot,
				batchId: options?.batchId,
				logContext: "abort",
			});
			killMergeAgentV2(baseSessionName);
			killedBaseSessions.add(baseSessionName);
		}

		results.push({
			sessionName: name,
			killed: true,
			error: null,
		});
	}

	return results;
}

/**
 * Execute a full abort operation.
 *
 * Phase/state transition ordering:
 *   1. Set phase to "stopped"
 *   2. Persist runtime state (so state file reflects stopped phase)
 *   3. Kill V2 merge agents (process-owned, not session-owned)
 *   4. Discover + select target sessions
 *   5. Execute mode-specific flow (graceful or hard)
 *   6. Delete batch state file
 *   7. Return AbortResult
 *
 * Non-goal: does NOT delete worktrees/branches (preserved for inspection).
 */
export async function executeAbort(
	mode: AbortMode,
	prefix: string,
	repoRoot: string,
	batchState: MissionBatchRuntimeState,
	persistedState: PersistedBatchState | null,
	gracePeriodMs: number = 60_000,
	pollIntervalMs: number = 2_000,
): Promise<AbortResult> {
	const startTime = Date.now();
	const errors: Array<{ code: AbortErrorCode; message: string }> = [];

	batchState.phase = "stopped";
	batchState.endedAt = Date.now();

	// Persist state best-effort — abort must continue even if persist fails.
	try {
		await persistRuntimeState(`abort-${mode}`, batchState, [], batchState.currentLanes, [], null, repoRoot);
	} catch (err) {
		execLog(
			"abort",
			batchState.batchId,
			`Failed to persist state during abort: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const v2MergeKilled = killAllMergeAgentsV2();
	if (v2MergeKilled > 0) {
		execLog("abort", batchState.batchId, `killed ${v2MergeKilled} V2 merge agent(s)`);
	}

	const allSessionNames = discoverAbortSessionNames(prefix, persistedState, batchState.currentLanes);
	if (allSessionNames.length === 0) {
		execLog(
			"abort",
			batchState.batchId,
			`No abort targets discovered for prefix "${prefix}" from runtime/persisted state.`,
		);
	}

	const targets = selectAbortTargetSessions(
		allSessionNames,
		persistedState,
		batchState.currentLanes,
		repoRoot,
		prefix,
	);

	const laneResults: AbortLaneResult[] = [];
	let gracefulExits = 0;
	let wrapUpFailures = 0;

	if (mode === "graceful") {
		const wrapUpResults = await writeWrapUpFiles(targets);
		for (const wr of wrapUpResults) {
			if (wr.error) wrapUpFailures++;
		}
		if (wrapUpFailures > 0) {
			errors.push({
				code: "ABORT_WRAPUP_WRITE_FAILED",
				message: `Failed to write wrap-up files for ${wrapUpFailures} session(s)`,
			});
		}

		const allTargetNames = targets.map(t => t.sessionName);
		const waitResult = await waitForSessionExit(allTargetNames, gracePeriodMs, pollIntervalMs);
		gracefulExits = waitResult.exited.length;

		const killResultBySession = new Map<string, { killed: boolean; error: string | null }>();
		if (waitResult.remaining.length > 0) {
			const killResults = killOrchSessions(waitResult.remaining, {
				stateRoot: repoRoot,
				batchId: batchState.batchId,
			});
			for (const kr of killResults) {
				killResultBySession.set(kr.sessionName, { killed: kr.killed, error: kr.error });
			}
			const killFailures = killResults.filter(kr => !kr.killed);
			if (killFailures.length > 0) {
				errors.push({
					code: "ABORT_KILL_FAILED",
					message: `Failed to kill ${killFailures.length} session(s)`,
				});
			}
		}

		const exitedSet = new Set(waitResult.exited);
		for (const target of targets) {
			const wrapUp = wrapUpResults.find(wr => wr.sessionName === target.sessionName);
			const wasGraceful = exitedSet.has(target.sessionName);
			const killResult = killResultBySession.get(target.sessionName);
			const sessionKilled = wasGraceful || killResult?.killed === true;
			laneResults.push({
				sessionName: target.sessionName,
				laneId: target.laneId,
				taskId: target.taskId,
				taskFolderInWorktree: target.taskFolderInWorktree,
				wrapUpWritten: wrapUp?.written || false,
				wrapUpError: wrapUp?.error || null,
				sessionKilled,
				exitedGracefully: wasGraceful,
			});
		}
	} else {
		const allTargetNames = targets.map(t => t.sessionName);
		const killResults = killOrchSessions(allTargetNames, {
			stateRoot: repoRoot,
			batchId: batchState.batchId,
		});
		const killResultBySession = new Map<string, { killed: boolean; error: string | null }>();
		for (const kr of killResults) {
			killResultBySession.set(kr.sessionName, { killed: kr.killed, error: kr.error });
		}
		const killFailures = killResults.filter(kr => !kr.killed);
		if (killFailures.length > 0) {
			errors.push({
				code: "ABORT_KILL_FAILED",
				message: `Failed to kill ${killFailures.length} session(s)`,
			});
		}

		for (const target of targets) {
			const killResult = killResultBySession.get(target.sessionName);
			laneResults.push({
				sessionName: target.sessionName,
				laneId: target.laneId,
				taskId: target.taskId,
				taskFolderInWorktree: target.taskFolderInWorktree,
				wrapUpWritten: false,
				wrapUpError: null,
				sessionKilled: killResult?.killed === true,
				exitedGracefully: false,
			});
		}
	}

	let stateDeleted = false;
	try {
		await deleteBatchState(repoRoot);
		stateDeleted = true;
	} catch (err) {
		errors.push({
			code: "ABORT_STATE_DELETE_FAILED",
			message: err instanceof Error ? err.message : String(err),
		});
	}

	return {
		mode,
		sessionsFound: targets.length,
		sessionsKilled: laneResults.filter(lr => lr.sessionKilled).length,
		gracefulExits,
		laneResults,
		wrapUpFailures,
		stateDeleted,
		errors,
		durationMs: Date.now() - startTime,
	};
}
