/**
 * Resume logic for paused/interrupted mission batches.
 *
 * Pure/semi-pure helpers ported from `taskplane/extensions/taskplane/resume.ts`.
 * The full execution loop (`resumeOrchBatch`) depends on the engine runtime
 * and lands after the engine.ts port — only the decision-layer functions
 * ship here.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ParsedTask } from "./discovery";
import { runGit } from "./git";
import { type ReconcileMilestoneValidatorsOptions, reconcileMilestoneValidators } from "./milestone-resume";
import { hasTaskDoneMarker } from "./persistence";
import { resolveCanonicalTaskPaths } from "./task-paths";
import type {
	AllocatedLane,
	LaneTaskStatus,
	PersistedBatchState,
	PersistedLaneRecord,
	PersistedSegmentRecord,
	ReconciledTaskState,
	ResumeEligibility,
	ResumePoint,
	WorkspaceConfig,
} from "./types";
import { resolveRepoRoot } from "./waves";

// ── Resume Repo Helpers ──────────────────────────────────────────────

/**
 * Collect unique repo roots from persisted lane records.
 *
 * In repo mode (no repoId on lanes) returns `[defaultRepoRoot]`.
 * In workspace mode returns one entry per unique repoId resolved via
 * `resolveRepoRoot`. The default root is always included as a fallback
 * for lanes without a repoId.
 */
export function collectRepoRoots(
	persistedState: PersistedBatchState,
	defaultRepoRoot: string,
	workspaceConfig?: WorkspaceConfig | null,
): string[] {
	const roots = new Set<string>();
	for (const lane of persistedState.lanes) {
		roots.add(resolveRepoRoot(lane.repoId, defaultRepoRoot, workspaceConfig));
	}
	roots.add(defaultRepoRoot);
	return [...roots];
}

/**
 * Reverse lookup: given a resolved repo root path, find its repoId in the
 * workspace config. Returns `undefined` in repo mode or when no match.
 */
export function resolveRepoIdFromRoot(repoRoot: string, workspaceConfig?: WorkspaceConfig | null): string | undefined {
	if (!workspaceConfig) return undefined;
	for (const [repoId, repoConfig] of workspaceConfig.repos) {
		if (repoConfig.path === repoRoot) return repoId;
	}
	return undefined;
}

/**
 * Reconstruct `AllocatedLane[]` from persisted lane records so lane
 * metadata (worktreePath/branch/repoId) survives across resume checkpoints.
 *
 * When `persistedTasks` is provided, repo attribution fields
 * (repoId/resolvedRepoId/taskFolder) are carried forward onto the stub
 * `ParsedTask` so serializers can emit them for archived tasks.
 */
export function reconstructAllocatedLanes(
	persistedLanes: PersistedLaneRecord[],
	persistedTasks?: PersistedBatchState["tasks"],
): AllocatedLane[] {
	const taskLookup = new Map<string, PersistedBatchState["tasks"][0]>();
	if (persistedTasks) {
		for (const t of persistedTasks) taskLookup.set(t.taskId, t);
	}

	return persistedLanes.map(lr => ({
		laneNumber: lr.laneNumber,
		laneId: lr.laneId,
		laneSessionId: lr.laneSessionId,
		worktreePath: lr.worktreePath,
		branch: lr.branch,
		tasks: lr.taskIds.map(taskId => {
			const persistedTask = taskLookup.get(taskId);
			const taskStub: Partial<ParsedTask> = {};
			if (persistedTask?.repoId !== undefined) taskStub.promptRepoId = persistedTask.repoId;
			if (persistedTask?.resolvedRepoId !== undefined) taskStub.resolvedRepoId = persistedTask.resolvedRepoId;
			// TP-169: always set taskFolder even if empty string (avoids
			// crashes on dynamic segments whose persisted records have "").
			taskStub.taskFolder = persistedTask?.taskFolder ?? "";
			if (persistedTask?.packetRepoId !== undefined) taskStub.packetRepoId = persistedTask.packetRepoId;
			if (persistedTask?.packetTaskPath !== undefined) taskStub.packetTaskPath = persistedTask.packetTaskPath;
			if (persistedTask?.segmentIds !== undefined) taskStub.segmentIds = persistedTask.segmentIds;
			if (persistedTask?.activeSegmentId !== undefined) taskStub.activeSegmentId = persistedTask.activeSegmentId;
			return {
				taskId,
				order: 0,
				task: (Object.keys(taskStub).length > 0 ? taskStub : null) as unknown as ParsedTask,
				estimatedMinutes: 0,
			};
		}),
		strategy: "round-robin" as const,
		estimatedLoad: 0,
		estimatedMinutes: 0,
		...(lr.repoId !== undefined ? { repoId: lr.repoId } : {}),
	}));
}

/**
 * Collect unique repo roots from multiple lane sources (e.g., persisted
 * lanes + newly-allocated lanes from later waves). Always includes the
 * default repo root.
 */
export function collectAllRepoRoots(
	laneSources: Array<{ repoId?: string }[]>,
	defaultRepoRoot: string,
	workspaceConfig?: WorkspaceConfig | null,
): string[] {
	const roots = new Set<string>();
	for (const lanes of laneSources) {
		for (const lane of lanes) {
			roots.add(resolveRepoRoot(lane.repoId, defaultRepoRoot, workspaceConfig));
		}
	}
	roots.add(defaultRepoRoot);
	return [...roots];
}

// ── Resume Pure Functions ────────────────────────────────────────────

/**
 * Collect task IDs with authoritative `.DONE` markers.
 *
 * Segment frontier state does NOT suppress `.DONE` authority — if a marker
 * exists the task is marked complete regardless of segment state.
 */
export function collectDoneTaskIdsForResume(
	persistedState: PersistedBatchState,
	repoRoot: string,
	workspaceConfig?: WorkspaceConfig | null,
): Set<string> {
	const doneTaskIds = new Set<string>();
	for (const task of persistedState.tasks) {
		if (task.taskFolder && hasTaskDoneMarker(task.taskFolder)) {
			doneTaskIds.add(task.taskId);
			continue;
		}
		const laneRec = persistedState.lanes.find(l => l.taskIds.includes(task.taskId));
		if (laneRec?.worktreePath && task.taskFolder) {
			const resolved = resolveCanonicalTaskPaths(task.taskFolder, laneRec.worktreePath, repoRoot, !!workspaceConfig);
			if (existsSync(resolved.donePath)) doneTaskIds.add(task.taskId);
		}
	}
	return doneTaskIds;
}

/**
 * Check whether a persisted batch state is eligible for resume.
 *
 * | Phase     | Normal | --force | Reason                                     |
 * |-----------|--------|---------|--------------------------------------------|
 * | paused    | yes    | yes     | Batch was paused (user/merge-failure)      |
 * | executing | yes    | yes     | Orchestrator died mid-execution            |
 * | merging   | yes    | yes     | Orchestrator died mid-merge                |
 * | stopped   | no     | yes     | Batch was stopped by failure policy        |
 * | failed    | no     | yes     | Batch has terminal failure                 |
 * | completed | no     | no      | Batch already completed                    |
 * | idle      | no     | no      | Batch never started execution              |
 * | launching | no     | no      | Currently launching                        |
 * | planning  | no     | no      | Still in planning phase                    |
 */
export function checkResumeEligibility(state: PersistedBatchState, force: boolean = false): ResumeEligibility {
	const { phase, batchId } = state;

	switch (phase) {
		case "paused":
			return { eligible: true, reason: `Batch ${batchId} is paused and can be resumed.`, phase, batchId };
		case "executing":
			return {
				eligible: true,
				reason: `Batch ${batchId} was executing when the orchestrator disconnected. Can be resumed.`,
				phase,
				batchId,
			};
		case "merging":
			return {
				eligible: true,
				reason: `Batch ${batchId} was merging when the orchestrator disconnected. Can be resumed.`,
				phase,
				batchId,
			};
		case "stopped":
			return force
				? {
						eligible: true,
						reason: `Batch ${batchId} was stopped by failure policy. Force-resuming (--force).`,
						phase,
						batchId,
					}
				: {
						eligible: false,
						reason: `Batch ${batchId} was stopped by failure policy. Use --force to resume, or /mission-abort to clean up.`,
						phase,
						batchId,
					};
		case "failed":
			return force
				? {
						eligible: true,
						reason: `Batch ${batchId} has a terminal failure. Force-resuming (--force).`,
						phase,
						batchId,
					}
				: {
						eligible: false,
						reason: `Batch ${batchId} has a terminal failure. Use --force to resume, or /mission-abort to clean up.`,
						phase,
						batchId,
					};
		case "completed":
			return {
				eligible: false,
				reason: `Batch ${batchId} already completed. ${force ? "--force cannot resume a completed batch. " : ""}Delete the state file or start a new batch.`,
				phase,
				batchId,
			};
		case "idle":
			return {
				eligible: false,
				reason: `Batch ${batchId} never started execution. Start a new batch with /mission.`,
				phase,
				batchId,
			};
		case "launching":
			return {
				eligible: false,
				reason: `Batch ${batchId} is currently launching. Wait for it to start or use /mission-abort.`,
				phase,
				batchId,
			};
		case "planning":
			return {
				eligible: false,
				reason: `Batch ${batchId} was still in planning phase. Start a new batch with /mission.`,
				phase,
				batchId,
			};
		default:
			return {
				eligible: false,
				reason: `Batch ${batchId} has unknown phase "${phase}". Delete the state file and start a new batch.`,
				phase,
				batchId,
			};
	}
}

interface SegmentFrontierResumeTaskState {
	taskId: string;
	completedSegmentIds: string[];
	inFlightSegmentIds: string[];
	pendingSegmentIds: string[];
	failedSegmentIds: string[];
	nextSegmentId: string | null;
	allSucceeded: boolean;
	dependencyBySegmentId: Map<string, string[]>;
}

function classifySegmentStatus(
	status: PersistedSegmentRecord["status"] | undefined,
): "completed" | "failed" | "in-flight" | "pending" {
	if (status === "succeeded" || status === "skipped") return "completed";
	if (status === "failed" || status === "stalled") return "failed";
	if (status === "running") return "in-flight";
	return "pending";
}

/**
 * Reconstruct per-task segment frontier from persisted segment records.
 *
 * Mutates persisted task records in-place:
 * - sets `activeSegmentId` to the running or next-pending segment
 * - normalizes task `status` to pending/running/terminal based on segments
 *
 * Returns the frontier map keyed by taskId.
 */
export function reconstructSegmentFrontier(
	persistedState: PersistedBatchState,
): Map<string, SegmentFrontierResumeTaskState> {
	const byTask = new Map<string, SegmentFrontierResumeTaskState>();
	const segmentRecordById = new Map<string, PersistedSegmentRecord>();
	for (const segment of persistedState.segments ?? []) {
		segmentRecordById.set(segment.segmentId, segment);
	}

	for (const task of persistedState.tasks) {
		const segmentIds = task.segmentIds ?? [];
		if (segmentIds.length === 0) continue;

		const dependencyBySegmentId = new Map<string, string[]>();
		const completedSegmentIds: string[] = [];
		const inFlightSegmentIds: string[] = [];
		const pendingSegmentIds: string[] = [];
		const failedSegmentIds: string[] = [];
		let hasConcreteSegmentRecord = false;

		for (let idx = 0; idx < segmentIds.length; idx++) {
			const segmentId = segmentIds[idx];
			const record = segmentRecordById.get(segmentId);
			if (record) hasConcreteSegmentRecord = true;
			const recordDeps = record?.dependsOnSegmentIds ?? [];
			const fallbackDeps = idx > 0 ? [segmentIds[idx - 1]] : [];
			const deps = (recordDeps.length > 0 ? recordDeps : fallbackDeps).filter(dep => segmentIds.includes(dep));
			dependencyBySegmentId.set(
				segmentId,
				[...new Set(deps)].sort((a, b) => a.localeCompare(b)),
			);

			switch (classifySegmentStatus(record?.status)) {
				case "completed":
					completedSegmentIds.push(segmentId);
					break;
				case "in-flight":
					inFlightSegmentIds.push(segmentId);
					break;
				case "failed":
					failedSegmentIds.push(segmentId);
					break;
				default:
					pendingSegmentIds.push(segmentId);
					break;
			}
		}

		const completedSet = new Set(completedSegmentIds);
		const readyPending = pendingSegmentIds.filter(segmentId => {
			const deps = dependencyBySegmentId.get(segmentId) ?? [];
			return deps.every(dep => completedSet.has(dep));
		});

		const nextSegmentId = inFlightSegmentIds[0] ?? readyPending[0] ?? pendingSegmentIds[0] ?? null;
		const allSucceeded = segmentIds.every(segmentId => segmentRecordById.get(segmentId)?.status === "succeeded");

		if (hasConcreteSegmentRecord) {
			if (failedSegmentIds.length > 0) {
				task.status = task.status === "skipped" ? "skipped" : "failed";
				task.activeSegmentId = null;
			} else if (inFlightSegmentIds.length > 0) {
				task.status = "running";
				task.activeSegmentId = inFlightSegmentIds[0];
			} else if (pendingSegmentIds.length > 0) {
				task.status = "pending";
				task.activeSegmentId = nextSegmentId;
			} else if (allSucceeded) {
				task.status = "succeeded";
				task.activeSegmentId = null;
			} else {
				task.status = task.status === "skipped" ? "skipped" : "failed";
				task.activeSegmentId = null;
			}
		}

		byTask.set(task.taskId, {
			taskId: task.taskId,
			completedSegmentIds,
			inFlightSegmentIds,
			pendingSegmentIds,
			failedSegmentIds,
			nextSegmentId,
			allSucceeded,
			dependencyBySegmentId,
		});
	}

	return byTask;
}

/**
 * Reconcile persisted task states against live signals.
 *
 * Precedence (per-task):
 * 1. `.DONE` file found → `mark-complete` (authoritative even if session alive)
 * 2. Session alive + no `.DONE` → `reconnect`
 * 3. Persisted status terminal (succeeded/failed/stalled/skipped) → `skip`
 * 4. Dead session + no `.DONE` + worktree exists → `re-execute`
 * 5. Never-started pending task (no session or dead + no worktree) → `pending`
 * 6. Dead session + not terminal + no `.DONE` + no worktree → `mark-failed`
 */
export function reconcileTaskStates(
	persistedState: PersistedBatchState,
	aliveSessions: ReadonlySet<string>,
	doneTaskIds: ReadonlySet<string>,
	existingWorktrees: ReadonlySet<string> = new Set(),
): ReconciledTaskState[] {
	return persistedState.tasks.map(task => {
		const sessionAlive = aliveSessions.has(task.sessionName);
		const doneFileFound = doneTaskIds.has(task.taskId);
		const worktreeExists = existingWorktrees.has(task.taskId);

		if (doneFileFound) {
			return {
				taskId: task.taskId,
				persistedStatus: task.status,
				liveStatus: "succeeded" as LaneTaskStatus,
				sessionAlive,
				doneFileFound: true,
				worktreeExists,
				action: "mark-complete" as const,
			};
		}

		if (sessionAlive) {
			return {
				taskId: task.taskId,
				persistedStatus: task.status,
				liveStatus: "running" as LaneTaskStatus,
				sessionAlive: true,
				doneFileFound: false,
				worktreeExists,
				action: "reconnect" as const,
			};
		}

		const terminalStatuses: LaneTaskStatus[] = ["succeeded", "failed", "stalled", "skipped"];
		if (terminalStatuses.includes(task.status)) {
			return {
				taskId: task.taskId,
				persistedStatus: task.status,
				liveStatus: task.status,
				sessionAlive: false,
				doneFileFound: false,
				worktreeExists,
				action: "skip" as const,
			};
		}

		if (worktreeExists) {
			return {
				taskId: task.taskId,
				persistedStatus: task.status,
				liveStatus: "pending" as LaneTaskStatus,
				sessionAlive: false,
				doneFileFound: false,
				worktreeExists: true,
				action: "re-execute" as const,
			};
		}

		// Precedence 5: never-started pending task — matches
		//   (a) no session assigned, or
		//   (b) dead session + no worktree (TP-037 bug #102b).
		if (task.status === "pending" && (!task.sessionName || (!sessionAlive && !worktreeExists))) {
			return {
				taskId: task.taskId,
				persistedStatus: task.status,
				liveStatus: "pending" as LaneTaskStatus,
				sessionAlive: false,
				doneFileFound: false,
				worktreeExists: false,
				action: "pending" as const,
			};
		}

		return {
			taskId: task.taskId,
			persistedStatus: task.status,
			liveStatus: "failed" as LaneTaskStatus,
			sessionAlive: false,
			doneFileFound: false,
			worktreeExists: false,
			action: "mark-failed" as const,
		};
	});
}

/**
 * Latest merge status for a specific wave index (reverse scan, last wins).
 * Persisted merge results may contain multiple entries for the same wave
 * (re-exec sentinels, retry attempts) — the most recent entry wins.
 */
export function getMergeStatusForWave(
	mergeResults: ReadonlyArray<{ waveIndex: number; status: "succeeded" | "failed" | "partial" }>,
	waveIndex: number,
): "succeeded" | "failed" | "partial" | null {
	for (let i = mergeResults.length - 1; i >= 0; i--) {
		if (mergeResults[i].waveIndex === waveIndex) return mergeResults[i].status;
	}
	return null;
}

/**
 * Expand persisted wave plan with continuation rounds required by
 * per-task segment counts. Groups missing rounds by each task's
 * last-occurrence wave so resumed execution preserves multi-task round
 * concurrency semantics (`[A,B]`, then `[A]`, etc.).
 */
export function buildResumeRuntimeWavePlan(persistedState: PersistedBatchState): string[][] {
	const baseWavePlan = persistedState.wavePlan.map(wave => [...wave]);
	const runtimeWavePlan = [...baseWavePlan];
	const segmentCountByTaskId = new Map<string, number>();
	for (const task of persistedState.tasks) {
		if (Array.isArray(task.segmentIds) && task.segmentIds.length > 0) {
			segmentCountByTaskId.set(task.taskId, task.segmentIds.length);
		}
	}

	const scheduledCountByTaskId = new Map<string, number>();
	const lastWaveIndexByTaskId = new Map<string, number>();
	for (let waveIdx = 0; waveIdx < baseWavePlan.length; waveIdx++) {
		for (const taskId of baseWavePlan[waveIdx]) {
			scheduledCountByTaskId.set(taskId, (scheduledCountByTaskId.get(taskId) ?? 0) + 1);
			lastWaveIndexByTaskId.set(taskId, waveIdx);
		}
	}

	const missingByLastWaveIndex = new Map<number, Map<string, number>>();
	for (const [taskId, segmentCount] of segmentCountByTaskId.entries()) {
		const scheduledCount = scheduledCountByTaskId.get(taskId) ?? 0;
		if (segmentCount <= scheduledCount) continue;
		const lastWaveIndex = lastWaveIndexByTaskId.get(taskId) ?? -1;
		if (!missingByLastWaveIndex.has(lastWaveIndex)) {
			missingByLastWaveIndex.set(lastWaveIndex, new Map<string, number>());
		}
		missingByLastWaveIndex.get(lastWaveIndex)!.set(taskId, segmentCount - scheduledCount);
	}

	let offset = 0;
	for (let baseWaveIdx = 0; baseWaveIdx < baseWavePlan.length; baseWaveIdx++) {
		const missingForWave = missingByLastWaveIndex.get(baseWaveIdx);
		if (!missingForWave || missingForWave.size === 0) continue;
		const rounds: string[][] = [];
		const remaining = new Map(missingForWave);
		while ([...remaining.values()].some(count => count > 0)) {
			const roundTaskIds = [...remaining.entries()]
				.filter(([, count]) => count > 0)
				.map(([taskId]) => taskId)
				.sort((a, b) => a.localeCompare(b));
			if (roundTaskIds.length === 0) break;
			rounds.push(roundTaskIds);
			for (const taskId of roundTaskIds) {
				remaining.set(taskId, (remaining.get(taskId) ?? 0) - 1);
			}
		}
		if (rounds.length > 0) {
			runtimeWavePlan.splice(baseWaveIdx + 1 + offset, 0, ...rounds);
			offset += rounds.length;
		}
	}

	const dangling = missingByLastWaveIndex.get(-1);
	if (dangling && dangling.size > 0) {
		const remaining = new Map(dangling);
		while ([...remaining.values()].some(count => count > 0)) {
			const roundTaskIds = [...remaining.entries()]
				.filter(([, count]) => count > 0)
				.map(([taskId]) => taskId)
				.sort((a, b) => a.localeCompare(b));
			if (roundTaskIds.length === 0) break;
			runtimeWavePlan.push(roundTaskIds);
			for (const taskId of roundTaskIds) {
				remaining.set(taskId, (remaining.get(taskId) ?? 0) - 1);
			}
		}
	}

	return runtimeWavePlan;
}

/**
 * Compute resume point from reconciled task states and wave plan.
 *
 * TP-037 (Bug #102): A wave whose tasks are all terminal but whose
 * merge is missing/failed is NOT skipped — it is flagged for merge
 * retry via `mergeRetryWaveIndexes`. `resumeWaveIndex` is set to the
 * earliest such wave so the resume loop can process it.
 */
export function computeResumePoint(
	persistedState: PersistedBatchState,
	reconciledTasks: ReconciledTaskState[],
	wavePlan: string[][] = persistedState.wavePlan,
): ResumePoint {
	const reconciledMap = new Map<string, ReconciledTaskState>();
	for (const task of reconciledTasks) reconciledMap.set(task.taskId, task);

	const segmentStatusBySegmentId = new Map<string, PersistedSegmentRecord["status"]>();
	for (const segment of persistedState.segments ?? []) {
		segmentStatusBySegmentId.set(segment.segmentId, segment.status);
	}

	const persistedTasks = Array.isArray((persistedState as { tasks?: unknown }).tasks) ? persistedState.tasks : [];
	const segmentIdsByTaskId = new Map<string, string[]>();
	for (const task of persistedTasks) {
		if (task.segmentIds && task.segmentIds.length > 0) {
			segmentIdsByTaskId.set(task.taskId, task.segmentIds);
		}
	}
	const waveSegmentIdByTaskOccurrence = new Map<string, string>();
	const occurrenceByTaskId = new Map<string, number>();
	for (let waveIdx = 0; waveIdx < wavePlan.length; waveIdx++) {
		for (const taskId of wavePlan[waveIdx]) {
			const segmentIds = segmentIdsByTaskId.get(taskId);
			if (!segmentIds || segmentIds.length === 0) continue;
			const occurrence = occurrenceByTaskId.get(taskId) ?? 0;
			if (occurrence < segmentIds.length) {
				waveSegmentIdByTaskOccurrence.set(`${waveIdx}:${taskId}`, segmentIds[occurrence]);
			}
			occurrenceByTaskId.set(taskId, occurrence + 1);
		}
	}

	const completedTaskIds: string[] = [];
	const pendingTaskIds: string[] = [];
	const failedTaskIds: string[] = [];
	const reconnectTaskIds: string[] = [];
	const reExecuteTaskIds: string[] = [];

	for (const task of reconciledTasks) {
		switch (task.action) {
			case "mark-complete":
				completedTaskIds.push(task.taskId);
				break;
			case "skip":
				if (task.liveStatus === "succeeded" || task.persistedStatus === "succeeded") {
					completedTaskIds.push(task.taskId);
				} else if (
					task.liveStatus === "failed" ||
					task.liveStatus === "stalled" ||
					task.persistedStatus === "failed" ||
					task.persistedStatus === "stalled"
				) {
					failedTaskIds.push(task.taskId);
				}
				// persistedStatus === "skipped" → not re-queued, counted via
				// batchState.skippedTasks.
				break;
			case "reconnect":
				reconnectTaskIds.push(task.taskId);
				break;
			case "re-execute":
				reExecuteTaskIds.push(task.taskId);
				break;
			case "mark-failed":
				failedTaskIds.push(task.taskId);
				break;
			case "pending":
				pendingTaskIds.push(task.taskId);
				break;
		}
	}

	let resumeWaveIndex = wavePlan.length;
	const mergeRetryWaveIndexes: number[] = [];

	for (let i = 0; i < wavePlan.length; i++) {
		const waveTasks = wavePlan[i];
		const allDone = waveTasks.every(taskId => {
			const waveSegmentId = waveSegmentIdByTaskOccurrence.get(`${i}:${taskId}`);
			if (waveSegmentId && segmentStatusBySegmentId.has(waveSegmentId)) {
				const segmentStatus = segmentStatusBySegmentId.get(waveSegmentId)!;
				return (
					segmentStatus === "succeeded" ||
					segmentStatus === "failed" ||
					segmentStatus === "stalled" ||
					segmentStatus === "skipped"
				);
			}
			const reconciled = reconciledMap.get(taskId);
			if (!reconciled) return false;
			if (reconciled.action === "mark-complete" || reconciled.action === "mark-failed") return true;
			if (reconciled.action === "skip") {
				const s = reconciled.liveStatus ?? reconciled.persistedStatus;
				return s === "succeeded" || s === "failed" || s === "stalled" || s === "skipped";
			}
			return false;
		});

		if (!allDone) {
			if (resumeWaveIndex === wavePlan.length) resumeWaveIndex = i;
			break;
		}

		// TP-037 (Bug #102): check merge status only when the wave had
		// any succeeded tasks (failure/skip-only waves produce no merges).
		const hasSucceededTasks = waveTasks.some(taskId => {
			const waveSegmentId = waveSegmentIdByTaskOccurrence.get(`${i}:${taskId}`);
			if (waveSegmentId && segmentStatusBySegmentId.has(waveSegmentId)) {
				return segmentStatusBySegmentId.get(waveSegmentId) === "succeeded";
			}
			const reconciled = reconciledMap.get(taskId);
			if (!reconciled) return false;
			if (reconciled.action === "mark-complete") return true;
			if (
				reconciled.action === "skip" &&
				(reconciled.liveStatus === "succeeded" || reconciled.persistedStatus === "succeeded")
			) {
				return true;
			}
			return false;
		});

		if (hasSucceededTasks && persistedState.mergeResults) {
			const mergeStatus = getMergeStatusForWave(persistedState.mergeResults, i);
			if (mergeStatus !== "succeeded") {
				mergeRetryWaveIndexes.push(i);
				if (resumeWaveIndex === wavePlan.length) resumeWaveIndex = i;
			}
		}
	}

	const actualPendingTaskIds: string[] = [];
	for (let i = resumeWaveIndex; i < wavePlan.length; i++) {
		for (const taskId of wavePlan[i]) {
			const waveSegmentId = waveSegmentIdByTaskOccurrence.get(`${i}:${taskId}`);
			if (waveSegmentId && segmentStatusBySegmentId.has(waveSegmentId)) {
				const segmentStatus = segmentStatusBySegmentId.get(waveSegmentId)!;
				if (segmentStatus === "running" || segmentStatus === "pending") {
					actualPendingTaskIds.push(taskId);
				}
				continue;
			}

			const reconciled = reconciledMap.get(taskId);
			if (!reconciled) {
				actualPendingTaskIds.push(taskId);
				continue;
			}
			if (reconciled.action === "reconnect") actualPendingTaskIds.push(taskId);
			if (reconciled.action === "re-execute") actualPendingTaskIds.push(taskId);
			if (reconciled.action === "skip" && reconciled.persistedStatus === "pending") {
				actualPendingTaskIds.push(taskId);
			}
			if (reconciled.action === "pending") actualPendingTaskIds.push(taskId);
		}
	}

	return {
		resumeWaveIndex,
		completedTaskIds,
		pendingTaskIds: actualPendingTaskIds,
		failedTaskIds,
		reconnectTaskIds,
		reExecuteTaskIds,
		mergeRetryWaveIndexes,
	};
}

// ── Pre-Resume Diagnostics ───────────────────────────────────────────

export interface DiagnosticCheckResult {
	check: string;
	passed: boolean;
	detail: string;
}

export interface PreResumeDiagnosticsResult {
	passed: boolean;
	checks: DiagnosticCheckResult[];
	summary: string;
}

/**
 * Run pre-resume diagnostics before allowing a force-resume.
 *
 * Checks:
 * 1. State coherence (batch state loaded successfully).
 * 2. Branch consistency — mission branch exists in each repo.
 * 3. Worktree health — lane worktrees are accessible or cleanly absent.
 *
 * Pure-ish: reads filesystem/git state but does not mutate.
 */
export function runPreResumeDiagnostics(
	persistedState: PersistedBatchState,
	repoRoot: string,
	_stateRoot: string,
	workspaceConfig?: WorkspaceConfig | null,
): PreResumeDiagnosticsResult {
	const checks: DiagnosticCheckResult[] = [];

	checks.push({
		check: "state-coherence",
		passed: true,
		detail: `Batch state loaded successfully (batchId: ${persistedState.batchId}, phase: ${persistedState.phase})`,
	});

	const repoRoots = collectRepoRoots(persistedState, repoRoot, workspaceConfig);
	for (const root of repoRoots) {
		const repoId = resolveRepoIdFromRoot(root, workspaceConfig);
		const label = repoId ? `repo:${repoId}` : "default-repo";

		if (persistedState.orchBranch) {
			const branchCheck = runGit(["rev-parse", "--verify", `refs/heads/${persistedState.orchBranch}`], root);
			if (branchCheck.ok) {
				checks.push({
					check: `branch-consistency:${label}`,
					passed: true,
					detail: `Mission branch "${persistedState.orchBranch}" exists in ${label}`,
				});
			} else {
				checks.push({
					check: `branch-consistency:${label}`,
					passed: false,
					detail:
						`Mission branch "${persistedState.orchBranch}" not found in ${label}. ` +
						`The branch may have been deleted or the repo is in an inconsistent state.`,
				});
			}
		}
	}

	for (const lane of persistedState.lanes) {
		if (!lane.worktreePath) continue;

		const wtExists = existsSync(lane.worktreePath);
		if (wtExists) {
			const gitMarker = join(lane.worktreePath, ".git");
			const isValidWt = existsSync(gitMarker);
			checks.push({
				check: `worktree-health:lane-${lane.laneNumber}`,
				passed: isValidWt,
				detail: isValidWt
					? `Lane ${lane.laneNumber} worktree exists and has valid .git marker`
					: `Lane ${lane.laneNumber} worktree exists at ${lane.worktreePath} but lacks .git marker (corrupted)`,
			});
		} else {
			checks.push({
				check: `worktree-health:lane-${lane.laneNumber}`,
				passed: true,
				detail: `Lane ${lane.laneNumber} worktree absent (will be re-created on resume)`,
			});
		}
	}

	const failed = checks.filter(c => !c.passed);
	const passed = failed.length === 0;

	const summary = passed
		? `Pre-resume diagnostics passed (${checks.length} checks)`
		: `Pre-resume diagnostics failed (${failed.length}/${checks.length} checks failed):\n` +
			failed.map(c => `   - ${c.check}: ${c.detail}`).join("\n");

	return { passed, checks, summary };
}

/**
 * Enrich a {@link ResumePoint} with per-milestone validator
 * reconciliation (Track H3). Called after {@link computeResumePoint}
 * when the caller wants the validator resume decision on the same
 * record. Returns a NEW `ResumePoint`; never mutates the input.
 *
 * Milestones not in `"validating"` status are skipped; the resulting
 * `milestoneValidatorActions` array is `undefined` when no milestones
 * required reconciliation.
 */
export async function enrichResumePointWithMilestoneValidators(
	resumePoint: ResumePoint,
	batchState: PersistedBatchState,
	cwd: string,
	options: ReconcileMilestoneValidatorsOptions = {},
): Promise<ResumePoint> {
	const actions = await reconcileMilestoneValidators(batchState, cwd, options);
	if (actions.length === 0) return resumePoint;
	return { ...resumePoint, milestoneValidatorActions: actions };
}
