import { describe, expect, test } from "bun:test";

import type { ParsedTask } from "../src/missioncontrol/discovery";
import { DEFAULT_ORCHESTRATOR_CONFIG, type OrchestratorConfig } from "../src/missioncontrol/types";
import { computeWaveAssignments } from "../src/missioncontrol/waves";

function mkTask(taskId: string, dependencies: string[] = [], size = "M"): ParsedTask {
	return {
		taskId,
		taskName: taskId.toLowerCase(),
		folderPath: `/repo/tasks/${taskId}`,
		promptPath: `/repo/tasks/${taskId}/PROMPT.md`,
		prompt: "",
		dependencies,
		size,
	};
}

function mkPending(tasks: ParsedTask[]): Map<string, ParsedTask> {
	const map = new Map<string, ParsedTask>();
	for (const t of tasks) map.set(t.taskId, t);
	return map;
}

function mkConfig(overrides: Partial<OrchestratorConfig["orchestrator"]> = {}): OrchestratorConfig {
	return {
		...DEFAULT_ORCHESTRATOR_CONFIG,
		orchestrator: { ...DEFAULT_ORCHESTRATOR_CONFIG.orchestrator, ...overrides },
	};
}

describe("computeWaveAssignments", () => {
	test("empty pending yields no waves", () => {
		const result = computeWaveAssignments(new Map(), new Set(), mkConfig());
		expect(result.waves).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("independent tasks land in a single wave", () => {
		const pending = mkPending([mkTask("T-1"), mkTask("T-2"), mkTask("T-3")]);
		const result = computeWaveAssignments(pending, new Set(), mkConfig({ max_lanes: 3 }));
		expect(result.waves).toHaveLength(1);
		const wave = result.waves[0];
		expect(wave?.waveNumber).toBe(1);
		expect(wave?.tasks.map(t => t.taskId).sort()).toEqual(["T-1", "T-2", "T-3"]);
	});

	test("dependency chain produces sequential waves", () => {
		const pending = mkPending([mkTask("T-1"), mkTask("T-2", ["T-1"]), mkTask("T-3", ["T-2"])]);
		const result = computeWaveAssignments(pending, new Set(), mkConfig({ max_lanes: 3 }));
		expect(result.waves).toHaveLength(3);
		expect(result.waves[0]?.tasks.map(t => t.taskId)).toEqual(["T-1"]);
		expect(result.waves[1]?.tasks.map(t => t.taskId)).toEqual(["T-2"]);
		expect(result.waves[2]?.tasks.map(t => t.taskId)).toEqual(["T-3"]);
	});

	test("completed tasks pre-satisfy dependencies", () => {
		const pending = mkPending([mkTask("T-2", ["T-1"])]);
		const result = computeWaveAssignments(pending, new Set(["T-1"]), mkConfig());
		expect(result.waves).toHaveLength(1);
		expect(result.waves[0]?.tasks[0]?.taskId).toBe("T-2");
	});

	test("cycle is reported in errors with empty waves", () => {
		const pending = mkPending([mkTask("T-1", ["T-2"]), mkTask("T-2", ["T-1"])]);
		const result = computeWaveAssignments(pending, new Set(), mkConfig());
		expect(result.waves).toEqual([]);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]?.message).toContain("Circular");
	});

	test("missing dependency target is reported with empty waves", () => {
		const pending = mkPending([mkTask("T-1", ["T-999"])]);
		const result = computeWaveAssignments(pending, new Set(), mkConfig());
		expect(result.waves).toEqual([]);
		expect(result.errors.some(e => e.message.includes("T-999"))).toBe(true);
	});

	test("wave lane numbers are 1-indexed", () => {
		const pending = mkPending([mkTask("T-1"), mkTask("T-2")]);
		const result = computeWaveAssignments(pending, new Set(), mkConfig({ max_lanes: 2 }));
		const lanes = result.waves[0]?.tasks.map(t => t.lane) ?? [];
		expect(Math.min(...lanes)).toBe(1);
	});

	test("diamond dependency A→B,A→C,B→D,C→D produces 3 waves", () => {
		const pending = mkPending([mkTask("A"), mkTask("B", ["A"]), mkTask("C", ["A"]), mkTask("D", ["B", "C"])]);
		const result = computeWaveAssignments(pending, new Set(), mkConfig({ max_lanes: 3 }));
		expect(result.waves).toHaveLength(3);
		expect(result.waves[0]?.tasks.map(t => t.taskId)).toEqual(["A"]);
		expect(result.waves[1]?.tasks.map(t => t.taskId).sort()).toEqual(["B", "C"]);
		expect(result.waves[2]?.tasks.map(t => t.taskId)).toEqual(["D"]);
	});

	test("segmentPlans map is populated even when no explicit DAG is present", () => {
		const pending = mkPending([mkTask("T-1"), mkTask("T-2")]);
		const result = computeWaveAssignments(pending, new Set(), mkConfig());
		expect(result.segmentPlans).toBeDefined();
		expect(result.segmentPlans?.size).toBe(2);
		expect(result.segmentPlans?.get("T-1")?.mode).toBe("repo-singleton");
	});

	test("workspaceRepoIds option is threaded into segment planning", () => {
		const task = mkTask("T-1");
		task.fileScope = ["api/src/**"];
		const pending = mkPending([task]);
		const result = computeWaveAssignments(pending, new Set(), mkConfig(), { workspaceRepoIds: ["api", "ui"] });
		const plan = result.segmentPlans?.get("T-1");
		expect(plan?.mode).toBe("inferred-sequential");
		expect(plan?.segments[0]?.repoId).toBe("api");
	});

	test("result is deterministic across runs with the same input", () => {
		const pending = mkPending([mkTask("C"), mkTask("A"), mkTask("B")]);
		const r1 = computeWaveAssignments(pending, new Set(), mkConfig({ max_lanes: 3 }));
		const r2 = computeWaveAssignments(pending, new Set(), mkConfig({ max_lanes: 3 }));
		expect(r1.waves[0]?.tasks.map(t => t.taskId)).toEqual(r2.waves[0]?.tasks.map(t => t.taskId));
	});

	test("waves respect max_lanes cap", () => {
		const pending = mkPending([mkTask("T-1"), mkTask("T-2"), mkTask("T-3"), mkTask("T-4")]);
		const result = computeWaveAssignments(pending, new Set(), mkConfig({ max_lanes: 2 }));
		// All 4 tasks are independent → wave 1 has all 4, but across 2 lanes.
		const lanes = new Set(result.waves[0]?.tasks.map(t => t.lane));
		expect(lanes.size).toBe(2);
	});
});
