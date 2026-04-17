/**
 * Tests for `applyPartialProgressToOutcomes` in `missioncontrol/persistence.ts`.
 *
 * Backfills saved-branch + commit-count metadata onto matching
 * `LaneTaskOutcome` entries from a `PreserveFailedLaneProgressResult`.
 */

import { describe, expect, test } from "bun:test";

import { applyPartialProgressToOutcomes } from "../src/missioncontrol/persistence";
import type { LaneTaskOutcome } from "../src/missioncontrol/types";
import type { PreserveFailedLaneProgressResult, SavePartialProgressResult } from "../src/missioncontrol/worktree";

function mkOutcome(taskId: string, overrides: Partial<LaneTaskOutcome> = {}): LaneTaskOutcome {
	return {
		taskId,
		status: "failed",
		startTime: null,
		endTime: null,
		exitReason: "test",
		sessionName: `mission-lane-${taskId}`,
		doneFileFound: false,
		laneNumber: 1,
		...overrides,
	};
}

function mkResult(overrides: Partial<SavePartialProgressResult> = {}): SavePartialProgressResult {
	return {
		saved: true,
		savedBranch: "saved/opid-TP-001-b-1",
		commitCount: 3,
		taskId: "TP-001",
		...overrides,
	};
}

function mkPPResult(results: SavePartialProgressResult[]): PreserveFailedLaneProgressResult {
	return {
		results,
		preservedBranches: new Set(results.filter(r => r.savedBranch).map(r => r.savedBranch as string)),
		unsafeBranches: new Set(),
	};
}

describe("applyPartialProgressToOutcomes", () => {
	test("backfills branch + commit count onto matching outcome", () => {
		const outcomes = [mkOutcome("TP-001")];
		const updated = applyPartialProgressToOutcomes(mkPPResult([mkResult()]), outcomes);
		expect(updated).toBe(1);
		expect(outcomes[0]?.partialProgressBranch).toBe("saved/opid-TP-001-b-1");
		expect(outcomes[0]?.partialProgressCommits).toBe(3);
	});

	test("skips results with saved=false", () => {
		const outcomes = [mkOutcome("TP-001")];
		const updated = applyPartialProgressToOutcomes(
			mkPPResult([mkResult({ saved: false, savedBranch: undefined })]),
			outcomes,
		);
		expect(updated).toBe(0);
		expect(outcomes[0]?.partialProgressBranch).toBeUndefined();
	});

	test("skips results missing savedBranch", () => {
		const outcomes = [mkOutcome("TP-001")];
		const updated = applyPartialProgressToOutcomes(mkPPResult([mkResult({ savedBranch: undefined })]), outcomes);
		expect(updated).toBe(0);
	});

	test("is a no-op when no outcome matches the result taskId", () => {
		const outcomes = [mkOutcome("TP-002")];
		const updated = applyPartialProgressToOutcomes(mkPPResult([mkResult({ taskId: "TP-001" })]), outcomes);
		expect(updated).toBe(0);
		expect(outcomes[0]?.partialProgressBranch).toBeUndefined();
	});

	test("leaves non-failed outcomes alone when their taskId is not in the result", () => {
		const outcomes = [mkOutcome("TP-001"), mkOutcome("TP-002", { status: "succeeded" })];
		applyPartialProgressToOutcomes(mkPPResult([mkResult()]), outcomes);
		expect(outcomes[1]?.partialProgressBranch).toBeUndefined();
		expect(outcomes[1]?.partialProgressCommits).toBeUndefined();
	});

	test("applies across multiple matching results", () => {
		const outcomes = [mkOutcome("TP-001"), mkOutcome("TP-002")];
		const updated = applyPartialProgressToOutcomes(
			mkPPResult([
				mkResult({ taskId: "TP-001", savedBranch: "saved/a", commitCount: 1 }),
				mkResult({ taskId: "TP-002", savedBranch: "saved/b", commitCount: 5 }),
			]),
			outcomes,
		);
		expect(updated).toBe(2);
		expect(outcomes[0]?.partialProgressBranch).toBe("saved/a");
		expect(outcomes[0]?.partialProgressCommits).toBe(1);
		expect(outcomes[1]?.partialProgressBranch).toBe("saved/b");
		expect(outcomes[1]?.partialProgressCommits).toBe(5);
	});

	test("overwrites prior partial-progress fields when a later preserve run succeeds", () => {
		const outcomes = [mkOutcome("TP-001", { partialProgressBranch: "saved/old", partialProgressCommits: 2 })];
		applyPartialProgressToOutcomes(mkPPResult([mkResult({ savedBranch: "saved/new", commitCount: 7 })]), outcomes);
		expect(outcomes[0]?.partialProgressBranch).toBe("saved/new");
		expect(outcomes[0]?.partialProgressCommits).toBe(7);
	});
});
