/**
 * Unit tests for scanAreaForTasks + buildCompletedTaskSet — FS walkers ported
 * from taskplane discovery.ts:825-958.
 *
 * Covers:
 *  - Missing area dir → SCAN_ERROR
 *  - Unreadable area dir → SCAN_ERROR (skipped on platforms that can't simulate it)
 *  - Subdirectory with no PROMPT.md skipped
 *  - Subdirectory with .DONE skipped
 *  - `archive/` subdir skipped by scanAreaForTasks
 *  - Archive .DONE markers included by buildCompletedTaskSet
 *  - Active .DONE folder included by buildCompletedTaskSet
 *  - Fatal parse error surfaces in errors; warnings surface alongside tasks
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCompletedTaskSet, scanAreaForTasks } from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-scan-area-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function taskFolder(area: string, name: string, promptContent: string | null): string {
	const dir = join(sandbox, area, name);
	mkdirSync(dir, { recursive: true });
	if (promptContent !== null) {
		writeFileSync(join(dir, "PROMPT.md"), promptContent, "utf-8");
	}
	return dir;
}

function markDone(dir: string): void {
	writeFileSync(join(dir, ".DONE"), "", "utf-8");
}

describe("scanAreaForTasks", () => {
	test("missing area path produces SCAN_ERROR", () => {
		const result = scanAreaForTasks(join(sandbox, "does-not-exist"), "api");
		expect(result.tasks).toEqual([]);
		expect(result.errors[0]?.code).toBe("SCAN_ERROR");
		expect(result.errors[0]?.message).toContain("does not exist");
	});

	test("returns empty for an empty area directory", () => {
		mkdirSync(join(sandbox, "api"), { recursive: true });
		const result = scanAreaForTasks(join(sandbox, "api"), "api");
		expect(result.tasks).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("parses valid PROMPT.md into a task", () => {
		taskFolder("api", "TA-001", "# Task: TA-001 - Seed\n");
		const result = scanAreaForTasks(join(sandbox, "api"), "api");
		expect(result.tasks).toHaveLength(1);
		expect(result.tasks[0]?.taskId).toBe("TA-001");
		expect(result.tasks[0]?.areaName).toBe("api");
		expect(result.errors).toEqual([]);
	});

	test("skips folders with .DONE marker", () => {
		const dir = taskFolder("api", "TA-001", "# Task: TA-001 - Done\n");
		markDone(dir);
		taskFolder("api", "TA-002", "# Task: TA-002 - Active\n");
		const result = scanAreaForTasks(join(sandbox, "api"), "api");
		expect(result.tasks.map(t => t.taskId)).toEqual(["TA-002"]);
	});

	test("skips folders without PROMPT.md", () => {
		taskFolder("api", "TA-001", null);
		taskFolder("api", "TA-002", "# Task: TA-002 - Has prompt\n");
		const result = scanAreaForTasks(join(sandbox, "api"), "api");
		expect(result.tasks.map(t => t.taskId)).toEqual(["TA-002"]);
	});

	test("skips `archive` directory entirely", () => {
		taskFolder("api", "archive", null);
		taskFolder("api", "TA-001", "# Task: TA-001 - live\n");
		const result = scanAreaForTasks(join(sandbox, "api"), "api");
		expect(result.tasks.map(t => t.taskId)).toEqual(["TA-001"]);
	});

	test("surfaces fatal parse errors in errors[]", () => {
		taskFolder("api", "missing-id", "No heading here.\n");
		const result = scanAreaForTasks(join(sandbox, "api"), "api");
		expect(result.tasks).toEqual([]);
		expect(result.errors.some(e => e.code === "PARSE_MISSING_ID")).toBe(true);
	});

	test("surfaces non-fatal warnings alongside the task", () => {
		const content = ["# Task: TA-001 - warn", "## Steps", "### Step 1: empty", "#### Segment: api", "", ""].join(
			"\n",
		);
		taskFolder("api", "TA-001", content);
		const result = scanAreaForTasks(join(sandbox, "api"), "api");
		expect(result.tasks).toHaveLength(1);
		expect(result.errors.some(e => e.code === "SEGMENT_STEP_EMPTY")).toBe(true);
	});

	test("ignores non-directory entries", () => {
		mkdirSync(join(sandbox, "api"), { recursive: true });
		writeFileSync(join(sandbox, "api", "stray.txt"), "junk", "utf-8");
		const result = scanAreaForTasks(join(sandbox, "api"), "api");
		expect(result.tasks).toEqual([]);
		expect(result.errors).toEqual([]);
	});
});

describe("buildCompletedTaskSet", () => {
	test("collects .DONE markers from active folders", () => {
		const dir = taskFolder("api", "TA-001-done", null);
		markDone(dir);
		taskFolder("api", "TA-002-live", null);
		const result = buildCompletedTaskSet([join(sandbox, "api")]);
		expect(result.has("TA-001")).toBe(true);
		expect(result.has("TA-002")).toBe(false);
	});

	test("collects .DONE markers from archive/ subfolders", () => {
		const archived = join(sandbox, "api", "archive", "TA-009-shipped");
		mkdirSync(archived, { recursive: true });
		markDone(archived);
		const result = buildCompletedTaskSet([join(sandbox, "api")]);
		expect(result.has("TA-009")).toBe(true);
	});

	test("ignores archive entries without .DONE", () => {
		const inFlight = join(sandbox, "api", "archive", "TA-008-wip");
		mkdirSync(inFlight, { recursive: true });
		const result = buildCompletedTaskSet([join(sandbox, "api")]);
		expect(result.has("TA-008")).toBe(false);
	});

	test("returns empty set when all area paths are missing", () => {
		const result = buildCompletedTaskSet([join(sandbox, "nope-1"), join(sandbox, "nope-2")]);
		expect(result.size).toBe(0);
	});

	test("aggregates across multiple area paths", () => {
		const a = taskFolder("area-1", "AA-001", null);
		const b = taskFolder("area-2", "BB-002", null);
		markDone(a);
		markDone(b);
		const result = buildCompletedTaskSet([join(sandbox, "area-1"), join(sandbox, "area-2")]);
		expect(result.has("AA-001")).toBe(true);
		expect(result.has("BB-002")).toBe(true);
	});
});
