import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	BATCH_STATE_SCHEMA_VERSION,
	loadBatchState,
	type MissionBatchRuntimeState,
	STATE_WRITE_MAX_RETRIES,
	STATE_WRITE_RETRY_DELAY_MS,
	StateFileError,
	saveBatchState,
	serializeBatchState,
	unlinkBatchState,
} from "../src/missioncontrol";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "mc-io-"));
});

afterEach(() => {
	try {
		rmSync(cwd, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup.
	}
});

function mkState(overrides: Partial<MissionBatchRuntimeState> = {}): MissionBatchRuntimeState {
	return {
		phase: "executing",
		batchId: "b-io-1",
		baseBranch: "main",
		orchBranch: "orch/b-io-1",
		mode: "repo",
		pauseSignal: { paused: false },
		waveResults: [],
		currentWaveIndex: 0,
		totalWaves: 1,
		blockedTaskIds: new Set<string>(),
		startedAt: 1700000000000,
		endedAt: null,
		totalTasks: 1,
		succeededTasks: 0,
		failedTasks: 0,
		skippedTasks: 0,
		blockedTasks: 0,
		errors: [],
		currentLanes: [],
		dependencyGraph: null,
		mergeResults: [],
		...overrides,
	};
}

describe("saveBatchState", () => {
	test("writes JSON to .omp/mission-batch.json atomically (no tmp file left behind)", async () => {
		const json = serializeBatchState(mkState(), [["TP-001"]], [], []);
		await saveBatchState(json, cwd);
		const finalPath = join(cwd, ".omp", "mission-batch.json");
		const tmpPath = `${finalPath}.tmp`;
		expect(existsSync(finalPath)).toBe(true);
		expect(existsSync(tmpPath)).toBe(false);
	});

	test("creates .omp dir when missing", async () => {
		const json = serializeBatchState(mkState(), [[]], [], []);
		await saveBatchState(json, cwd);
		expect(existsSync(join(cwd, ".omp"))).toBe(true);
	});

	test("overwrites existing state file", async () => {
		const json1 = serializeBatchState(mkState({ batchId: "first" }), [[]], [], []);
		const json2 = serializeBatchState(mkState({ batchId: "second" }), [[]], [], []);
		await saveBatchState(json1, cwd);
		await saveBatchState(json2, cwd);
		const raw = await readFile(join(cwd, ".omp", "mission-batch.json"), "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed.batchId).toBe("second");
	});

	test("throws StateFileError when target path is not writable", async () => {
		// Force failure by making .omp a file instead of a dir.
		const ompPath = join(cwd, ".omp");
		writeFileSync(ompPath, "not a dir");
		const json = serializeBatchState(mkState(), [[]], [], []);
		expect(async () => {
			await saveBatchState(json, cwd);
		}).toThrow(StateFileError);
	});

	test("retry constants exported", () => {
		expect(STATE_WRITE_MAX_RETRIES).toBe(3);
		expect(STATE_WRITE_RETRY_DELAY_MS).toBe(500);
	});
});

describe("loadBatchState", () => {
	test("returns null when no file exists", async () => {
		const result = await loadBatchState(cwd);
		expect(result).toBeNull();
	});

	test("reads + validates round-trip with serializeBatchState output", async () => {
		const json = serializeBatchState(
			mkState({ batchId: "round-trip", succeededTasks: 2 }),
			[["TP-001", "TP-002"]],
			[],
			[],
		);
		await saveBatchState(json, cwd);
		const loaded = await loadBatchState(cwd);
		expect(loaded).not.toBeNull();
		expect(loaded?.schemaVersion).toBe(BATCH_STATE_SCHEMA_VERSION);
		expect(loaded?.batchId).toBe("round-trip");
		expect(loaded?.succeededTasks).toBe(2);
		expect(loaded?.wavePlan).toEqual([["TP-001", "TP-002"]]);
	});

	test("falls back to legacy .pi/batch-state.json when native file missing", async () => {
		const legacyDir = join(cwd, ".pi");
		await mkdir(legacyDir, { recursive: true });
		const legacyJson = serializeBatchState(mkState({ batchId: "legacy" }), [[]], [], []);
		await writeFile(join(legacyDir, "batch-state.json"), legacyJson);
		const loaded = await loadBatchState(cwd);
		expect(loaded?.batchId).toBe("legacy");
	});

	test("throws STATE_FILE_PARSE_ERROR on invalid JSON", async () => {
		const dir = join(cwd, ".omp");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "mission-batch.json"), "{ not valid }");
		try {
			await loadBatchState(cwd);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(StateFileError);
			expect((err as StateFileError).code).toBe("STATE_FILE_PARSE_ERROR");
		}
	});

	test("throws STATE_SCHEMA_INVALID when JSON fails validation", async () => {
		const dir = join(cwd, ".omp");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "mission-batch.json"),
			JSON.stringify({ schemaVersion: 99, phase: "idle", batchId: "", lanes: [], tasks: [], wavePlan: [] }),
		);
		try {
			await loadBatchState(cwd);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(StateFileError);
			expect((err as StateFileError).code).toBe("STATE_SCHEMA_INVALID");
		}
	});

	test("upconverts v1 file in-memory and returns v4 shape", async () => {
		const dir = join(cwd, ".omp");
		mkdirSync(dir, { recursive: true });
		const v1Shape = {
			schemaVersion: 1,
			phase: "idle",
			batchId: "b-legacy",
			startedAt: 1700000000000,
			updatedAt: 1700000000000,
			endedAt: null,
			currentWaveIndex: 0,
			totalWaves: 0,
			totalTasks: 0,
			succeededTasks: 0,
			failedTasks: 0,
			skippedTasks: 0,
			blockedTasks: 0,
			blockedTaskIds: [],
			errors: [],
			lastError: null,
			lanes: [],
			tasks: [],
			wavePlan: [],
			mergeResults: [],
		};
		writeFileSync(join(dir, "mission-batch.json"), JSON.stringify(v1Shape));
		const loaded = await loadBatchState(cwd);
		expect(loaded?.schemaVersion).toBe(BATCH_STATE_SCHEMA_VERSION);
		expect(loaded?.baseBranch).toBe("");
		expect(loaded?.mode).toBe("repo");
		expect(loaded?.resilience).toEqual({
			resumeForced: false,
			retryCountByScope: {},
			lastFailureClass: null,
			repairHistory: [],
		});
		expect(loaded?.segments).toEqual([]);
	});
});

describe("unlinkBatchState", () => {
	test("no-op when file absent", async () => {
		await unlinkBatchState(cwd);
		expect(existsSync(join(cwd, ".omp", "mission-batch.json"))).toBe(false);
	});

	test("removes the file when present", async () => {
		const json = serializeBatchState(mkState(), [[]], [], []);
		await saveBatchState(json, cwd);
		const finalPath = join(cwd, ".omp", "mission-batch.json");
		expect(existsSync(finalPath)).toBe(true);
		await unlinkBatchState(cwd);
		expect(existsSync(finalPath)).toBe(false);
	});
});
