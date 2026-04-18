/**
 * Tests for batch-history helpers in `missioncontrol/persistence.ts`.
 *
 * Validates round-trip, upsert-by-batchId, max-entries trim, legacy
 * `.pi/batch-history.json` fallback, and integration-timestamp update.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { legacyBatchHistoryPath, missionHistoryPath } from "../src/missioncontrol/adapter";
import { loadBatchHistory, saveBatchHistory, updateBatchHistoryIntegration } from "../src/missioncontrol/persistence";
import { BATCH_HISTORY_MAX_ENTRIES, type BatchHistorySummary } from "../src/missioncontrol/types";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "omp-history-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function mkSummary(batchId: string, overrides: Partial<BatchHistorySummary> = {}): BatchHistorySummary {
	return {
		batchId,
		status: "completed",
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_060_000,
		durationMs: 60_000,
		totalWaves: 1,
		totalTasks: 1,
		succeededTasks: 1,
		failedTasks: 0,
		skippedTasks: 0,
		blockedTasks: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
		tasks: [],
		waves: [],
		...overrides,
	};
}

describe("loadBatchHistory", () => {
	test("returns [] when no history file exists", async () => {
		expect(await loadBatchHistory(tmp)).toEqual([]);
	});

	test("reads the new .omp/mission-history.json path when present", async () => {
		const history = [mkSummary("b-1"), mkSummary("b-2")];
		mkdirSync(join(tmp, ".omp"), { recursive: true });
		writeFileSync(missionHistoryPath(tmp), JSON.stringify(history));
		expect(await loadBatchHistory(tmp)).toEqual(history);
	});

	test("falls back to legacy .pi/batch-history.json when new path missing", async () => {
		const legacy = [mkSummary("legacy-1")];
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(legacyBatchHistoryPath(tmp), JSON.stringify(legacy));
		expect(await loadBatchHistory(tmp)).toEqual(legacy);
	});

	test("prefers new path over legacy when both exist", async () => {
		const newOne = [mkSummary("new")];
		const legacy = [mkSummary("legacy")];
		mkdirSync(join(tmp, ".omp"), { recursive: true });
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(missionHistoryPath(tmp), JSON.stringify(newOne));
		writeFileSync(legacyBatchHistoryPath(tmp), JSON.stringify(legacy));
		expect(await loadBatchHistory(tmp)).toEqual(newOne);
	});

	test("returns [] on malformed JSON (non-array)", async () => {
		mkdirSync(join(tmp, ".omp"), { recursive: true });
		writeFileSync(missionHistoryPath(tmp), `{"not":"array"}`);
		expect(await loadBatchHistory(tmp)).toEqual([]);
	});

	test("returns [] on invalid JSON", async () => {
		mkdirSync(join(tmp, ".omp"), { recursive: true });
		writeFileSync(missionHistoryPath(tmp), "not json");
		expect(await loadBatchHistory(tmp)).toEqual([]);
	});
});

describe("saveBatchHistory", () => {
	test("creates history file and prepends newest-first", async () => {
		await saveBatchHistory(tmp, mkSummary("b-1"));
		await saveBatchHistory(tmp, mkSummary("b-2"));
		const history = await loadBatchHistory(tmp);
		expect(history.map(h => h.batchId)).toEqual(["b-2", "b-1"]);
	});

	test("upserts by batchId — resumed batch replaces earlier entry", async () => {
		await saveBatchHistory(tmp, mkSummary("b-1", { status: "partial", durationMs: 10 }));
		await saveBatchHistory(tmp, mkSummary("other"));
		await saveBatchHistory(tmp, mkSummary("b-1", { status: "completed", durationMs: 99_999 }));
		const history = await loadBatchHistory(tmp);
		expect(history).toHaveLength(2);
		// Newest-first: the replaced b-1 is at the head.
		expect(history[0]).toMatchObject({ batchId: "b-1", status: "completed", durationMs: 99_999 });
		expect(history[1]).toMatchObject({ batchId: "other" });
	});

	test(`trims to BATCH_HISTORY_MAX_ENTRIES (${BATCH_HISTORY_MAX_ENTRIES})`, async () => {
		// Save one more than the cap to exercise the trim.
		for (let i = 0; i < BATCH_HISTORY_MAX_ENTRIES + 3; i++) {
			await saveBatchHistory(tmp, mkSummary(`b-${i}`));
		}
		const history = await loadBatchHistory(tmp);
		expect(history).toHaveLength(BATCH_HISTORY_MAX_ENTRIES);
		// Oldest kept at tail, newest at head
		const last = BATCH_HISTORY_MAX_ENTRIES + 2;
		expect(history[0]?.batchId).toBe(`b-${last}`);
		expect(history.at(-1)?.batchId).toBe(`b-${3}`);
	});

	test("writes atomically — no .tmp file left behind", async () => {
		await saveBatchHistory(tmp, mkSummary("b-1"));
		const finalPath = missionHistoryPath(tmp);
		expect(() => readFileSync(finalPath, "utf-8")).not.toThrow();
		expect(() => readFileSync(`${finalPath}.tmp`, "utf-8")).toThrow();
	});

	test("writes formatted JSON with 2-space indent", async () => {
		await saveBatchHistory(tmp, mkSummary("b-1"));
		const raw = readFileSync(missionHistoryPath(tmp), "utf-8");
		expect(raw).toContain("\n  ");
	});
});

describe("updateBatchHistoryIntegration", () => {
	test("sets integratedAt on a matching entry", async () => {
		await saveBatchHistory(tmp, mkSummary("b-1"));
		await updateBatchHistoryIntegration(tmp, "b-1", 1_700_000_999_000);
		const [entry] = await loadBatchHistory(tmp);
		expect(entry?.integratedAt).toBe(1_700_000_999_000);
	});

	test("is a no-op when batchId is absent", async () => {
		await saveBatchHistory(tmp, mkSummary("existing"));
		await updateBatchHistoryIntegration(tmp, "missing-id", 42);
		const [entry] = await loadBatchHistory(tmp);
		expect(entry?.integratedAt).toBeUndefined();
	});

	test("leaves other entries unchanged", async () => {
		await saveBatchHistory(tmp, mkSummary("a"));
		await saveBatchHistory(tmp, mkSummary("b"));
		await updateBatchHistoryIntegration(tmp, "a", 777);
		const history = await loadBatchHistory(tmp);
		const a = history.find(e => e.batchId === "a");
		const b = history.find(e => e.batchId === "b");
		expect(a?.integratedAt).toBe(777);
		expect(b?.integratedAt).toBeUndefined();
	});
});
