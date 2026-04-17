import { describe, expect, test } from "bun:test";

import type { ParsedTask } from "../src/missioncontrol/discovery";
import { assignTasksToLanes } from "../src/missioncontrol/waves";

function mkTask(taskId: string, size = "M", fileScope?: string[]): ParsedTask {
	const t: ParsedTask = {
		taskId,
		taskName: taskId.toLowerCase(),
		folderPath: `/repo/tasks/${taskId}`,
		promptPath: `/repo/tasks/${taskId}/PROMPT.md`,
		prompt: "",
		dependencies: [],
		size,
	};
	if (fileScope) t.fileScope = fileScope;
	return t;
}

function mkPending(tasks: ParsedTask[]): Map<string, ParsedTask> {
	const map = new Map<string, ParsedTask>();
	for (const t of tasks) map.set(t.taskId, t);
	return map;
}

const WEIGHTS: Record<string, number> = { S: 1, M: 2, L: 4 };

describe("assignTasksToLanes", () => {
	test("empty wave returns empty assignment list", () => {
		expect(assignTasksToLanes([], new Map(), 4, "round-robin", WEIGHTS)).toEqual([]);
	});

	test("single task with maxLanes=4 lands in lane 1", () => {
		const pending = mkPending([mkTask("T-1")]);
		const out = assignTasksToLanes(["T-1"], pending, 4, "round-robin", WEIGHTS);
		expect(out).toHaveLength(1);
		expect(out[0]?.taskId).toBe("T-1");
		expect(out[0]?.lane).toBe(1);
	});

	test("round-robin spreads single-task groups across lanes modulo laneCount", () => {
		const pending = mkPending([mkTask("T-1"), mkTask("T-2"), mkTask("T-3")]);
		const out = assignTasksToLanes(["T-1", "T-2", "T-3"], pending, 2, "round-robin", WEIGHTS);
		const byId = new Map(out.map(a => [a.taskId, a.lane]));
		// Affinity groups are sorted by first task id: [T-1], [T-2], [T-3].
		// Round-robin: T-1→lane1, T-2→lane2, T-3→lane1.
		expect(byId.get("T-1")).toBe(1);
		expect(byId.get("T-2")).toBe(2);
		expect(byId.get("T-3")).toBe(1);
	});

	test("lane count is capped by min(groups, maxLanes)", () => {
		const pending = mkPending([mkTask("T-1"), mkTask("T-2")]);
		const out = assignTasksToLanes(["T-1", "T-2"], pending, 10, "round-robin", WEIGHTS);
		const usedLanes = new Set(out.map(a => a.lane));
		expect(usedLanes.size).toBe(2);
		expect(Math.max(...usedLanes)).toBe(2);
	});

	test("load-balanced places heaviest group on lightest lane", () => {
		const pending = mkPending([mkTask("T-1", "L"), mkTask("T-2", "L"), mkTask("T-3", "S"), mkTask("T-4", "S")]);
		const out = assignTasksToLanes(["T-1", "T-2", "T-3", "T-4"], pending, 2, "load-balanced", WEIGHTS);
		// Sorted heaviest-first (with alphabetical tie-break): T-1(4) T-2(4) T-3(1) T-4(1).
		// T-1 → lane1 (weight 4), T-2 → lane2 (weight 4), T-3 → lane1 (weight 5), T-4 → lane2 (weight 5).
		const byId = new Map(out.map(a => [a.taskId, a.lane]));
		expect(byId.get("T-1")).toBe(1);
		expect(byId.get("T-2")).toBe(2);
		expect(byId.get("T-3")).toBe(1);
		expect(byId.get("T-4")).toBe(2);
	});

	test("affinity-first keeps overlapping-scope tasks on one lane", () => {
		const pending = mkPending([
			mkTask("T-1", "M", ["src/api/**"]),
			mkTask("T-2", "M", ["src/api/**"]),
			mkTask("T-3", "M", ["src/ui/**"]),
		]);
		const out = assignTasksToLanes(["T-1", "T-2", "T-3"], pending, 3, "affinity-first", WEIGHTS);
		const byId = new Map(out.map(a => [a.taskId, a.lane]));
		// Multi-group {T-1,T-2} goes first (heaviest=4) to lane1. Single {T-3} fills lane2.
		expect(byId.get("T-1")).toBe(byId.get("T-2"));
		expect(byId.get("T-3")).not.toBe(byId.get("T-1"));
	});

	test("affinity-first — multi-task group takes lane 1 before singletons", () => {
		const pending = mkPending([
			mkTask("Z-1", "M", ["src/api/**"]),
			mkTask("Z-2", "M", ["src/api/**"]),
			mkTask("A-1", "M"),
			mkTask("A-2", "M"),
		]);
		const out = assignTasksToLanes(["Z-1", "Z-2", "A-1", "A-2"], pending, 3, "affinity-first", WEIGHTS);
		const byId = new Map(out.map(a => [a.taskId, a.lane]));
		// Even though A-1/A-2 sort first alphabetically, the Z-1/Z-2 multi-group
		// is processed before singletons, so it lands on lane 1.
		expect(byId.get("Z-1")).toBe(1);
		expect(byId.get("Z-2")).toBe(1);
	});

	test("lane numbers are 1-indexed, not 0-indexed", () => {
		const pending = mkPending([mkTask("T-1"), mkTask("T-2")]);
		const out = assignTasksToLanes(["T-1", "T-2"], pending, 2, "round-robin", WEIGHTS);
		const lanes = out.map(a => a.lane);
		expect(Math.min(...lanes)).toBe(1);
		expect(lanes).not.toContain(0);
	});

	test("unknown size falls back to sizeWeights.M", () => {
		const pending = mkPending([mkTask("T-1", "XXL"), mkTask("T-2", "L")]);
		const out = assignTasksToLanes(["T-1", "T-2"], pending, 2, "load-balanced", WEIGHTS);
		// T-1 weight = M=2, T-2 weight = L=4. Heaviest first: T-2 → lane1, T-1 → lane2.
		const byId = new Map(out.map(a => [a.taskId, a.lane]));
		expect(byId.get("T-2")).toBe(1);
		expect(byId.get("T-1")).toBe(2);
	});

	test("sizeWeights missing M defaults weight to 2", () => {
		const pending = mkPending([mkTask("T-1", "XXX"), mkTask("T-2", "XXX")]);
		const out = assignTasksToLanes(["T-1", "T-2"], pending, 2, "load-balanced", {});
		// Both tasks fall back to 2. Tie-broken alphabetically.
		const byId = new Map(out.map(a => [a.taskId, a.lane]));
		expect(byId.get("T-1")).toBe(1);
		expect(byId.get("T-2")).toBe(2);
	});

	test("tasks missing from pending are skipped (not assigned)", () => {
		const pending = mkPending([mkTask("T-1")]);
		// T-2 is listed in the wave but missing from pending; applyFileScopeAffinity
		// still creates a singleton group for it, but assignGroupToLane drops unknowns.
		const out = assignTasksToLanes(["T-1", "T-2"], pending, 2, "round-robin", WEIGHTS);
		const ids = out.map(a => a.taskId);
		expect(ids).toContain("T-1");
		expect(ids).not.toContain("T-2");
	});

	test("load-balanced tie-break is alphabetical on first task id", () => {
		const pending = mkPending([mkTask("B-1"), mkTask("A-1")]);
		const out = assignTasksToLanes(["A-1", "B-1"], pending, 2, "load-balanced", WEIGHTS);
		const byId = new Map(out.map(a => [a.taskId, a.lane]));
		// Equal weights → alphabetical: A-1 → lane1, B-1 → lane2.
		expect(byId.get("A-1")).toBe(1);
		expect(byId.get("B-1")).toBe(2);
	});

	test("result order is lane1 tasks first, then lane2, then lane3…", () => {
		const pending = mkPending([mkTask("T-1"), mkTask("T-2"), mkTask("T-3"), mkTask("T-4")]);
		const out = assignTasksToLanes(["T-1", "T-2", "T-3", "T-4"], pending, 2, "round-robin", WEIGHTS);
		// Lane order monotonically non-decreasing in output.
		for (let i = 1; i < out.length; i++) {
			const prev = out[i - 1]?.lane ?? 0;
			const cur = out[i]?.lane ?? 0;
			expect(cur).toBeGreaterThanOrEqual(prev);
		}
	});

	test("all three strategies return assignments covering every known task", () => {
		const pending = mkPending([mkTask("T-1"), mkTask("T-2"), mkTask("T-3")]);
		for (const strategy of ["round-robin", "load-balanced", "affinity-first"]) {
			const out = assignTasksToLanes(["T-1", "T-2", "T-3"], pending, 3, strategy, WEIGHTS);
			expect(new Set(out.map(a => a.taskId))).toEqual(new Set(["T-1", "T-2", "T-3"]));
		}
	});
});
