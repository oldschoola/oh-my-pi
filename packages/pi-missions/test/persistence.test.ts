import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	getTaskDoneFileCandidates,
	hasTaskDoneMarker,
	VALID_BATCH_PHASES,
	VALID_PERSISTED_MERGE_STATUSES,
	VALID_TASK_STATUSES,
} from "../src/missioncontrol/persistence";

function mkTmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("getTaskDoneFileCandidates", () => {
	test("returns active + archive path for non-archive folder", () => {
		const out = getTaskDoneFileCandidates("/repo/tasks/t-1");
		expect(out).toHaveLength(2);
		expect(out[0]).toBe(join("/repo/tasks/t-1", ".DONE"));
		expect(out[1]).toBe(join("/repo/tasks", "archive", "t-1", ".DONE"));
	});

	test("already-archived folder only checks that path (no duplicate archive/archive)", () => {
		const out = getTaskDoneFileCandidates("/repo/tasks/archive/t-1");
		expect(out).toHaveLength(1);
		expect(out[0]).toBe(join("/repo/tasks/archive/t-1", ".DONE"));
	});
});

describe("hasTaskDoneMarker", () => {
	test("returns true if .DONE exists in active folder", () => {
		const dir = mkTmp("mc-done-");
		const taskFolder = join(dir, "tasks", "t-1");
		mkdirSync(taskFolder, { recursive: true });
		writeFileSync(join(taskFolder, ".DONE"), "");
		expect(hasTaskDoneMarker(taskFolder)).toBe(true);
	});

	test("returns true if .DONE exists only in archive folder", () => {
		const dir = mkTmp("mc-done-");
		mkdirSync(join(dir, "tasks", "archive", "t-1"), { recursive: true });
		writeFileSync(join(dir, "tasks", "archive", "t-1", ".DONE"), "");
		expect(hasTaskDoneMarker(join(dir, "tasks", "t-1"))).toBe(true);
	});

	test("returns false when no .DONE exists", () => {
		const dir = mkTmp("mc-done-");
		mkdirSync(join(dir, "tasks", "t-1"), { recursive: true });
		expect(hasTaskDoneMarker(join(dir, "tasks", "t-1"))).toBe(false);
	});
});

describe("validation constants", () => {
	test("VALID_BATCH_PHASES covers expected phases", () => {
		for (const phase of [
			"idle",
			"launching",
			"planning",
			"executing",
			"merging",
			"paused",
			"stopped",
			"completed",
			"failed",
		]) {
			expect(VALID_BATCH_PHASES.has(phase)).toBe(true);
		}
		expect(VALID_BATCH_PHASES.has("bogus")).toBe(false);
	});

	test("VALID_TASK_STATUSES covers expected statuses", () => {
		for (const s of ["pending", "running", "succeeded", "failed", "stalled", "skipped"]) {
			expect(VALID_TASK_STATUSES.has(s)).toBe(true);
		}
		expect(VALID_TASK_STATUSES.has("bogus")).toBe(false);
	});

	test("VALID_PERSISTED_MERGE_STATUSES covers succeeded/failed/partial", () => {
		expect(VALID_PERSISTED_MERGE_STATUSES.has("succeeded")).toBe(true);
		expect(VALID_PERSISTED_MERGE_STATUSES.has("failed")).toBe(true);
		expect(VALID_PERSISTED_MERGE_STATUSES.has("partial")).toBe(true);
		expect(VALID_PERSISTED_MERGE_STATUSES.has("bogus")).toBe(false);
	});
});
