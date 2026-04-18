/**
 * Unit tests for buildTaskRegistry — registry aggregator that combines
 * scanAreaForTasks + parsePromptForOrchestrator + buildCompletedTaskSet,
 * enforces global uniqueness of task IDs, and aggregates a completed set
 * across every area path (not just the scan targets).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskArea } from "../src/missioncontrol";
import { buildTaskRegistry } from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-registry-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function area(path: string, prefix = "TA"): TaskArea {
	return { path, prefix, context: "test" };
}

function writeTask(relDir: string, taskId: string, title = "seed"): string {
	const dir = join(sandbox, relDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "PROMPT.md"), `# Task: ${taskId} - ${title}\n`, "utf-8");
	return dir;
}

function markDone(dir: string): void {
	writeFileSync(join(dir, ".DONE"), "", "utf-8");
}

describe("buildTaskRegistry", () => {
	test("empty inputs yield an empty registry", () => {
		const result = buildTaskRegistry([], [], {}, sandbox);
		expect(result.pending.size).toBe(0);
		expect(result.completed.size).toBe(0);
		expect(result.errors).toEqual([]);
	});

	test("scans an area path and registers its pending task", () => {
		writeTask("api/TA-001", "TA-001");
		const result = buildTaskRegistry([join(sandbox, "api")], [], { api: area("api") }, sandbox);
		expect(result.pending.has("TA-001")).toBe(true);
		expect(result.pending.get("TA-001")?.areaName).toBe("api");
	});

	test("direct task folder is registered via parsePromptForOrchestrator", () => {
		const dir = writeTask("TA-007", "TA-007");
		const result = buildTaskRegistry([], [dir], {}, sandbox);
		expect(result.pending.has("TA-007")).toBe(true);
	});

	test("direct task folder with missing PROMPT.md yields SCAN_ERROR", () => {
		const dir = join(sandbox, "empty-dir");
		mkdirSync(dir, { recursive: true });
		const result = buildTaskRegistry([], [dir], {}, sandbox);
		expect(result.errors[0]?.code).toBe("SCAN_ERROR");
		expect(result.errors[0]?.message).toContain("No PROMPT.md");
	});

	test("direct task folder with .DONE marker is skipped silently", () => {
		const dir = writeTask("TA-010", "TA-010");
		markDone(dir);
		const result = buildTaskRegistry([], [dir], {}, sandbox);
		expect(result.pending.size).toBe(0);
		expect(result.errors).toEqual([]);
	});

	test("direct task folder infers area name from configured area path", () => {
		const dir = writeTask("api/TA-020", "TA-020");
		const result = buildTaskRegistry([], [dir], { api: area("api") }, sandbox);
		expect(result.pending.get("TA-020")?.areaName).toBe("api");
	});

	test("duplicate task IDs across two scanned areas yield a DUPLICATE_ID error", () => {
		writeTask("api/TA-001", "TA-001");
		writeTask("web/TA-001", "TA-001");
		const result = buildTaskRegistry(
			[join(sandbox, "api"), join(sandbox, "web")],
			[],
			{ api: area("api"), web: area("web") },
			sandbox,
		);
		const dup = result.errors.find(e => e.code === "DUPLICATE_ID");
		expect(dup?.message).toContain("TA-001");
		expect(dup?.message).toContain("2 locations");
	});

	test("completed tasks collected from scan paths populate completed set", () => {
		const doneDir = writeTask("api/TA-050", "TA-050");
		markDone(doneDir);
		writeTask("api/TA-051", "TA-051");
		const result = buildTaskRegistry([join(sandbox, "api")], [], { api: area("api") }, sandbox);
		expect(result.completed.has("TA-050")).toBe(true);
		expect(result.pending.has("TA-051")).toBe(true);
	});

	test("completed set aggregates from all configured areas, even those not scanned", () => {
		// Only "api" is in areaScanPaths; but "web" also has a done task → must still be in completed
		writeTask("api/TA-100", "TA-100");
		const webDone = writeTask("web/TA-200", "TA-200");
		markDone(webDone);
		const result = buildTaskRegistry([join(sandbox, "api")], [], { api: area("api"), web: area("web") }, sandbox);
		expect(result.pending.has("TA-100")).toBe(true);
		expect(result.completed.has("TA-200")).toBe(true);
	});

	test("errors from scanAreaForTasks propagate verbatim", () => {
		const result = buildTaskRegistry([join(sandbox, "missing")], [], {}, sandbox);
		expect(result.errors.some(e => e.code === "SCAN_ERROR")).toBe(true);
	});

	test("parse warnings from direct folder surface as errors[]", () => {
		const dir = join(sandbox, "TA-300");
		mkdirSync(dir, { recursive: true });
		const content = [
			"# Task: TA-300 - empty segment",
			"## Steps",
			"### Step 1: empty",
			"#### Segment: api",
			"",
			"",
		].join("\n");
		writeFileSync(join(dir, "PROMPT.md"), content, "utf-8");
		const result = buildTaskRegistry([], [dir], {}, sandbox);
		expect(result.pending.has("TA-300")).toBe(true);
		expect(result.errors.some(e => e.code === "SEGMENT_STEP_EMPTY")).toBe(true);
	});
});
