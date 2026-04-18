/**
 * Unit tests for worktree pure helpers: preflight formatter, retry
 * classifier, semver-ish tuple helpers, sleepAsync yield.
 */

import { describe, expect, test } from "bun:test";

import type { PreflightResult } from "../src/missioncontrol/types";
import {
	formatPreflightResults,
	isRetriableRemoveError,
	meetsMinVersion,
	parseVersion,
	sleepAsync,
} from "../src/missioncontrol/worktree";

describe("isRetriableRemoveError", () => {
	test("matches Windows cannot-lock error", () => {
		expect(isRetriableRemoveError("fatal: cannot lock ref")).toBe(true);
	});

	test("matches Windows process-access error", () => {
		expect(isRetriableRemoveError("The process cannot access the file")).toBe(true);
	});

	test("matches Unix permission-denied", () => {
		expect(isRetriableRemoveError("rm: permission denied: /foo")).toBe(true);
	});

	test("matches device-busy", () => {
		expect(isRetriableRemoveError("device or resource busy")).toBe(true);
	});

	test("matches used-by-another-process", () => {
		expect(isRetriableRemoveError("The file is used by another process")).toBe(true);
	});

	test("matches directory-not-empty", () => {
		expect(isRetriableRemoveError("ENOTEMPTY: directory not empty")).toBe(true);
	});

	test("matches i/o error forms", () => {
		expect(isRetriableRemoveError("I/O error detected")).toBe(true);
		expect(isRetriableRemoveError("input/output error")).toBe(true);
	});

	test("matches generic failed-to-remove", () => {
		expect(isRetriableRemoveError("fatal: failed to remove worktree")).toBe(true);
	});

	test("rejects git usage error (non-retriable)", () => {
		expect(isRetriableRemoveError("fatal: 'foo' is not a valid worktree")).toBe(false);
	});

	test("rejects empty stderr", () => {
		expect(isRetriableRemoveError("")).toBe(false);
	});

	test("is case-insensitive", () => {
		expect(isRetriableRemoveError("CANNOT LOCK REF")).toBe(true);
	});
});

describe("parseVersion", () => {
	test("extracts major.minor from git banner", () => {
		expect(parseVersion("git version 2.43.0.windows.1")).toEqual([2, 43]);
	});

	test("extracts major.minor from tmux banner", () => {
		expect(parseVersion("tmux 3.3a")).toEqual([3, 3]);
	});

	test("extracts first major.minor when multiple version-ish pairs appear", () => {
		expect(parseVersion("foo 1.2 bar 9.9")).toEqual([1, 2]);
	});

	test("returns [0, 0] when no version pair present", () => {
		expect(parseVersion("no numbers here")).toEqual([0, 0]);
	});

	test("returns [0, 0] for empty string", () => {
		expect(parseVersion("")).toEqual([0, 0]);
	});

	test("handles zero major/minor", () => {
		expect(parseVersion("v0.0.1")).toEqual([0, 0]);
	});
});

describe("meetsMinVersion", () => {
	test("higher major passes", () => {
		expect(meetsMinVersion([3, 0], [2, 15])).toBe(true);
	});

	test("same major, higher minor passes", () => {
		expect(meetsMinVersion([2, 43], [2, 15])).toBe(true);
	});

	test("same major, same minor passes (inclusive)", () => {
		expect(meetsMinVersion([2, 15], [2, 15])).toBe(true);
	});

	test("same major, lower minor fails", () => {
		expect(meetsMinVersion([2, 14], [2, 15])).toBe(false);
	});

	test("lower major fails even with higher minor", () => {
		expect(meetsMinVersion([1, 99], [2, 0])).toBe(false);
	});

	test("[0, 0] fails any non-zero minimum", () => {
		expect(meetsMinVersion([0, 0], [2, 15])).toBe(false);
	});
});

describe("formatPreflightResults", () => {
	test("renders all-pass footer + check lines", () => {
		const result: PreflightResult = {
			passed: true,
			checks: [
				{ name: "git", status: "pass", message: "Git 2.43 available" },
				{ name: "git-worktree", status: "pass", message: "Worktree support available" },
			],
		};
		const out = formatPreflightResults(result);
		expect(out).toContain("Preflight Check:");
		expect(out).toContain("✅ git");
		expect(out).toContain("Git 2.43 available");
		expect(out).toContain("All required checks passed.");
		expect(out).not.toContain("❌ Preflight FAILED");
	});

	test("renders failure footer listing failed check names", () => {
		const result: PreflightResult = {
			passed: false,
			checks: [
				{ name: "git", status: "pass", message: "Git 2.43 available" },
				{
					name: "pi",
					status: "fail",
					message: "Pi not found",
					hint: "Install Pi: npm install -g @mariozechner/pi-coding-agent",
				},
			],
		};
		const out = formatPreflightResults(result);
		expect(out).toContain("❌ pi");
		expect(out).toContain("Pi not found");
		expect(out).toContain("Install Pi:");
		expect(out).toContain("❌ Preflight FAILED: pi");
		expect(out).toContain("Fix the issues above");
	});

	test("emits warn icon for warn status without hint indentation", () => {
		const result: PreflightResult = {
			passed: true,
			checks: [{ name: "runtime-backend", status: "warn", message: "Using experimental backend" }],
		};
		const out = formatPreflightResults(result);
		expect(out).toContain("⚠️  runtime-backend");
		expect(out).toContain("Using experimental backend");
		expect(out).toContain("All required checks passed.");
	});

	test("hint lines indent under check, one line each", () => {
		const result: PreflightResult = {
			passed: false,
			checks: [
				{
					name: "git",
					status: "fail",
					message: "Git 1.9 found",
					hint: "Line A\nLine B",
				},
			],
		};
		const out = formatPreflightResults(result);
		const lines = out.split("\n");
		const hintA = lines.find(l => l.includes("Line A"));
		const hintB = lines.find(l => l.includes("Line B"));
		expect(hintA?.startsWith("      ")).toBe(true);
		expect(hintB?.startsWith("      ")).toBe(true);
	});

	test("pass status suppresses hint even when provided", () => {
		const result: PreflightResult = {
			passed: true,
			checks: [
				{
					name: "git",
					status: "pass",
					message: "Git 2.43 available",
					hint: "You shouldn't see this",
				},
			],
		};
		const out = formatPreflightResults(result);
		expect(out).not.toContain("You shouldn't see this");
	});

	test("fail-list concatenates multiple failed checks", () => {
		const result: PreflightResult = {
			passed: false,
			checks: [
				{ name: "git", status: "fail", message: "missing" },
				{ name: "pi", status: "fail", message: "missing" },
			],
		};
		const out = formatPreflightResults(result);
		expect(out).toContain("❌ Preflight FAILED: git, pi");
	});
});

describe("sleepAsync", () => {
	test("resolves after roughly the requested interval", async () => {
		const start = performance.now();
		await sleepAsync(25);
		const elapsed = performance.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(10);
	});

	test("returns a Promise<void>", () => {
		const p = sleepAsync(0);
		expect(p).toBeInstanceOf(Promise);
		return p;
	});
});
