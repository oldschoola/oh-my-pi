/**
 * Integration test — drive the lane-runner end-to-end with a stubbed agent
 * (OMP_MISSION_STUB_AGENT=1). Asserts the engine transitions pending tasks
 * through running → succeeded → complete without real RPC calls.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { beginBatch, promoteToBatch } from "../src/missioncontrol/engine";
import { startLaneRunner } from "../src/missioncontrol/lane-runner";
import { DEFAULT_MISSIONCONTROL_CONFIG } from "../src/missioncontrol/types";
import type { MissionState } from "../src/types";

const originalStubFlag = process.env.OMP_MISSION_STUB_AGENT;

function baseMission(): MissionState {
	return {
		description: "test mission",
		mode: "simple",
		phases: [],
		autonomy: "auto",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: new Date().toISOString(),
	};
}

describe("lane-runner stub integration", () => {
	beforeEach(() => {
		process.env.OMP_MISSION_STUB_AGENT = "1";
	});
	afterEach(() => {
		if (originalStubFlag === undefined) delete process.env.OMP_MISSION_STUB_AGENT;
		else process.env.OMP_MISSION_STUB_AGENT = originalStubFlag;
	});

	test("drains all tasks to completion across waves", async () => {
		let state: MissionState = promoteToBatch(
			baseMission(),
			{ taskIds: ["t1", "t2", "t3"], laneCount: 2, waveSize: 2 },
			DEFAULT_MISSIONCONTROL_CONFIG,
		);
		state = beginBatch(state);

		const persisted: MissionState[] = [];
		const runner = startLaneRunner({
			cwd: process.cwd(),
			getMission: () => state,
			setMission: next => {
				state = next;
			},
			persist: async next => {
				persisted.push(next);
			},
			config: DEFAULT_MISSIONCONTROL_CONFIG,
		});

		const deadline = Date.now() + 5000;
		while (runner.running && Date.now() < deadline) {
			if (state.batch?.phase === "complete") break;
			await new Promise(r => setTimeout(r, 25));
		}
		await runner.stop();

		expect(state.batch?.phase).toBe("complete");
		expect(state.batch?.tasksComplete).toBe(3);
		expect(state.batch?.tasksFailed).toBe(0);
		expect(state.batch?.tasks.every(t => t.status === "succeeded")).toBe(true);
		expect(state.batch?.laneStatuses.every(l => l.status === "idle")).toBe(true);
		expect(persisted.length).toBeGreaterThan(0);
	});

	test("stop() aborts in-flight work cleanly", async () => {
		let state: MissionState = promoteToBatch(
			baseMission(),
			{ taskIds: ["t1"], laneCount: 1, waveSize: 1 },
			DEFAULT_MISSIONCONTROL_CONFIG,
		);
		state = beginBatch(state);

		const runner = startLaneRunner({
			cwd: process.cwd(),
			getMission: () => state,
			setMission: next => {
				state = next;
			},
			persist: async () => {},
			config: DEFAULT_MISSIONCONTROL_CONFIG,
		});

		await new Promise(r => setTimeout(r, 10));
		await runner.stop();
		expect(runner.running).toBe(false);
	});
});
