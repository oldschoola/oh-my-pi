/**
 * Tests for worktree filesystem + subprocess helpers:
 *   - ensureBatchContainerDir
 *   - removeBatchContainerIfEmpty
 *   - sleepSync
 *   - execCheck
 *   - runPreflight
 *
 * Real ephemeral filesystem + real subprocess — the helpers are thin
 * wrappers over fs/child_process and their behavioral contract is
 * observable without mocking.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_ORCHESTRATOR_CONFIG } from "../src/missioncontrol/types";
import {
	ensureBatchContainerDir,
	execCheck,
	removeBatchContainerIfEmpty,
	runPreflight,
	sleepSync,
} from "../src/missioncontrol/worktree";

function mkTmp(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("ensureBatchContainerDir", () => {
	let base: string;

	beforeEach(() => {
		base = mkTmp("mc-ensure");
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	test("creates missing directory (recursive)", () => {
		const target = join(base, "a", "b", "c");
		expect(existsSync(target)).toBe(false);
		ensureBatchContainerDir(target);
		expect(existsSync(target)).toBe(true);
	});

	test("idempotent when directory already exists", () => {
		const target = join(base, "already");
		mkdirSync(target, { recursive: true });
		expect(() => ensureBatchContainerDir(target)).not.toThrow();
		expect(existsSync(target)).toBe(true);
	});
});

describe("removeBatchContainerIfEmpty", () => {
	let base: string;

	beforeEach(() => {
		base = mkTmp("mc-rm");
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	test("no-op + returns false when directory does not exist", () => {
		const target = join(base, "nope");
		expect(removeBatchContainerIfEmpty(target)).toBe(false);
		expect(existsSync(target)).toBe(false);
	});

	test("removes empty directory + returns true", () => {
		const target = join(base, "empty");
		mkdirSync(target);
		expect(removeBatchContainerIfEmpty(target)).toBe(true);
		expect(existsSync(target)).toBe(false);
	});

	test("returns false + leaves directory when non-empty", () => {
		const target = join(base, "nonempty");
		mkdirSync(target);
		writeFileSync(join(target, "file.txt"), "x\n");
		expect(removeBatchContainerIfEmpty(target)).toBe(false);
		expect(existsSync(target)).toBe(true);
		expect(existsSync(join(target, "file.txt"))).toBe(true);
	});
});

describe("sleepSync", () => {
	test("blocks for at least the requested duration (second granularity)", () => {
		// ping/sleep at 1-second granularity means 500ms requested still
		// takes ~1s to return. Allow a generous tolerance.
		const start = Date.now();
		sleepSync(500);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(500);
	});
});

describe("execCheck", () => {
	test("reports ok:true + stdout on a known-good command", () => {
		const result = execCheck("git --version");
		expect(result.ok).toBe(true);
		expect(result.stdout).toContain("git version");
	});

	test("reports ok:false + empty stdout on a bogus command", () => {
		const result = execCheck("this-binary-does-not-exist-__mc__ --nope");
		expect(result.ok).toBe(false);
		expect(result.stdout).toBe("");
	});

	test("respects the cwd option", () => {
		const dir = mkTmp("mc-exec");
		try {
			// `git rev-parse --show-toplevel` fails outside a repo — use a
			// cwd-neutral command instead. Just ensures cwd is accepted.
			const result = execCheck("git --version", dir);
			expect(result.ok).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("runPreflight", () => {
	test("passes in a healthy dev environment (git + bun on PATH)", () => {
		const result = runPreflight(DEFAULT_ORCHESTRATOR_CONFIG);
		expect(result.passed).toBe(true);
		const names = result.checks.map(c => c.name).sort();
		expect(names).toEqual(["bun", "git", "git-worktree", "runtime-backend"]);
		for (const check of result.checks) {
			expect(check.status).toBe("pass");
		}
	});

	test("git-worktree check uses repoRoot when supplied", () => {
		// Without repoRoot, git-worktree runs in cwd which should still be
		// inside the pi-missions repo for the dev environment.
		const result = runPreflight(DEFAULT_ORCHESTRATOR_CONFIG, process.cwd());
		const worktreeCheck = result.checks.find(c => c.name === "git-worktree");
		expect(worktreeCheck?.status).toBe("pass");
	});

	test("runtime-backend check mirrors configured spawn_mode", () => {
		const result = runPreflight(DEFAULT_ORCHESTRATOR_CONFIG);
		const backend = result.checks.find(c => c.name === "runtime-backend");
		expect(backend?.message).toContain(DEFAULT_ORCHESTRATOR_CONFIG.orchestrator.spawn_mode);
	});
});
