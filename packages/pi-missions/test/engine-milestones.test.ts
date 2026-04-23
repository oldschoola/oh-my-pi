/**
 * Unit tests for engine-milestones (Track A3).
 */

import { describe, expect, test } from "bun:test";
import {
	advanceMilestonePhase,
	bumpValidationRound,
	canAttemptAnotherValidationRound,
	currentMilestone,
	DEFAULT_MILESTONE_ID,
	DEFAULT_MILESTONE_MAX_VALIDATION_ROUNDS,
	defaultMilestone,
	findMilestone,
	groupWavesIntoMilestones,
	type Milestone,
	markMilestoneFailed,
	markMilestonePassed,
	milestoneAllFeaturesComplete,
	milestoneAnyFeatureStarted,
	onTaskOutcomeRecorded,
	recomputeMilestones,
	TERMINAL_MILESTONE_STATUSES,
	toBatchMilestone,
	updateMilestoneInArray,
} from "../src/missioncontrol";
import type { TaskOutcome, WaveAssignment } from "../src/types";

function outcome(taskId: string, status: TaskOutcome["status"]): TaskOutcome {
	return {
		taskId,
		status,
		startTime: null,
		endTime: null,
		exitReason: "",
		sessionName: "",
		doneFileFound: false,
	};
}

describe("defaultMilestone", () => {
	test("populates sensible defaults", () => {
		const m = defaultMilestone("M-001", "Mission", ["F-001"]);
		expect(m.id).toBe("M-001");
		expect(m.name).toBe("Mission");
		expect(m.featureIds).toEqual(["F-001"]);
		expect(m.assertionIds).toEqual([]);
		expect(m.status).toBe("pending");
		expect(m.validationRounds).toBe(0);
		expect(m.maxValidationRounds).toBe(DEFAULT_MILESTONE_MAX_VALIDATION_ROUNDS);
	});

	test("copies featureIds to avoid aliasing", () => {
		const src = ["F-001"];
		const m = defaultMilestone("M-001", "Mission", src);
		src.push("F-002");
		expect(m.featureIds).toEqual(["F-001"]);
	});
});

describe("groupWavesIntoMilestones", () => {
	test("wraps a flat wave plan in a single M-001", () => {
		const ms = groupWavesIntoMilestones([["F-001", "F-002"], ["F-003"]]);
		expect(ms).toHaveLength(1);
		expect(ms[0]?.id).toBe(DEFAULT_MILESTONE_ID);
		expect(ms[0]?.featureIds).toEqual(["F-001", "F-002", "F-003"]);
	});

	test("dedupes repeated tasks", () => {
		const ms = groupWavesIntoMilestones([["F-001"], ["F-001", "F-002"]]);
		expect(ms[0]?.featureIds).toEqual(["F-001", "F-002"]);
	});

	test("handles empty plan", () => {
		const ms = groupWavesIntoMilestones([]);
		expect(ms).toHaveLength(1);
		expect(ms[0]?.featureIds).toEqual([]);
	});
});

describe("findMilestone + currentMilestone", () => {
	const ms: Milestone[] = [defaultMilestone("M-001", "a", []), defaultMilestone("M-002", "b", [])];

	test("findMilestone returns match or undefined", () => {
		expect(findMilestone(ms, "M-002")?.name).toBe("b");
		expect(findMilestone(ms, "M-999")).toBeUndefined();
		expect(findMilestone(undefined, "M-001")).toBeUndefined();
	});

	test("currentMilestone returns first non-terminal", () => {
		const chain = [
			{ ...ms[0]!, status: "passed" as const },
			{ ...ms[1]!, status: "in_progress" as const },
		];
		expect(currentMilestone(chain)?.id).toBe("M-002");
	});

	test("currentMilestone returns undefined when all terminal", () => {
		const chain = [
			{ ...ms[0]!, status: "passed" as const },
			{ ...ms[1]!, status: "failed" as const },
		];
		expect(currentMilestone(chain)).toBeUndefined();
	});

	test("currentMilestone returns undefined for empty array", () => {
		expect(currentMilestone([])).toBeUndefined();
		expect(currentMilestone(undefined)).toBeUndefined();
	});
});

describe("milestoneAllFeaturesComplete + milestoneAnyFeatureStarted", () => {
	const m = defaultMilestone("M-001", "Mission", ["F-001", "F-002"]);

	test("returns false when a feature has no outcome", () => {
		expect(milestoneAllFeaturesComplete(m, [outcome("F-001", "succeeded")])).toBe(false);
	});

	test("returns false when any feature is still pending/running", () => {
		const tasks = [outcome("F-001", "succeeded"), outcome("F-002", "running")];
		expect(milestoneAllFeaturesComplete(m, tasks)).toBe(false);
	});

	test("returns true when every feature is terminal", () => {
		const tasks = [outcome("F-001", "succeeded"), outcome("F-002", "failed")];
		expect(milestoneAllFeaturesComplete(m, tasks)).toBe(true);
	});

	test("excludes fix features from the 'all complete' count", () => {
		const mWithFix = { ...m, featureIds: ["F-001", "F-002", "FIX-001-001"] };
		const tasks = [outcome("F-001", "succeeded"), outcome("F-002", "succeeded")];
		// Without exclusion → incomplete (no FIX-001-001 outcome); with exclusion → complete.
		expect(milestoneAllFeaturesComplete(mWithFix, tasks, new Set(["FIX-001-001"]))).toBe(true);
		expect(milestoneAllFeaturesComplete(mWithFix, tasks)).toBe(false);
	});

	test("empty featureIds reports false", () => {
		const empty = defaultMilestone("M-001", "n", []);
		expect(milestoneAllFeaturesComplete(empty, [])).toBe(false);
	});

	test("anyFeatureStarted ignores pending tasks", () => {
		expect(milestoneAnyFeatureStarted(m, [outcome("F-001", "pending"), outcome("F-002", "pending")])).toBe(false);
		expect(milestoneAnyFeatureStarted(m, [outcome("F-001", "running"), outcome("F-002", "pending")])).toBe(true);
	});
});

describe("advanceMilestonePhase", () => {
	const m = defaultMilestone("M-001", "Mission", ["F-001"]);

	test("pending → in_progress on first running feature", () => {
		const next = advanceMilestonePhase(m, [outcome("F-001", "running")], new Set(), 1000);
		expect(next.status).toBe("in_progress");
		expect(next.startedAt).toBe(1000);
	});

	test("in_progress → validating when all features terminal", () => {
		const base = { ...m, status: "in_progress" as const, startedAt: 500 };
		const next = advanceMilestonePhase(base, [outcome("F-001", "succeeded")]);
		expect(next.status).toBe("validating");
		expect(next.startedAt).toBe(500); // preserved
	});

	test("stays in validating (awaits validator)", () => {
		const base = { ...m, status: "validating" as const };
		const next = advanceMilestonePhase(base, [outcome("F-001", "succeeded")]);
		expect(next).toBe(base);
	});

	test("terminal statuses are fixed points", () => {
		const passed = { ...m, status: "passed" as const };
		expect(advanceMilestonePhase(passed, [outcome("F-001", "succeeded")])).toBe(passed);
		const failed = { ...m, status: "failed" as const };
		expect(advanceMilestonePhase(failed, [outcome("F-001", "failed")])).toBe(failed);
	});

	test("pending stays pending when nothing has started", () => {
		const next = advanceMilestonePhase(m, [outcome("F-001", "pending")]);
		expect(next).toBe(m);
	});
});

describe("bumpValidationRound + markMilestonePassed + markMilestoneFailed + canAttemptAnotherValidationRound", () => {
	const m = defaultMilestone("M-001", "Mission", []);

	test("bumpValidationRound increments counter immutably", () => {
		const next = bumpValidationRound(m);
		expect(next.validationRounds).toBe(1);
		expect(m.validationRounds).toBe(0);
	});

	test("markMilestonePassed sets status and endedAt", () => {
		const next = markMilestonePassed(m, 5000);
		expect(next.status).toBe("passed");
		expect(next.endedAt).toBe(5000);
	});

	test("markMilestoneFailed sets status and endedAt", () => {
		const next = markMilestoneFailed(m, 7000);
		expect(next.status).toBe("failed");
		expect(next.endedAt).toBe(7000);
	});

	test("canAttemptAnotherValidationRound respects max rounds", () => {
		expect(canAttemptAnotherValidationRound(m)).toBe(true);
		const maxed = { ...m, validationRounds: m.maxValidationRounds };
		expect(canAttemptAnotherValidationRound(maxed)).toBe(false);
		const oneMore = { ...m, validationRounds: m.maxValidationRounds - 1 };
		expect(canAttemptAnotherValidationRound(oneMore)).toBe(true);
	});

	test("TERMINAL_MILESTONE_STATUSES contains passed + failed only", () => {
		expect(TERMINAL_MILESTONE_STATUSES.has("passed")).toBe(true);
		expect(TERMINAL_MILESTONE_STATUSES.has("failed")).toBe(true);
		expect(TERMINAL_MILESTONE_STATUSES.has("pending")).toBe(false);
		expect(TERMINAL_MILESTONE_STATUSES.has("validating")).toBe(false);
	});
});

describe("updateMilestoneInArray + recomputeMilestones", () => {
	test("updateMilestoneInArray replaces matching milestone by reference", () => {
		const arr: Milestone[] = [defaultMilestone("M-001", "a", []), defaultMilestone("M-002", "b", [])];
		const next = updateMilestoneInArray(arr, "M-002", m => ({ ...m, name: "B" }));
		expect(next).not.toBe(arr);
		expect(next?.[1]?.name).toBe("B");
		expect(next?.[0]).toBe(arr[0]); // untouched element preserved by reference
	});

	test("recomputeMilestones advances every entry based on tasks", () => {
		const ms: Milestone[] = [defaultMilestone("M-001", "a", ["F-001"]), defaultMilestone("M-002", "b", ["F-002"])];
		const tasks = [outcome("F-001", "succeeded"), outcome("F-002", "pending")];
		const next = recomputeMilestones(ms, tasks);
		expect(next?.[0]?.status).toBe("in_progress");
		// M-001 went to in_progress (something ran); next recompute takes it to validating.
		const next2 = recomputeMilestones(next, tasks);
		expect(next2?.[0]?.status).toBe("validating");
		expect(next2?.[1]?.status).toBe("pending");
	});

	test("recomputeMilestones returns undefined when input undefined", () => {
		expect(recomputeMilestones(undefined, [])).toBeUndefined();
	});
});

describe("toBatchMilestone + onTaskOutcomeRecorded", () => {
	test("toBatchMilestone projects every field", () => {
		const m: Milestone = {
			...defaultMilestone("M-001", "Mission", ["F-001"]),
			status: "validating",
			validationRounds: 2,
			maxValidationRounds: 4,
			startedAt: 10,
			endedAt: 20,
		};
		const b = toBatchMilestone(m);
		expect(b).toEqual({
			id: "M-001",
			name: "Mission",
			featureIds: ["F-001"],
			assertionIds: [],
			status: "validating",
			validationRounds: 2,
			maxValidationRounds: 4,
			startedAt: 10,
			endedAt: 20,
		});
		// Copy not alias.
		b.featureIds.push("leak");
		expect(m.featureIds).toEqual(["F-001"]);
	});

	test("onTaskOutcomeRecorded returns new milestones when state changes", () => {
		const waves: WaveAssignment[] = [{ wave: 1, taskIds: ["F-001"] }];
		const tasks = [outcome("F-001", "running")];
		const batch = {
			batchId: "b",
			phase: "running" as const,
			waves,
			currentWave: 0,
			laneCount: 1,
			laneStatuses: [],
			tasks,
			tasksTotal: 1,
			tasksComplete: 0,
			tasksFailed: 0,
			startTime: 0,
			errors: [],
			milestones: groupWavesIntoMilestones(waves.map(w => w.taskIds)).map(toBatchMilestone),
		};
		const next = onTaskOutcomeRecorded(batch, outcome("F-001", "running"));
		expect(next?.[0]?.status).toBe("in_progress");
	});

	test("onTaskOutcomeRecorded returns original reference when no milestones", () => {
		const batch = {
			batchId: "b",
			phase: "running" as const,
			waves: [],
			currentWave: 0,
			laneCount: 1,
			laneStatuses: [],
			tasks: [],
			tasksTotal: 0,
			tasksComplete: 0,
			tasksFailed: 0,
			startTime: 0,
			errors: [],
		};
		expect(onTaskOutcomeRecorded(batch, outcome("F-001", "running"))).toBeUndefined();
	});
});
