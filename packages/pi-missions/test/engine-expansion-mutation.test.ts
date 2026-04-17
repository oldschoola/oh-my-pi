/**
 * Unit tests for `applySegmentExpansionMutation` — after-current / end
 * placement, repeat-repo sequence disambiguation, anchor-successor rewiring,
 * priority-respecting topo sort, and rollback on cycle.
 */

import { describe, expect, test } from "bun:test";

import { applySegmentExpansionMutation } from "../src/missioncontrol/engine-expansion";
import {
	buildSegmentId,
	type SegmentExpansionRequest,
	type SegmentFrontierTaskState,
	type SegmentId,
	type SegmentLifecycleStatus,
	type TaskSegmentNode,
} from "../src/missioncontrol/types";

function node(taskId: string, repoId: string, order: number, sequence?: number): TaskSegmentNode {
	return {
		segmentId: buildSegmentId(taskId, repoId, sequence),
		taskId,
		repoId,
		order,
	};
}

function makeFrontier(
	orderedSegments: TaskSegmentNode[],
	dependsOn: Array<[string, string[]]>,
	statuses: Array<[string, SegmentLifecycleStatus]> = [],
): SegmentFrontierTaskState {
	const statusBySegmentId = new Map<string, SegmentLifecycleStatus>();
	for (const seg of orderedSegments) statusBySegmentId.set(seg.segmentId, "pending");
	for (const [id, st] of statuses) statusBySegmentId.set(id, st);
	return {
		taskId: orderedSegments[0]?.taskId ?? "TP-000",
		orderedSegments,
		nextSegmentIndex: 0,
		statusBySegmentId,
		dependsOnBySegmentId: new Map(dependsOn),
		terminalStatus: "pending",
	};
}

function makeRequest(overrides: Partial<SegmentExpansionRequest> = {}): SegmentExpansionRequest {
	return {
		requestId: "exp-1",
		taskId: "TP-001",
		fromSegmentId: buildSegmentId("TP-001", "alpha") as SegmentId,
		requestedRepoIds: ["beta"],
		rationale: "test",
		placement: "after-current",
		edges: [],
		timestamp: 0,
		...overrides,
	};
}

describe("applySegmentExpansionMutation", () => {
	test("after-current: inserts roots depending on anchor, rewires anchor successors through sinks", () => {
		const a = node("TP-001", "alpha", 0);
		const c = node("TP-001", "gamma", 1);
		const frontier = makeFrontier(
			[a, c],
			[
				[a.segmentId, []],
				[c.segmentId, [a.segmentId]],
			],
		);
		const request = makeRequest({
			requestedRepoIds: ["beta"],
			placement: "after-current",
		});
		const result = applySegmentExpansionMutation(frontier, request, a.segmentId);

		const newBeta = buildSegmentId("TP-001", "beta");
		expect(result.insertedSegmentIds).toEqual([newBeta]);
		expect(frontier.orderedSegments.map(s => s.segmentId)).toEqual([a.segmentId, newBeta, c.segmentId]);
		expect(frontier.dependsOnBySegmentId.get(newBeta)).toEqual([a.segmentId]);
		expect(frontier.dependsOnBySegmentId.get(c.segmentId)).toEqual([newBeta]);
		expect(frontier.statusBySegmentId.get(newBeta)).toBe("pending");
	});

	test("end: inserts roots after all pre-existing terminals", () => {
		const a = node("TP-001", "alpha", 0);
		const b = node("TP-001", "beta", 1);
		const frontier = makeFrontier(
			[a, b],
			[
				[a.segmentId, []],
				[b.segmentId, []],
			],
		);
		const request = makeRequest({
			requestedRepoIds: ["gamma"],
			placement: "end",
		});
		const result = applySegmentExpansionMutation(frontier, request, a.segmentId);

		const newGamma = buildSegmentId("TP-001", "gamma");
		expect(result.insertedSegmentIds).toEqual([newGamma]);
		expect(frontier.orderedSegments[frontier.orderedSegments.length - 1]?.segmentId).toBe(newGamma);
		expect(frontier.dependsOnBySegmentId.get(newGamma)?.sort()).toEqual([a.segmentId, b.segmentId].sort());
	});

	test("repeat-repo: appends ::2 suffix when task already has a segment for that repo", () => {
		const a = node("TP-001", "alpha", 0);
		const frontier = makeFrontier([a], [[a.segmentId, []]]);
		const request = makeRequest({ requestedRepoIds: ["alpha"], placement: "end" });
		const result = applySegmentExpansionMutation(frontier, request, a.segmentId);

		const expected = buildSegmentId("TP-001", "alpha", 2);
		expect(result.insertedSegmentIds).toEqual([expected]);
		expect(frontier.orderedSegments.map(s => s.segmentId)).toEqual([a.segmentId, expected]);
	});

	test("repeat-repo: sequences continue past existing ::3 suffix", () => {
		const a = node("TP-001", "alpha", 0);
		const a3 = node("TP-001", "alpha", 1, 3);
		const frontier = makeFrontier(
			[a, a3],
			[
				[a.segmentId, []],
				[a3.segmentId, [a.segmentId]],
			],
		);
		const request = makeRequest({ requestedRepoIds: ["alpha"], placement: "end" });
		const result = applySegmentExpansionMutation(frontier, request, a3.segmentId);

		const expected = buildSegmentId("TP-001", "alpha", 4);
		expect(result.insertedSegmentIds).toEqual([expected]);
	});

	test("internal edges: beta depends on gamma gets rewired when both inserted", () => {
		const a = node("TP-001", "alpha", 0);
		const frontier = makeFrontier([a], [[a.segmentId, []]]);
		const request = makeRequest({
			requestedRepoIds: ["beta", "gamma"],
			placement: "after-current",
			edges: [{ from: "gamma", to: "beta" }],
		});
		const result = applySegmentExpansionMutation(frontier, request, a.segmentId);

		const beta = buildSegmentId("TP-001", "beta");
		const gamma = buildSegmentId("TP-001", "gamma");
		expect(new Set(result.insertedSegmentIds)).toEqual(new Set([beta, gamma]));
		// Only root (gamma) pulls in anchor dep; beta is a sink and depends only on gamma internally.
		expect(frontier.dependsOnBySegmentId.get(beta)).toEqual([gamma]);
		expect(frontier.dependsOnBySegmentId.get(gamma)).toEqual([a.segmentId]);
		const betaIdx = frontier.orderedSegments.findIndex(s => s.segmentId === beta);
		const gammaIdx = frontier.orderedSegments.findIndex(s => s.segmentId === gamma);
		expect(gammaIdx).toBeLessThan(betaIdx);
	});

	test("cycle rollback: topo-sort failure restores original state and returns empty insertedSegmentIds", () => {
		const a = node("TP-001", "alpha", 0);
		const b = node("TP-001", "beta", 1);
		const dependsOn: Array<[string, string[]]> = [
			[a.segmentId, [b.segmentId]],
			[b.segmentId, [a.segmentId]],
		];
		const frontier = makeFrontier([a, b], dependsOn);
		const request = makeRequest({
			requestedRepoIds: ["gamma"],
			placement: "after-current",
		});
		const result = applySegmentExpansionMutation(frontier, request, a.segmentId);

		const gamma = buildSegmentId("TP-001", "gamma");
		expect(result.insertedSegmentIds).toEqual([]);
		expect(frontier.orderedSegments.map(s => s.segmentId)).toEqual([a.segmentId, b.segmentId]);
		expect(frontier.statusBySegmentId.has(gamma)).toBe(false);
	});

	test("recomputes nextSegmentIndex after insertion", () => {
		const a = node("TP-001", "alpha", 0);
		const frontier = makeFrontier([a], [[a.segmentId, []]], [[a.segmentId, "succeeded"]]);
		frontier.nextSegmentIndex = 1;
		const request = makeRequest({ requestedRepoIds: ["beta"], placement: "end" });
		applySegmentExpansionMutation(frontier, request, a.segmentId);

		const beta = buildSegmentId("TP-001", "beta");
		const betaIdx = frontier.orderedSegments.findIndex(s => s.segmentId === beta);
		expect(frontier.nextSegmentIndex).toBe(betaIdx);
	});

	test("insertedSegmentIds preserves requestedRepoIds order", () => {
		const a = node("TP-001", "alpha", 0);
		const frontier = makeFrontier([a], [[a.segmentId, []]]);
		const request = makeRequest({
			requestedRepoIds: ["zeta", "beta", "gamma"],
			placement: "after-current",
		});
		const result = applySegmentExpansionMutation(frontier, request, a.segmentId);

		expect(result.insertedSegmentIds).toEqual([
			buildSegmentId("TP-001", "zeta"),
			buildSegmentId("TP-001", "beta"),
			buildSegmentId("TP-001", "gamma"),
		]);
	});

	test("priority-respecting topo sort: new segments appended in request order on tie", () => {
		const a = node("TP-001", "alpha", 0);
		const frontier = makeFrontier([a], [[a.segmentId, []]]);
		const request = makeRequest({
			requestedRepoIds: ["beta", "gamma"],
			placement: "after-current",
			edges: [],
		});
		applySegmentExpansionMutation(frontier, request, a.segmentId);

		const ids = frontier.orderedSegments.map(s => s.segmentId);
		expect(ids[0]).toBe(a.segmentId);
		expect(ids[1]).toBe(buildSegmentId("TP-001", "beta"));
		expect(ids[2]).toBe(buildSegmentId("TP-001", "gamma"));
	});
});
