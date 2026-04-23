/**
 * Milestone state machine — Track A3 + A4.
 *
 * Pure reducers operating on `Milestone[]` plus helpers that bridge
 * milestone state to the existing wave/task plumbing. The engine's
 * runtime {@link BatchState} owns an optional `milestones` array which
 * this module reads and returns new values for. Nothing in here writes
 * to disk or spawns processes — the validator spawning half of Track B
 * and C sits in separate modules.
 *
 * Lifecycle summary (per milestone):
 *
 *   pending   \u2014 no task in the milestone has entered `running`.
 *   in_progress \u2014 at least one task is running or terminal.
 *   validating \u2014 every non-fix task is terminal; waiting for validators.
 *   passed    \u2014 validators reported no blocking findings.
 *   failed    \u2014 validators kept flagging blockers through
 *               `maxValidationRounds` and the engine gave up.
 *
 * The per-feature state (`TaskOutcome.status`) remains the source of
 * truth for individual features. Milestone status is a rollup.
 */

import type { BatchMilestone, BatchState, TaskOutcome } from "../types";
import type { Milestone, MilestoneStatus } from "./types";
import { DEFAULT_MILESTONE_ID, DEFAULT_MILESTONE_MAX_VALIDATION_ROUNDS } from "./types";

/** Terminal feature statuses (Factory "feature complete"). */
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "skipped"] as const);

/** Terminal milestone statuses. */
export const TERMINAL_MILESTONE_STATUSES: ReadonlySet<MilestoneStatus> = new Set(["passed", "failed"]);

/** Conservative defaults for a Factory-style milestone. */
export function defaultMilestone(id: string, name: string, featureIds: string[]): Milestone {
	return {
		id,
		name,
		featureIds: [...featureIds],
		assertionIds: [],
		status: "pending",
		validationRounds: 0,
		maxValidationRounds: DEFAULT_MILESTONE_MAX_VALIDATION_ROUNDS,
	};
}

/**
 * Build an implicit single-milestone layout from a wave plan. Used when
 * a batch promotes without an explicit planning conversation (legacy /
 * simple-start path). Every non-empty task in the plan is attached to a
 * single `M-001` milestone.
 */
export function groupWavesIntoMilestones(wavePlan: readonly (readonly string[])[]): Milestone[] {
	const seen = new Set<string>();
	const featureIds: string[] = [];
	for (const wave of wavePlan) {
		for (const id of wave) {
			if (typeof id !== "string" || seen.has(id)) continue;
			seen.add(id);
			featureIds.push(id);
		}
	}
	return [defaultMilestone(DEFAULT_MILESTONE_ID, "Mission", featureIds)];
}

/** Locate a milestone by id. Returns `undefined` when absent. */
export function findMilestone(milestones: readonly Milestone[] | undefined, id: string): Milestone | undefined {
	if (!milestones) return undefined;
	return milestones.find(m => m.id === id);
}

/**
 * Return the first non-terminal milestone in `milestones` order. Returns
 * `undefined` when every milestone is terminal (or `milestones` is
 * missing/empty). This is the "current" milestone the orchestrator
 * focuses on when deciding which validator to spawn next.
 */
export function currentMilestone(milestones: readonly Milestone[] | undefined): Milestone | undefined {
	if (!milestones) return undefined;
	return milestones.find(m => !TERMINAL_MILESTONE_STATUSES.has(m.status));
}

/**
 * Does a milestone have every non-fix feature complete?
 *
 * Fix features are excluded from the "all complete" count because they
 * are generated mid-validation and resolve during the same round — a
 * feature that is already done before a fix feature appears must not
 * cause a milestone to revert from `validating` back to `in_progress`.
 */
export function milestoneAllFeaturesComplete(
	milestone: Milestone,
	tasks: readonly TaskOutcome[],
	fixFeatureIds: ReadonlySet<string> = new Set(),
): boolean {
	if (milestone.featureIds.length === 0) return false;
	for (const featureId of milestone.featureIds) {
		if (fixFeatureIds.has(featureId)) continue;
		const outcome = tasks.find(t => t.taskId === featureId);
		if (!outcome) return false;
		if (!TERMINAL_TASK_STATUSES.has(outcome.status as "succeeded" | "failed" | "skipped")) return false;
	}
	return true;
}

/** Has any task in the milestone ever started? */
export function milestoneAnyFeatureStarted(milestone: Milestone, tasks: readonly TaskOutcome[]): boolean {
	for (const featureId of milestone.featureIds) {
		const outcome = tasks.find(t => t.taskId === featureId);
		if (!outcome) continue;
		if (outcome.status === "pending") continue;
		return true;
	}
	return false;
}

/**
 * Advance a milestone one phase based on the latest feature outcomes.
 *
 * Returns a new `Milestone` (immutable update); never mutates the input.
 * The transition rules are:
 *
 *   pending     \u2192 in_progress  when any feature has started.
 *   in_progress \u2192 validating   when every non-fix feature is terminal.
 *
 * Validators drive `validating \u2192 passed | failed`; this helper does not
 * leave `validating` on its own. Callers spawning validators should
 * record `validationRounds += 1` through {@link bumpValidationRound}
 * when they actually spawn a validator pass.
 */
export function advanceMilestonePhase(
	milestone: Milestone,
	tasks: readonly TaskOutcome[],
	fixFeatureIds: ReadonlySet<string> = new Set(),
	now: number = Date.now(),
): Milestone {
	if (milestone.status === "passed" || milestone.status === "failed") return milestone;
	if (milestone.status === "validating") return milestone;

	const anyStarted = milestoneAnyFeatureStarted(milestone, tasks);
	const allComplete = milestoneAllFeaturesComplete(milestone, tasks, fixFeatureIds);

	if (milestone.status === "pending" && anyStarted) {
		return { ...milestone, status: "in_progress", startedAt: milestone.startedAt ?? now };
	}
	if (milestone.status === "in_progress" && allComplete) {
		return { ...milestone, status: "validating" };
	}
	return milestone;
}

/**
 * Bump the validation round counter when a validator pass starts. Call
 * this at the moment the engine actually spawns the scrutiny +
 * user-testing validators so the counter reflects attempts, not
 * outcomes. Returns a new `Milestone`.
 */
export function bumpValidationRound(milestone: Milestone): Milestone {
	return { ...milestone, validationRounds: milestone.validationRounds + 1 };
}

/**
 * Mark a milestone as passed (validators reported no blockers). Sets
 * `endedAt` when absent so downstream telemetry can measure milestone
 * duration.
 */
export function markMilestonePassed(milestone: Milestone, now: number = Date.now()): Milestone {
	return {
		...milestone,
		status: "passed",
		endedAt: milestone.endedAt ?? now,
	};
}

/**
 * Mark a milestone as failed because the validation loop exhausted
 * `maxValidationRounds` without convergence (or the operator
 * force-failed it).
 */
export function markMilestoneFailed(milestone: Milestone, now: number = Date.now()): Milestone {
	return {
		...milestone,
		status: "failed",
		endedAt: milestone.endedAt ?? now,
	};
}

/** True when a milestone may still attempt another validation round. */
export function canAttemptAnotherValidationRound(milestone: Milestone): boolean {
	return milestone.validationRounds < milestone.maxValidationRounds;
}

/**
 * Apply a functional update to a single milestone in an array, returning
 * a new array. Milestones not matching `id` are returned by reference.
 * `undefined` is returned when `milestones` is undefined.
 */
export function updateMilestoneInArray(
	milestones: readonly Milestone[] | undefined,
	id: string,
	update: (m: Milestone) => Milestone,
): Milestone[] | undefined {
	if (!milestones) return undefined;
	let changed = false;
	const next = milestones.map(m => {
		if (m.id !== id) return m;
		const updated = update(m);
		if (updated !== m) changed = true;
		return updated;
	});
	return changed ? next : [...milestones];
}

/**
 * Recompute every milestone's lifecycle phase from the latest task
 * outcomes. Runs after each `recordTaskOutcome` call so milestones track
 * feature completion without per-caller plumbing.
 */
export function recomputeMilestones(
	milestones: readonly Milestone[] | undefined,
	tasks: readonly TaskOutcome[],
	fixFeatureIds: ReadonlySet<string> = new Set(),
	now: number = Date.now(),
): Milestone[] | undefined {
	if (!milestones) return milestones;
	return milestones.map(m => advanceMilestonePhase(m, tasks, fixFeatureIds, now));
}

/**
 * Project a Milestone onto the dashboard-facing `BatchMilestone` shape.
 * They are structurally identical today but keep one central projection
 * in case runtime/client shapes diverge later.
 */
export function toBatchMilestone(milestone: Milestone): BatchMilestone {
	const out: BatchMilestone = {
		id: milestone.id,
		name: milestone.name,
		featureIds: [...milestone.featureIds],
		assertionIds: [...milestone.assertionIds],
		status: milestone.status,
		validationRounds: milestone.validationRounds,
		maxValidationRounds: milestone.maxValidationRounds,
	};
	if (milestone.startedAt !== undefined) out.startedAt = milestone.startedAt;
	if (milestone.endedAt !== undefined) out.endedAt = milestone.endedAt;
	return out;
}

/**
 * Extract the set of fix-feature task IDs from a batch state by
 * consulting the runtime tasks + milestone memberships. Pure helper.
 * When tasks don't carry an explicit `isFixFeature` flag (they won't on
 * simple runtime state because `TaskOutcome` has no such field), the
 * caller is responsible for passing an explicit set.
 */
export function emptyFixFeatureSet(): Set<string> {
	return new Set();
}

/**
 * Hook called by `engine.recordTaskOutcome`. Given the current batch
 * state and the outcome that just landed, returns a new `milestones`
 * array (possibly unchanged reference) reflecting the phase transitions
 * triggered by the outcome.
 */
export function onTaskOutcomeRecorded(
	batch: BatchState,
	_outcome: TaskOutcome,
	fixFeatureIds: ReadonlySet<string> = new Set(),
	now: number = Date.now(),
): BatchMilestone[] | undefined {
	const milestones = batch.milestones;
	if (!milestones || milestones.length === 0) return milestones;
	// BatchMilestone structurally matches Milestone today, so a narrow cast
	// is safe; the projection below re-normalises to the client shape.
	const runtimeShape = milestones as unknown as Milestone[];
	const next = recomputeMilestones(runtimeShape, batch.tasks, fixFeatureIds, now);
	if (!next) return milestones;
	return next.map(m => toBatchMilestone(m));
}
