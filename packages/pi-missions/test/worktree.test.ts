/**
 * Tests for `missioncontrol/worktree.ts` pure helpers.
 *
 * Covers branch-name math, worktree path layout (sibling + subdirectory,
 * with + without `batchId`), porcelain parsing, path normalization,
 * regex escaping. The mutating surface (create/remove/preserve/reset) is
 * deferred until the engine port, so no shelling out here.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { DEFAULT_ORCHESTRATOR_CONFIG, type OrchestratorConfig } from "../src/missioncontrol/types";
import {
	computePartialProgressBranchName,
	computeSavedBranchName,
	escapeRegex,
	generateBatchContainerName,
	generateBatchContainerPath,
	generateBranchName,
	generateMergeWorktreePath,
	generateWorktreePath,
	normalizePath,
	parseWorktreeList,
	resolveWorktreeBasePath,
} from "../src/missioncontrol/worktree";

function siblingConfig(): OrchestratorConfig {
	return {
		...DEFAULT_ORCHESTRATOR_CONFIG,
		orchestrator: { ...DEFAULT_ORCHESTRATOR_CONFIG.orchestrator, worktree_location: "sibling" },
	};
}

describe("branch naming", () => {
	test("generateBranchName composes opId + lane + batch", () => {
		expect(generateBranchName(3, "b-1", "henry")).toBe("task/henry-lane-3-b-1");
	});

	test("computeSavedBranchName prepends saved/ namespace", () => {
		expect(computeSavedBranchName("task/henry-lane-1-b-1")).toBe("saved/task/henry-lane-1-b-1");
	});

	test("computePartialProgressBranchName omits repoId when absent", () => {
		expect(computePartialProgressBranchName("henry", "t-42", "b-7")).toBe("saved/henry-t-42-b-7");
	});

	test("computePartialProgressBranchName includes repoId when present", () => {
		expect(computePartialProgressBranchName("henry", "t-42", "b-7", "api")).toBe("saved/henry-api-t-42-b-7");
	});
});

describe("resolveWorktreeBasePath", () => {
	test("subdirectory layout nests under .worktrees", () => {
		const base = resolveWorktreeBasePath("/repo", DEFAULT_ORCHESTRATOR_CONFIG);
		expect(base).toBe(resolve("/repo", ".worktrees"));
	});

	test("sibling layout resolves to repo parent", () => {
		const base = resolveWorktreeBasePath("/repo", siblingConfig());
		expect(base).toBe(resolve("/repo", ".."));
	});
});

describe("generateBatchContainerName / generateBatchContainerPath", () => {
	test("container name concatenates opId + batchId", () => {
		expect(generateBatchContainerName("henry", "b-1")).toBe("henry-b-1");
	});

	test("container path defaults to subdirectory layout when config omitted", () => {
		const p = generateBatchContainerPath("henry", "b-1", "/repo");
		expect(p).toBe(resolve("/repo", ".worktrees", "henry-b-1"));
	});

	test("container path honours sibling layout", () => {
		const p = generateBatchContainerPath("henry", "b-1", "/repo", siblingConfig());
		expect(p).toBe(resolve("/repo", "..", "henry-b-1"));
	});
});

describe("generateWorktreePath", () => {
	test("batchId present → batch-scoped container + lane-N", () => {
		const p = generateWorktreePath("mission-wt", 2, "/repo", "henry", undefined, "b-1");
		expect(p).toBe(resolve("/repo", ".worktrees", "henry-b-1", "lane-2"));
	});

	test("no batchId → legacy flat layout prefix-opId-lane", () => {
		const p = generateWorktreePath("mission-wt", 2, "/repo", "henry");
		expect(p).toBe(resolve("/repo", ".worktrees", "mission-wt-henry-2"));
	});

	test("sibling config with batchId lands next to repo", () => {
		const p = generateWorktreePath("mission-wt", 1, "/repo", "henry", siblingConfig(), "b-9");
		expect(p).toBe(resolve("/repo", "..", "henry-b-9", "lane-1"));
	});
});

describe("generateMergeWorktreePath", () => {
	test("appends /merge inside the batch container", () => {
		const p = generateMergeWorktreePath("/repo", "henry", "b-1");
		expect(p).toBe(resolve("/repo", ".worktrees", "henry-b-1", "merge"));
	});
});

describe("parseWorktreeList", () => {
	test("returns empty array when git command fails", () => {
		// Non-existent path → runGit returns ok:false → parser returns [].
		const result = parseWorktreeList("/definitely/not/a/git/repo/xyz-123456");
		expect(result).toEqual([]);
	});

	test("parses the current oh-my-pi repo worktrees if available", () => {
		// Opportunistic: runs inside a real repo, so at minimum the main
		// worktree is reported. We don't assert the count — just the shape.
		const result = parseWorktreeList(process.cwd());
		for (const entry of result) {
			expect(typeof entry.path).toBe("string");
			expect(typeof entry.head).toBe("string");
			expect(typeof entry.bare).toBe("boolean");
			expect(entry.branch === null || typeof entry.branch === "string").toBe(true);
		}
	});
});

describe("normalizePath", () => {
	test("lowercases and replaces backslashes with forward slashes", () => {
		const raw = "C:\\Users\\Henry\\Repo";
		const normalized = normalizePath(raw);
		expect(normalized.includes("\\")).toBe(false);
		expect(normalized).toBe(normalized.toLowerCase());
	});

	test("resolves relative paths before normalizing", () => {
		const normalized = normalizePath("./a/b");
		expect(normalized).toContain("/a/b");
	});
});

describe("escapeRegex", () => {
	test("escapes each regex metacharacter", () => {
		expect(escapeRegex("a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o")).toBe(
			"a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o",
		);
	});

	test("leaves plain alphanumerics unchanged", () => {
		expect(escapeRegex("mission-wt-henry-1")).toBe("mission-wt-henry-1");
	});

	test("result compiles to a RegExp matching the original string literally", () => {
		const input = "a.b+c?";
		const rx = new RegExp(escapeRegex(input));
		expect(rx.test(input)).toBe(true);
		expect(rx.test("aXbYcZ")).toBe(false);
	});
});
