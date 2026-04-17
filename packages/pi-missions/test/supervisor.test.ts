/**
 * Tests for `missioncontrol/supervisor.ts` pure helpers.
 *
 * Covers the decision matrix for confirmations, audit-trail round-trip,
 * lockfile (sync + async) semantics, branch/integration plan helpers,
 * event tailer primitives (byte reader, JSONL parser, digest buffer,
 * notification formatter, dispatch), and the pure batch summary
 * collection + markdown rendering.
 *
 * All filesystem work is scoped to temp dirs; all `gh` / git network
 * paths are exercised via `protectionOverride` so tests stay offline.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AuditTrailEntry,
	EventTailerState,
	MissionBatchRuntimeState,
	ParsedSupervisorEvent,
	SupervisorLockfile,
} from "../src/missioncontrol";
import {
	ACTION_CLASSIFICATION_EXAMPLES,
	appendAuditEntry,
	auditTrailPath,
	bufferDigestEvent,
	buildIntegrationPlan,
	collectBatchSummaryData,
	DEFAULT_SUPERVISOR_CONFIG,
	DIGEST_SUPERVISOR_EVENT_TYPES,
	formatBatchSummary,
	formatDurationMs,
	formatEventNotification,
	formatIntegrationOutcome,
	formatIntegrationPlan,
	formatTaskDigest,
	freshDigestBuffer,
	freshEventTailerState,
	freshMissionBatchState,
	freshSupervisorState,
	isBatchTerminal,
	isDigestEmpty,
	isLockStale,
	isSupervisorProcessAlive,
	lockfilePath,
	logRecoveryAction,
	parseJsonlLines,
	processEvents,
	readAuditTrail,
	readLockfile,
	readLockfileAsync,
	readNewBytes,
	readNewBytesAsync,
	readTier0EventsForBatch,
	removeLockfile,
	requiresConfirmation,
	resolveSupervisorConfig,
	SIGNIFICANT_SUPERVISOR_EVENT_TYPES,
	STALE_LOCK_THRESHOLD_MS,
	shouldNotify,
	TERMINAL_BATCH_PHASES,
	writeLockfile,
	writeLockfileAsync,
} from "../src/missioncontrol";

function makeTmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function freshLock(overrides: Partial<SupervisorLockfile> = {}): SupervisorLockfile {
	return {
		pid: process.pid,
		sessionId: "sess-1",
		batchId: "b-1",
		startedAt: new Date().toISOString(),
		heartbeat: new Date().toISOString(),
		...overrides,
	};
}

function batchFixture(overrides: Partial<MissionBatchRuntimeState> = {}): MissionBatchRuntimeState {
	const base = freshMissionBatchState();
	return {
		...base,
		batchId: "b-1",
		baseBranch: "main",
		orchBranch: "orch/feature",
		succeededTasks: 2,
		failedTasks: 1,
		totalTasks: 3,
		startedAt: 1_000,
		endedAt: 4_000,
		phase: "completed",
		...overrides,
	};
}

function auditFixture(overrides: Partial<AuditTrailEntry> = {}): AuditTrailEntry {
	return {
		ts: new Date().toISOString(),
		action: "orch_pause",
		classification: "destructive",
		context: "stalled lane 2",
		command: "orch_pause({batchId:'b-1'})",
		result: "success",
		detail: "paused",
		batchId: "b-1",
		...overrides,
	};
}

function parsedEvent(overrides: Partial<ParsedSupervisorEvent> = {}): ParsedSupervisorEvent {
	return {
		timestamp: new Date().toISOString(),
		type: "wave_start",
		batchId: "b-1",
		waveIndex: 0,
		...overrides,
	};
}

// ── requiresConfirmation — full 3×3 decision matrix ─────────────────

describe("requiresConfirmation", () => {
	test("diagnostic never asks, regardless of autonomy", () => {
		expect(requiresConfirmation("diagnostic", "interactive")).toBe(false);
		expect(requiresConfirmation("diagnostic", "supervised")).toBe(false);
		expect(requiresConfirmation("diagnostic", "autonomous")).toBe(false);
	});

	test("tier0_known asks only in interactive", () => {
		expect(requiresConfirmation("tier0_known", "interactive")).toBe(true);
		expect(requiresConfirmation("tier0_known", "supervised")).toBe(false);
		expect(requiresConfirmation("tier0_known", "autonomous")).toBe(false);
	});

	test("destructive asks in interactive and supervised, not autonomous", () => {
		expect(requiresConfirmation("destructive", "interactive")).toBe(true);
		expect(requiresConfirmation("destructive", "supervised")).toBe(true);
		expect(requiresConfirmation("destructive", "autonomous")).toBe(false);
	});

	test("ACTION_CLASSIFICATION_EXAMPLES has all three categories populated", () => {
		expect(ACTION_CLASSIFICATION_EXAMPLES.diagnostic.length).toBeGreaterThan(0);
		expect(ACTION_CLASSIFICATION_EXAMPLES.tier0_known.length).toBeGreaterThan(0);
		expect(ACTION_CLASSIFICATION_EXAMPLES.destructive.length).toBeGreaterThan(0);
	});
});

// ── Audit Trail ─────────────────────────────────────────────────────

describe("audit trail", () => {
	test("appendAuditEntry creates missing directory and writes JSONL line", () => {
		const dir = makeTmp("mc-audit-");
		try {
			appendAuditEntry(dir, auditFixture());
			const raw = readFileSync(auditTrailPath(dir), "utf-8");
			expect(raw.endsWith("\n")).toBe(true);
			const parsed = JSON.parse(raw.trim());
			expect(parsed.action).toBe("orch_pause");
			expect(parsed.batchId).toBe("b-1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("logRecoveryAction fills ts and batchId automatically", () => {
		const dir = makeTmp("mc-audit-");
		try {
			logRecoveryAction(dir, "b-42", {
				action: "git_reset",
				classification: "destructive",
				context: "mid-wave",
				command: "git reset --hard",
				result: "pending",
				detail: "about to reset",
			});
			const entries = readAuditTrail(dir);
			expect(entries).toHaveLength(1);
			expect(entries[0]?.batchId).toBe("b-42");
			expect(entries[0]?.action).toBe("git_reset");
			expect(typeof entries[0]?.ts).toBe("string");
			expect(Number.isNaN(Date.parse(entries[0]?.ts ?? ""))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("readAuditTrail filters by batchId and applies limit as tail", () => {
		const dir = makeTmp("mc-audit-");
		try {
			for (let i = 0; i < 5; i++) {
				appendAuditEntry(dir, auditFixture({ action: `a-${i}`, batchId: i < 3 ? "b-1" : "b-2" }));
			}

			expect(readAuditTrail(dir)).toHaveLength(5);
			expect(readAuditTrail(dir, { batchId: "b-1" }).map(e => e.action)).toEqual(["a-0", "a-1", "a-2"]);
			expect(readAuditTrail(dir, { batchId: "b-2" }).map(e => e.action)).toEqual(["a-3", "a-4"]);
			expect(readAuditTrail(dir, { limit: 2 }).map(e => e.action)).toEqual(["a-3", "a-4"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("readAuditTrail returns empty for missing + malformed lines skip silently", () => {
		const dir = makeTmp("mc-audit-");
		try {
			expect(readAuditTrail(dir)).toEqual([]);

			// Seed one valid entry so the directory exists.
			appendAuditEntry(dir, auditFixture({ action: "prime" }));
			// Overwrite with partial + bogus lines + one valid entry.
			writeFileSync(
				auditTrailPath(dir),
				["{not json", JSON.stringify(auditFixture({ action: "valid" })), '{"incomplete": true}', ""].join("\n"),
				{ flag: "w" },
			);
			const entries = readAuditTrail(dir);
			expect(entries).toHaveLength(1);
			expect(entries[0]?.action).toBe("valid");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ── Lockfile ────────────────────────────────────────────────────────

describe("lockfile", () => {
	test("write → read round-trip", () => {
		const dir = makeTmp("mc-lock-");
		try {
			const lock = freshLock();
			writeLockfile(dir, lock);
			expect(readLockfile(dir)).toEqual(lock);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("readLockfile returns null for missing file", () => {
		const dir = makeTmp("mc-lock-");
		try {
			expect(readLockfile(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("readLockfile rejects wrong-shape JSON", () => {
		const dir = makeTmp("mc-lock-");
		try {
			const dirPath = lockfilePath(dir);
			// write a file with wrong shape via writeLockfile helper path
			writeLockfile(dir, freshLock());
			// Overwrite with garbage
			writeFileSync(dirPath, '{"pid": "not-a-number"}');
			expect(readLockfile(dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("removeLockfile clears present file, is no-op when absent", () => {
		const dir = makeTmp("mc-lock-");
		try {
			writeLockfile(dir, freshLock());
			expect(readLockfile(dir)).not.toBeNull();
			removeLockfile(dir);
			expect(readLockfile(dir)).toBeNull();
			removeLockfile(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("async variants mirror sync behaviour", async () => {
		const dir = makeTmp("mc-lock-async-");
		try {
			const lock = freshLock({ sessionId: "async-session" });
			await writeLockfileAsync(dir, lock);
			expect(await readLockfileAsync(dir)).toEqual(lock);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("isLockStale returns true for past heartbeats and malformed strings", () => {
		expect(isLockStale(freshLock())).toBe(false);
		expect(
			isLockStale(freshLock({ heartbeat: new Date(Date.now() - STALE_LOCK_THRESHOLD_MS - 10).toISOString() })),
		).toBe(true);
		expect(isLockStale(freshLock({ heartbeat: "not-a-date" }))).toBe(true);
	});

	test("isSupervisorProcessAlive: current PID alive, bogus PID dead", () => {
		expect(isSupervisorProcessAlive(process.pid)).toBe(true);
		// Pick a PID unlikely to exist (just under INT_MAX).
		expect(isSupervisorProcessAlive(2_147_483_640)).toBe(false);
	});

	test("isBatchTerminal matches TERMINAL_BATCH_PHASES", () => {
		for (const phase of ["idle", "completed", "failed", "stopped"]) {
			expect(isBatchTerminal(phase)).toBe(true);
			expect(TERMINAL_BATCH_PHASES.has(phase)).toBe(true);
		}
		expect(isBatchTerminal("running")).toBe(false);
		expect(isBatchTerminal("merging")).toBe(false);
	});
});

// ── Supervisor Config + State ───────────────────────────────────────

describe("resolveSupervisorConfig", () => {
	test("returns clone of DEFAULT when no section provided", () => {
		const resolved = resolveSupervisorConfig();
		expect(resolved).toEqual(DEFAULT_SUPERVISOR_CONFIG);
		expect(resolved).not.toBe(DEFAULT_SUPERVISOR_CONFIG);
	});

	test("fills missing fields from DEFAULT", () => {
		expect(resolveSupervisorConfig({ model: "custom-model" })).toEqual({
			model: "custom-model",
			autonomy: "supervised",
		});
		expect(resolveSupervisorConfig({ autonomy: "autonomous" })).toEqual({
			model: "",
			autonomy: "autonomous",
		});
	});

	test("fully populated section passes through", () => {
		expect(resolveSupervisorConfig({ model: "opus-5", autonomy: "interactive" })).toEqual({
			model: "opus-5",
			autonomy: "interactive",
		});
	});
});

describe("fresh state constructors", () => {
	test("freshDigestBuffer is empty; isDigestEmpty true; populated → false", () => {
		const buf = freshDigestBuffer();
		expect(isDigestEmpty(buf)).toBe(true);
		buf.completed.push("T-1");
		expect(isDigestEmpty(buf)).toBe(false);

		const buf2 = freshDigestBuffer();
		buf2.recoveryAttempts = 1;
		expect(isDigestEmpty(buf2)).toBe(false);
	});

	test("freshEventTailerState is inactive with empty digest", () => {
		const tailer = freshEventTailerState();
		expect(tailer.running).toBe(false);
		expect(tailer.byteOffset).toBe(0);
		expect(tailer.partialLine).toBe("");
		expect(tailer.batchId).toBe("");
		expect(isDigestEmpty(tailer.digestBuffer)).toBe(true);
		expect(tailer.pollTimer).toBeNull();
		expect(tailer.digestTimer).toBeNull();
	});

	test("freshSupervisorState wires fresh tailer + default config + null previousModel", () => {
		const state = freshSupervisorState();
		expect(state.active).toBe(false);
		expect(state.config).toEqual(DEFAULT_SUPERVISOR_CONFIG);
		expect(state.config).not.toBe(DEFAULT_SUPERVISOR_CONFIG);
		expect(state.batchStateRef).toBeNull();
		expect(state.stateRoot).toBe("");
		expect(state.previousModel).toBeNull();
		expect(isDigestEmpty(state.eventTailer.digestBuffer)).toBe(true);
	});
});

// ── Integration Plan ────────────────────────────────────────────────

describe("buildIntegrationPlan", () => {
	test("returns null when branches missing or no succeeded tasks", () => {
		expect(buildIntegrationPlan(batchFixture({ orchBranch: "" }), process.cwd(), "unprotected")).toBeNull();
		expect(buildIntegrationPlan(batchFixture({ baseBranch: "" }), process.cwd(), "unprotected")).toBeNull();
		expect(buildIntegrationPlan(batchFixture({ succeededTasks: 0 }), process.cwd(), "unprotected")).toBeNull();
	});

	test("protected + diverged → PR mode (needs remotes + non-linear branches)", () => {
		const dir = makeTmp("mc-integrate-");
		try {
			// Init a minimal git repo + fake remote so hasGitRemotes returns true.
			Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: dir });
			Bun.spawnSync({ cmd: ["git", "remote", "add", "origin", "https://example.invalid/r.git"], cwd: dir });

			const plan = buildIntegrationPlan(batchFixture(), dir, "protected");
			expect(plan?.mode).toBe("pr");
			expect(plan?.branchProtection).toBe("protected");
			expect(plan?.rationale).toContain("protected");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("unprotected + diverged → merge mode", () => {
		const dir = makeTmp("mc-integrate-");
		try {
			const plan = buildIntegrationPlan(batchFixture(), dir, "unprotected");
			expect(plan?.mode).toBe("merge");
			expect(plan?.branchProtection).toBe("unprotected");
			expect(plan?.rationale).toContain("diverged");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("integration plan formatters", () => {
	test("formatIntegrationPlan renders mode, branches, rationale, counts", () => {
		const out = formatIntegrationPlan({
			mode: "pr",
			orchBranch: "orch/feature",
			baseBranch: "main",
			batchId: "b-1",
			branchProtection: "protected",
			rationale: "diverged and protected",
			succeededTasks: 3,
			failedTasks: 1,
		});
		expect(out).toContain("Integration Plan");
		expect(out).toContain("pull request");
		expect(out).toContain("orch/feature");
		expect(out).toContain("main");
		expect(out).toContain("3 succeeded, 1 failed");
		expect(out).toContain("Branch protection detected");
	});

	test("formatIntegrationPlan omits protection note for unprotected", () => {
		const out = formatIntegrationPlan({
			mode: "ff",
			orchBranch: "orch",
			baseBranch: "main",
			batchId: "b-1",
			branchProtection: "unprotected",
			rationale: "linear",
			succeededTasks: 2,
			failedTasks: 0,
		});
		expect(out).toContain("fast-forward");
		expect(out).not.toContain("Branch protection detected");
	});

	test("formatIntegrationOutcome success uses mode-specific verb", () => {
		const plan = {
			mode: "ff" as const,
			orchBranch: "orch",
			baseBranch: "main",
			batchId: "b-1",
			branchProtection: "unprotected" as const,
			rationale: "linear",
			succeededTasks: 2,
			failedTasks: 0,
		};
		expect(formatIntegrationOutcome(plan, true, "done")).toContain("Fast-forwarded");
		expect(formatIntegrationOutcome({ ...plan, mode: "merge" }, true, "done")).toContain("Merged");
		expect(formatIntegrationOutcome({ ...plan, mode: "pr" }, true, "done")).toContain("Created PR");
	});

	test("formatIntegrationOutcome failure starts with ❌", () => {
		const out = formatIntegrationOutcome(
			{
				mode: "merge",
				orchBranch: "orch",
				baseBranch: "main",
				batchId: "b-1",
				branchProtection: "unprotected",
				rationale: "...",
				succeededTasks: 2,
				failedTasks: 0,
			},
			false,
			"conflicts",
		);
		expect(out.startsWith("❌")).toBe(true);
		expect(out).toContain("conflicts");
	});
});

// ── Event Tailer Primitives ─────────────────────────────────────────

describe("readNewBytes / readNewBytesAsync", () => {
	test("returns empty when file missing", () => {
		expect(readNewBytes(join(makeTmp("mc-rnb-"), "missing.jsonl"), 0)).toEqual(["", 0]);
	});

	test("returns empty when offset already at EOF", () => {
		const dir = makeTmp("mc-rnb-");
		try {
			const file = join(dir, "events.jsonl");
			writeFileSync(file, "first\nsecond\n");
			const size = readFileSync(file).byteLength;
			expect(readNewBytes(file, size)).toEqual(["", size]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reads only the delta from the last offset (sync + async agree)", async () => {
		const dir = makeTmp("mc-rnb-");
		try {
			const file = join(dir, "events.jsonl");
			writeFileSync(file, "line1\n");
			const firstSize = readFileSync(file).byteLength;
			writeFileSync(file, "line1\nline2\n");

			const [delta, newOffset] = readNewBytes(file, firstSize);
			expect(delta).toBe("line2\n");
			expect(newOffset).toBe(readFileSync(file).byteLength);

			const [aDelta, aOffset] = await readNewBytesAsync(file, firstSize);
			expect(aDelta).toBe(delta);
			expect(aOffset).toBe(newOffset);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("parseJsonlLines", () => {
	test("extracts complete events, preserves partial trailing line", () => {
		const chunk =
			`${JSON.stringify(parsedEvent({ type: "wave_start" }))}\n` +
			`${JSON.stringify(parsedEvent({ type: "merge_success" }))}\n` +
			`{"partial":`;
		const [events, remaining] = parseJsonlLines(chunk, "");
		expect(events).toHaveLength(2);
		expect(events[0]?.type).toBe("wave_start");
		expect(events[1]?.type).toBe("merge_success");
		expect(remaining).toBe('{"partial":');
	});

	test("concatenates previous partial with new chunk", () => {
		const event = parsedEvent({ type: "task_complete", taskId: "T-1" });
		const serialized = JSON.stringify(event);
		const mid = Math.floor(serialized.length / 2);
		const [events1, remaining1] = parseJsonlLines(serialized.slice(0, mid), "");
		expect(events1).toHaveLength(0);

		const [events2, remaining2] = parseJsonlLines(`${serialized.slice(mid)}\n`, remaining1);
		expect(events2).toHaveLength(1);
		expect(events2[0]?.taskId).toBe("T-1");
		expect(remaining2).toBe("");
	});

	test("skips malformed lines and events missing required fields", () => {
		const chunk = [
			"not-json",
			JSON.stringify({ type: "wave_start", batchId: "b", waveIndex: 0 }), // missing timestamp
			JSON.stringify(parsedEvent({ type: "wave_start" })),
			"",
		].join("\n");
		const [events] = parseJsonlLines(chunk, "");
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("wave_start");
	});
});

// ── Notification Formatters ─────────────────────────────────────────

describe("formatEventNotification", () => {
	test("wave_start shows 1-based wave number and task count", () => {
		const out = formatEventNotification(
			parsedEvent({ type: "wave_start", waveIndex: 1, taskIds: ["T-1", "T-2"], laneCount: 2 }),
			"supervised",
		);
		expect(out).toContain("Wave 2");
		expect(out).toContain("2 task(s)");
		expect(out).toContain("2 lanes");
	});

	test("merge_failed verbosity scales with autonomy", () => {
		const evt = parsedEvent({
			type: "merge_failed",
			waveIndex: 0,
			reason: "conflict",
			laneNumber: 3,
		});
		expect(formatEventNotification(evt, "autonomous")).toContain("Attempting recovery");
		expect(formatEventNotification(evt, "supervised")).toContain("Recovery may be needed");
		expect(formatEventNotification(evt, "supervised")).toContain("(lane 3)");
	});

	test("batch_complete summarises counts + formatted duration", () => {
		const out = formatEventNotification(
			parsedEvent({
				type: "batch_complete",
				succeededTasks: 3,
				failedTasks: 1,
				skippedTasks: 2,
				batchDurationMs: 125_000,
			}),
			"supervised",
		);
		expect(out).toContain("3 succeeded");
		expect(out).toContain("1 failed");
		expect(out).toContain("2 skipped");
		expect(out).toContain("2m 5s");
	});

	test("batch_paused interactive includes options prompt", () => {
		const evt = parsedEvent({ type: "batch_paused", reason: "operator request" });
		expect(formatEventNotification(evt, "interactive")).toContain("Options");
		expect(formatEventNotification(evt, "supervised")).not.toContain("Options");
	});

	test("tier0_escalation wording shifts per autonomy", () => {
		const evt = parsedEvent({ type: "tier0_escalation", pattern: "stale_worktree", suggestion: "retry" });
		expect(formatEventNotification(evt, "autonomous")).toContain("Investigating automatically");
		expect(formatEventNotification(evt, "interactive")).toContain("Need your input");
		expect(formatEventNotification(evt, "supervised")).toContain("Diagnosing");
	});

	test("unknown event type falls through to generic label", () => {
		const evt = parsedEvent({ type: "tier0_recovery_attempt" as never });
		const out = formatEventNotification(evt, "supervised");
		expect(out).toContain("Event:");
	});
});

describe("formatTaskDigest", () => {
	test("returns null for empty buffer", () => {
		expect(formatTaskDigest(freshDigestBuffer(), "supervised")).toBeNull();
	});

	test("interactive lists task IDs; supervised omits them", () => {
		const buf = freshDigestBuffer();
		buf.completed.push("T-1", "T-2");
		buf.failed.push("T-3");

		const interactive = formatTaskDigest(buf, "interactive")!;
		expect(interactive).toContain("T-1, T-2");
		expect(interactive).toContain("T-3");

		const supervised = formatTaskDigest(buf, "supervised")!;
		expect(supervised).not.toContain("T-1, T-2");
		expect(supervised).toContain("2 task(s) completed");
	});

	test("recovery attempts hidden in autonomous, visible otherwise", () => {
		const buf = freshDigestBuffer();
		buf.completed.push("T-1");
		buf.recoveryAttempts = 2;
		buf.recoverySuccesses = 1;
		buf.recoveryExhausted = 1;

		expect(formatTaskDigest(buf, "autonomous")).not.toContain("recovery attempt(s)");
		expect(formatTaskDigest(buf, "autonomous")).toContain("recovery budget(s) exhausted");
		expect(formatTaskDigest(buf, "supervised")).toContain("recovery attempt(s)");
		expect(formatTaskDigest(buf, "supervised")).toContain("(1 succeeded)");
	});
});

describe("shouldNotify", () => {
	test("terminal/failure events always notify regardless of autonomy", () => {
		for (const type of [
			"batch_complete",
			"batch_paused",
			"merge_failed",
			"merge_health_dead",
			"merge_health_stuck",
			"tier0_escalation",
		] as const) {
			for (const autonomy of ["interactive", "supervised", "autonomous"] as const) {
				expect(shouldNotify(type, autonomy)).toBe(true);
			}
		}
	});

	test("autonomous filters routine events; supervised surfaces them", () => {
		expect(shouldNotify("wave_start", "autonomous")).toBe(false);
		expect(shouldNotify("wave_start", "supervised")).toBe(true);
		expect(shouldNotify("wave_start", "interactive")).toBe(true);
	});

	test("digest-class events never pass shouldNotify (handled via buffer)", () => {
		expect(shouldNotify("task_complete", "supervised")).toBe(false);
		expect(shouldNotify("task_failed", "supervised")).toBe(false);
	});

	test("SIGNIFICANT and DIGEST sets are disjoint", () => {
		for (const type of SIGNIFICANT_SUPERVISOR_EVENT_TYPES) {
			expect(DIGEST_SUPERVISOR_EVENT_TYPES.has(type)).toBe(false);
		}
	});
});

describe("bufferDigestEvent", () => {
	test("routes each digest-class event to the correct field", () => {
		const buf = freshDigestBuffer();
		bufferDigestEvent(parsedEvent({ type: "task_complete", taskId: "T-1" }), buf);
		bufferDigestEvent(parsedEvent({ type: "task_failed", taskId: "T-2" }), buf);
		bufferDigestEvent(parsedEvent({ type: "tier0_recovery_attempt" }), buf);
		bufferDigestEvent(parsedEvent({ type: "tier0_recovery_success" }), buf);
		bufferDigestEvent(parsedEvent({ type: "tier0_recovery_exhausted" }), buf);
		expect(buf.completed).toEqual(["T-1"]);
		expect(buf.failed).toEqual(["T-2"]);
		expect(buf.recoveryAttempts).toBe(1);
		expect(buf.recoverySuccesses).toBe(1);
		expect(buf.recoveryExhausted).toBe(1);
	});

	test("ignores non-digest event types", () => {
		const buf = freshDigestBuffer();
		bufferDigestEvent(parsedEvent({ type: "wave_start" }), buf);
		expect(isDigestEmpty(buf)).toBe(true);
	});
});

describe("processEvents", () => {
	function collectingNotifier(): { notify: (text: string) => void; messages: string[] } {
		const messages: string[] = [];
		return {
			notify: (text: string) => messages.push(text),
			messages,
		};
	}

	test("adopts batchId from the first event when tailer has none", () => {
		const tailer: EventTailerState = freshEventTailerState();
		const { notify, messages } = collectingNotifier();
		processEvents([parsedEvent({ type: "wave_start", batchId: "b-xyz" })], tailer, "supervised", notify);
		expect(tailer.batchId).toBe("b-xyz");
		expect(messages).toHaveLength(1);
	});

	test("drops events with batchId that doesn't match the tailer's active batch", () => {
		const tailer: EventTailerState = { ...freshEventTailerState(), batchId: "b-1" };
		const { notify, messages } = collectingNotifier();
		processEvents(
			[parsedEvent({ type: "wave_start", batchId: "b-1" }), parsedEvent({ type: "wave_start", batchId: "b-2" })],
			tailer,
			"supervised",
			notify,
		);
		expect(messages).toHaveLength(1);
	});

	test("digest-class events buffer without notifying", () => {
		const tailer: EventTailerState = { ...freshEventTailerState(), batchId: "b-1" };
		const { notify, messages } = collectingNotifier();
		processEvents(
			[
				parsedEvent({ type: "task_complete", batchId: "b-1", taskId: "T-1" }),
				parsedEvent({ type: "task_failed", batchId: "b-1", taskId: "T-2" }),
			],
			tailer,
			"supervised",
			notify,
		);
		expect(messages).toHaveLength(0);
		expect(tailer.digestBuffer.completed).toEqual(["T-1"]);
		expect(tailer.digestBuffer.failed).toEqual(["T-2"]);
	});

	test("batch_complete fires onBatchComplete callback with the event", () => {
		const tailer: EventTailerState = { ...freshEventTailerState(), batchId: "b-1" };
		const { notify } = collectingNotifier();
		const seen: ParsedSupervisorEvent[] = [];
		processEvents(
			[parsedEvent({ type: "batch_complete", batchId: "b-1", succeededTasks: 3 })],
			tailer,
			"supervised",
			notify,
			evt => seen.push(evt),
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.type).toBe("batch_complete");
	});

	test("autonomous mode drops routine events but still surfaces failures", () => {
		const tailer: EventTailerState = { ...freshEventTailerState(), batchId: "b-1" };
		const { notify, messages } = collectingNotifier();
		processEvents(
			[
				parsedEvent({ type: "wave_start", batchId: "b-1" }),
				parsedEvent({ type: "merge_failed", batchId: "b-1", reason: "x" }),
			],
			tailer,
			"autonomous",
			notify,
		);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("merge failed");
	});
});

// ── Tier 0 + Batch Summary ──────────────────────────────────────────

describe("readTier0EventsForBatch", () => {
	test("returns empty when events.jsonl missing", () => {
		const dir = makeTmp("mc-t0-");
		try {
			expect(readTier0EventsForBatch(dir, "b-1")).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("filters by batchId and Tier 0 type", async () => {
		const dir = makeTmp("mc-t0-");
		try {
			const eventsDir = join(dir, ".omp", "supervisor");
			await mkdir(eventsDir, { recursive: true });
			const lines = [
				JSON.stringify({
					batchId: "b-1",
					type: "tier0_recovery_attempt",
					pattern: "stale_worktree",
					attempt: 1,
					maxAttempts: 3,
					timestamp: "t1",
				}),
				JSON.stringify({ batchId: "b-1", type: "wave_start", pattern: "noise", timestamp: "t2" }),
				JSON.stringify({ batchId: "b-2", type: "tier0_escalation", pattern: "worker_crash", timestamp: "t3" }),
				JSON.stringify({
					batchId: "b-1",
					type: "tier0_recovery_success",
					pattern: "stale_worktree",
					taskId: "T-1",
					timestamp: "t4",
				}),
			];
			await writeFile(join(eventsDir, "events.jsonl"), `${lines.join("\n")}\n`);
			const results = readTier0EventsForBatch(dir, "b-1");
			expect(results).toHaveLength(2);
			expect(results[0]?.type).toBe("tier0_recovery_attempt");
			expect(results[1]?.taskId).toBe("T-1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("formatDurationMs", () => {
	test("scales through s / m / h units", () => {
		expect(formatDurationMs(0)).toBe("0s");
		expect(formatDurationMs(-50)).toBe("0s");
		expect(formatDurationMs(45_000)).toBe("45s");
		expect(formatDurationMs(120_000)).toBe("2m");
		expect(formatDurationMs(125_000)).toBe("2m 5s");
		expect(formatDurationMs(3_600_000)).toBe("1h");
		expect(formatDurationMs(3_660_000)).toBe("1h 1m");
	});
});

describe("collectBatchSummaryData + formatBatchSummary", () => {
	test("collects audit entries, tier0 events, diagnostics; markdown renders sections", async () => {
		const dir = makeTmp("mc-summary-");
		try {
			// Seed audit trail
			appendAuditEntry(dir, auditFixture({ action: "orch_pause", result: "success" }));

			// Seed tier0 events
			const eventsDir = join(dir, ".omp", "supervisor");
			await mkdir(eventsDir, { recursive: true });
			await writeFile(
				join(eventsDir, "events.jsonl"),
				`${JSON.stringify({
					batchId: "b-1",
					type: "tier0_recovery_success",
					pattern: "stale_worktree",
					timestamp: "t1",
					attempt: 1,
					maxAttempts: 3,
				})}\n`,
			);

			const state = batchFixture({
				waveResults: [
					{
						waveIndex: 0,
						startedAt: 1_000,
						endedAt: 3_000,
						laneResults: [],
						policyApplied: "skip-dependents",
						stoppedEarly: false,
						failedTaskIds: ["T-3"],
						skippedTaskIds: [],
						succeededTaskIds: ["T-1", "T-2"],
						blockedTaskIds: [],
						laneCount: 2,
						overallStatus: "partial",
						finalMonitorState: null,
						allocatedLanes: [],
					},
				],
				errors: ["boom"],
			});

			const data = collectBatchSummaryData(state, dir, {
				taskExits: { "T-1": { classification: "success", cost: 0.1, durationSec: 10 } },
				batchCost: 0.42,
			});

			expect(data.auditEntries).toHaveLength(1);
			expect(data.tier0Events).toHaveLength(1);
			expect(data.batchCost).toBe(0.42);
			expect(data.waveResults).toHaveLength(1);

			const md = formatBatchSummary(data);
			expect(md).toContain("# Batch Summary: b-1");
			expect(md).toContain("**Cost:** $0.42");
			expect(md).toContain("2/3 tasks succeeded");
			expect(md).toContain("Wave Timeline");
			expect(md).toContain("Wave 1 (3 tasks)");
			expect(md).toContain("⚠️"); // partial status icon
			expect(md).toContain("Failed: T-3");
			expect(md).toContain("Incidents");
			expect(md).toContain("Tier 0 Recoveries");
			expect(md).toContain("stale_worktree");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("cost fallback reads V2 lane snapshots when diagnostics.batchCost is 0", async () => {
		const dir = makeTmp("mc-summary-");
		try {
			const lanesDir = join(dir, ".omp", "runtime", "b-1", "lanes");
			await mkdir(lanesDir, { recursive: true });
			await writeFile(
				join(lanesDir, "lane-1.json"),
				JSON.stringify({ worker: { costUsd: 0.3 }, reviewer: { costUsd: 0.2 } }),
			);
			await writeFile(join(lanesDir, "lane-2.json"), JSON.stringify({ worker: { costUsd: 0.5 } }));

			const data = collectBatchSummaryData(batchFixture(), dir);
			expect(data.batchCost).toBeCloseTo(1.0, 5);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("formatBatchSummary handles missing wave data gracefully", () => {
		const md = formatBatchSummary({
			batchId: "b-empty",
			phase: "idle",
			startedAt: 0,
			endedAt: null,
			totalTasks: 0,
			succeededTasks: 0,
			failedTasks: 0,
			skippedTasks: 0,
			blockedTasks: 0,
			batchCost: 0,
			wavePlan: [],
			waveResults: [],
			taskExits: {},
			mergeResults: [],
			segmentOutcomes: null,
			auditEntries: [],
			tier0Events: [],
			errors: [],
		});
		expect(md).toContain("No wave data available");
		expect(md).toContain("No incidents recorded");
		expect(md).toContain("In progress");
		expect(md).toContain("Not available");
	});
});
