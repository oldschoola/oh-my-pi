/**
 * Unit tests for `parseIntegrateArgs` + `parseResumeArgs`.
 *
 * Success shape has a `mode` / `force` field; failure shape has `error`.
 * Tests discriminate on `"error" in result` and assert specific copy.
 */

import { describe, expect, test } from "bun:test";

import { parseIntegrateArgs, parseResumeArgs } from "../src/missioncontrol/extension-args";

function assertSuccessIntegrate(
	result: ReturnType<typeof parseIntegrateArgs>,
): asserts result is Extract<typeof result, { mode: "ff" | "merge" | "pr" }> {
	if ("error" in result) throw new Error(`Expected success, got error: ${result.error}`);
}

function assertErrorIntegrate(result: ReturnType<typeof parseIntegrateArgs>): asserts result is { error: string } {
	if (!("error" in result)) throw new Error("Expected error, got success");
}

function assertSuccessResume(result: ReturnType<typeof parseResumeArgs>): asserts result is { force: boolean } {
	if ("error" in result) throw new Error(`Expected success, got error: ${result.error}`);
}

function assertErrorResume(result: ReturnType<typeof parseResumeArgs>): asserts result is { error: string } {
	if (!("error" in result)) throw new Error("Expected error, got success");
}

describe("parseIntegrateArgs", () => {
	test("defaults to ff mode, no force, no branch arg", () => {
		const result = parseIntegrateArgs("");
		assertSuccessIntegrate(result);
		expect(result.mode).toBe("ff");
		expect(result.force).toBe(false);
		expect(result.orchBranchArg).toBeUndefined();
	});

	test("undefined input defaults to ff", () => {
		const result = parseIntegrateArgs(undefined);
		assertSuccessIntegrate(result);
		expect(result.mode).toBe("ff");
	});

	test("--merge switches mode", () => {
		const result = parseIntegrateArgs("--merge");
		assertSuccessIntegrate(result);
		expect(result.mode).toBe("merge");
	});

	test("--pr switches mode", () => {
		const result = parseIntegrateArgs("--pr");
		assertSuccessIntegrate(result);
		expect(result.mode).toBe("pr");
	});

	test("--force sets force true without changing mode", () => {
		const result = parseIntegrateArgs("--force");
		assertSuccessIntegrate(result);
		expect(result.force).toBe(true);
		expect(result.mode).toBe("ff");
	});

	test("combined flags + branch positional", () => {
		const result = parseIntegrateArgs("--merge --force orch/op-abc123");
		assertSuccessIntegrate(result);
		expect(result.mode).toBe("merge");
		expect(result.force).toBe(true);
		expect(result.orchBranchArg).toBe("orch/op-abc123");
	});

	test("--merge + --pr returns mutual exclusion error", () => {
		const result = parseIntegrateArgs("--merge --pr");
		assertErrorIntegrate(result);
		expect(result.error).toContain("Cannot use --merge and --pr together");
	});

	test("unknown flag returns error", () => {
		const result = parseIntegrateArgs("--bogus");
		assertErrorIntegrate(result);
		expect(result.error).toBe("Unknown flag: --bogus");
	});

	test("multiple positionals returns error", () => {
		const result = parseIntegrateArgs("foo bar baz");
		assertErrorIntegrate(result);
		expect(result.error).toContain("Expected at most one branch argument");
		expect(result.error).toContain("foo, bar, baz");
	});

	test("tolerates extra whitespace", () => {
		const result = parseIntegrateArgs("  --merge   --force   ");
		assertSuccessIntegrate(result);
		expect(result.mode).toBe("merge");
		expect(result.force).toBe(true);
	});

	test("single positional without flags becomes branch arg", () => {
		const result = parseIntegrateArgs("orch/op-xyz");
		assertSuccessIntegrate(result);
		expect(result.orchBranchArg).toBe("orch/op-xyz");
		expect(result.mode).toBe("ff");
	});
});

describe("parseResumeArgs", () => {
	test("empty input returns default (force false)", () => {
		const result = parseResumeArgs("");
		assertSuccessResume(result);
		expect(result.force).toBe(false);
	});

	test("undefined input returns default", () => {
		const result = parseResumeArgs(undefined);
		assertSuccessResume(result);
		expect(result.force).toBe(false);
	});

	test("--force sets force true", () => {
		const result = parseResumeArgs("--force");
		assertSuccessResume(result);
		expect(result.force).toBe(true);
	});

	test("--help returns usage string under error", () => {
		const result = parseResumeArgs("--help");
		assertErrorResume(result);
		expect(result.error).toContain("Usage: /mission-resume");
		expect(result.error).toContain("--force");
	});

	test("unknown flag returns error mentioning /mission-resume", () => {
		const result = parseResumeArgs("--bogus");
		assertErrorResume(result);
		expect(result.error).toContain("Unknown flag: --bogus");
		expect(result.error).toContain("Usage: /mission-resume [--force]");
	});

	test("positional argument is rejected", () => {
		const result = parseResumeArgs("bogus");
		assertErrorResume(result);
		expect(result.error).toContain("Unexpected argument: bogus");
	});

	test("tolerates extra whitespace", () => {
		const result = parseResumeArgs("  --force  ");
		assertSuccessResume(result);
		expect(result.force).toBe(true);
	});
});
