/**
 * Unit tests for the telemetry rollup (Track K).
 */

import { describe, expect, test } from "bun:test";

import type { PersistedBatchState, PersistedTaskRecord } from "../src/missioncontrol";
import {
	bucketDurations,
	DEFAULT_DURATION_BUCKETS,
	extractDurations,
	rollupBatchState,
	rollupTelemetry,
	TELEMETRY_ROLES,
	type TelemetryRole,
	type TelemetrySample,
	taskRecordToSample,
} from "../src/missioncontrol";

function sample(role: TelemetryRole, overrides: Partial<TelemetrySample> = {}): TelemetrySample {
	return {
		role,
		durationMs: 1000,
		inputTokens: 10,
		outputTokens: 20,
		cacheReadTokens: 30,
		cacheWriteTokens: 5,
		costUsd: 0.01,
		toolCalls: 2,
		...overrides,
	};
}

function task(overrides: Partial<PersistedTaskRecord> = {}): PersistedTaskRecord {
	return {
		taskId: "T-001",
		laneNumber: 1,
		sessionName: "s",
		status: "succeeded",
		taskFolder: "tasks/T-001",
		startedAt: 1000,
		endedAt: 3000,
		doneFileFound: true,
		exitReason: "",
		...overrides,
	};
}

function mkState(overrides: Partial<PersistedBatchState> = {}): PersistedBatchState {
	return {
		schemaVersion: 5,
		batchId: "b-1",
		phase: "completed",
		lanes: [],
		tasks: [],
		wavePlan: [],
		...overrides,
	};
}

describe("rollupTelemetry", () => {
	test("empty input produces zeroed rollup for every role", () => {
		const rollup = rollupTelemetry([]);
		expect(rollup.perRole).toHaveLength(TELEMETRY_ROLES.length);
		for (const r of rollup.perRole) {
			expect(r.count).toBe(0);
			expect(r.totalTokens).toBe(0);
			expect(r.durationMs).toBe(0);
			expect(r.costUsd).toBe(0);
		}
		expect(rollup.totals.count).toBe(0);
	});

	test("sums per role independently", () => {
		const rollup = rollupTelemetry([
			sample("worker", { durationMs: 500, costUsd: 0.01 }),
			sample("worker", { durationMs: 1000, costUsd: 0.02 }),
			sample("scrutiny_validator", { durationMs: 100, costUsd: 0.005 }),
		]);
		const worker = rollup.perRole.find(r => r.role === "worker")!;
		const scrutiny = rollup.perRole.find(r => r.role === "scrutiny_validator")!;
		expect(worker.count).toBe(2);
		expect(worker.durationMs).toBe(1500);
		expect(worker.costUsd).toBeCloseTo(0.03, 5);
		expect(scrutiny.count).toBe(1);
		expect(scrutiny.durationMs).toBe(100);
	});

	test("totalTokens is inputs + outputs + cacheRead + cacheWrite", () => {
		const rollup = rollupTelemetry([
			sample("worker", {
				inputTokens: 10,
				outputTokens: 20,
				cacheReadTokens: 30,
				cacheWriteTokens: 40,
			}),
		]);
		const worker = rollup.perRole.find(r => r.role === "worker")!;
		expect(worker.totalTokens).toBe(100);
	});

	test("totals sums across every role", () => {
		const rollup = rollupTelemetry([
			sample("worker", { durationMs: 1000, costUsd: 0.01, toolCalls: 3 }),
			sample("orchestrator", { durationMs: 500, costUsd: 0.02, toolCalls: 1 }),
			sample("user_testing_validator", { durationMs: 250, costUsd: 0.005, toolCalls: 5 }),
		]);
		expect(rollup.totals.count).toBe(3);
		expect(rollup.totals.durationMs).toBe(1750);
		expect(rollup.totals.costUsd).toBeCloseTo(0.035, 5);
		expect(rollup.totals.toolCalls).toBe(9);
	});

	test("unknown roles are silently dropped", () => {
		const rollup = rollupTelemetry([
			sample("worker"),
			{ ...sample("worker"), role: "nonexistent" as unknown as TelemetryRole },
		]);
		const worker = rollup.perRole.find(r => r.role === "worker")!;
		expect(worker.count).toBe(1);
		expect(rollup.totals.count).toBe(1);
	});

	test("perRole order matches TELEMETRY_ROLES order", () => {
		const rollup = rollupTelemetry([]);
		expect(rollup.perRole.map(r => r.role)).toEqual([...TELEMETRY_ROLES]);
	});
});

describe("taskRecordToSample", () => {
	test("worker role for regular feature", () => {
		const s = taskRecordToSample(task());
		expect(s.role).toBe("worker");
		expect(s.durationMs).toBe(2000);
	});

	test("fix_worker role when isFixFeature is set", () => {
		const s = taskRecordToSample(task({ isFixFeature: true }));
		expect(s.role).toBe("fix_worker");
	});

	test("zero duration when timestamps incomplete", () => {
		expect(taskRecordToSample(task({ startedAt: null, endedAt: null })).durationMs).toBe(0);
		expect(taskRecordToSample(task({ endedAt: null })).durationMs).toBe(0);
	});

	test("clamps negative duration to zero", () => {
		expect(taskRecordToSample(task({ startedAt: 100, endedAt: 50 })).durationMs).toBe(0);
	});
});

describe("rollupBatchState", () => {
	test("classifies tasks by fix-feature flag", () => {
		const rollup = rollupBatchState(
			mkState({
				tasks: [
					task({ taskId: "T-001", startedAt: 0, endedAt: 1000 }),
					task({ taskId: "FIX-001-001", startedAt: 1000, endedAt: 1500, isFixFeature: true }),
				],
			}),
		);
		expect(rollup.perRole.find(r => r.role === "worker")?.count).toBe(1);
		expect(rollup.perRole.find(r => r.role === "fix_worker")?.count).toBe(1);
	});

	test("uses diagnostics.taskExits for cost + duration when present", () => {
		const rollup = rollupBatchState(
			mkState({
				tasks: [task({ taskId: "T-001" })],
				diagnostics: {
					taskExits: {
						"T-001": { classification: "completed", cost: 0.25, durationSec: 60 },
					},
					batchCost: 0.25,
				},
			}),
		);
		const worker = rollup.perRole.find(r => r.role === "worker")!;
		expect(worker.durationMs).toBe(60_000);
		expect(worker.costUsd).toBe(0.25);
	});

	test("appends extra samples (orchestrator + validators) on top of task-derived samples", () => {
		const rollup = rollupBatchState(mkState({ tasks: [task({ taskId: "T-001" })] }), [
			sample("scrutiny_validator", { durationMs: 100 }),
			sample("user_testing_validator", { durationMs: 200 }),
			sample("orchestrator", { durationMs: 50 }),
		]);
		expect(rollup.perRole.find(r => r.role === "worker")?.count).toBe(1);
		expect(rollup.perRole.find(r => r.role === "scrutiny_validator")?.count).toBe(1);
		expect(rollup.perRole.find(r => r.role === "user_testing_validator")?.count).toBe(1);
		expect(rollup.perRole.find(r => r.role === "orchestrator")?.count).toBe(1);
		expect(rollup.totals.count).toBe(4);
	});
});

describe("bucketDurations", () => {
	test("applies default buckets to a mix of durations", () => {
		const buckets = bucketDurations([5_000, 30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 5 * 60 * 60_000]);
		expect(buckets.map(b => b.count)).toEqual([1, 1, 1, 1, 1, 1]);
		expect(buckets.map(b => b.label)).toEqual(DEFAULT_DURATION_BUCKETS.map(b => b.label));
	});

	test("last bucket catches all values past the max edge", () => {
		const buckets = bucketDurations([10 * 60 * 60_000, 24 * 60 * 60_000]);
		expect(buckets[buckets.length - 1]?.count).toBe(2);
	});

	test("negative / non-finite durations are dropped", () => {
		const buckets = bucketDurations([-1, Number.NaN, Number.POSITIVE_INFINITY, 5_000]);
		expect(buckets[0]?.count).toBe(1);
		expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(1);
	});

	test("custom buckets honored", () => {
		const custom = [
			{ lower: 0, upper: 100, label: "short" },
			{ lower: 100, upper: Number.POSITIVE_INFINITY, label: "long" },
		];
		const buckets = bucketDurations([50, 200, 300], custom);
		expect(buckets[0]?.count).toBe(1);
		expect(buckets[1]?.count).toBe(2);
	});
});

describe("extractDurations", () => {
	test("filters zero-duration samples", () => {
		const durations = extractDurations([
			sample("worker", { durationMs: 100 }),
			sample("worker", { durationMs: 0 }),
			sample("worker", { durationMs: 200 }),
		]);
		expect(durations).toEqual([100, 200]);
	});
});
