/**
 * Unit tests for parseStepSegmentMapping — parses `## Steps` /
 * `### Step N:` / `#### Segment: <repoId>` into StepSegmentMapping[].
 *
 * Covers:
 *  - Missing `## Steps` section → empty mapping (no warnings/errors)
 *  - Step with no segment header → fallback repo with all checkboxes
 *  - Explicit segment markers flip `hasExplicitMarkers`
 *  - Pre-segment checkboxes combine with concrete fallback repo (dedup vs first segment)
 *  - Duplicate repoId within a step → SEGMENT_STEP_DUPLICATE_REPO error
 *  - Invalid repoId → SEGMENT_STEP_REPO_INVALID warning (checkboxes still captured)
 *  - Empty segment → SEGMENT_STEP_EMPTY warning
 *  - Steps body stops at next `## ` section or `---` divider
 */

import { describe, expect, test } from "bun:test";

import { parseStepSegmentMapping, SEGMENT_FALLBACK_REPO_PLACEHOLDER } from "../src/missioncontrol";

describe("parseStepSegmentMapping", () => {
	test("returns empty mapping when `## Steps` section is absent", () => {
		const result = parseStepSegmentMapping("# Task: TASK-001\n\nNo steps here.\n", "TASK-001", "api");
		expect(result.mapping).toEqual([]);
		expect(result.hasExplicitMarkers).toBe(false);
		expect(result.warnings).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("returns empty mapping when `## Steps` header has no body", () => {
		const result = parseStepSegmentMapping("## Steps", "TASK-001", "api");
		expect(result.mapping).toEqual([]);
		expect(result.hasExplicitMarkers).toBe(false);
	});

	test("returns empty mapping when `## Steps` has no `### Step N:` headers", () => {
		const content = "## Steps\n\nPlain prose, no step headers.\n";
		const result = parseStepSegmentMapping(content, "TASK-001", "api");
		expect(result.mapping).toEqual([]);
	});

	test("single step without segment markers routes checkboxes to fallback repo", () => {
		const content = "## Steps\n\n### Step 1: Build API\n- [ ] Add route\n- [ ] Add tests\n";
		const result = parseStepSegmentMapping(content, "TASK-001", "api");
		expect(result.mapping).toHaveLength(1);
		expect(result.mapping[0]).toEqual({
			stepNumber: 1,
			stepName: "Build API",
			segments: [{ repoId: "api", checkboxes: ["Add route", "Add tests"] }],
		});
		expect(result.hasExplicitMarkers).toBe(false);
		expect(result.warnings).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("explicit segment markers set hasExplicitMarkers and scope checkboxes", () => {
		const content = [
			"## Steps",
			"",
			"### Step 1: Wire",
			"#### Segment: api",
			"- [ ] Add endpoint",
			"#### Segment: web-client",
			"- [x] Call endpoint",
			"",
		].join("\n");
		const result = parseStepSegmentMapping(content, "TASK-001", SEGMENT_FALLBACK_REPO_PLACEHOLDER);
		expect(result.hasExplicitMarkers).toBe(true);
		expect(result.mapping[0]?.segments).toEqual([
			{ repoId: "api", checkboxes: ["Add endpoint"] },
			{ repoId: "web-client", checkboxes: ["Call endpoint"] },
		]);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("pre-segment checkboxes attach to fallback repo (placeholder does not block dup check)", () => {
		const content = [
			"## Steps",
			"### Step 1: Setup",
			"- [ ] Pre-segment bullet",
			"#### Segment: api",
			"- [ ] API bullet",
			"",
		].join("\n");
		const result = parseStepSegmentMapping(content, "TASK-001", SEGMENT_FALLBACK_REPO_PLACEHOLDER);
		expect(result.mapping[0]?.segments).toEqual([
			{ repoId: SEGMENT_FALLBACK_REPO_PLACEHOLDER, checkboxes: ["Pre-segment bullet"] },
			{ repoId: "api", checkboxes: ["API bullet"] },
		]);
		expect(result.errors).toEqual([]);
	});

	test("concrete fallback + first segment matching fallback repo → duplicate error", () => {
		const content = [
			"## Steps",
			"### Step 1: Setup",
			"- [ ] Pre-segment bullet",
			"#### Segment: api",
			"- [ ] Api bullet",
			"",
		].join("\n");
		const result = parseStepSegmentMapping(content, "TASK-001", "api");
		expect(result.errors.length).toBeGreaterThanOrEqual(1);
		expect(result.errors[0]?.code).toBe("SEGMENT_STEP_DUPLICATE_REPO");
	});

	test("duplicate segment within a step records SEGMENT_STEP_DUPLICATE_REPO", () => {
		const content = [
			"## Steps",
			"### Step 1: Double",
			"#### Segment: api",
			"- [ ] First",
			"#### Segment: api",
			"- [ ] Duplicate",
			"",
		].join("\n");
		const result = parseStepSegmentMapping(content, "TASK-001", SEGMENT_FALLBACK_REPO_PLACEHOLDER);
		const dup = result.errors.find(err => err.code === "SEGMENT_STEP_DUPLICATE_REPO");
		expect(dup).toBeDefined();
		expect(dup?.message).toContain("duplicate segment repo ID");
	});

	test("invalid repoId yields SEGMENT_STEP_REPO_INVALID warning (checkboxes still captured)", () => {
		const content = ["## Steps", "### Step 1: Bad", "#### Segment: Bad_Name", "- [ ] Work bullet", ""].join("\n");
		const result = parseStepSegmentMapping(content, "TASK-001", SEGMENT_FALLBACK_REPO_PLACEHOLDER);
		const warn = result.warnings.find(w => w.code === "SEGMENT_STEP_REPO_INVALID");
		expect(warn).toBeDefined();
		expect(result.mapping[0]?.segments[0]?.checkboxes).toEqual(["Work bullet"]);
	});

	test("empty segment yields SEGMENT_STEP_EMPTY warning", () => {
		const content = ["## Steps", "### Step 1: Empty", "#### Segment: api", "", ""].join("\n");
		const result = parseStepSegmentMapping(content, "TASK-001", SEGMENT_FALLBACK_REPO_PLACEHOLDER);
		const warn = result.warnings.find(w => w.code === "SEGMENT_STEP_EMPTY");
		expect(warn).toBeDefined();
		expect(warn?.message).toContain('empty segment "api"');
	});

	test("multiple steps accumulate into ordered mapping", () => {
		const content = ["## Steps", "### Step 1: First", "- [ ] one", "### Step 2: Second", "- [x] two", ""].join("\n");
		const result = parseStepSegmentMapping(content, "TASK-001", "api");
		expect(result.mapping.map(m => m.stepNumber)).toEqual([1, 2]);
		expect(result.mapping[0]?.segments[0]?.checkboxes).toEqual(["one"]);
		expect(result.mapping[1]?.segments[0]?.checkboxes).toEqual(["two"]);
	});

	test("stops at next `## ` section", () => {
		const content = [
			"## Steps",
			"### Step 1: Scope",
			"- [ ] should include",
			"## Notes",
			"### Step 2: Outside",
			"- [ ] should NOT include",
			"",
		].join("\n");
		const result = parseStepSegmentMapping(content, "TASK-001", "api");
		expect(result.mapping).toHaveLength(1);
		expect(result.mapping[0]?.segments[0]?.checkboxes).toEqual(["should include"]);
	});

	test("stops at `---` divider", () => {
		const content = [
			"## Steps",
			"### Step 1: Scope",
			"- [ ] included",
			"---",
			"### Step 2: After divider",
			"- [ ] excluded",
			"",
		].join("\n");
		const result = parseStepSegmentMapping(content, "TASK-001", "api");
		expect(result.mapping).toHaveLength(1);
		expect(result.mapping[0]?.segments[0]?.checkboxes).toEqual(["included"]);
	});

	test("segment repo token with outer backticks wrapping bold is normalized", () => {
		const content = ["## Steps", "### Step 1: Styled", "#### Segment: `**api**`", "- [ ] Bullet", ""].join("\n");
		const result = parseStepSegmentMapping(content, "TASK-001", SEGMENT_FALLBACK_REPO_PLACEHOLDER);
		expect(result.mapping[0]?.segments[0]?.repoId).toBe("api");
		expect(result.warnings).toEqual([]);
	});

	test("CRLF line endings are tolerated end-to-end", () => {
		const content = "## Steps\r\n### Step 1: Cross-platform\r\n#### Segment: api\r\n- [ ] CRLF bullet\r\n";
		const result = parseStepSegmentMapping(content, "TASK-001", SEGMENT_FALLBACK_REPO_PLACEHOLDER);
		expect(result.mapping[0]?.segments[0]?.checkboxes).toEqual(["CRLF bullet"]);
	});
});
