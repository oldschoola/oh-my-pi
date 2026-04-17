import { describe, expect, test } from "bun:test";

import {
	getSegmentCheckboxes,
	getStepsForRepoId,
	isSegmentComplete,
	mapLaneSnapshotStatusToWorkerStatus,
	mapLaneTaskStatusToTerminalSnapshotStatus,
} from "../src/missioncontrol/lane-runner";
import type { StepSegmentMapping } from "../src/missioncontrol/types";

function mkMap(steps: Array<{ stepNumber: number; stepName?: string; repoIds: string[] }>): StepSegmentMapping[] {
	return steps.map(s => ({
		stepNumber: s.stepNumber,
		stepName: s.stepName ?? `Step ${s.stepNumber}`,
		segments: s.repoIds.map(repoId => ({ repoId, checkboxes: [] })),
	}));
}

describe("getStepsForRepoId", () => {
	test("empty mapping → empty set", () => {
		expect(getStepsForRepoId([], "api")).toEqual(new Set());
	});

	test("returns step numbers where repoId has at least one segment", () => {
		const map = mkMap([
			{ stepNumber: 1, repoIds: ["api"] },
			{ stepNumber: 2, repoIds: ["ui"] },
			{ stepNumber: 3, repoIds: ["api", "ui"] },
		]);
		expect(getStepsForRepoId(map, "api")).toEqual(new Set([1, 3]));
		expect(getStepsForRepoId(map, "ui")).toEqual(new Set([2, 3]));
	});

	test("repoId not present anywhere → empty set", () => {
		const map = mkMap([{ stepNumber: 1, repoIds: ["api"] }]);
		expect(getStepsForRepoId(map, "cli")).toEqual(new Set());
	});

	test("a step with no segments is ignored", () => {
		const map = mkMap([
			{ stepNumber: 1, repoIds: [] },
			{ stepNumber: 2, repoIds: ["api"] },
		]);
		expect(getStepsForRepoId(map, "api")).toEqual(new Set([2]));
	});
});

describe("getSegmentCheckboxes", () => {
	const status = [
		"# Task status",
		"",
		"### Step 1: Discover",
		"#### Segment: api",
		"- [x] plan api",
		"- [ ] list api files",
		"",
		"#### Segment: ui",
		"- [x] plan ui",
		"- [x] list ui files",
		"",
		"### Step 2: Execute",
		"#### Segment: api",
		"- [ ] write code",
		"",
		"---",
		"",
	].join("\n");

	test("counts checked/unchecked under a Step/Segment header", () => {
		const result = getSegmentCheckboxes(status, 1, "api");
		expect(result).not.toBeNull();
		expect(result?.checked).toBe(1);
		expect(result?.unchecked).toBe(1);
		expect(result?.total).toBe(2);
		expect(result?.uncheckedTexts).toEqual(["list api files"]);
	});

	test("all-checked segment → unchecked=0, total>0", () => {
		const result = getSegmentCheckboxes(status, 1, "ui");
		expect(result?.checked).toBe(2);
		expect(result?.unchecked).toBe(0);
		expect(result?.uncheckedTexts).toEqual([]);
	});

	test("stops before next step header", () => {
		const result = getSegmentCheckboxes(status, 2, "api");
		expect(result?.checked).toBe(0);
		expect(result?.unchecked).toBe(1);
		expect(result?.uncheckedTexts).toEqual(["write code"]);
	});

	test("unknown step → null", () => {
		expect(getSegmentCheckboxes(status, 9, "api")).toBeNull();
	});

	test("unknown repoId within a known step → null", () => {
		expect(getSegmentCheckboxes(status, 1, "cli")).toBeNull();
	});

	test("handles CRLF line endings", () => {
		const crlf = status.replace(/\n/g, "\r\n");
		const result = getSegmentCheckboxes(crlf, 1, "api");
		expect(result?.checked).toBe(1);
		expect(result?.unchecked).toBe(1);
	});

	test("uppercase [X] counts as checked", () => {
		const s = ["### Step 1: X", "#### Segment: api", "- [X] cap-checked", "- [x] lower-checked"].join("\n");
		const result = getSegmentCheckboxes(s, 1, "api");
		expect(result?.checked).toBe(2);
		expect(result?.unchecked).toBe(0);
	});

	test("repoId with regex metacharacters is escaped", () => {
		const s = ["### Step 1: X", "#### Segment: pkg.sub", "- [ ] todo"].join("\n");
		const result = getSegmentCheckboxes(s, 1, "pkg.sub");
		expect(result?.unchecked).toBe(1);
		// Would match via `.`, but we look up the literal id — a different id must not collide.
		expect(getSegmentCheckboxes(s, 1, "pkgXsub")).toBeNull();
	});

	test("empty segment block → zero totals", () => {
		const s = ["### Step 1: X", "#### Segment: api", "", "#### Segment: ui", "- [ ] todo"].join("\n");
		const result = getSegmentCheckboxes(s, 1, "api");
		expect(result?.total).toBe(0);
	});
});

describe("isSegmentComplete", () => {
	test("true when every checkbox is checked and at least one exists", () => {
		const s = ["### Step 1: X", "#### Segment: api", "- [x] a", "- [x] b"].join("\n");
		expect(isSegmentComplete(s, 1, "api")).toBe(true);
	});

	test("false when any checkbox is unchecked", () => {
		const s = ["### Step 1: X", "#### Segment: api", "- [x] a", "- [ ] b"].join("\n");
		expect(isSegmentComplete(s, 1, "api")).toBe(false);
	});

	test("false when segment block has no checkboxes", () => {
		const s = ["### Step 1: X", "#### Segment: api", ""].join("\n");
		expect(isSegmentComplete(s, 1, "api")).toBe(false);
	});

	test("false when step/segment not found", () => {
		expect(isSegmentComplete("", 1, "api")).toBe(false);
	});
});

describe("mapLaneTaskStatusToTerminalSnapshotStatus", () => {
	test("succeeded → complete", () => {
		expect(mapLaneTaskStatusToTerminalSnapshotStatus("succeeded")).toBe("complete");
	});

	test("skipped → idle", () => {
		expect(mapLaneTaskStatusToTerminalSnapshotStatus("skipped")).toBe("idle");
	});

	test("failed/pending/running/stalled → failed (non-succeeded, non-skipped bucket)", () => {
		expect(mapLaneTaskStatusToTerminalSnapshotStatus("failed")).toBe("failed");
		expect(mapLaneTaskStatusToTerminalSnapshotStatus("pending")).toBe("failed");
		expect(mapLaneTaskStatusToTerminalSnapshotStatus("running")).toBe("failed");
		expect(mapLaneTaskStatusToTerminalSnapshotStatus("stalled")).toBe("failed");
	});
});

describe("mapLaneSnapshotStatusToWorkerStatus", () => {
	test("running → running", () => {
		expect(mapLaneSnapshotStatusToWorkerStatus("running")).toBe("running");
	});

	test("complete → exited", () => {
		expect(mapLaneSnapshotStatusToWorkerStatus("complete")).toBe("exited");
	});

	test("idle → wrapping_up", () => {
		expect(mapLaneSnapshotStatusToWorkerStatus("idle")).toBe("wrapping_up");
	});

	test("failed → crashed", () => {
		expect(mapLaneSnapshotStatusToWorkerStatus("failed")).toBe("crashed");
	});
});
