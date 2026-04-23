import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../src/missioncontrol/runtime";
import { readLockfile } from "../src/missioncontrol/supervisor";
import type { MissionState } from "../src/types";

function seedMission(description = "port taskplane"): MissionState {
	return {
		description,
		mode: "simple",
		phases: [
			{ name: "Plan", emoji: "🧭", status: "active" },
			{ name: "Build", emoji: "🔨", status: "pending" },
		],
		autonomy: "high",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: new Date().toISOString(),
		templateKey: "default",
		phasesExpanded: true,
		kind: "simple",
	};
}

describe("createEngine runtime surface", () => {
	let cwd: string;
	let stubPrev: string | undefined;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "mission-engine-"));
		stubPrev = process.env.OMP_MISSION_STUB_AGENT;
		process.env.OMP_MISSION_STUB_AGENT = "1";
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		if (stubPrev === undefined) delete process.env.OMP_MISSION_STUB_AGENT;
		else process.env.OMP_MISSION_STUB_AGENT = stubPrev;
	});

	it("is inert when no mission active", () => {
		const engine = createEngine({
			cwd,
			getMission: () => null,
			setMission: () => {},
		});

		expect(engine.status().active).toBe(false);
	});

	it("promotes a simple mission to batch and reports active status", async () => {
		let mission: MissionState | null = seedMission();
		const engine = createEngine({
			cwd,
			getMission: () => mission,
			setMission: state => {
				mission = state;
			},
		});

		const next = await engine.handlers.batch({ taskIds: ["TP-001", "TP-002"], laneCount: 2 });

		expect(next?.kind).toBe("batch");
		expect(next?.batch?.phase).toBe("running");
		expect(next?.batch?.tasksTotal).toBe(2);

		const status = engine.status();
		expect(status.active).toBe(true);
		expect(status.laneCount).toBe(2);
		expect(status.tasksTotal).toBe(2);

		// Clean shutdown so the lane-runner timer does not leak across tests.
		await engine.handlers.abort("test teardown");
	});

	it("pause + abort mutate batch phase and persist", async () => {
		let mission: MissionState | null = seedMission();
		const engine = createEngine({
			cwd,
			getMission: () => mission,
			setMission: state => {
				mission = state;
			},
		});

		await engine.handlers.batch({ taskIds: ["TP-001"], laneCount: 1 });
		expect(mission?.batch?.phase).toBe("running");

		await engine.handlers.pause();
		expect(mission?.batch?.phase).toBe("paused");

		const aborted = await engine.handlers.abort("operator");
		expect(aborted?.batch?.phase).toBe("aborted");
	});

	it("onSessionStart rehydrates a persisted batch", async () => {
		let mission: MissionState | null = seedMission();
		const engineA = createEngine({
			cwd,
			getMission: () => mission,
			setMission: state => {
				mission = state;
			},
		});

		await engineA.handlers.batch({ taskIds: ["TP-001"], laneCount: 1 });
		await engineA.handlers.pause();
		const persistedBatchId = mission?.batch?.batchId;
		expect(persistedBatchId).toBeDefined();

		// New engine instance in the same cwd should hydrate the persisted batch.
		let rehydrated: MissionState | null = null;
		const engineB = createEngine({
			cwd,
			getMission: () => rehydrated,
			setMission: state => {
				rehydrated = state;
			},
		});

		await engineB.hooks.onSessionStart();
		expect(rehydrated).not.toBeNull();
		expect((rehydrated as MissionState | null)?.batch?.batchId).toBe(persistedBatchId!);
	});

	it("activates supervisor on batch start and deactivates on pause/abort", async () => {
		let mission: MissionState | null = seedMission();
		const engine = createEngine({
			cwd,
			getMission: () => mission,
			setMission: state => {
				mission = state;
			},
		});

		await engine.handlers.batch({ taskIds: ["TP-A"], laneCount: 1 });
		const lockActive = readLockfile(cwd);
		expect(lockActive).not.toBeNull();
		expect(lockActive?.batchId).toBe(mission?.batch?.batchId);
		expect(lockActive?.pid).toBe(process.pid);

		await engine.handlers.pause();
		expect(readLockfile(cwd)).toBeNull();

		await engine.handlers.resume({ force: true });
		const lockResumed = readLockfile(cwd);
		expect(lockResumed).not.toBeNull();
		expect(lockResumed?.batchId).toBe(mission?.batch?.batchId);

		await engine.handlers.abort("test teardown");
		expect(readLockfile(cwd)).toBeNull();
	});

	it("onSessionEnd releases the supervisor lockfile", async () => {
		let mission: MissionState | null = seedMission();
		const engine = createEngine({
			cwd,
			getMission: () => mission,
			setMission: state => {
				mission = state;
			},
		});
		await engine.handlers.batch({ taskIds: ["TP-B"], laneCount: 1 });
		expect(readLockfile(cwd)).not.toBeNull();
		await engine.hooks.onSessionEnd();
		expect(readLockfile(cwd)).toBeNull();
	});
});
