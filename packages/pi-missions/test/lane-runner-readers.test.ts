/**
 * Tests for the two pure file-reader helpers ported onto
 * `missioncontrol/lane-runner.ts`:
 *
 * - `hasPendingExpansionRequestFiles` — scans an agent's outbox for any
 *   `segment-expansion-*.json` pending message.
 * - `readReviewerTelemetrySnapshot` — reads `.reviewer-state.json` (or its
 *   sibling from a `status.md` path) and returns a running-reviewer snapshot,
 *   or `null` when the file is missing, stale, non-running, or malformed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	hasPendingExpansionRequestFiles,
	REVIEWER_STATE_STALE_MS,
	readReviewerTelemetrySnapshot,
} from "../src/missioncontrol/lane-runner";
import { sessionOutboxDir } from "../src/missioncontrol/mailbox";
import { buildRuntimeAgentId } from "../src/missioncontrol/types";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "omp-lane-runner-readers-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("hasPendingExpansionRequestFiles", () => {
	const batchId = "op-TEST-001";
	const agentId = "mission-lane-1";

	test("returns false when outbox dir does not exist", () => {
		expect(hasPendingExpansionRequestFiles(tmpRoot, batchId, agentId)).toBe(false);
	});

	test("returns false when outbox is empty", () => {
		const outbox = sessionOutboxDir(tmpRoot, batchId, agentId);
		mkdirSync(outbox, { recursive: true });
		expect(hasPendingExpansionRequestFiles(tmpRoot, batchId, agentId)).toBe(false);
	});

	test("returns true when a segment-expansion file is present", () => {
		const outbox = sessionOutboxDir(tmpRoot, batchId, agentId);
		mkdirSync(outbox, { recursive: true });
		writeFileSync(join(outbox, "segment-expansion-abc123.json"), "{}", "utf-8");
		expect(hasPendingExpansionRequestFiles(tmpRoot, batchId, agentId)).toBe(true);
	});

	test("returns false when outbox has only non-matching files", () => {
		const outbox = sessionOutboxDir(tmpRoot, batchId, agentId);
		mkdirSync(outbox, { recursive: true });
		writeFileSync(join(outbox, "other-msg.json"), "{}", "utf-8");
		writeFileSync(join(outbox, "segment-expansion.json"), "{}", "utf-8"); // needs char after "expansion-"
		writeFileSync(join(outbox, "segment-expansion-x.txt"), "{}", "utf-8"); // wrong extension
		expect(hasPendingExpansionRequestFiles(tmpRoot, batchId, agentId)).toBe(false);
	});

	test("returns true when at least one matching file exists alongside non-matching", () => {
		const outbox = sessionOutboxDir(tmpRoot, batchId, agentId);
		mkdirSync(outbox, { recursive: true });
		writeFileSync(join(outbox, "other-msg.json"), "{}", "utf-8");
		writeFileSync(join(outbox, "segment-expansion-task-5.json"), "{}", "utf-8");
		expect(hasPendingExpansionRequestFiles(tmpRoot, batchId, agentId)).toBe(true);
	});

	test("uses sessionOutboxDir path = .omp/mailbox/{batchId}/{agentId}/outbox", () => {
		const expected = join(tmpRoot, ".omp", "mailbox", batchId, agentId, "outbox");
		expect(sessionOutboxDir(tmpRoot, batchId, agentId)).toBe(expected);
		mkdirSync(expected, { recursive: true });
		writeFileSync(join(expected, "segment-expansion-x.json"), "{}", "utf-8");
		expect(hasPendingExpansionRequestFiles(tmpRoot, batchId, agentId)).toBe(true);
	});
});

describe("readReviewerTelemetrySnapshot", () => {
	const context = { agentIdPrefix: "op-TEST-001-b-1", laneNumber: 1 };
	const expectedAgentId = buildRuntimeAgentId(context.agentIdPrefix, context.laneNumber, "reviewer");

	function writeReviewerState(dir: string, obj: unknown, fileName = ".reviewer-state.json"): string {
		mkdirSync(dir, { recursive: true });
		const path = join(dir, fileName);
		writeFileSync(path, JSON.stringify(obj), "utf-8");
		return path;
	}

	test("returns null when file is missing", () => {
		const path = join(tmpRoot, ".reviewer-state.json");
		expect(readReviewerTelemetrySnapshot(context, path)).toBeNull();
	});

	test("returns null when status is not 'running'", () => {
		const path = writeReviewerState(tmpRoot, { status: "complete", updatedAt: Date.now() });
		expect(readReviewerTelemetrySnapshot(context, path)).toBeNull();
	});

	test("returns null when updatedAt is older than REVIEWER_STATE_STALE_MS", () => {
		const path = writeReviewerState(tmpRoot, {
			status: "running",
			updatedAt: Date.now() - REVIEWER_STATE_STALE_MS - 1000,
		});
		expect(readReviewerTelemetrySnapshot(context, path)).toBeNull();
	});

	test("returns snapshot when updatedAt is within freshness window", () => {
		const path = writeReviewerState(tmpRoot, {
			status: "running",
			updatedAt: Date.now() - 1000, // 1 s ago — well within 120 s window
		});
		const snap = readReviewerTelemetrySnapshot(context, path);
		expect(snap).not.toBeNull();
		expect(snap?.status).toBe("running");
		expect(snap?.agentId).toBe(expectedAgentId);
	});

	test("returns null on parse error", () => {
		mkdirSync(tmpRoot, { recursive: true });
		const path = join(tmpRoot, ".reviewer-state.json");
		writeFileSync(path, "{not valid json}", "utf-8");
		expect(readReviewerTelemetrySnapshot(context, path)).toBeNull();
	});

	test("zero-defaults all numeric fields when absent", () => {
		const path = writeReviewerState(tmpRoot, { status: "running" }); // no updatedAt = no staleness check
		const snap = readReviewerTelemetrySnapshot(context, path);
		expect(snap).not.toBeNull();
		expect(snap?.elapsedMs).toBe(0);
		expect(snap?.toolCalls).toBe(0);
		expect(snap?.contextPct).toBe(0);
		expect(snap?.costUsd).toBe(0);
		expect(snap?.lastTool).toBe("");
		expect(snap?.inputTokens).toBe(0);
		expect(snap?.outputTokens).toBe(0);
		expect(snap?.cacheReadTokens).toBe(0);
		expect(snap?.cacheWriteTokens).toBe(0);
		expect(snap?.reviewType).toBeUndefined();
		expect(snap?.reviewStep).toBeUndefined();
	});

	test("populates all fields when well-formed", () => {
		const path = writeReviewerState(tmpRoot, {
			status: "running",
			updatedAt: Date.now(),
			elapsedMs: 15000,
			toolCalls: 42,
			contextPct: 87.5,
			costUsd: 0.12,
			lastTool: "Read",
			inputTokens: 1000,
			outputTokens: 250,
			cacheReadTokens: 500,
			cacheWriteTokens: 100,
			reviewType: "correctness",
			reviewStep: 3,
		});
		const snap = readReviewerTelemetrySnapshot(context, path);
		expect(snap).not.toBeNull();
		expect(snap?.agentId).toBe(expectedAgentId);
		expect(snap?.status).toBe("running");
		expect(snap?.elapsedMs).toBe(15000);
		expect(snap?.toolCalls).toBe(42);
		expect(snap?.contextPct).toBe(87.5);
		expect(snap?.costUsd).toBe(0.12);
		expect(snap?.lastTool).toBe("Read");
		expect(snap?.inputTokens).toBe(1000);
		expect(snap?.outputTokens).toBe(250);
		expect(snap?.cacheReadTokens).toBe(500);
		expect(snap?.cacheWriteTokens).toBe(100);
		expect(snap?.reviewType).toBe("correctness");
		expect(snap?.reviewStep).toBe(3);
	});

	test("accepts path to status.md and reads sibling .reviewer-state.json", () => {
		writeReviewerState(tmpRoot, { status: "running", updatedAt: Date.now(), toolCalls: 7 });
		const statusPath = join(tmpRoot, "status.md"); // do not create — reader should still derive sibling path
		writeFileSync(statusPath, "# status", "utf-8");
		const snap = readReviewerTelemetrySnapshot(context, statusPath);
		expect(snap).not.toBeNull();
		expect(snap?.toolCalls).toBe(7);
	});

	test("accepts path to status.md case-insensitively (STATUS.MD)", () => {
		writeReviewerState(tmpRoot, { status: "running", updatedAt: Date.now(), toolCalls: 9 });
		const statusPath = join(tmpRoot, "STATUS.MD");
		writeFileSync(statusPath, "# status", "utf-8");
		const snap = readReviewerTelemetrySnapshot(context, statusPath);
		expect(snap).not.toBeNull();
		expect(snap?.toolCalls).toBe(9);
	});

	test("agentId is built via buildRuntimeAgentId(prefix, laneNumber, 'reviewer')", () => {
		const path = writeReviewerState(tmpRoot, { status: "running" });
		const snap = readReviewerTelemetrySnapshot({ agentIdPrefix: "op-XYZ", laneNumber: 7 }, path);
		expect(snap?.agentId).toBe(buildRuntimeAgentId("op-XYZ", 7, "reviewer"));
	});
});
