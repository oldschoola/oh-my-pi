/**
 * Unit tests for pure discovery helpers — path comparison + dep normalization.
 *
 * Covers:
 *  - normalizePathForCompare resolves absolute, lowercases, normalizes slashes
 *  - isPathWithin matches self + nested, rejects siblings + partial-prefix paths
 *  - dedupeAndNormalizeDeps deduplicates + normalizes + preserves order
 *  - SEGMENT_FALLBACK_REPO_PLACEHOLDER has stable value for persistence compat
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
	dedupeAndNormalizeDeps,
	isPathWithin,
	normalizePathForCompare,
	SEGMENT_FALLBACK_REPO_PLACEHOLDER,
} from "../src/missioncontrol";

describe("SEGMENT_FALLBACK_REPO_PLACEHOLDER", () => {
	test("has the stable sentinel value consumers serialize to disk", () => {
		expect(SEGMENT_FALLBACK_REPO_PLACEHOLDER).toBe("__primary__");
	});
});

describe("normalizePathForCompare", () => {
	test("lowercases the resolved path", () => {
		const input = resolve("./SrcFolder/FILE.txt");
		expect(normalizePathForCompare(input)).toBe(input.replace(/\\/g, "/").toLowerCase());
	});

	test("converts backslashes to forward slashes", () => {
		const out = normalizePathForCompare("./a\\b\\c");
		expect(out.includes("\\")).toBe(false);
		expect(out.endsWith("/a/b/c")).toBe(true);
	});

	test("two differently-cased inputs compare equal", () => {
		expect(normalizePathForCompare("./Foo/Bar")).toBe(normalizePathForCompare("./foo/BAR"));
	});
});

describe("isPathWithin", () => {
	test("matches identical path", () => {
		expect(isPathWithin("./a/b", "./a/b")).toBe(true);
	});

	test("matches nested child path", () => {
		expect(isPathWithin("./a/b/c/d.txt", "./a/b")).toBe(true);
	});

	test("rejects sibling path", () => {
		expect(isPathWithin("./a/c", "./a/b")).toBe(false);
	});

	test("rejects partial-prefix false match (`a/b` vs `a/bc`)", () => {
		expect(isPathWithin("./a/bc", "./a/b")).toBe(false);
	});

	test("case-insensitive comparison", () => {
		expect(isPathWithin("./A/B/file", "./a/b")).toBe(true);
	});
});

describe("dedupeAndNormalizeDeps", () => {
	test("empty array returns empty array", () => {
		expect(dedupeAndNormalizeDeps([])).toEqual([]);
	});

	test("normalizes bare taskId to upper case", () => {
		expect(dedupeAndNormalizeDeps(["to-001"])).toEqual(["TO-001"]);
	});

	test("normalizes qualified area/taskId preserving lowercase area", () => {
		expect(dedupeAndNormalizeDeps(["API/to-001"])).toEqual(["api/TO-001"]);
	});

	test("deduplicates case variants + prefix variants", () => {
		expect(dedupeAndNormalizeDeps(["to-001", "TO-001", "to-001"])).toEqual(["TO-001"]);
	});

	test("preserves first-seen order across unique tokens", () => {
		expect(dedupeAndNormalizeDeps(["to-003", "to-001", "to-002"])).toEqual(["TO-003", "TO-001", "TO-002"]);
	});

	test("qualified + bare refs with same taskId remain distinct", () => {
		// `api/TO-001` normalizes to `api/TO-001`, bare `TO-001` stays `TO-001`.
		expect(dedupeAndNormalizeDeps(["api/TO-001", "TO-001"])).toEqual(["api/TO-001", "TO-001"]);
	});
});
