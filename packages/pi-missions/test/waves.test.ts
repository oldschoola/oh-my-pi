import { describe, expect, test } from "bun:test";

import type { ParsedTask } from "../src/missioncontrol/discovery";
import type { WorkspaceConfig, WorkspaceRepoConfig } from "../src/missioncontrol/types";
import {
	chunkIntoWaves,
	generateLaneId,
	generateLaneSessionId,
	groupTasksByRepo,
	isGlobScope,
	nextWaveIndex,
	normalizeScope,
	pathStartsWithSegment,
	prefixOfGlob,
	resolveRepoRoot,
	scopesOverlap,
	taskScopesOverlap,
	tasksRemaining,
} from "../src/missioncontrol/waves";

function mkTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
	return {
		taskId: "t-1",
		taskName: "t-1",
		promptPath: "/tasks/t-1/PROMPT.md",
		statusPath: "/tasks/t-1/STATUS.md",
		dependencies: [],
		fileScope: [],
		...overrides,
	} as ParsedTask;
}

function mkWorkspace(entries: Array<[string, string]>): WorkspaceConfig {
	const repos = new Map<string, WorkspaceRepoConfig>();
	for (const [id, path] of entries) repos.set(id, { id, path });
	return {
		mode: "workspace",
		repos,
		routing: { tasksRoot: "tasks", defaultRepo: entries[0]?.[0] ?? "", taskPacketRepo: entries[0]?.[0] ?? "" },
		configPath: "",
	};
}

// ── MVP chunking ────────────────────────────────────────────────────────────

describe("chunkIntoWaves", () => {
	test("chunks evenly", () => {
		const waves = chunkIntoWaves(["a", "b", "c", "d"], 2);
		expect(waves).toHaveLength(2);
		expect(waves[0]).toEqual({ wave: 0, taskIds: ["a", "b"] });
		expect(waves[1]).toEqual({ wave: 1, taskIds: ["c", "d"] });
	});
	test("returns empty for waveSize <= 0", () => {
		expect(chunkIntoWaves(["a"], 0)).toEqual([]);
	});
});

describe("nextWaveIndex", () => {
	test("returns next index when available", () => {
		const w = chunkIntoWaves(["a", "b"], 1);
		expect(nextWaveIndex(0, w)).toBe(1);
	});
	test("returns null at end", () => {
		const w = chunkIntoWaves(["a", "b"], 1);
		expect(nextWaveIndex(1, w)).toBe(null);
	});
});

describe("tasksRemaining", () => {
	test("counts incomplete tasks across waves", () => {
		const w = chunkIntoWaves(["a", "b", "c"], 2);
		expect(tasksRemaining(w, new Set(["a"]))).toBe(2);
	});
});

// ── Scope helpers ───────────────────────────────────────────────────────────

describe("normalizeScope", () => {
	test("converts backslashes, collapses slashes, trims trailing slash", () => {
		expect(normalizeScope("  src\\\\foo//bar/ ")).toBe("src/foo/bar");
	});
});

describe("isGlobScope", () => {
	test("detects asterisk", () => {
		expect(isGlobScope("src/foo/*")).toBe(true);
		expect(isGlobScope("src/foo.ts")).toBe(false);
	});
});

describe("prefixOfGlob", () => {
	test("returns prefix up to first wildcard (trailing slash trimmed)", () => {
		expect(prefixOfGlob("src/foo/*")).toBe("src/foo");
		expect(prefixOfGlob("src/foo/*.ts")).toBe("src/foo");
	});
	test("returns whole string if no wildcard", () => {
		expect(prefixOfGlob("src/foo.ts")).toBe("src/foo.ts");
	});
});

describe("pathStartsWithSegment", () => {
	test("empty prefix matches anything", () => {
		expect(pathStartsWithSegment("anything", "")).toBe(true);
	});
	test("matches exact path", () => {
		expect(pathStartsWithSegment("src/foo", "src/foo")).toBe(true);
	});
	test("matches segment boundary", () => {
		expect(pathStartsWithSegment("src/foo/bar.ts", "src/foo")).toBe(true);
		expect(pathStartsWithSegment("src/foobar", "src/foo")).toBe(false);
	});
});

describe("scopesOverlap", () => {
	test("exact file paths overlap when identical", () => {
		expect(scopesOverlap("src/a.ts", "src/a.ts")).toBe(true);
	});
	test("different file paths do not overlap without glob", () => {
		expect(scopesOverlap("src/a.ts", "src/b.ts")).toBe(false);
	});
	test("glob covers file under prefix", () => {
		expect(scopesOverlap("src/foo/*", "src/foo/bar.ts")).toBe(true);
	});
	test("non-overlapping globs return false", () => {
		expect(scopesOverlap("src/foo/*", "src/bar/*")).toBe(false);
	});
});

describe("taskScopesOverlap", () => {
	test("returns true when any scope pair overlaps", () => {
		const a = mkTask({ taskId: "a", fileScope: ["src/foo/*"] });
		const b = mkTask({ taskId: "b", fileScope: ["src/foo/bar.ts"] });
		expect(taskScopesOverlap(a, b)).toBe(true);
	});
	test("returns false when no scope pair overlaps", () => {
		const a = mkTask({ taskId: "a", fileScope: ["src/foo/*"] });
		const b = mkTask({ taskId: "b", fileScope: ["src/bar/*"] });
		expect(taskScopesOverlap(a, b)).toBe(false);
	});
	test("returns false when either task has empty fileScope", () => {
		const a = mkTask({ taskId: "a", fileScope: [] });
		const b = mkTask({ taskId: "b", fileScope: ["src/foo/bar.ts"] });
		expect(taskScopesOverlap(a, b)).toBe(false);
	});
});

// ── Repo grouping ───────────────────────────────────────────────────────────

describe("groupTasksByRepo", () => {
	test("repo mode: all tasks land in one group with undefined repoId", () => {
		const pending = new Map([
			["t-1", mkTask({ taskId: "t-1" })],
			["t-2", mkTask({ taskId: "t-2" })],
		]);
		const groups = groupTasksByRepo(["t-1", "t-2"], pending);
		expect(groups).toHaveLength(1);
		expect(groups[0].repoId).toBeUndefined();
		expect(groups[0].taskIds).toEqual(["t-1", "t-2"]);
	});
	test("workspace mode: tasks grouped by resolvedRepoId, sorted", () => {
		const pending = new Map([
			["t-a", mkTask({ taskId: "t-a", resolvedRepoId: "alpha" })],
			["t-b", mkTask({ taskId: "t-b", resolvedRepoId: "beta" })],
			["t-a2", mkTask({ taskId: "t-a2", resolvedRepoId: "alpha" })],
		]);
		const groups = groupTasksByRepo(["t-b", "t-a2", "t-a"], pending);
		expect(groups).toHaveLength(2);
		expect(groups[0].repoId).toBe("alpha");
		expect(groups[0].taskIds).toEqual(["t-a", "t-a2"]);
		expect(groups[1].repoId).toBe("beta");
		expect(groups[1].taskIds).toEqual(["t-b"]);
	});
});

// ── Lane IDs ────────────────────────────────────────────────────────────────

describe("generateLaneId", () => {
	test("repo mode", () => {
		expect(generateLaneId(3)).toBe("lane-3");
	});
	test("workspace mode includes repo prefix", () => {
		expect(generateLaneId(3, "alpha")).toBe("alpha/lane-3");
	});
});

describe("generateLaneSessionId", () => {
	test("repo mode includes operator", () => {
		expect(generateLaneSessionId("orch", 2, "op1")).toBe("orch-op1-lane-2");
	});
	test("workspace mode includes operator + repo", () => {
		expect(generateLaneSessionId("orch", 2, "op1", "alpha")).toBe("orch-op1-alpha-lane-2");
	});
});

// ── resolveRepoRoot ─────────────────────────────────────────────────────────

describe("resolveRepoRoot", () => {
	test("returns default when repoId undefined", () => {
		expect(resolveRepoRoot(undefined, "/root")).toBe("/root");
	});
	test("returns default when no workspace config", () => {
		expect(resolveRepoRoot("alpha", "/root")).toBe("/root");
	});
	test("returns repo path from workspace config", () => {
		const ws = mkWorkspace([
			["alpha", "/repos/alpha"],
			["beta", "/repos/beta"],
		]);
		expect(resolveRepoRoot("beta", "/root", ws)).toBe("/repos/beta");
	});
	test("falls back to default for unknown repo id", () => {
		const ws = mkWorkspace([["alpha", "/repos/alpha"]]);
		expect(resolveRepoRoot("missing", "/root", ws)).toBe("/root");
	});
});
