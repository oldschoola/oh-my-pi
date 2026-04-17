/**
 * Unit tests for the pure autostash-index selector behind
 * `dropBatchAutostash`.
 *
 * The `dropBatchAutostash` wrapper itself shells out to `git` so its
 * coverage lives in integration tests; here we only exercise the
 * pattern-matching + descending-sort contract of
 * `selectBatchAutostashIndices`.
 */

import { describe, expect, test } from "bun:test";

import { selectBatchAutostashIndices } from "../src/missioncontrol/post-integration";

describe("selectBatchAutostashIndices", () => {
	test("empty stash output returns []", () => {
		expect(selectBatchAutostashIndices("", "batch-1")).toEqual([]);
	});

	test("whitespace-only stash output returns []", () => {
		expect(selectBatchAutostashIndices("   \n  \n", "batch-1")).toEqual([]);
	});

	test("empty batchId returns [] even when matching entries exist", () => {
		const output = "stash@{0} On main: orch-integrate-autostash-batch-1\n";
		expect(selectBatchAutostashIndices(output, "")).toEqual([]);
	});

	test("picks integrate-autostash entries by batch id", () => {
		const output = ["stash@{0} On main: orch-integrate-autostash-batch-1", "stash@{1} On feat: unrelated WIP"].join(
			"\n",
		);
		expect(selectBatchAutostashIndices(output, "batch-1")).toEqual([0]);
	});

	test("picks merge-agent-autostash wave entries by regex", () => {
		const output = [
			"stash@{0} On main: merge-agent-autostash-w2-batch-77",
			"stash@{1} On main: merge-agent-autostash-w10-batch-77",
			"stash@{2} On main: merge-agent-autostash-w0-other-batch",
		].join("\n");
		expect(selectBatchAutostashIndices(output, "batch-77")).toEqual([1, 0]);
	});

	test("returns all matches sorted descending (bottom-up drop order)", () => {
		const output = [
			"stash@{0} On main: orch-integrate-autostash-b9",
			"stash@{1} On main: unrelated",
			"stash@{2} On main: merge-agent-autostash-w1-b9",
			"stash@{3} On main: merge-agent-autostash-w5-b9",
		].join("\n");
		expect(selectBatchAutostashIndices(output, "b9")).toEqual([3, 2, 0]);
	});

	test("ignores malformed stash lines", () => {
		const output = [
			"garbage without stash prefix",
			"stash@{0} On main: orch-integrate-autostash-bX",
			"stash@{NaN} On main: orch-integrate-autostash-bX",
			"",
		].join("\n");
		expect(selectBatchAutostashIndices(output, "bX")).toEqual([0]);
	});

	test("batch id is regex-escaped so special chars do not break merge pattern", () => {
		const output = "stash@{0} On main: merge-agent-autostash-w1-batch.1+foo\n";
		expect(selectBatchAutostashIndices(output, "batch.1+foo")).toEqual([0]);
	});

	test("non-batch stash is never selected even when it looks similar", () => {
		const output = [
			"stash@{0} On main: orch-integrate-autostash-other-batch",
			"stash@{1} On main: merge-agent-autostash-w3-other-batch",
		].join("\n");
		expect(selectBatchAutostashIndices(output, "mine")).toEqual([]);
	});

	test("same batch appearing multiple times returns every index", () => {
		const output = [
			"stash@{0} On main: orch-integrate-autostash-b1",
			"stash@{1} On main: orch-integrate-autostash-b1",
			"stash@{5} On main: orch-integrate-autostash-b1",
		].join("\n");
		expect(selectBatchAutostashIndices(output, "b1")).toEqual([5, 1, 0]);
	});
});
