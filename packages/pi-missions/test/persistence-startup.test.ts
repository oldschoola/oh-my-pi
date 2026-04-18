/**
 * Tests for mission startup-state analyzer + orphan detection in
 * `missioncontrol/persistence.ts`.
 *
 * Covers `parseMissionSessionNames`, `analyzeMissionStartupState`
 * (9-cell decision matrix), and `detectOrphanSessions` (I/O path).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missionBatchPath } from "../src/missioncontrol/adapter";

import {
	analyzeMissionStartupState,
	detectOrphanSessions,
	parseMissionSessionNames,
	saveBatchState,
	serializeBatchState,
} from "../src/missioncontrol/persistence";
import type {
	AllocatedLane,
	MissionBatchPhase,
	MissionBatchRuntimeState,
	PersistedBatchState,
	PersistedTaskRecord,
} from "../src/missioncontrol/types";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "omp-startup-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function mkTask(id: string, taskFolder = ""): PersistedTaskRecord {
	return {
		taskId: id,
		laneNumber: 1,
		sessionName: `mission-lane-${id}`,
		status: "pending",
		taskFolder,
		startedAt: null,
		endedAt: null,
		doneFileFound: false,
		exitReason: "",
	};
}

function mkState(phase: MissionBatchPhase, tasks: PersistedTaskRecord[] = []): PersistedBatchState {
	return {
		phase,
		batchId: "b-startup",
		lanes: [],
		tasks,
		wavePlan: [],
	};
}

describe("parseMissionSessionNames", () => {
	test("returns [] for empty stdout", () => {
		expect(parseMissionSessionNames("", "mission")).toEqual([]);
	});

	test("returns [] for whitespace-only stdout", () => {
		expect(parseMissionSessionNames("   \n  \n", "mission")).toEqual([]);
	});

	test("filters names by `<prefix>-` (appends a dash)", () => {
		const stdout = "mission-lane-1\nother-lane-1\nmission-lane-2\n";
		expect(parseMissionSessionNames(stdout, "mission")).toEqual(["mission-lane-1", "mission-lane-2"]);
	});

	test("trims whitespace-padded names and drops blank lines", () => {
		const stdout = "  mission-lane-1  \n\n   \n\tmission-lane-2\t\n";
		expect(parseMissionSessionNames(stdout, "mission")).toEqual(["mission-lane-1", "mission-lane-2"]);
	});

	test("sorts the output alphabetically", () => {
		const stdout = "mission-z\nmission-a\nmission-m\n";
		expect(parseMissionSessionNames(stdout, "mission")).toEqual(["mission-a", "mission-m", "mission-z"]);
	});

	test("does NOT match the prefix without a dash separator", () => {
		const stdout = "missionary\nmission-real\n";
		expect(parseMissionSessionNames(stdout, "mission")).toEqual(["mission-real"]);
	});
});

describe("analyzeMissionStartupState — 9-cell decision matrix", () => {
	const noDone = new Set<string>();

	test("orphans + valid state → resume", () => {
		const state = mkState("executing", [mkTask("t-1")]);
		const result = analyzeMissionStartupState(["mission-lane-1"], "valid", state, null, noDone);
		expect(result.recommendedAction).toBe("resume");
		expect(result.userMessage).toContain("/mission-resume");
	});

	test("orphans + missing state → abort-orphans", () => {
		const result = analyzeMissionStartupState(["mission-lane-1"], "missing", null, null, noDone);
		expect(result.recommendedAction).toBe("abort-orphans");
		expect(result.userMessage).toContain("/mission-abort");
	});

	test("orphans + invalid state → abort-orphans (includes state error)", () => {
		const result = analyzeMissionStartupState(["mission-lane-1"], "invalid", null, "bad json", noDone);
		expect(result.recommendedAction).toBe("abort-orphans");
		expect(result.userMessage).toContain("bad json");
	});

	test("orphans + io-error state → abort-orphans", () => {
		const result = analyzeMissionStartupState(["mission-lane-1"], "io-error", null, "EIO", noDone);
		expect(result.recommendedAction).toBe("abort-orphans");
	});

	test("no orphans + valid state + all tasks done → cleanup-stale", () => {
		const state = mkState("executing", [mkTask("t-1"), mkTask("t-2")]);
		const done = new Set(["t-1", "t-2"]);
		const result = analyzeMissionStartupState([], "valid", state, null, done);
		expect(result.recommendedAction).toBe("cleanup-stale");
	});

	test("no orphans + valid state + partial done + resumable phase → resume", () => {
		const state = mkState("paused", [mkTask("t-1"), mkTask("t-2")]);
		const done = new Set(["t-1"]);
		const result = analyzeMissionStartupState([], "valid", state, null, done);
		expect(result.recommendedAction).toBe("resume");
		expect(result.userMessage).toContain("/mission-resume");
	});

	test("no orphans + valid state + non-resumable phase + 0 completed → cleanup-stale", () => {
		const state = mkState("failed", [mkTask("t-1")]);
		const result = analyzeMissionStartupState([], "valid", state, null, noDone);
		expect(result.recommendedAction).toBe("cleanup-stale");
	});

	test("no orphans + valid state + non-resumable phase + some completed → cleanup-stale", () => {
		const state = mkState("failed", [mkTask("t-1"), mkTask("t-2")]);
		const done = new Set(["t-1"]);
		const result = analyzeMissionStartupState([], "valid", state, null, done);
		expect(result.recommendedAction).toBe("cleanup-stale");
	});

	test("no orphans + missing → start-fresh (no message)", () => {
		const result = analyzeMissionStartupState([], "missing", null, null, noDone);
		expect(result.recommendedAction).toBe("start-fresh");
		expect(result.userMessage).toBe("");
	});

	test("no orphans + invalid → paused-corrupt (references .omp path)", () => {
		const result = analyzeMissionStartupState([], "invalid", null, "schema", noDone);
		expect(result.recommendedAction).toBe("paused-corrupt");
		expect(result.userMessage).toContain(".omp/mission-batch.json");
		expect(result.userMessage).toContain("schema");
	});

	test("no orphans + io-error → paused-corrupt", () => {
		const result = analyzeMissionStartupState([], "io-error", null, "EIO", noDone);
		expect(result.recommendedAction).toBe("paused-corrupt");
	});
});

function mkRuntimeState(
	phase: MissionBatchPhase,
	overrides: Partial<MissionBatchRuntimeState> = {},
): MissionBatchRuntimeState {
	return {
		phase,
		batchId: "b-startup-io",
		baseBranch: "main",
		orchBranch: "orch/b-startup-io",
		mode: "repo",
		pauseSignal: { paused: false },
		waveResults: [],
		currentWaveIndex: 0,
		totalWaves: 1,
		blockedTaskIds: new Set<string>(),
		startedAt: 1_700_000_000_000,
		endedAt: null,
		totalTasks: 1,
		succeededTasks: 0,
		failedTasks: 0,
		skippedTasks: 0,
		blockedTasks: 0,
		errors: [],
		currentLanes: [] as AllocatedLane[],
		dependencyGraph: null,
		mergeResults: [],
		...overrides,
	};
}

async function writeStateWithTaskFolder(cwd: string, phase: MissionBatchPhase, taskFolder: string): Promise<void> {
	const runtime = mkRuntimeState(phase);
	const json = serializeBatchState(runtime, [["t-1"]], [], []);
	// Inject taskFolder into the serialized task record so hasTaskDoneMarker can find a .DONE.
	const parsed = JSON.parse(json);
	(parsed.tasks as PersistedTaskRecord[])[0] = {
		...(parsed.tasks[0] as PersistedTaskRecord),
		taskId: "t-1",
		taskFolder,
	};
	await saveBatchState(JSON.stringify(parsed), cwd);
}

describe("detectOrphanSessions (async I/O)", () => {
	test("missing state file → start-fresh", async () => {
		const result = await detectOrphanSessions("mission", tmp);
		expect(result.recommendedAction).toBe("start-fresh");
		expect(result.stateStatus).toBe("missing");
		expect(result.loadedState).toBeNull();
	});

	test("valid state + no .DONE markers + resumable phase → resume", async () => {
		const taskFolder = join(tmp, "tasks", "t-1");
		mkdirSync(taskFolder, { recursive: true });
		await writeStateWithTaskFolder(tmp, "paused", taskFolder);
		const result = await detectOrphanSessions("mission", tmp);
		expect(result.stateStatus).toBe("valid");
		expect(result.recommendedAction).toBe("resume");
	});

	test("valid state + all tasks have .DONE → cleanup-stale", async () => {
		const taskFolder = join(tmp, "tasks", "t-1");
		mkdirSync(taskFolder, { recursive: true });
		writeFileSync(join(taskFolder, ".DONE"), "");
		await writeStateWithTaskFolder(tmp, "executing", taskFolder);
		const result = await detectOrphanSessions("mission", tmp);
		expect(result.recommendedAction).toBe("cleanup-stale");
	});

	test("malformed state JSON → paused-corrupt (stateStatus=invalid)", async () => {
		mkdirSync(join(tmp, ".omp"), { recursive: true });
		writeFileSync(missionBatchPath(tmp), "not valid json");
		const result = await detectOrphanSessions("mission", tmp);
		expect(result.stateStatus).toBe("invalid");
		expect(result.recommendedAction).toBe("paused-corrupt");
		expect(result.stateError).toContain("STATE_FILE_PARSE_ERROR");
	});
});
