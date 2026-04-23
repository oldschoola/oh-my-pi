/**
 * Integration tests: engine reducers drive milestone transitions
 * (Track A3 hook into engine.ts:recordTaskOutcome + promoteToBatch).
 */

import { describe, expect, test } from "bun:test";

import { promoteToBatch, recordTaskOutcome } from "../src/missioncontrol";
import type { MissionState } from "../src/types";

function seedMission(): MissionState {
	return {
		description: "Test mission",
		mode: "simple",
		phases: [],
		autonomy: "medium",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: new Date().toISOString(),
	};
}

describe("promoteToBatch seeds a default milestone", () => {
	test("wraps promoted tasks in an implicit M-001 milestone", () => {
		const next = promoteToBatch(seedMission(), { taskIds: ["F-001", "F-002"], laneCount: 1, waveSize: 2 });
		expect(next.batch?.milestones).toHaveLength(1);
		const milestone = next.batch?.milestones?.[0];
		expect(milestone?.id).toBe("M-001");
		expect(milestone?.featureIds).toEqual(["F-001", "F-002"]);
		expect(milestone?.status).toBe("pending");
		expect(milestone?.validationRounds).toBe(0);
	});

	test("empty task set seeds no milestones", () => {
		const next = promoteToBatch(seedMission(), { taskIds: [] });
		expect(next.batch?.milestones).toEqual([]);
	});
});

describe("recordTaskOutcome advances milestone lifecycle", () => {
	function promoted(ids: string[] = ["F-001", "F-002"]) {
		return promoteToBatch(seedMission(), { taskIds: ids, laneCount: 2, waveSize: 2 });
	}

	test("transitions pending → in_progress on first running feature", () => {
		const state = promoted();
		const next = recordTaskOutcome(state, {
			taskId: "F-001",
			status: "running",
			startTime: 100,
			endTime: null,
			exitReason: "",
			sessionName: "sess-1",
			doneFileFound: false,
		});
		expect(next.batch?.milestones?.[0]?.status).toBe("in_progress");
	});

	test("transitions in_progress → validating when last feature completes", () => {
		let state = promoted();
		state = recordTaskOutcome(state, {
			taskId: "F-001",
			status: "succeeded",
			startTime: 100,
			endTime: 200,
			exitReason: "",
			sessionName: "sess-1",
			doneFileFound: true,
		});
		expect(state.batch?.milestones?.[0]?.status).toBe("in_progress");

		state = recordTaskOutcome(state, {
			taskId: "F-002",
			status: "succeeded",
			startTime: 200,
			endTime: 300,
			exitReason: "",
			sessionName: "sess-2",
			doneFileFound: true,
		});
		expect(state.batch?.milestones?.[0]?.status).toBe("validating");
	});

	test("does not rewind terminal milestones", () => {
		let state = promoted(["F-001"]);
		// Manually push milestone into `passed` for this scenario.
		if (state.batch) {
			state = {
				...state,
				batch: {
					...state.batch,
					milestones: state.batch.milestones?.map(m => ({ ...m, status: "passed" as const, endedAt: 999 })),
				},
			};
		}
		const next = recordTaskOutcome(state, {
			taskId: "F-001",
			status: "running",
			startTime: 10,
			endTime: null,
			exitReason: "",
			sessionName: "s",
			doneFileFound: false,
		});
		expect(next.batch?.milestones?.[0]?.status).toBe("passed");
	});
});
