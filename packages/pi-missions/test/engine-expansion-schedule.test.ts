/**
 * Unit tests for `scheduleContinuationSegmentRound` —
 * inserts a deterministic continuation wave after currentWaveIndex.
 */

import { describe, expect, test } from "bun:test";

import { scheduleContinuationSegmentRound } from "../src/missioncontrol/engine-expansion";

describe("scheduleContinuationSegmentRound", () => {
	test("inserts deduped + lex-sorted continuation wave immediately after current", () => {
		const rounds = [["TP-001", "TP-002"], ["TP-003"]];
		const result = scheduleContinuationSegmentRound(rounds, 0, ["TP-b", "TP-a", "TP-b", "TP-c"]);
		expect(result).toEqual(["TP-a", "TP-b", "TP-c"]);
		expect(rounds).toEqual([["TP-001", "TP-002"], ["TP-a", "TP-b", "TP-c"], ["TP-003"]]);
	});

	test("appends to the end when currentWaveIndex is the last index", () => {
		const rounds = [["W1"], ["W2"]];
		const result = scheduleContinuationSegmentRound(rounds, 1, ["TP-x"]);
		expect(result).toEqual(["TP-x"]);
		expect(rounds).toEqual([["W1"], ["W2"], ["TP-x"]]);
	});

	test("empty taskIds iterable returns empty array and does NOT mutate rounds", () => {
		const rounds = [["W1"], ["W2"]];
		const beforeLength = rounds.length;
		const result = scheduleContinuationSegmentRound(rounds, 0, []);
		expect(result).toEqual([]);
		expect(rounds.length).toBe(beforeLength);
	});

	test("all-duplicate taskIds iterable produces single-entry wave", () => {
		const rounds: string[][] = [[]];
		scheduleContinuationSegmentRound(rounds, 0, ["T", "T", "T"]);
		expect(rounds[1]).toEqual(["T"]);
	});

	test("inserts at index 0 when currentWaveIndex is -1 (before first wave)", () => {
		// Not the typical call site, but confirms the splice semantics.
		const rounds = [["W1"]];
		scheduleContinuationSegmentRound(rounds, -1, ["T"]);
		expect(rounds).toEqual([["T"], ["W1"]]);
	});

	test("accepts any iterable (Set works as well as array)", () => {
		const rounds: string[][] = [[]];
		const result = scheduleContinuationSegmentRound(rounds, 0, new Set(["b", "a"]));
		expect(result).toEqual(["a", "b"]);
	});
});
