/**
 * Unit tests for pure segment-aware discovery helpers.
 *
 * Covers:
 *  - SEGMENT_REPO_ID_PATTERN accepts/rejects expected token shapes
 *  - normalizeSegmentRepoToken strips backticks + bold markers, trims, lowercases
 *  - extractCheckboxes parses `- [ ]` / `- [x]` across CRLF + LF content
 */

import { describe, expect, test } from "bun:test";

import { extractCheckboxes, normalizeSegmentRepoToken, SEGMENT_REPO_ID_PATTERN } from "../src/missioncontrol";

describe("SEGMENT_REPO_ID_PATTERN", () => {
	test.each([
		["api", true],
		["web-client", true],
		["a1", true],
		["0abc", true],
		["Api", false],
		["-leading-hyphen", false],
		["trailing hyphen ", false],
		["has_underscore", false],
		["", false],
	])("regex match for %p → %p", (input, expected) => {
		expect(SEGMENT_REPO_ID_PATTERN.test(input)).toBe(expected);
	});
});

describe("normalizeSegmentRepoToken", () => {
	test("lowercases plain token", () => {
		expect(normalizeSegmentRepoToken("API")).toBe("api");
	});

	test("strips surrounding backticks", () => {
		expect(normalizeSegmentRepoToken("`web-client`")).toBe("web-client");
	});

	test("strips surrounding bold markers", () => {
		expect(normalizeSegmentRepoToken("**api**")).toBe("api");
	});

	test("strips backticks that wrap a bolded token (outer layer wins)", () => {
		expect(normalizeSegmentRepoToken("`**api**`")).toBe("api");
	});

	test("trims whitespace before stripping decoration", () => {
		expect(normalizeSegmentRepoToken("   API   ")).toBe("api");
	});

	test("leaves inner decoration alone when unbalanced", () => {
		expect(normalizeSegmentRepoToken("`api")).toBe("`api");
	});
});

describe("extractCheckboxes", () => {
	test("empty content yields empty array", () => {
		expect(extractCheckboxes("")).toEqual([]);
	});

	test("extracts unchecked and checked boxes preserving text", () => {
		const content = "- [ ] First task\n- [x] Second task\n";
		expect(extractCheckboxes(content)).toEqual(["First task", "Second task"]);
	});

	test("tolerates CRLF line endings", () => {
		const content = "- [ ] Alpha\r\n- [x] Beta\r\n";
		expect(extractCheckboxes(content)).toEqual(["Alpha", "Beta"]);
	});

	test("ignores non-checkbox bullets and paragraphs", () => {
		const content = "- bullet\n- [ ] real\nsome text\n";
		expect(extractCheckboxes(content)).toEqual(["real"]);
	});

	test("handles leading whitespace before the bullet", () => {
		const content = "    - [x] Indented item\n";
		expect(extractCheckboxes(content)).toEqual(["Indented item"]);
	});

	test("trims trailing whitespace from extracted text", () => {
		const content = "- [ ] Has trailing space   \n";
		expect(extractCheckboxes(content)).toEqual(["Has trailing space"]);
	});
});
