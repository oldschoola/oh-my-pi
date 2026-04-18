/**
 * Unit tests for `parseSegmentDagMetadata` — `## Segment DAG` section parser.
 *
 * Covers:
 *  - absent section → { metadata: null, error: null }
 *  - empty Repos/Edges body → metadata: null (no entries to report)
 *  - entries before subsection header → SEGMENT_DAG_INVALID
 *  - malformed bullet / non-bullet text → SEGMENT_DAG_INVALID
 *  - repo-list token that includes `->` → SEGMENT_DAG_INVALID
 *  - invalid repoId (uppercase / leading hyphen / underscore) → SEGMENT_DAG_INVALID
 *  - malformed edge ("a" with no `->`) → SEGMENT_DAG_INVALID
 *  - self-edge (a -> a) → SEGMENT_DAG_INVALID
 *  - edge endpoint not declared in Repos → SEGMENT_REPO_UNKNOWN
 *  - cycle in DAG → SEGMENT_DAG_INVALID with cycle path
 *  - valid repos + edges → deterministic metadata with sorted edges
 *  - edges deduplicated
 *  - markdown decoration on subsection headers + tokens accepted
 */

import { describe, expect, test } from "bun:test";

import { parseSegmentDagMetadata } from "../src/missioncontrol";

function body(...lines: string[]): string {
	return ["## Segment DAG", ...lines, ""].join("\n");
}

describe("parseSegmentDagMetadata — absent / empty", () => {
	test("returns null metadata + null error when section absent", () => {
		const out = parseSegmentDagMetadata("# Task\n\nNo DAG here.", "T-001", "/x/PROMPT.md");
		expect(out.metadata).toBeNull();
		expect(out.error).toBeNull();
	});

	test("returns null metadata when body declares no repos + no edges", () => {
		const out = parseSegmentDagMetadata(body("Repos:", "Edges:"), "T-001", "/x/PROMPT.md");
		expect(out.metadata).toBeNull();
		expect(out.error).toBeNull();
	});

	test("section heading with no newline after → null null", () => {
		// File ends exactly on heading — no trailing newline.
		const out = parseSegmentDagMetadata("## Segment DAG", "T-001", "/x/PROMPT.md");
		expect(out.metadata).toBeNull();
		expect(out.error).toBeNull();
	});
});

describe("parseSegmentDagMetadata — structural errors", () => {
	test("entry before any subsection header → SEGMENT_DAG_INVALID", () => {
		const out = parseSegmentDagMetadata(body("- api"), "T-001", "/x/PROMPT.md");
		expect(out.metadata).toBeNull();
		expect(out.error?.code).toBe("SEGMENT_DAG_INVALID");
		expect(out.error?.message).toContain("Repos:");
	});

	test("non-bullet content after Repos header → SEGMENT_DAG_INVALID", () => {
		const out = parseSegmentDagMetadata(body("Repos:", "not a bullet"), "T-001", "/x/PROMPT.md");
		expect(out.error?.code).toBe("SEGMENT_DAG_INVALID");
		expect(out.error?.message).toContain("bullet entry");
	});

	test("repo entry containing `->` → SEGMENT_DAG_INVALID", () => {
		const out = parseSegmentDagMetadata(body("Repos:", "- api -> web"), "T-001", "/x/PROMPT.md");
		expect(out.error?.code).toBe("SEGMENT_DAG_INVALID");
		expect(out.error?.message).toContain("single repo ID");
	});

	test("invalid repoId pattern → SEGMENT_DAG_INVALID", () => {
		const out = parseSegmentDagMetadata(body("Repos:", "- bad_underscore"), "T-001", "/x/PROMPT.md");
		expect(out.error?.code).toBe("SEGMENT_DAG_INVALID");
		expect(out.error?.message).toContain("/^[a-z0-9]");
	});

	test("malformed edge (no `->`) → SEGMENT_DAG_INVALID", () => {
		const out = parseSegmentDagMetadata(body("Repos:", "- api", "Edges:", "- just-text"), "T-001", "/x/PROMPT.md");
		expect(out.error?.code).toBe("SEGMENT_DAG_INVALID");
		expect(out.error?.message).toContain("Expected format");
	});

	test("self-edge rejected", () => {
		const out = parseSegmentDagMetadata(body("Repos:", "- api", "Edges:", "- api -> api"), "T-001", "/x/PROMPT.md");
		expect(out.error?.code).toBe("SEGMENT_DAG_INVALID");
		expect(out.error?.message).toContain("self-edge");
	});

	test("edge endpoint not in Repos: → SEGMENT_REPO_UNKNOWN", () => {
		const out = parseSegmentDagMetadata(body("Repos:", "- api", "Edges:", "- api -> web"), "T-001", "/x/PROMPT.md");
		expect(out.error?.code).toBe("SEGMENT_REPO_UNKNOWN");
	});

	test("cycle detected and reported with path", () => {
		const out = parseSegmentDagMetadata(
			body("Repos:", "- a", "- b", "- c", "Edges:", "- a -> b", "- b -> c", "- c -> a"),
			"T-001",
			"/x/PROMPT.md",
		);
		expect(out.error?.code).toBe("SEGMENT_DAG_INVALID");
		expect(out.error?.message).toContain("cyclic");
		// Cycle string should mention all three nodes.
		expect(out.error?.message).toMatch(/a.*b.*c.*a/);
	});
});

describe("parseSegmentDagMetadata — valid DAGs", () => {
	test("well-formed 2-node DAG yields metadata with declared repoIds + edge", () => {
		const out = parseSegmentDagMetadata(
			body("Repos:", "- api", "- web", "Edges:", "- api -> web"),
			"T-001",
			"/x/PROMPT.md",
		);
		expect(out.error).toBeNull();
		expect(out.metadata?.repoIds).toEqual(["api", "web"]);
		expect(out.metadata?.edges).toEqual([{ fromRepoId: "api", toRepoId: "web" }]);
	});

	test("edges sorted by (from, to) regardless of source order", () => {
		const out = parseSegmentDagMetadata(
			body("Repos:", "- a", "- b", "- c", "Edges:", "- b -> c", "- a -> c", "- a -> b"),
			"T-001",
			"/x/PROMPT.md",
		);
		expect(out.error).toBeNull();
		expect(out.metadata?.edges).toEqual([
			{ fromRepoId: "a", toRepoId: "b" },
			{ fromRepoId: "a", toRepoId: "c" },
			{ fromRepoId: "b", toRepoId: "c" },
		]);
	});

	test("duplicate edges deduplicated", () => {
		const out = parseSegmentDagMetadata(
			body("Repos:", "- a", "- b", "Edges:", "- a -> b", "- a -> b"),
			"T-001",
			"/x/PROMPT.md",
		);
		expect(out.error).toBeNull();
		expect(out.metadata?.edges).toHaveLength(1);
	});

	test("markdown-decorated subsection headers + tokens accepted", () => {
		const out = parseSegmentDagMetadata(
			body("**Repos:**", "- `api`", "- **web**", "**Edges:**", "- `api` -> **web**"),
			"T-001",
			"/x/PROMPT.md",
		);
		expect(out.error).toBeNull();
		expect(out.metadata?.repoIds).toEqual(["api", "web"]);
		expect(out.metadata?.edges).toEqual([{ fromRepoId: "api", toRepoId: "web" }]);
	});

	test("stops parsing at next ## section boundary", () => {
		const content = [
			"## Segment DAG",
			"Repos:",
			"- api",
			"- web",
			"Edges:",
			"- api -> web",
			"",
			"## Notes",
			"- this line should not be parsed as a DAG entry",
			"",
		].join("\n");
		const out = parseSegmentDagMetadata(content, "T-001", "/x/PROMPT.md");
		expect(out.error).toBeNull();
		expect(out.metadata?.repoIds).toEqual(["api", "web"]);
	});
});
