/**
 * Unit tests for `missioncontrol/engine-expansion.ts` —
 * `expansionRequestHasCycle` cycle-detection on SegmentExpansionRequest.edges.
 */

import { describe, expect, test } from "bun:test";

import { expansionRequestHasCycle } from "../src/missioncontrol/engine-expansion";
import type { SegmentExpansionEdge, SegmentExpansionRequest, SegmentId } from "../src/missioncontrol/types";

function makeRequest(repoIds: string[], edges: SegmentExpansionEdge[]): SegmentExpansionRequest {
	return {
		requestId: "exp-test",
		taskId: "TP-001",
		fromSegmentId: "TP-001::api" as SegmentId,
		requestedRepoIds: repoIds,
		rationale: "test",
		placement: "after-current",
		edges,
		timestamp: 1_700_000_000_000,
	};
}

describe("expansionRequestHasCycle", () => {
	test("empty request (no repos, no edges) has no cycle", () => {
		expect(expansionRequestHasCycle(makeRequest([], []))).toBe(false);
	});

	test("single repo with no edges has no cycle", () => {
		expect(expansionRequestHasCycle(makeRequest(["api"], []))).toBe(false);
	});

	test("linear DAG (api → web → mobile) has no cycle", () => {
		const request = makeRequest(
			["api", "web", "mobile"],
			[
				{ from: "api", to: "web" },
				{ from: "web", to: "mobile" },
			],
		);
		expect(expansionRequestHasCycle(request)).toBe(false);
	});

	test("diamond DAG (api → web, api → mobile, web → shared, mobile → shared) has no cycle", () => {
		const request = makeRequest(
			["api", "web", "mobile", "shared"],
			[
				{ from: "api", to: "web" },
				{ from: "api", to: "mobile" },
				{ from: "web", to: "shared" },
				{ from: "mobile", to: "shared" },
			],
		);
		expect(expansionRequestHasCycle(request)).toBe(false);
	});

	test("two-node cycle (api → web → api) is detected", () => {
		const request = makeRequest(
			["api", "web"],
			[
				{ from: "api", to: "web" },
				{ from: "web", to: "api" },
			],
		);
		expect(expansionRequestHasCycle(request)).toBe(true);
	});

	test("three-node cycle (a → b → c → a) is detected", () => {
		const request = makeRequest(
			["a", "b", "c"],
			[
				{ from: "a", to: "b" },
				{ from: "b", to: "c" },
				{ from: "c", to: "a" },
			],
		);
		expect(expansionRequestHasCycle(request)).toBe(true);
	});

	test("self-loop (a → a) is detected", () => {
		const request = makeRequest(["a"], [{ from: "a", to: "a" }]);
		expect(expansionRequestHasCycle(request)).toBe(true);
	});

	test("cycle embedded in otherwise-acyclic graph is detected", () => {
		const request = makeRequest(
			["api", "web", "mobile"],
			[
				{ from: "api", to: "web" },
				{ from: "web", to: "mobile" },
				{ from: "mobile", to: "web" },
			],
		);
		expect(expansionRequestHasCycle(request)).toBe(true);
	});

	test("edges referencing repos outside requestedRepoIds are ignored", () => {
		const request = makeRequest(
			["api", "web"],
			[
				{ from: "api", to: "web" },
				{ from: "external", to: "api" }, // ignored — external not in requestedRepoIds
				{ from: "web", to: "external" }, // ignored
			],
		);
		expect(expansionRequestHasCycle(request)).toBe(false);
	});

	test("duplicate repo IDs in requestedRepoIds do not affect result", () => {
		const request = makeRequest(["api", "api", "web"], [{ from: "api", to: "web" }]);
		expect(expansionRequestHasCycle(request)).toBe(false);
	});
});
