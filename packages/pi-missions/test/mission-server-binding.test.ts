/**
 * Contract tests for `bindMissionServer` — the extension-side wire-up that
 * populates `server-hooks.ts` so the dashboard's HTTP endpoints can signal
 * the live mission state, engine, and `pi.sendUserMessage` channel.
 *
 * Focus: the `controlBatch` hook must dispatch through the engine handlers
 * so the in-memory lane-runner observes pause/resume. The prior wiring
 * only mutated `.omp/mission-batch.json` on disk — which left the runner
 * oblivious to the phase change.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getDefaultToken, removeDefaultBridge } from "../src/gui-bridge";
import { bindMissionServer } from "../src/mission-server-binding";
import { clearMissionServerHooks, getMissionServerHooks } from "../src/server-hooks";
import type { BatchPhase, MissionState } from "../src/types";

function seedBatchMission(phase: BatchPhase = "running"): MissionState {
	return {
		description: "batch under test",
		mode: "simple",
		phases: [],
		autonomy: "auto",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: new Date().toISOString(),
		kind: "batch",
		batch: {
			batchId: "batch-bind-1",
			phase,
			waves: [],
			currentWave: 0,
			laneCount: 1,
			laneStatuses: [],
			tasks: [],
			tasksTotal: 0,
			tasksComplete: 0,
			tasksFailed: 0,
			startTime: Date.now(),
			errors: [],
		},
	};
}

function stubPi(): ExtensionAPI {
	// Narrow stub — bindMissionServer only calls sendUserMessage /
	// appendEntry / setSessionName on error paths we do not exercise
	// in controlBatch tests.
	return {
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
	} as unknown as ExtensionAPI;
}

describe("bindMissionServer controlBatch hook", () => {
	let cwd = "";
	afterEach(() => {
		clearMissionServerHooks();
		if (cwd) {
			rmSync(cwd, { recursive: true, force: true });
			cwd = "";
		}
	});

	it("forwards pause action to engineHandlers.pause when the current phase is running", async () => {
		cwd = mkdtempSync(join(tmpdir(), "omp-bind-"));
		let mission: MissionState | null = seedBatchMission("running");
		const pauseCalls: number[] = [];

		bindMissionServer({
			pi: stubPi(),
			cwd,
			getState: () => mission,
			setState: s => {
				mission = s;
			},
			getCtx: () => null,
			engineHandlers: {
				pause: async () => {
					pauseCalls.push(Date.now());
					if (mission?.batch) mission = { ...mission, batch: { ...mission.batch, phase: "paused" } };
					return mission;
				},
				resume: async () => mission,
			},
		});

		const hook = getMissionServerHooks().controlBatch;
		expect(hook).toBeDefined();
		const result = await hook!("pause");
		expect(result).toEqual({ ok: true, phase: "paused" });
		expect(pauseCalls.length).toBe(1);
	});

	it("rejects pause when phase is not running and does not call the engine", async () => {
		cwd = mkdtempSync(join(tmpdir(), "omp-bind-"));
		const mission: MissionState = seedBatchMission("paused");
		let engineInvoked = false;

		bindMissionServer({
			pi: stubPi(),
			cwd,
			getState: () => mission,
			setState: () => {},
			getCtx: () => null,
			engineHandlers: {
				pause: async () => {
					engineInvoked = true;
					return mission;
				},
				resume: async () => mission,
			},
		});

		const result = await getMissionServerHooks().controlBatch!("pause");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("not_pausable:paused");
		expect(engineInvoked).toBe(false);
	});

	it("forwards resume action to engineHandlers.resume when the current phase is paused", async () => {
		cwd = mkdtempSync(join(tmpdir(), "omp-bind-"));
		let mission: MissionState | null = seedBatchMission("paused");
		const resumeForceFlags: Array<boolean | undefined> = [];

		bindMissionServer({
			pi: stubPi(),
			cwd,
			getState: () => mission,
			setState: s => {
				mission = s;
			},
			getCtx: () => null,
			engineHandlers: {
				pause: async () => mission,
				resume: async opts => {
					resumeForceFlags.push(opts?.force);
					if (mission?.batch) mission = { ...mission, batch: { ...mission.batch, phase: "running" } };
					return mission;
				},
			},
		});

		const result = await getMissionServerHooks().controlBatch!("resume");
		expect(result).toEqual({ ok: true, phase: "running" });
		expect(resumeForceFlags).toEqual([undefined]);
	});

	it("rejects resume when phase is not paused and force flag is absent", async () => {
		cwd = mkdtempSync(join(tmpdir(), "omp-bind-"));
		const mission: MissionState = seedBatchMission("running");
		let engineInvoked = false;

		bindMissionServer({
			pi: stubPi(),
			cwd,
			getState: () => mission,
			setState: () => {},
			getCtx: () => null,
			engineHandlers: {
				pause: async () => mission,
				resume: async () => {
					engineInvoked = true;
					return mission;
				},
			},
		});

		// The engine would no-op this anyway (phase already running). The
		// hook surfaces ok:true with the unchanged phase so the dashboard
		// stays in sync without treating it as an operator error.
		const result = await getMissionServerHooks().controlBatch!("resume");
		expect(result.ok).toBe(true);
		expect(result.phase).toBe("running");
		expect(engineInvoked).toBe(false);
	});

	it("forwards resume with force=true to engineHandlers.resume for stuck batches", async () => {
		cwd = mkdtempSync(join(tmpdir(), "omp-bind-"));
		let mission: MissionState | null = seedBatchMission("error");
		const resumeForceFlags: Array<boolean | undefined> = [];

		bindMissionServer({
			pi: stubPi(),
			cwd,
			getState: () => mission,
			setState: s => {
				mission = s;
			},
			getCtx: () => null,
			engineHandlers: {
				pause: async () => mission,
				resume: async opts => {
					resumeForceFlags.push(opts?.force);
					if (mission?.batch) mission = { ...mission, batch: { ...mission.batch, phase: "running" } };
					return mission;
				},
			},
		});

		const result = await getMissionServerHooks().controlBatch!("resume", { force: true });
		expect(result.ok).toBe(true);
		expect(resumeForceFlags).toEqual([true]);
	});

	it("returns no_active_batch when called without an active batch mission", async () => {
		cwd = mkdtempSync(join(tmpdir(), "omp-bind-"));
		bindMissionServer({
			pi: stubPi(),
			cwd,
			getState: () => null,
			setState: () => {},
			getCtx: () => null,
			engineHandlers: {
				pause: async () => null,
				resume: async () => null,
			},
		});

		const result = await getMissionServerHooks().controlBatch!("pause");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("no_active_batch");
	});

	it("leaves controlBatch hook unset when engineHandlers are not provided (standalone boot)", async () => {
		cwd = mkdtempSync(join(tmpdir(), "omp-bind-"));
		bindMissionServer({
			pi: stubPi(),
			cwd,
			getState: () => null,
			setState: () => {},
			getCtx: () => null,
		});
		expect(getMissionServerHooks().controlBatch).toBeUndefined();
		// controlSimple is still wired.
		expect(getMissionServerHooks().controlSimple).toBeDefined();
	});
});

describe("bindMissionServer default bridge registration", () => {
	let cwd = "";
	beforeEach(() => {
		// The `controlBatch` suite above does not unregister the default bridge
		// between tests. Start from a clean slate so the first assertion in
		// each test here is deterministic.
		removeDefaultBridge();
	});
	afterEach(() => {
		clearMissionServerHooks();
		removeDefaultBridge();
		if (cwd) {
			rmSync(cwd, { recursive: true, force: true });
			cwd = "";
		}
	});

	it("registers a default GUI bridge synchronously so the dashboard can resolve a token immediately", () => {
		cwd = mkdtempSync(join(tmpdir(), "omp-bind-"));
		expect(getDefaultToken()).toBeNull();
		bindMissionServer({
			pi: stubPi(),
			cwd,
			getState: () => null,
			setState: () => {},
			getCtx: () => null,
		});
		const token = getDefaultToken();
		expect(token).not.toBeNull();
		expect(token).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("replaces any prior default bridge on re-bind so extension reloads mint a fresh token", () => {
		cwd = mkdtempSync(join(tmpdir(), "omp-bind-"));
		bindMissionServer({
			pi: stubPi(),
			cwd,
			getState: () => null,
			setState: () => {},
			getCtx: () => null,
		});
		const first = getDefaultToken();
		expect(first).not.toBeNull();
		bindMissionServer({
			pi: stubPi(),
			cwd,
			getState: () => null,
			setState: () => {},
			getCtx: () => null,
		});
		const second = getDefaultToken();
		expect(second).not.toBeNull();
		expect(second).not.toBe(first);
	});
});
