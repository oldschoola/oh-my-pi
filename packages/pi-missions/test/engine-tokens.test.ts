/**
 * Unit tests for `missioncontrol/engine-tokens.ts` — pure token aggregation
 * helpers used by batch-history assembly. Exercises the priority chain in
 * `resolveBatchHistoryTaskTokens` end-to-end with minimal fixtures.
 */

import { describe, expect, test } from "bun:test";

import { resolveBatchHistoryTaskTokens, taskTokensFromOutcomeTelemetry } from "../src/missioncontrol/engine-tokens";
import type { LaneTaskOutcome, LaneTaskOutcomeTelemetry, TokenCounts } from "../src/missioncontrol/types";

function makeTelemetry(overrides: Partial<LaneTaskOutcomeTelemetry> = {}): LaneTaskOutcomeTelemetry {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		toolCalls: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeOutcome(overrides: Partial<LaneTaskOutcome> = {}): LaneTaskOutcome {
	return {
		taskId: "TP-001",
		status: "succeeded",
		startTime: null,
		endTime: null,
		exitReason: "done",
		sessionName: "session-1",
		doneFileFound: true,
		...overrides,
	};
}

function counts(overrides: Partial<TokenCounts> = {}): TokenCounts {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, ...overrides };
}

describe("taskTokensFromOutcomeTelemetry", () => {
	test("returns fresh zero counts when telemetry is absent", () => {
		const result = taskTokensFromOutcomeTelemetry(makeOutcome());
		expect(result).toEqual(counts());
	});

	test("maps all five telemetry fields into TokenCounts shape", () => {
		const outcome = makeOutcome({
			telemetry: makeTelemetry({
				inputTokens: 10,
				outputTokens: 20,
				cacheReadTokens: 30,
				cacheWriteTokens: 40,
				costUsd: 1.25,
			}),
		});
		expect(taskTokensFromOutcomeTelemetry(outcome)).toEqual({
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			costUsd: 1.25,
		});
	});

	test("returned zero object is a fresh copy, not a shared reference", () => {
		const first = taskTokensFromOutcomeTelemetry(makeOutcome());
		first.input = 999;
		const second = taskTokensFromOutcomeTelemetry(makeOutcome());
		expect(second.input).toBe(0);
	});
});

describe("resolveBatchHistoryTaskTokens priority chain", () => {
	test("skipped status short-circuits to zero even when telemetry, V2, or legacy would match", () => {
		const outcome = makeOutcome({
			status: "skipped",
			laneNumber: 2,
			telemetry: makeTelemetry({ inputTokens: 500 }),
		});
		const v2 = new Map<number, TokenCounts>([[2, counts({ input: 111 })]]);
		const legacy = new Map<string, TokenCounts>([["session-1", counts({ input: 222 })]]);

		expect(resolveBatchHistoryTaskTokens(outcome, 2, v2, legacy)).toEqual(counts());
	});

	test("embedded telemetry wins over V2 and legacy lookups", () => {
		const outcome = makeOutcome({
			laneNumber: 2,
			telemetry: makeTelemetry({
				inputTokens: 1,
				outputTokens: 2,
				cacheReadTokens: 3,
				cacheWriteTokens: 4,
				costUsd: 0.5,
			}),
		});
		const v2 = new Map<number, TokenCounts>([[2, counts({ input: 999 })]]);
		const legacy = new Map<string, TokenCounts>([["session-1", counts({ input: 888 })]]);

		expect(resolveBatchHistoryTaskTokens(outcome, 2, v2, legacy)).toEqual({
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			costUsd: 0.5,
		});
	});

	test("V2 by laneNumber used when no telemetry", () => {
		const outcome = makeOutcome({ sessionName: "no-legacy-key" });
		const v2 = new Map<number, TokenCounts>([[3, counts({ input: 77 })]]);
		const legacy = new Map<string, TokenCounts>();

		expect(resolveBatchHistoryTaskTokens(outcome, 3, v2, legacy)).toEqual(counts({ input: 77 }));
	});

	test("legacy lookup by exact sessionName when no telemetry or V2 hit", () => {
		const outcome = makeOutcome({ sessionName: "lane-1-worker" });
		const v2 = new Map<number, TokenCounts>();
		const legacy = new Map<string, TokenCounts>([["lane-1-worker", counts({ input: 55 })]]);

		expect(resolveBatchHistoryTaskTokens(outcome, 1, v2, legacy)).toEqual(counts({ input: 55 }));
	});

	test("legacy lookup strips -worker suffix from sessionName", () => {
		const outcome = makeOutcome({ sessionName: "lane-1-worker" });
		const v2 = new Map<number, TokenCounts>();
		const legacy = new Map<string, TokenCounts>([["lane-1", counts({ input: 33 })]]);

		expect(resolveBatchHistoryTaskTokens(outcome, 1, v2, legacy)).toEqual(counts({ input: 33 }));
	});

	test("legacy lookup strips -reviewer suffix from sessionName", () => {
		const outcome = makeOutcome({ sessionName: "lane-1-reviewer" });
		const v2 = new Map<number, TokenCounts>();
		const legacy = new Map<string, TokenCounts>([["lane-1", counts({ input: 42 })]]);

		expect(resolveBatchHistoryTaskTokens(outcome, 1, v2, legacy)).toEqual(counts({ input: 42 }));
	});

	test("legacy `lane-{N}` key used as final fallback when sessionName misses", () => {
		const outcome = makeOutcome({ sessionName: "unrelated-session" });
		const v2 = new Map<number, TokenCounts>();
		const legacy = new Map<string, TokenCounts>([["lane-5", counts({ input: 21 })]]);

		expect(resolveBatchHistoryTaskTokens(outcome, 5, v2, legacy)).toEqual(counts({ input: 21 }));
	});

	test("returns fresh zero counts when nothing matches", () => {
		const outcome = makeOutcome({ sessionName: "ghost" });
		const v2 = new Map<number, TokenCounts>();
		const legacy = new Map<string, TokenCounts>();

		expect(resolveBatchHistoryTaskTokens(outcome, 9, v2, legacy)).toEqual(counts());
	});

	test("laneNumber <= 0 skips V2 and lane-key lookups, falls through to sessionName", () => {
		const outcome = makeOutcome({ sessionName: "session-x" });
		const v2 = new Map<number, TokenCounts>([[0, counts({ input: 999 })]]);
		const legacy = new Map<string, TokenCounts>([
			["lane-0", counts({ input: 888 })],
			["session-x", counts({ input: 7 })],
		]);

		expect(resolveBatchHistoryTaskTokens(outcome, 0, v2, legacy)).toEqual(counts({ input: 7 }));
	});

	test("zero fallback is a fresh copy (callers can mutate safely)", () => {
		const outcome = makeOutcome({ sessionName: "ghost" });
		const a = resolveBatchHistoryTaskTokens(outcome, 9, new Map(), new Map());
		a.input = 500;
		const b = resolveBatchHistoryTaskTokens(outcome, 9, new Map(), new Map());
		expect(b.input).toBe(0);
	});
});
