/**
 * Unit tests for `linearizeTaskSegmentPlan` + `resolveDisplayWaveNumber`.
 */

import { describe, expect, test } from "bun:test";

import { linearizeTaskSegmentPlan, resolveDisplayWaveNumber } from "../src/missioncontrol/engine-segment-waves";
import {
	buildSegmentId,
	type SegmentId,
	type TaskSegmentEdge,
	type TaskSegmentNode,
	type TaskSegmentPlan,
} from "../src/missioncontrol/types";

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

describe("linearizeTaskSegmentPlan", () => {
	test("returns empty when plan has no segments", () => {
		expect(linearizeTaskSegmentPlan(makePlan([], []))).toEqual([]);
	});

	test("single-segment plan returns that segment", () => {
		const a = node("TP-001", "alpha", 0);
		expect(linearizeTaskSegmentPlan(makePlan([a], []))).toEqual([a]);
	});

	test("linear chain respects order + edges", () => {
		const a = node("TP-001", "alpha", 0);
		const b = node("TP-001", "beta", 1);
		const c = node("TP-001", "gamma", 2);
		const plan = makePlan([c, a, b], [edge(a.segmentId, b.segmentId), edge(b.segmentId, c.segmentId)]);
		expect(linearizeTaskSegmentPlan(plan).map(n => n.segmentId)).toEqual([a.segmentId, b.segmentId, c.segmentId]);
	});

	test("diamond DAG: alpha → {beta, gamma} → delta", () => {
		const a = node("TP-001", "alpha", 0);
		const b = node("TP-001", "beta", 1);
		const c = node("TP-001", "gamma", 2);
		const d = node("TP-001", "delta", 3);
		const plan = makePlan(
			[a, b, c, d],
			[
				edge(a.segmentId, b.segmentId),
				edge(a.segmentId, c.segmentId),
				edge(b.segmentId, d.segmentId),
				edge(c.segmentId, d.segmentId),
			],
		);
		const result = linearizeTaskSegmentPlan(plan).map(n => n.segmentId);
		expect(result[0]).toBe(a.segmentId);
		expect(result[3]).toBe(d.segmentId);
		expect(new Set(result.slice(1, 3))).toEqual(new Set([b.segmentId, c.segmentId]));
	});

	test("ignores edges that reference unknown segments", () => {
		const a = node("TP-001", "alpha", 0);
		const b = node("TP-001", "beta", 1);
		const ghost = buildSegmentId("TP-001", "ghost");
		const plan = makePlan([a, b], [edge(ghost, b.segmentId)]);
		expect(linearizeTaskSegmentPlan(plan).length).toBe(2);
	});

	test("cycle falls back to sort by order + segmentId", () => {
		const a = node("TP-001", "alpha", 1);
		const b = node("TP-001", "beta", 0);
		const plan = makePlan([a, b], [edge(a.segmentId, b.segmentId), edge(b.segmentId, a.segmentId)]);
		expect(linearizeTaskSegmentPlan(plan).map(n => n.segmentId)).toEqual([b.segmentId, a.segmentId]);
	});

	test("ties on order break by segmentId lex", () => {
		const a = node("TP-001", "alpha", 5);
		const b = node("TP-001", "beta", 5);
		const c = node("TP-001", "gamma", 5);
		const plan = makePlan([c, b, a], []);
		expect(linearizeTaskSegmentPlan(plan).map(n => n.segmentId)).toEqual([a.segmentId, b.segmentId, c.segmentId]);
	});
});

describe("resolveDisplayWaveNumber", () => {
	test("maps via roundToTaskWave when present (0-based → 1-based display)", () => {
		expect(resolveDisplayWaveNumber(2, [0, 0, 1, 1], 2)).toEqual({ displayWave: 2, displayTotal: 2 });
	});

	test("falls back to roundIdx+1 when roundToTaskWave is undefined", () => {
		expect(resolveDisplayWaveNumber(3, undefined, 5)).toEqual({ displayWave: 4, displayTotal: 5 });
	});

	test("falls back to roundIdx+1 when mapping is out of bounds", () => {
		expect(resolveDisplayWaveNumber(7, [0, 0], 3)).toEqual({ displayWave: 8, displayTotal: 3 });
	});

	test("uses fallbackTotal when taskLevelWaveCount is undefined", () => {
		expect(resolveDisplayWaveNumber(1, [0, 1], undefined, 9)).toEqual({ displayWave: 2, displayTotal: 9 });
	});

	test("final fallback: displayTotal = roundIdx+1", () => {
		expect(resolveDisplayWaveNumber(4, undefined, undefined)).toEqual({ displayWave: 5, displayTotal: 5 });
	});
});
