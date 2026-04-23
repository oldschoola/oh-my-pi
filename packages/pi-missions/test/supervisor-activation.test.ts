/**
 * Tests for `activateSupervisor` / `deactivateSupervisor` — the lockfile
 * + heartbeat pair that flips the dashboard's SupervisorPanel from
 * "inactive" to "active". The heartbeat cadence is verified by stubbing
 * `setInterval` so the test doesn't have to wait 30s.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	activateSupervisor,
	deactivateSupervisor,
	isLockStale,
	lockfilePath,
	readLockfile,
} from "../src/missioncontrol/supervisor";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-supervisor-activate-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

describe("activateSupervisor", () => {
	test("writes a readable lockfile pinned to the current process", () => {
		const handle = activateSupervisor(sandbox, "batch-001");
		try {
			const lock = readLockfile(sandbox);
			expect(lock).not.toBeNull();
			expect(lock?.batchId).toBe("batch-001");
			expect(lock?.pid).toBe(process.pid);
			expect(lock?.sessionId).toBe(handle.sessionId);
			expect(lock?.heartbeat).toBe(lock?.startedAt);
			expect(isLockStale(lock!)).toBe(false);
		} finally {
			deactivateSupervisor(handle, sandbox);
		}
	});

	test("returns a handle whose sessionId encodes the current pid", () => {
		const handle = activateSupervisor(sandbox, "batch-002");
		try {
			expect(handle.batchId).toBe("batch-002");
			expect(handle.stateRoot).toBe(sandbox);
			expect(handle.sessionId).toContain(`-${process.pid}`);
		} finally {
			deactivateSupervisor(handle, sandbox);
		}
	});

	test("heartbeat refresh advances the heartbeat timestamp", async () => {
		// Capture the interval callback by stubbing setInterval — we invoke
		// it manually instead of waiting 30 s for the real timer.
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		const capturedRef: { fn: (() => void) | null } = { fn: null };
		const fakeTimer = { unref: () => {} };
		globalThis.setInterval = ((fn: () => void) => {
			capturedRef.fn = fn;
			return fakeTimer as unknown as NodeJS.Timeout;
		}) as typeof setInterval;
		globalThis.clearInterval = (() => {}) as typeof clearInterval;

		try {
			const handle = activateSupervisor(sandbox, "batch-003");
			const first = readLockfile(sandbox);
			expect(first).not.toBeNull();

			// Sleep a tick so the new heartbeat string differs from the start
			// timestamp (ISO second resolution is enough at the 10 ms scale).
			await new Promise(r => setTimeout(r, 15));
			expect(capturedRef.fn).not.toBeNull();
			capturedRef.fn?.();

			const second = readLockfile(sandbox);
			expect(second).not.toBeNull();
			expect(second?.startedAt).toBe(first?.startedAt);
			expect(second?.heartbeat).not.toBe(first?.heartbeat);
			expect(Date.parse(second?.heartbeat ?? "")).toBeGreaterThanOrEqual(Date.parse(first?.heartbeat ?? ""));

			deactivateSupervisor(handle, sandbox);
		} finally {
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});
});

describe("deactivateSupervisor", () => {
	test("removes the lockfile and stops the heartbeat", () => {
		const handle = activateSupervisor(sandbox, "batch-010");
		expect(existsSync(lockfilePath(sandbox))).toBe(true);

		deactivateSupervisor(handle, sandbox);

		expect(existsSync(lockfilePath(sandbox))).toBe(false);
		// Second call is a no-op (handle already stopped); must not throw.
		deactivateSupervisor(handle, sandbox);
	});

	test("tolerates a null handle (no-op teardown)", () => {
		// Missing lockfile is fine — nothing to remove.
		expect(() => deactivateSupervisor(null, sandbox)).not.toThrow();
		expect(existsSync(lockfilePath(sandbox))).toBe(false);
	});
});
