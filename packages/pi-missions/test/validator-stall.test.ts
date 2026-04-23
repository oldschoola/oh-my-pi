/**
 * Unit tests for Track H2 validator stall + heartbeat helpers.
 */

import { describe, expect, test } from "bun:test";

import {
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	DEFAULT_VALIDATOR_STALL_TIMEOUT_MS,
	elapsedDays,
	heartbeatAgeMs,
	idleSinceLabel,
	isHeartbeatStale,
	withStallTimeout,
} from "../src/missioncontrol";

describe("withStallTimeout", () => {
	test("resolves with completed when promise finishes first", async () => {
		const outcome = await withStallTimeout({
			promise: Promise.resolve("done"),
			timeoutMs: 1000,
		});
		expect(outcome.kind).toBe("completed");
		if (outcome.kind === "completed") expect(outcome.value).toBe("done");
	});

	test("resolves with stalled when timer fires first", async () => {
		let stallCallbackFired = false;
		const slow = new Promise<string>(resolve => setTimeout(() => resolve("late"), 200));
		const outcome = await withStallTimeout({
			promise: slow,
			timeoutMs: 10,
			onStall: () => {
				stallCallbackFired = true;
			},
		});
		expect(outcome.kind).toBe("stalled");
		if (outcome.kind === "stalled") expect(outcome.timeoutMs).toBe(10);
		expect(stallCallbackFired).toBe(true);
	});

	test("resolves with aborted when signal fires first", async () => {
		const controller = new AbortController();
		const slow = new Promise<string>(resolve => setTimeout(() => resolve("late"), 500));
		const promise = withStallTimeout({
			promise: slow,
			timeoutMs: 1_000,
			signal: controller.signal,
		});
		controller.abort("operator cancel");
		const outcome = await promise;
		expect(outcome.kind).toBe("aborted");
		if (outcome.kind === "aborted") expect(outcome.reason).toBe("operator cancel");
	});

	test("pre-aborted signal short-circuits immediately", async () => {
		const controller = new AbortController();
		controller.abort();
		const outcome = await withStallTimeout({
			promise: new Promise(() => {}),
			timeoutMs: 10_000,
			signal: controller.signal,
		});
		expect(outcome.kind).toBe("aborted");
	});

	test("timeout 0 disables the timer (never stalls)", async () => {
		const outcome = await withStallTimeout({
			promise: Promise.resolve("ok"),
			timeoutMs: 0,
		});
		expect(outcome.kind).toBe("completed");
	});

	test("promise rejection is reported as completed (caller inspects value)", async () => {
		const err = new Error("boom");
		const outcome = await withStallTimeout({
			promise: Promise.reject(err),
			timeoutMs: 500,
		});
		expect(outcome.kind).toBe("completed");
		if (outcome.kind === "completed") expect(outcome.value).toBe(err);
	});

	test("DEFAULT_VALIDATOR_STALL_TIMEOUT_MS is 2h", () => {
		expect(DEFAULT_VALIDATOR_STALL_TIMEOUT_MS).toBe(2 * 60 * 60 * 1000);
	});
});

describe("heartbeatAgeMs", () => {
	test("computes positive ages", () => {
		expect(heartbeatAgeMs(1000, 2000)).toBe(1000);
	});

	test("clamps future timestamps to 0", () => {
		expect(heartbeatAgeMs(5000, 1000)).toBe(0);
	});

	test("returns Infinity for non-finite input", () => {
		expect(heartbeatAgeMs(Number.NaN, 1000)).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("isHeartbeatStale", () => {
	test("fresh heartbeat within one interval is not stale", () => {
		const now = 100_000;
		expect(isHeartbeatStale(now - DEFAULT_HEARTBEAT_INTERVAL_MS, now)).toBe(false);
	});

	test("heartbeat >3x interval is stale", () => {
		const now = 1_000_000;
		expect(isHeartbeatStale(now - DEFAULT_HEARTBEAT_INTERVAL_MS * 4, now)).toBe(true);
	});

	test("custom interval honoured", () => {
		expect(isHeartbeatStale(0, 10_000, 1_000)).toBe(true);
		expect(isHeartbeatStale(9_500, 10_000, 5_000)).toBe(false);
	});

	test("missing timestamp is always stale", () => {
		expect(isHeartbeatStale(Number.NaN, 1000)).toBe(true);
	});
});

describe("idleSinceLabel", () => {
	test("renders seconds for <1 minute", () => {
		expect(idleSinceLabel(1_000, 11_000)).toBe("10s");
	});

	test("renders minutes up to 1h", () => {
		expect(idleSinceLabel(0, 30 * 60_000)).toBe("30m");
	});

	test("renders hours up to 24h", () => {
		expect(idleSinceLabel(0, 5 * 60 * 60_000)).toBe("5h");
	});

	test("renders days for >24h", () => {
		expect(idleSinceLabel(0, 3 * 24 * 60 * 60_000)).toBe("3d");
	});

	test("reports unknown for non-finite input", () => {
		expect(idleSinceLabel(Number.NaN, 1000)).toBe("unknown");
	});
});

describe("elapsedDays", () => {
	test("rounds down whole days", () => {
		expect(elapsedDays(1, 1 + 2.5 * 24 * 60 * 60_000)).toBe(2);
	});

	test("zero for missing / invalid input", () => {
		expect(elapsedDays(0, 1000)).toBe(0);
		expect(elapsedDays(Number.NaN, 1000)).toBe(0);
	});

	test("clamps negative to zero", () => {
		expect(elapsedDays(5000, 1000)).toBe(0);
	});
});
