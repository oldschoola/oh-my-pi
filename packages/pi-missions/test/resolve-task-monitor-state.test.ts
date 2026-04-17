/**
 * Tests for `resolveTaskMonitorState` ported from taskplane `execution.ts:807`.
 *
 * Each case exercises one priority branch:
 *   1. .DONE file → succeeded
 *   2. STATUS.md quiet beyond stallTimeoutMs → stalled + kill
 *   3. session dead without .DONE → failed
 *   4. alive → running
 *
 * V2 backend special cases:
 *   - startup grace: stale snapshot + young tracker → alive
 *   - ghost-worker fast-fail (TP-159): current snapshot but dead PID → dead
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MtimeTracker, ParsedWorktreeStatus, RuntimeAgentManifest, RuntimeRegistry } from "../src/missioncontrol";
import { resolveTaskMonitorState, setV2LivenessRegistryCache, writeLaneSnapshot } from "../src/missioncontrol";

function tracker(overrides: Partial<MtimeTracker> = {}): MtimeTracker {
	return {
		taskId: "TP-1",
		firstObservedAt: Date.now(),
		statusFileSeenOnce: false,
		lastMtime: null,
		stallTimerStart: null,
		...overrides,
	};
}

function manifest(overrides: Partial<RuntimeAgentManifest>): RuntimeAgentManifest {
	return {
		batchId: "b-1",
		agentId: "mission-b-1-lane-1-worker",
		role: "worker",
		laneNumber: 1,
		taskId: "TP-1",
		repoId: "default",
		pid: process.pid,
		parentPid: process.ppid || 1,
		startedAt: Date.now(),
		status: "running",
		cwd: process.cwd(),
		packet: null,
		...overrides,
	};
}

function registry(agents: Record<string, RuntimeAgentManifest>): RuntimeRegistry {
	return { batchId: "b-1", updatedAt: Date.now(), agents };
}

function parsed(mtime: number, stepCount = 2): ParsedWorktreeStatus {
	const steps: ParsedWorktreeStatus["steps"] = [];
	for (let i = 1; i <= stepCount; i++) {
		steps.push({
			number: i,
			name: `Step ${i}`,
			status: i === 1 ? "in-progress" : "not-started",
			totalChecked: 0,
			totalItems: 3,
		});
	}
	return { steps, reviewCounter: 0, iteration: 1, mtime };
}

let _tmpDir: string | null = null;

function makeStateRoot(label: string): string {
	_tmpDir = mkdtempSync(join(tmpdir(), `mc-monitor-${label}-`));
	return _tmpDir;
}

afterEach(() => {
	setV2LivenessRegistryCache(null);
	if (_tmpDir) {
		rmSync(_tmpDir, { recursive: true, force: true });
		_tmpDir = null;
	}
});

describe("resolveTaskMonitorState", () => {
	test("priority 1: .DONE file present → succeeded", async () => {
		const stateRoot = makeStateRoot("done");
		const donePath = join(stateRoot, "TP-1.DONE");
		mkdirSync(stateRoot, { recursive: true });
		writeFileSync(donePath, "");

		setV2LivenessRegistryCache(registry({ "mission-b-1-lane-1-worker": manifest({}) }));
		const now = Date.now();
		const t = tracker({ firstObservedAt: now - 120_000 });

		const snap = await resolveTaskMonitorState(
			"TP-1",
			donePath,
			"mission-b-1-lane-1",
			{ parsed: parsed(now - 5_000), error: null },
			t,
			60_000,
			now,
		);

		expect(snap.status).toBe("succeeded");
		expect(snap.doneFileFound).toBe(true);
		expect(snap.taskId).toBe("TP-1");
	});

	test("priority 2: stall timeout + kill → stalled", async () => {
		// Use v2 snapshot path so sessionAlive is derived from snap.status ("running"),
		// not the registry — that keeps killV2LaneAgents from touching a real PID when
		// the stall branch invokes it. Registry cache is left null so the killer no-ops.
		const stateRoot = makeStateRoot("stall");
		const donePath = join(stateRoot, "absent.DONE");
		const now = Date.now();
		writeLaneSnapshot(stateRoot, "b-1", 1, {
			taskId: "TP-1",
			status: "running",
			updatedAt: now - 1_000,
		});

		setV2LivenessRegistryCache(null);
		const mtime = now - 300_000;
		const stallStart = now - 120_000;
		const t = tracker({
			firstObservedAt: now - 300_000,
			statusFileSeenOnce: true,
			lastMtime: mtime,
			stallTimerStart: stallStart,
		});

		const snap = await resolveTaskMonitorState(
			"TP-1",
			donePath,
			"mission-b-1-lane-1",
			{ parsed: parsed(mtime), error: null },
			t,
			60_000,
			now,
			"v2",
			{ stateRoot, batchId: "b-1", laneNumber: 1 },
		);

		expect(snap.status).toBe("stalled");
		expect(snap.sessionAlive).toBe(false);
		expect(snap.stallReason).toMatch(/STATUS\.md unchanged for \d+ minutes/);
	});

	test("priority 3: registry says dead → failed (legacy branch)", async () => {
		const stateRoot = makeStateRoot("dead");
		const donePath = join(stateRoot, "absent.DONE");

		setV2LivenessRegistryCache(registry({ "mission-b-1-lane-1-worker": manifest({ status: "exited" }) }));
		const now = Date.now();
		const t = tracker({ firstObservedAt: now - 90_000, statusFileSeenOnce: true, lastMtime: now - 30_000 });

		const snap = await resolveTaskMonitorState(
			"TP-1",
			donePath,
			"mission-b-1-lane-1",
			{ parsed: parsed(now - 30_000), error: null },
			t,
			600_000,
			now,
			// no runtimeBackend → legacy branch uses isV2AgentAlive fallback
		);

		expect(snap.status).toBe("failed");
		expect(snap.sessionAlive).toBe(false);
	});

	test("priority 4: alive worker, recent mtime → running (legacy)", async () => {
		const stateRoot = makeStateRoot("run");
		const donePath = join(stateRoot, "absent.DONE");

		setV2LivenessRegistryCache(registry({ "mission-b-1-lane-1-worker": manifest({}) }));
		const now = Date.now();
		const t = tracker({ firstObservedAt: now - 10_000 });

		const snap = await resolveTaskMonitorState(
			"TP-1",
			donePath,
			"mission-b-1-lane-1",
			{ parsed: parsed(now - 1_000), error: null },
			t,
			60_000,
			now,
		);

		expect(snap.status).toBe("running");
		expect(snap.sessionAlive).toBe(true);
		expect(snap.currentStepName).toBe("Step 1");
		expect(t.statusFileSeenOnce).toBe(true);
		expect(t.lastMtime).toBe(now - 1_000);
	});

	test("v2 snapshot status:running + matching taskId → running", async () => {
		const stateRoot = makeStateRoot("v2run");
		const donePath = join(stateRoot, "absent.DONE");
		writeLaneSnapshot(stateRoot, "b-1", 1, {
			taskId: "TP-1",
			status: "running",
			updatedAt: Date.now(),
		});

		setV2LivenessRegistryCache(registry({ "mission-b-1-lane-1-worker": manifest({}) }));
		const now = Date.now();
		const t = tracker({ firstObservedAt: now - 2_000 });

		const snap = await resolveTaskMonitorState(
			"TP-1",
			donePath,
			"mission-b-1-lane-1",
			{ parsed: parsed(now - 500), error: null },
			t,
			60_000,
			now,
			"v2",
			{ stateRoot, batchId: "b-1", laneNumber: 1 },
		);

		expect(snap.status).toBe("running");
		expect(snap.sessionAlive).toBe(true);
	});

	test("v2 startup grace: stale snapshot + young tracker → still alive", async () => {
		const stateRoot = makeStateRoot("grace");
		const donePath = join(stateRoot, "absent.DONE");
		const now = Date.now();
		// Snapshot belongs to a prior task and is 40s stale (>30s), but tracker is <60s old.
		writeLaneSnapshot(stateRoot, "b-1", 1, {
			taskId: "TP-PRIOR",
			status: "exited",
			updatedAt: now - 40_000,
		});

		// Registry says worker is dead — startup grace must ignore it.
		setV2LivenessRegistryCache(registry({ "mission-b-1-lane-1-worker": manifest({ status: "exited" }) }));
		const t = tracker({ firstObservedAt: now - 10_000 });

		const snap = await resolveTaskMonitorState(
			"TP-1",
			donePath,
			"mission-b-1-lane-1",
			{ parsed: parsed(now - 500), error: null },
			t,
			60_000,
			now,
			"v2",
			{ stateRoot, batchId: "b-1", laneNumber: 1 },
		);

		expect(snap.status).toBe("running");
		expect(snap.sessionAlive).toBe(true);
	});

	test("v2 ghost worker: current snapshot stale + dead PID → failed (TP-159)", async () => {
		const stateRoot = makeStateRoot("ghost");
		const donePath = join(stateRoot, "absent.DONE");
		const now = Date.now();
		// Snapshot matches current task but hasn't updated for 35s (> stallTimeout/2 = 30s).
		writeLaneSnapshot(stateRoot, "b-1", 1, {
			taskId: "TP-1",
			status: "running",
			updatedAt: now - 35_000,
		});

		// Registry confirms worker is dead — orphan scan marked it crashed.
		setV2LivenessRegistryCache(registry({ "mission-b-1-lane-1-worker": manifest({ status: "crashed" }) }));
		const t = tracker({ firstObservedAt: now - 120_000, statusFileSeenOnce: true, lastMtime: now - 60_000 });

		const snap = await resolveTaskMonitorState(
			"TP-1",
			donePath,
			"mission-b-1-lane-1",
			{ parsed: parsed(now - 60_000), error: null },
			t,
			60_000,
			now,
			"v2",
			{ stateRoot, batchId: "b-1", laneNumber: 1 },
		);

		expect(snap.status).toBe("failed");
		expect(snap.sessionAlive).toBe(false);
	});

	test("mtime tracker resets stall timer when mtime advances", async () => {
		const stateRoot = makeStateRoot("mtime");
		const donePath = join(stateRoot, "absent.DONE");

		setV2LivenessRegistryCache(registry({ "mission-b-1-lane-1-worker": manifest({}) }));
		const now = Date.now();
		const t = tracker({
			firstObservedAt: now - 10_000,
			statusFileSeenOnce: true,
			lastMtime: now - 30_000,
			stallTimerStart: now - 20_000,
		});

		// New mtime → timer should reset to null.
		await resolveTaskMonitorState(
			"TP-1",
			donePath,
			"mission-b-1-lane-1",
			{ parsed: parsed(now - 1_000), error: null },
			t,
			60_000,
			now,
		);

		expect(t.lastMtime).toBe(now - 1_000);
		expect(t.stallTimerStart).toBeNull();
	});

	test("mtime tracker arms stall timer when mtime unchanged", async () => {
		const stateRoot = makeStateRoot("arm");
		const donePath = join(stateRoot, "absent.DONE");

		setV2LivenessRegistryCache(registry({ "mission-b-1-lane-1-worker": manifest({}) }));
		const now = Date.now();
		const mtime = now - 30_000;
		const t = tracker({
			firstObservedAt: now - 10_000,
			statusFileSeenOnce: true,
			lastMtime: mtime,
			stallTimerStart: null,
		});

		await resolveTaskMonitorState(
			"TP-1",
			donePath,
			"mission-b-1-lane-1",
			{ parsed: parsed(mtime), error: null },
			t,
			60_000,
			now,
		);

		expect(t.stallTimerStart).toBe(now);
	});
});
