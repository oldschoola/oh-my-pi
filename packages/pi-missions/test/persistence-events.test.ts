/**
 * Tests for Tier 0 + engine event emission in
 * `missioncontrol/persistence.ts`.
 *
 * Validates:
 *  • `buildTier0EventBase` / `buildEngineEventBase` shape + ISO timestamp
 *  • `emitTier0Event` creates `.omp/supervisor/events.jsonl` and appends JSONL
 *  • `emitEngineEvent` appends to the same file and invokes callback
 *  • Both emitters are best-effort — they never throw on write failure
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { supervisorEventsPath } from "../src/missioncontrol/adapter";
import {
	buildEngineEventBase,
	buildTier0EventBase,
	emitEngineEvent,
	emitTier0Event,
} from "../src/missioncontrol/persistence";
import type { EngineEvent, Tier0Event } from "../src/missioncontrol/types";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "omp-events-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function readEvents(cwd: string): unknown[] {
	const raw = readFileSync(supervisorEventsPath(cwd), "utf-8").trim();
	return raw ? raw.split("\n").map(line => JSON.parse(line)) : [];
}

describe("buildTier0EventBase", () => {
	test("returns the six uniform header fields with an ISO timestamp", () => {
		const base = buildTier0EventBase("tier0_recovery_attempt", "b-1", 2, "worker_crash", 1, 3);
		expect(base.type).toBe("tier0_recovery_attempt");
		expect(base.batchId).toBe("b-1");
		expect(base.waveIndex).toBe(2);
		expect(base.pattern).toBe("worker_crash");
		expect(base.attempt).toBe(1);
		expect(base.maxAttempts).toBe(3);
		// ISO 8601 round-trip
		expect(new Date(base.timestamp).toISOString()).toBe(base.timestamp);
	});

	test("accepts merge_timeout escalation pattern", () => {
		const base = buildTier0EventBase("tier0_escalation", "b-2", 0, "merge_timeout", 2, 2);
		expect(base.pattern).toBe("merge_timeout");
	});
});

describe("buildEngineEventBase", () => {
	test("returns the five uniform header fields with an ISO timestamp", () => {
		const base = buildEngineEventBase("wave_start", "b-99", 0, "executing");
		expect(base.type).toBe("wave_start");
		expect(base.batchId).toBe("b-99");
		expect(base.waveIndex).toBe(0);
		expect(base.phase).toBe("executing");
		expect(new Date(base.timestamp).toISOString()).toBe(base.timestamp);
	});
});

describe("emitTier0Event", () => {
	test("creates .omp/supervisor dir and appends a single JSONL line", async () => {
		const event: Tier0Event = {
			...buildTier0EventBase("tier0_recovery_attempt", "b-1", 0, "stale_worktree", 1, 1),
			taskId: "T-42",
			cooldownMs: 2_000,
		};

		await emitTier0Event(tmp, event);

		const entries = readEvents(tmp);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			type: "tier0_recovery_attempt",
			batchId: "b-1",
			pattern: "stale_worktree",
			taskId: "T-42",
			cooldownMs: 2_000,
		});
	});

	test("appends successive events as separate JSONL lines", async () => {
		await emitTier0Event(tmp, {
			...buildTier0EventBase("tier0_recovery_attempt", "b-1", 0, "worker_crash", 1, 1),
		});
		await emitTier0Event(tmp, {
			...buildTier0EventBase("tier0_recovery_success", "b-1", 0, "worker_crash", 1, 1),
			resolution: "retried and completed",
		});

		const entries = readEvents(tmp);
		expect(entries).toHaveLength(2);
		expect((entries[0] as Tier0Event).type).toBe("tier0_recovery_attempt");
		expect((entries[1] as Tier0Event).type).toBe("tier0_recovery_success");
	});

	test("carries escalation payload verbatim", async () => {
		const event: Tier0Event = {
			...buildTier0EventBase("tier0_escalation", "b-1", 0, "merge_timeout", 2, 2),
			escalation: {
				pattern: "merge_timeout",
				attempts: 2,
				maxAttempts: 2,
				lastError: "merge locked by another lane",
				affectedTasks: ["T-1", "T-2"],
				suggestion: "inspect locked worktree",
			},
		};
		await emitTier0Event(tmp, event);
		const [e] = readEvents(tmp) as [Tier0Event];
		expect(e.escalation?.affectedTasks).toEqual(["T-1", "T-2"]);
		expect(e.escalation?.suggestion).toBe("inspect locked worktree");
	});

	test("never throws on write failure — logs and returns", async () => {
		// Simulate by pointing at a path where supervisor/ cannot be created.
		// Creating a FILE at the `.omp/` location makes mkdir + appendFile fail.
		await Bun.write(join(tmp, ".omp"), "blocker");

		const event: Tier0Event = {
			...buildTier0EventBase("tier0_recovery_attempt", "b-1", 0, "worker_crash", 1, 1),
		};
		// Must resolve (not throw)
		await expect(emitTier0Event(tmp, event)).resolves.toBeUndefined();
	});
});

describe("emitEngineEvent", () => {
	test("appends to the same events.jsonl file and invokes callback", async () => {
		const seen: EngineEvent[] = [];
		const event: EngineEvent = {
			...buildEngineEventBase("task_complete", "b-1", 0, "executing"),
			taskId: "T-7",
			durationMs: 12_345,
			outcome: "success",
		};

		await emitEngineEvent(tmp, event, e => seen.push(e));

		const entries = readEvents(tmp);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			type: "task_complete",
			taskId: "T-7",
			durationMs: 12_345,
		});
		expect(seen).toEqual([event]);
	});

	test("interleaves cleanly with tier0 events in the same file", async () => {
		await emitTier0Event(tmp, {
			...buildTier0EventBase("tier0_recovery_attempt", "b-1", 0, "worker_crash", 1, 1),
		});
		await emitEngineEvent(tmp, {
			...buildEngineEventBase("wave_start", "b-1", 0, "executing"),
			taskIds: ["T-1", "T-2"],
			laneCount: 2,
		});

		const entries = readEvents(tmp) as Array<{ type: string }>;
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("tier0_recovery_attempt");
		expect(entries[1].type).toBe("wave_start");
	});

	test("works without a callback", async () => {
		await emitEngineEvent(tmp, {
			...buildEngineEventBase("batch_complete", "b-1", -1, "completed"),
			succeededTasks: 3,
			failedTasks: 0,
			skippedTasks: 0,
			blockedTasks: 0,
			batchDurationMs: 120_000,
		});
		expect(readEvents(tmp)).toHaveLength(1);
	});

	test("swallows callback exceptions — write still succeeds", async () => {
		const event: EngineEvent = {
			...buildEngineEventBase("batch_paused", "b-1", 0, "paused"),
			reason: "manual pause",
		};

		await expect(
			emitEngineEvent(tmp, event, () => {
				throw new Error("boom");
			}),
		).resolves.toBeUndefined();

		expect(readEvents(tmp)).toHaveLength(1);
	});

	test("never throws on write failure", async () => {
		await Bun.write(join(tmp, ".omp"), "blocker");
		const event: EngineEvent = {
			...buildEngineEventBase("wave_start", "b-1", 0, "executing"),
		};
		await expect(emitEngineEvent(tmp, event)).resolves.toBeUndefined();
	});
});
