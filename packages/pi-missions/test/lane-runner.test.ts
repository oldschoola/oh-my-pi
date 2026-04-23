/**
 * Integration test — drive the lane-runner end-to-end with a stubbed agent
 * (OMP_MISSION_STUB_AGENT=1). Asserts the engine transitions pending tasks
 * through running → succeeded → complete without real RPC calls, and that
 * every spawn writes a runtime manifest + attaches telemetry to its
 * `TaskOutcome`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { supervisorEventsPath } from "../src/missioncontrol/adapter";
import { beginBatch, promoteToBatch } from "../src/missioncontrol/engine";
import { startLaneRunner } from "../src/missioncontrol/lane-runner";
import { readRegistrySnapshot } from "../src/missioncontrol/process-registry";
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
	let sandbox: string;

	beforeEach(() => {
		process.env.OMP_MISSION_STUB_AGENT = "1";
		sandbox = mkdtempSync(join(tmpdir(), "omp-lane-runner-"));
	});
	afterEach(() => {
		if (originalStubFlag === undefined) delete process.env.OMP_MISSION_STUB_AGENT;
		else process.env.OMP_MISSION_STUB_AGENT = originalStubFlag;
		rmSync(sandbox, { recursive: true, force: true });
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
			cwd: sandbox,
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

		// Every completed task carries a telemetry rollup (zeros in stub mode,
		// but the field must exist — dashboard's `aggregateBatchTelemetry`
		// reads it without null-checking beyond the field itself).
		const tasks = state.batch?.tasks ?? [];
		expect(tasks).toHaveLength(3);
		for (const task of tasks) {
			expect(task.telemetry).toBeDefined();
			expect(task.telemetry).toMatchObject({
				inputTokens: expect.any(Number),
				outputTokens: expect.any(Number),
				cacheReadTokens: expect.any(Number),
				cacheWriteTokens: expect.any(Number),
				costUsd: expect.any(Number),
				toolCalls: expect.any(Number),
				durationMs: expect.any(Number),
			});
		}

		// Every spawn wrote a manifest that the dashboard's Agents panel reads
		// via the per-batch registry snapshot.
		const batchId = state.batch?.batchId;
		expect(batchId).toBeTruthy();
		const registry = readRegistrySnapshot(sandbox, batchId as string);
		expect(registry).not.toBeNull();
		const agents = Object.values(registry?.agents ?? {});
		expect(agents.length).toBe(3);
		for (const agent of agents) {
			expect(agent.role).toBe("worker");
			expect(agent.status).toBe("crashed");
			// Stub mode never fires `agent_end`, so the host records a non-clean
			// terminal state. The important contract for the dashboard is that
			// a manifest exists per spawn — status progression is exercised by
			// agent-host.test.ts.
		}

		// Engine lifecycle events are written to `.omp/supervisor/events.jsonl`.
		// Dashboard's SupervisorPanel reads this file through `readEngineEventsForBatch`.
		const eventsPath = supervisorEventsPath(sandbox);
		const { readFileSync, existsSync } = await import("node:fs");
		expect(existsSync(eventsPath)).toBe(true);
		const rows = readFileSync(eventsPath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(l => JSON.parse(l));
		const types = rows.map(r => r.type);
		expect(types).toContain("task_complete");
		expect(types).toContain("batch_complete");
		// With 3 tasks across 2 waves there should be at least one wave_start
		// for the second wave (wave 0 is implicit at beginBatch time).
		expect(types).toContain("wave_start");
	});

	test("stop() aborts in-flight work cleanly", async () => {
		let state: MissionState = promoteToBatch(
			baseMission(),
			{ taskIds: ["t1"], laneCount: 1, waveSize: 1 },
			DEFAULT_MISSIONCONTROL_CONFIG,
		);
		state = beginBatch(state);

		const runner = startLaneRunner({
			cwd: sandbox,
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
