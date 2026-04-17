import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadActiveBatch } from "../src/missioncontrol/persistence";
import type { MissionState } from "../src/types";

function buildLegacyState(): MissionState {
	return {
		description: "legacy mission",
		mode: "simple",
		phases: [],
		autonomy: "high",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: "2026-01-01T00:00:00.000Z",
		kind: "batch",
		batch: {
			batchId: "batch-legacy-001",
			phase: "paused",
			waves: [],
			currentWave: 0,
			laneCount: 2,
			laneStatuses: [
				{ lane: 1, taskId: null, status: "idle", stepProgress: "", iteration: 0, elapsed: 0, sessionName: "" },
				{ lane: 2, taskId: null, status: "idle", stepProgress: "", iteration: 0, elapsed: 0, sessionName: "" },
			],
			tasks: [],
			tasksTotal: 0,
			tasksComplete: 0,
			tasksFailed: 0,
			startTime: Date.now(),
			errors: [],
		},
	};
}

describe("loadActiveBatch legacy migration", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "mc-legacy-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns null when no persisted state exists anywhere", async () => {
		const result = await loadActiveBatch(root);
		expect(result).toBeNull();
	});

	it("migrates .pi/batch-state.json → .omp/mission-batch.json on first load", async () => {
		const piDir = join(root, ".pi");
		mkdirSync(piDir, { recursive: true });
		const legacyPath = join(piDir, "batch-state.json");
		const payload = buildLegacyState();
		writeFileSync(legacyPath, JSON.stringify(payload), "utf8");

		const loaded = await loadActiveBatch(root);
		expect(loaded?.batch?.batchId).toBe("batch-legacy-001");

		// New .omp copy should exist after migration.
		const newPath = join(root, ".omp", "mission-batch.json");
		expect(existsSync(newPath)).toBe(true);

		// Legacy file is non-destructively kept in place (documented behaviour).
		expect(existsSync(legacyPath)).toBe(true);
	});

	it("prefers the .omp copy when both files exist", async () => {
		mkdirSync(join(root, ".pi"), { recursive: true });
		mkdirSync(join(root, ".omp"), { recursive: true });

		const legacy = buildLegacyState();
		legacy.batch!.batchId = "batch-legacy-old";
		writeFileSync(join(root, ".pi", "batch-state.json"), JSON.stringify(legacy));

		const current = buildLegacyState();
		current.batch!.batchId = "batch-current-new";
		writeFileSync(join(root, ".omp", "mission-batch.json"), JSON.stringify(current));

		const loaded = await loadActiveBatch(root);
		expect(loaded?.batch?.batchId).toBe("batch-current-new");
	});

	it("returns null when the legacy file is malformed JSON", async () => {
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "batch-state.json"), "{not json", "utf8");

		const loaded = await loadActiveBatch(root);
		expect(loaded).toBeNull();
	});
});
