/**
 * Unit tests for resolveArguments — the discovery CLI arg dispatcher.
 *
 * Verifies that the parser correctly categorizes each whitespace-separated
 * token as one of: "all" (expands task_areas), known area name, PROMPT.md
 * file (direct task folder), arbitrary directory (area scan), or unknown
 * argument (UNKNOWN_ARG error).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TaskArea } from "../src/missioncontrol";
import { resolveArguments } from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-resolveargs-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function area(path: string): TaskArea {
	return { path, prefix: "X", context: "test" };
}

describe("resolveArguments", () => {
	test("empty input yields empty lists and no errors", () => {
		const result = resolveArguments("", {}, sandbox);
		expect(result.areaScanPaths).toEqual([]);
		expect(result.directTaskFolders).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test('"all" expands to every configured area', () => {
		mkdirSync(join(sandbox, "a1"), { recursive: true });
		mkdirSync(join(sandbox, "a2"), { recursive: true });
		const result = resolveArguments("all", { a1: area("a1"), a2: area("a2") }, sandbox);
		expect(result.areaScanPaths).toEqual([resolve(sandbox, "a1"), resolve(sandbox, "a2")]);
	});

	test("known area name resolves to its configured path", () => {
		mkdirSync(join(sandbox, "frontend"), { recursive: true });
		const result = resolveArguments("frontend", { frontend: area("frontend") }, sandbox);
		expect(result.areaScanPaths).toEqual([resolve(sandbox, "frontend")]);
	});

	test("arbitrary existing directory is added as a scan path", () => {
		mkdirSync(join(sandbox, "ad-hoc"), { recursive: true });
		const result = resolveArguments("ad-hoc", {}, sandbox);
		expect(result.areaScanPaths).toEqual([resolve(sandbox, "ad-hoc")]);
	});

	test("PROMPT.md path resolves to its containing folder as a direct task folder", () => {
		const taskDir = join(sandbox, "TA-001");
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(join(taskDir, "PROMPT.md"), "# Task: TA-001 - x\n", "utf-8");
		const result = resolveArguments("TA-001/PROMPT.md", {}, sandbox);
		expect(result.directTaskFolders).toEqual([resolve(sandbox, "TA-001")]);
		expect(result.areaScanPaths).toEqual([]);
	});

	test("missing token yields UNKNOWN_ARG error", () => {
		const result = resolveArguments("nope", {}, sandbox);
		expect(result.areaScanPaths).toEqual([]);
		expect(result.errors[0]?.code).toBe("UNKNOWN_ARG");
		expect(result.errors[0]?.message).toContain("Unknown area, path, or file");
	});

	test("path pointing to a file (not PROMPT.md) → UNKNOWN_ARG", () => {
		writeFileSync(join(sandbox, "README.md"), "hi", "utf-8");
		const result = resolveArguments("README.md", {}, sandbox);
		expect(result.errors[0]?.code).toBe("UNKNOWN_ARG");
		expect(result.errors[0]?.message).toContain("Not a directory");
	});

	test("duplicate area names are deduplicated", () => {
		mkdirSync(join(sandbox, "api"), { recursive: true });
		const result = resolveArguments("api api", { api: area("api") }, sandbox);
		expect(result.areaScanPaths).toEqual([resolve(sandbox, "api")]);
	});

	test("mix of `all`, explicit area, direct PROMPT.md, and unknown token", () => {
		mkdirSync(join(sandbox, "a1"), { recursive: true });
		mkdirSync(join(sandbox, "a2"), { recursive: true });
		const taskDir = join(sandbox, "TA-009");
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(join(taskDir, "PROMPT.md"), "# Task: TA-009 - x\n", "utf-8");
		const result = resolveArguments("all a1 TA-009/PROMPT.md bogus", { a1: area("a1"), a2: area("a2") }, sandbox);
		expect(result.areaScanPaths).toContain(resolve(sandbox, "a1"));
		expect(result.areaScanPaths).toContain(resolve(sandbox, "a2"));
		expect(result.directTaskFolders).toEqual([resolve(sandbox, "TA-009")]);
		expect(result.errors[0]?.code).toBe("UNKNOWN_ARG");
	});

	test("`ALL` matches case-insensitively", () => {
		mkdirSync(join(sandbox, "zz"), { recursive: true });
		const result = resolveArguments("ALL", { zz: area("zz") }, sandbox);
		expect(result.areaScanPaths).toEqual([resolve(sandbox, "zz")]);
	});
});
