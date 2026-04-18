/**
 * Unit tests for `detachEngineRun` terminal-path sequencing.
 *
 * Asserts:
 *  - successful engineFn → updateWidget → onTerminal (exactly once)
 *  - rejected engineFn → phase=failed + endedAt + errors push + notify(error) → updateWidget → onTerminal
 *  - rejection when batch already `completed` → does NOT overwrite phase or endedAt
 *  - non-Error thrown value → coerced via String()
 */

import { describe, expect, test } from "bun:test";

import { detachEngineRun, type NotifyLevel } from "../src/missioncontrol/extension-async";
import { freshMissionBatchState, type MissionBatchPhase } from "../src/missioncontrol/types";

function nextTick(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

interface NotifyCall {
	message: string;
	level: NotifyLevel;
}

describe("detachEngineRun", () => {
	test("success path: updateWidget → onTerminal (each exactly once)", async () => {
		const batch = freshMissionBatchState();
		batch.batchId = "20260417T101010";
		const order: string[] = [];
		let widgetCount = 0;
		let terminalCount = 0;

		detachEngineRun({
			engineFn: async () => {
				order.push("engine");
			},
			batchState: batch,
			notify: () => order.push("notify"),
			updateWidget: () => {
				widgetCount += 1;
				order.push("widget");
			},
			onTerminal: () => {
				terminalCount += 1;
				order.push("terminal");
			},
		});

		await nextTick();
		await nextTick();

		expect(widgetCount).toBe(1);
		expect(terminalCount).toBe(1);
		expect(order).toEqual(["engine", "widget", "terminal"]);
		expect(batch.phase).toBe("idle");
		expect(batch.errors).toEqual([]);
	});

	test("detaches synchronously — caller returns before engineFn runs", () => {
		const batch = freshMissionBatchState();
		let started = false;

		detachEngineRun({
			engineFn: async () => {
				started = true;
			},
			batchState: batch,
			notify: () => {},
			updateWidget: () => {},
		});

		expect(started).toBe(false);
	});

	test("rejection path: marks failed + notifies + widget + terminal", async () => {
		const batch = freshMissionBatchState();
		batch.batchId = "20260417T101010";
		batch.phase = "executing" as MissionBatchPhase;
		const notifyCalls: NotifyCall[] = [];
		let widgetCount = 0;
		let terminalCount = 0;

		detachEngineRun({
			engineFn: async () => {
				throw new Error("boom");
			},
			batchState: batch,
			notify: (message, level) => notifyCalls.push({ message, level }),
			updateWidget: () => {
				widgetCount += 1;
			},
			onTerminal: () => {
				terminalCount += 1;
			},
		});

		await nextTick();
		await nextTick();

		expect(batch.phase).toBe("failed");
		expect(batch.endedAt).not.toBeNull();
		expect(batch.errors).toEqual(["Unhandled engine error: boom"]);
		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0].level).toBe("error");
		expect(notifyCalls[0].message).toContain("boom");
		expect(notifyCalls[0].message).toContain(batch.batchId);
		expect(widgetCount).toBe(1);
		expect(terminalCount).toBe(1);
	});

	test("rejection when already completed: does not overwrite phase or endedAt", async () => {
		const batch = freshMissionBatchState();
		batch.phase = "completed" as MissionBatchPhase;
		batch.endedAt = 12345;
		batch.errors.push("prior");

		detachEngineRun({
			engineFn: async () => {
				throw new Error("late failure");
			},
			batchState: batch,
			notify: () => {},
			updateWidget: () => {},
		});

		await nextTick();
		await nextTick();

		expect(batch.phase).toBe("completed");
		expect(batch.endedAt).toBe(12345);
		expect(batch.errors).toEqual(["prior"]);
	});

	test("rejection when already failed: does not push duplicate error", async () => {
		const batch = freshMissionBatchState();
		batch.phase = "failed" as MissionBatchPhase;
		batch.endedAt = 999;
		batch.errors.push("first");

		detachEngineRun({
			engineFn: async () => {
				throw new Error("second");
			},
			batchState: batch,
			notify: () => {},
			updateWidget: () => {},
		});

		await nextTick();
		await nextTick();

		expect(batch.phase).toBe("failed");
		expect(batch.endedAt).toBe(999);
		expect(batch.errors).toEqual(["first"]);
	});

	test("non-Error rejection coerced via String()", async () => {
		const batch = freshMissionBatchState();
		const notifyCalls: NotifyCall[] = [];

		detachEngineRun({
			engineFn: async () => {
				throw "stringy";
			},
			batchState: batch,
			notify: (message, level) => notifyCalls.push({ message, level }),
			updateWidget: () => {},
		});

		await nextTick();
		await nextTick();

		expect(batch.errors).toEqual(["Unhandled engine error: stringy"]);
		expect(notifyCalls[0].message).toContain("stringy");
	});

	test("onTerminal is optional on success", async () => {
		const batch = freshMissionBatchState();
		let widgetCount = 0;

		detachEngineRun({
			engineFn: async () => {},
			batchState: batch,
			notify: () => {},
			updateWidget: () => {
				widgetCount += 1;
			},
		});

		await nextTick();
		await nextTick();

		expect(widgetCount).toBe(1);
	});

	test("onTerminal is optional on rejection", async () => {
		const batch = freshMissionBatchState();
		let widgetCount = 0;
		const notifyCalls: NotifyCall[] = [];

		detachEngineRun({
			engineFn: async () => {
				throw new Error("x");
			},
			batchState: batch,
			notify: (message, level) => notifyCalls.push({ message, level }),
			updateWidget: () => {
				widgetCount += 1;
			},
		});

		await nextTick();
		await nextTick();

		expect(widgetCount).toBe(1);
		expect(notifyCalls).toHaveLength(1);
	});
});
