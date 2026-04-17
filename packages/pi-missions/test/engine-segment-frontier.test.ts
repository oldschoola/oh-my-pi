/**
 * Unit tests for `buildSegmentFrontierWaves` — plan → segment rounds
 * expansion, per-task frontier state construction, packet path resolution,
 * and task-dropout when segment counts differ within a wave.
 */

import { describe, expect, test } from "bun:test";

import type { ParsedTask } from "../src/missioncontrol/discovery";
import { buildSegmentFrontierWaves } from "../src/missioncontrol/engine-segment-waves";
import {
	buildSegmentId,
	type SegmentId,
	type TaskSegmentEdge,
	type TaskSegmentNode,
	type TaskSegmentPlan,
	type TaskSegmentPlanMap,
} from "../src/missioncontrol/types";

function makeTask(taskId: string, overrides: Partial<ParsedTask> = {}): ParsedTask {
	return {
		taskId,
		taskName: taskId,
		folderPath: "/tmp",
		promptPath: "/tmp/PROMPT.md",
		prompt: "",
		dependencies: [],
		size: "M",
		...overrides,
	} as unknown as ParsedTask;
}

function node(taskId: string, repoId: string, order: number): TaskSegmentNode {
	return {
		segmentId: buildSegmentId(taskId, repoId),
		taskId,
		repoId,
		order,
	};
}

function edge(fromSegmentId: SegmentId, toSegmentId: SegmentId): TaskSegmentEdge {
	return { fromSegmentId, toSegmentId, provenance: "explicit" };
}

function makePlan(segments: TaskSegmentNode[], edges: TaskSegmentEdge[]): TaskSegmentPlan {
	return {
		taskId: segments[0]?.taskId ?? "TP-000",
		segments,
		edges,
		mode: "explicit-dag",
	};
}

describe("buildSegmentFrontierWaves", () => {
	test("without segmentPlans uses fallback plan (single-segment per task)", () => {
		const pending = new Map<string, ParsedTask>([
			["TP-001", makeTask("TP-001", { resolvedRepoId: "alpha" })],
			["TP-002", makeTask("TP-002", { resolvedRepoId: "beta" })],
		]);
		const result = buildSegmentFrontierWaves([["TP-001", "TP-002"]], pending);

		expect(result.waves).toEqual([["TP-001", "TP-002"]]);
		expect(result.taskLevelWaveCount).toBe(1);
		expect(result.roundToTaskWave).toEqual([0]);
		expect(result.taskStateById.get("TP-001")?.orderedSegments.length).toBe(1);
		expect(result.taskStateById.get("TP-001")?.orderedSegments[0]?.repoId).toBe("alpha");
	});

	test("resolvedRepoId empty/missing falls back to 'default' repoId", () => {
		const pending = new Map<string, ParsedTask>([["TP-001", makeTask("TP-001")]]);
		const result = buildSegmentFrontierWaves([["TP-001"]], pending);
		expect(result.taskStateById.get("TP-001")?.orderedSegments[0]?.repoId).toBe("default");
	});

	test("explicit segmentPlans drive linearization + dependsOn map", () => {
		const a = node("TP-001", "alpha", 0);
		const b = node("TP-001", "beta", 1);
		const c = node("TP-001", "gamma", 2);
		const plans: TaskSegmentPlanMap = new Map([
			["TP-001", makePlan([a, b, c], [edge(a.segmentId, b.segmentId), edge(b.segmentId, c.segmentId)])],
		]);
		const pending = new Map<string, ParsedTask>([["TP-001", makeTask("TP-001")]]);
		const result = buildSegmentFrontierWaves([["TP-001"]], pending, plans);

		const state = result.taskStateById.get("TP-001");
		expect(state?.orderedSegments.map(s => s.segmentId)).toEqual([a.segmentId, b.segmentId, c.segmentId]);
		expect(state?.dependsOnBySegmentId.get(b.segmentId)).toEqual([a.segmentId]);
		expect(state?.dependsOnBySegmentId.get(c.segmentId)).toEqual([b.segmentId]);
		expect(result.waves).toEqual([["TP-001"], ["TP-001"], ["TP-001"]]);
		expect(result.roundToTaskWave).toEqual([0, 0, 0]);
	});

	test("max-segments-in-wave drop-off: 3-segment task + 1-segment task → 3 rounds, second only in first", () => {
		const a = node("TP-001", "alpha", 0);
		const b = node("TP-001", "beta", 1);
		const c = node("TP-001", "gamma", 2);
		const d = node("TP-002", "delta", 0);
		const plans: TaskSegmentPlanMap = new Map([
			["TP-001", makePlan([a, b, c], [edge(a.segmentId, b.segmentId), edge(b.segmentId, c.segmentId)])],
			["TP-002", makePlan([d], [])],
		]);
		const pending = new Map<string, ParsedTask>([
			["TP-001", makeTask("TP-001")],
			["TP-002", makeTask("TP-002")],
		]);
		const result = buildSegmentFrontierWaves([["TP-001", "TP-002"]], pending, plans);
		expect(result.waves).toEqual([["TP-001", "TP-002"], ["TP-001"], ["TP-001"]]);
		expect(result.roundToTaskWave).toEqual([0, 0, 0]);
	});

	test("multiple task-level waves: each expands independently and maps back", () => {
		const a1 = node("TP-001", "alpha", 0);
		const a2 = node("TP-001", "beta", 1);
		const b1 = node("TP-002", "gamma", 0);
		const plans: TaskSegmentPlanMap = new Map([
			["TP-001", makePlan([a1, a2], [edge(a1.segmentId, a2.segmentId)])],
			["TP-002", makePlan([b1], [])],
		]);
		const pending = new Map<string, ParsedTask>([
			["TP-001", makeTask("TP-001")],
			["TP-002", makeTask("TP-002")],
		]);
		const result = buildSegmentFrontierWaves([["TP-001"], ["TP-002"]], pending, plans);
		expect(result.waves).toEqual([["TP-001"], ["TP-001"], ["TP-002"]]);
		expect(result.roundToTaskWave).toEqual([0, 0, 1]);
		expect(result.taskLevelWaveCount).toBe(2);
	});

	test("mutates ParsedTask: sets segmentIds + clears activeSegmentId", () => {
		const a = node("TP-001", "alpha", 0);
		const b = node("TP-001", "beta", 1);
		const plans: TaskSegmentPlanMap = new Map([["TP-001", makePlan([a, b], [edge(a.segmentId, b.segmentId)])]]);
		const task = makeTask("TP-001", { activeSegmentId: "stale" });
		buildSegmentFrontierWaves([["TP-001"]], new Map([["TP-001", task]]), plans);
		expect(task.segmentIds).toEqual([a.segmentId, b.segmentId]);
		expect(task.activeSegmentId).toBeNull();
	});

	test("packetRepoId + workspaceRoot resolve absolute packetTaskPath", () => {
		const pending = new Map<string, ParsedTask>([
			["TP-001", makeTask("TP-001", { taskFolder: "sub/TP-001", resolvedRepoId: "alpha" })],
		]);
		buildSegmentFrontierWaves([["TP-001"]], pending, undefined, "host-repo", "/ws/root");
		const task = pending.get("TP-001");
		expect(task?.packetRepoId).toBe("host-repo");
		expect(task?.packetTaskPath).toMatch(/sub[\\/]TP-001$/);
		expect(task?.packetTaskPath?.startsWith("/ws/root") || task?.packetTaskPath?.includes("ws")).toBe(true);
	});

	test("packetRepoId without workspaceRoot falls back to relative taskFolder", () => {
		const pending = new Map<string, ParsedTask>([["TP-001", makeTask("TP-001", { taskFolder: "sub/TP-001" })]]);
		buildSegmentFrontierWaves([["TP-001"]], pending, undefined, "host-repo");
		expect(pending.get("TP-001")?.packetTaskPath).toBe("sub/TP-001");
	});

	test("empty pending + empty baseTaskWaves yields empty result", () => {
		const result = buildSegmentFrontierWaves([], new Map());
		expect(result.waves).toEqual([]);
		expect(result.roundToTaskWave).toEqual([]);
		expect(result.taskLevelWaveCount).toBe(0);
	});

	test("baseTaskWaves refers to taskId not in pending: round skipped", () => {
		const result = buildSegmentFrontierWaves([["unknown"]], new Map());
		expect(result.waves).toEqual([]);
		expect(result.roundToTaskWave).toEqual([]);
	});
});
