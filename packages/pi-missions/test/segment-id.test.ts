import { describe, expect, test } from "bun:test";

import { buildExpansionRequestId, buildSegmentId, parseSegmentIdRepo } from "../src/missioncontrol/types";

describe("buildSegmentId", () => {
	test("no sequence → taskId::repoId", () => {
		expect(buildSegmentId("T-1", "api")).toBe("T-1::api");
	});

	test("sequence 1 omitted (only 2+ included)", () => {
		expect(buildSegmentId("T-1", "api", 1)).toBe("T-1::api");
	});

	test("sequence 2 → taskId::repoId::2", () => {
		expect(buildSegmentId("T-1", "api", 2)).toBe("T-1::api::2");
	});

	test("fractional sequence is floored", () => {
		expect(buildSegmentId("T-1", "api", 2.9)).toBe("T-1::api::2");
	});

	test("non-finite sequence ignored", () => {
		expect(buildSegmentId("T-1", "api", Number.NaN)).toBe("T-1::api");
		expect(buildSegmentId("T-1", "api", Number.POSITIVE_INFINITY)).toBe("T-1::api");
	});
});

describe("parseSegmentIdRepo", () => {
	test("returns repoId field verbatim", () => {
		expect(parseSegmentIdRepo({ repoId: "web" })).toBe("web");
	});

	test("empty repoId returns empty string", () => {
		expect(parseSegmentIdRepo({ repoId: "" })).toBe("");
	});
});

describe("buildExpansionRequestId", () => {
	test("matches format exp-{ts}-{5 alnum}", () => {
		const id = buildExpansionRequestId(1_700_000_000_000);
		expect(id).toMatch(/^exp-1700000000000-[a-z0-9]{5}$/);
	});

	test("floors non-integer timestamp", () => {
		const id = buildExpansionRequestId(1_700_000_000_000.9);
		expect(id).toMatch(/^exp-1700000000000-[a-z0-9]{5}$/);
	});

	test("non-finite timestamp falls back to Date.now (non-zero)", () => {
		const id = buildExpansionRequestId(Number.NaN);
		const match = id.match(/^exp-(\d+)-[a-z0-9]{5}$/);
		expect(match).not.toBeNull();
		expect(Number(match?.[1])).toBeGreaterThan(0);
	});

	test("default timestamp uses Date.now", () => {
		const before = Date.now();
		const id = buildExpansionRequestId();
		const after = Date.now();
		const match = id.match(/^exp-(\d+)-[a-z0-9]{5}$/);
		expect(match).not.toBeNull();
		const ts = Number(match?.[1]);
		expect(ts).toBeGreaterThanOrEqual(before);
		expect(ts).toBeLessThanOrEqual(after);
	});
});
