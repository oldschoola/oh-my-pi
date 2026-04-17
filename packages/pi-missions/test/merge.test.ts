/**
 * Tests for `missioncontrol/merge.ts` pure helpers.
 *
 * Covers `parseMergeResult` / `parseMergeResultAsync` (happy path, alias
 * keys, flat verification, conflict filtering, unknown status fallback,
 * missing-field errors, missing file, empty/invalid JSON),
 * `determineMergeOrder` (fewest-files-first + tie-break, sequential),
 * `buildMergeRequest` (structure + POSIX path normalization), and
 * `classifyMergeHealth` (dead / healthy / warning / stuck transitions).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AllocatedLane, AllocatedTask, MergeSessionHealthState, ParsedTask } from "../src/missioncontrol";
import {
	buildMergeRequest,
	classifyMergeHealth,
	determineMergeOrder,
	MERGE_HEALTH_STUCK_THRESHOLD_MS,
	MERGE_HEALTH_WARNING_THRESHOLD_MS,
	MergeError,
	parseMergeResult,
	parseMergeResultAsync,
} from "../src/missioncontrol";

function makeTmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function writeResult(dir: string, body: string): string {
	const p = join(dir, "RESULT.md");
	writeFileSync(p, body);
	return p;
}

function makeParsedTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
	return {
		taskId: "T-1",
		taskName: "demo",
		folderPath: "/repo/tasks/T-1",
		promptPath: "/repo/tasks/T-1/PROMPT.md",
		prompt: "",
		dependencies: [],
		size: "M",
		...overrides,
	} satisfies ParsedTask;
}

function makeAllocatedTask(taskId: string, task: ParsedTask): AllocatedTask {
	return { taskId, order: 1, task, estimatedMinutes: 30 };
}

function makeLane(overrides: Partial<AllocatedLane> = {}): AllocatedLane {
	return {
		laneNumber: 1,
		laneId: "lane-1",
		laneSessionId: "mission-henry-lane-1",
		worktreePath: "/wt",
		branch: "task/henry-lane-1-a",
		tasks: [],
		strategy: "round-robin",
		estimatedLoad: 1,
		estimatedMinutes: 30,
		...overrides,
	} as AllocatedLane;
}

function makeHealth(overrides: Partial<MergeSessionHealthState> = {}): MergeSessionHealthState {
	return {
		sessionName: "mission-merge-1",
		laneNumber: 1,
		lastSnapshot: null,
		lastActivityAt: 0,
		status: "healthy",
		warningEmitted: false,
		stuckEmitted: false,
		deadEmitted: false,
		...overrides,
	};
}

// ── parseMergeResult / parseMergeResultAsync ─────────────────────────

describe("parseMergeResult", () => {
	test("parses a canonical success result", () => {
		const dir = makeTmp("merge-ok-");
		try {
			const path = writeResult(
				dir,
				JSON.stringify({
					status: "SUCCESS",
					source_branch: "task/a",
					target_branch: "develop",
					merge_commit: "abc123",
					conflicts: [],
					verification: { ran: true, passed: true, output: "ok" },
				}),
			);
			const result = parseMergeResult(path);
			expect(result.status).toBe("SUCCESS");
			expect(result.source_branch).toBe("task/a");
			expect(result.target_branch).toBe("develop");
			expect(result.merge_commit).toBe("abc123");
			expect(result.conflicts).toEqual([]);
			expect(result.verification).toEqual({ ran: true, passed: true, output: "ok" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("accepts camelCase alias keys for source/target/merge_commit", () => {
		const dir = makeTmp("merge-alias-");
		try {
			const path = writeResult(
				dir,
				JSON.stringify({
					status: "success",
					sourceBranch: "task/b",
					targetBranch: "develop",
					mergeCommit: "def456",
					verification: { ran: true, passed: true, output: "" },
				}),
			);
			const result = parseMergeResult(path);
			expect(result.status).toBe("SUCCESS");
			expect(result.source_branch).toBe("task/b");
			expect(result.target_branch).toBe("develop");
			expect(result.merge_commit).toBe("def456");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reconstructs verification from flat keys when nested is absent", () => {
		const dir = makeTmp("merge-flat-");
		try {
			const path = writeResult(
				dir,
				JSON.stringify({
					status: "SUCCESS",
					source_branch: "task/c",
					verification_passed: true,
					verification_exit_code: 0,
					verification_output: "flat output",
				}),
			);
			const result = parseMergeResult(path);
			expect(result.verification.ran).toBe(true);
			expect(result.verification.passed).toBe(true);
			expect(result.verification.output).toBe("flat output");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("filters malformed conflicts and preserves well-formed ones", () => {
		const dir = makeTmp("merge-conflicts-");
		try {
			const path = writeResult(
				dir,
				JSON.stringify({
					status: "CONFLICT_RESOLVED",
					source_branch: "task/d",
					verification: { ran: true, passed: true, output: "" },
					conflicts: [
						{ file: "a.ts", type: "content", resolved: true, resolution: "kept ours" },
						{ file: "b.ts", type: "content", resolved: "no" }, // bad `resolved`
						null,
						{ file: "c.ts", type: "content", resolved: false },
					],
				}),
			);
			const result = parseMergeResult(path);
			expect(result.conflicts).toEqual([
				{ file: "a.ts", type: "content", resolved: true, resolution: "kept ours" },
				{ file: "c.ts", type: "content", resolved: false },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("maps unknown status values to BUILD_FAILURE", () => {
		const dir = makeTmp("merge-unknown-");
		try {
			const path = writeResult(
				dir,
				JSON.stringify({
					status: "WEIRD_STATUS",
					source_branch: "task/e",
					verification: { ran: false, passed: false, output: "" },
				}),
			);
			const result = parseMergeResult(path);
			expect(result.status).toBe("BUILD_FAILURE");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("throws MERGE_RESULT_MISSING_FIELDS when status is absent", () => {
		const dir = makeTmp("merge-nostat-");
		try {
			const path = writeResult(
				dir,
				JSON.stringify({
					source_branch: "task/f",
					verification: { ran: true, passed: true, output: "" },
				}),
			);
			expect(() => parseMergeResult(path)).toThrow(MergeError);
			try {
				parseMergeResult(path);
			} catch (err) {
				expect((err as MergeError).code).toBe("MERGE_RESULT_MISSING_FIELDS");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("throws MERGE_RESULT_MISSING_FIELDS when source_branch absent", () => {
		const dir = makeTmp("merge-nosrc-");
		try {
			const path = writeResult(
				dir,
				JSON.stringify({
					status: "SUCCESS",
					verification: { ran: true, passed: true, output: "" },
				}),
			);
			expect(() => parseMergeResult(path)).toThrow(/source_branch/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("throws MERGE_RESULT_MISSING_FIELDS when verification absent", () => {
		const dir = makeTmp("merge-noverif-");
		try {
			const path = writeResult(
				dir,
				JSON.stringify({
					status: "SUCCESS",
					source_branch: "task/g",
				}),
			);
			expect(() => parseMergeResult(path)).toThrow(/verification/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("throws MERGE_RESULT_INVALID when file missing", () => {
		expect(() => parseMergeResult(join(tmpdir(), "does-not-exist-mission-merge.json"))).toThrow(/not found/);
	});
});

describe("parseMergeResultAsync", () => {
	test("parses canonical result asynchronously", async () => {
		const dir = makeTmp("merge-async-");
		try {
			const path = writeResult(
				dir,
				JSON.stringify({
					status: "SUCCESS",
					source_branch: "task/h",
					verification: { ran: true, passed: true, output: "" },
				}),
			);
			const result = await parseMergeResultAsync(path);
			expect(result.status).toBe("SUCCESS");
			expect(result.source_branch).toBe("task/h");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("propagates MergeError on missing fields", async () => {
		const dir = makeTmp("merge-async-err-");
		try {
			const path = writeResult(dir, JSON.stringify({ status: "SUCCESS" }));
			await expect(parseMergeResultAsync(path)).rejects.toThrow(MergeError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ── determineMergeOrder ─────────────────────────────────────────────

describe("determineMergeOrder", () => {
	test("sequential order sorts by lane number ascending", () => {
		const lanes = [
			makeLane({ laneNumber: 3, branch: "task/c" }),
			makeLane({ laneNumber: 1, branch: "task/a" }),
			makeLane({ laneNumber: 2, branch: "task/b" }),
		];
		const ordered = determineMergeOrder(lanes, "sequential");
		expect(ordered.map(l => l.laneNumber)).toEqual([1, 2, 3]);
	});

	test("fewest-files-first sorts by file scope size with branch tiebreak", () => {
		const small = makeLane({
			laneNumber: 5,
			branch: "zz-small",
			tasks: [makeAllocatedTask("A", makeParsedTask({ taskId: "A", fileScope: ["a.ts"] }))],
		});
		const tied1 = makeLane({
			laneNumber: 3,
			branch: "bb-mid",
			tasks: [makeAllocatedTask("B", makeParsedTask({ taskId: "B", fileScope: ["b.ts", "c.ts"] }))],
		});
		const tied2 = makeLane({
			laneNumber: 2,
			branch: "aa-mid",
			tasks: [makeAllocatedTask("C", makeParsedTask({ taskId: "C", fileScope: ["d.ts", "e.ts"] }))],
		});
		const big = makeLane({
			laneNumber: 1,
			branch: "cc-big",
			tasks: [makeAllocatedTask("D", makeParsedTask({ taskId: "D", fileScope: ["f.ts", "g.ts", "h.ts"] }))],
		});

		const ordered = determineMergeOrder([big, tied1, tied2, small], "fewest-files-first");
		expect(ordered.map(l => l.branch)).toEqual(["zz-small", "aa-mid", "bb-mid", "cc-big"]);
	});

	test("does not mutate the input array", () => {
		const lanes = [makeLane({ laneNumber: 2 }), makeLane({ laneNumber: 1 })];
		const snapshot = lanes.map(l => l.laneNumber);
		determineMergeOrder(lanes, "sequential");
		expect(lanes.map(l => l.laneNumber)).toEqual(snapshot);
	});
});

// ── buildMergeRequest ───────────────────────────────────────────────

describe("buildMergeRequest", () => {
	test("emits all required sections with POSIX result path", () => {
		const lane = makeLane({
			laneNumber: 2,
			branch: "task/henry-lane-2-b-1",
			tasks: [
				makeAllocatedTask(
					"T-1",
					makeParsedTask({ taskId: "T-1", taskName: "first task", fileScope: ["a.ts", "b.ts"] }),
				),
				makeAllocatedTask(
					"T-2",
					makeParsedTask({ taskId: "T-2", taskName: "second task", fileScope: ["b.ts", "c.ts"] }),
				),
			],
		});

		const request = buildMergeRequest(lane, "develop", 3, ["bun check", "bun test"], "C:\\tmp\\RESULT.md");

		expect(request).toContain("# Merge Request");
		expect(request).toContain("## Source Branch\ntask/henry-lane-2-b-1");
		expect(request).toContain("## Target Branch\ndevelop");
		expect(request).toContain("## Merge Message\nmerge: wave 3 lane 2 — T-1, T-2");
		expect(request).toContain("- T-1: first task");
		expect(request).toContain("- T-2: second task");
		// Deduplicated file scope
		expect(request).toContain("- a.ts\n- b.ts\n- c.ts");
		expect(request).toContain("```bash\nbun check\n```");
		expect(request).toContain("```bash\nbun test\n```");
		// Path normalized to forward slashes
		expect(request).toContain("result_file: C:/tmp/RESULT.md");
		expect(request).toContain("EXACTLY this path (do NOT modify or convert it): C:/tmp/RESULT.md");
		expect(request).not.toContain("C:\\tmp\\RESULT.md");
		// Schema must reference snake_case fields
		expect(request).toContain('"source_branch"');
		expect(request).toContain('"merge_commit"');
	});

	test("falls back to '(no file scope declared)' when tasks have no fileScope", () => {
		const lane = makeLane({
			tasks: [makeAllocatedTask("T-X", makeParsedTask({ taskId: "T-X" }))],
		});
		const request = buildMergeRequest(lane, "main", 1, ["bun test"], "/tmp/r.md");
		expect(request).toContain("- (no file scope declared)");
	});
});

// ── classifyMergeHealth ─────────────────────────────────────────────

describe("classifyMergeHealth", () => {
	test("dead when session exited without a result file", () => {
		expect(classifyMergeHealth(false, false, makeHealth(), Date.now())).toBe("dead");
	});

	test("healthy when session exited but wrote a result file", () => {
		expect(classifyMergeHealth(false, true, makeHealth(), Date.now())).toBe("healthy");
	});

	test("healthy when session alive and recent activity", () => {
		const now = 1_000_000;
		const state = makeHealth({ lastActivityAt: now - 60_000 });
		expect(classifyMergeHealth(true, false, state, now)).toBe("healthy");
	});

	test("warning at exactly the warning threshold", () => {
		const now = 5_000_000;
		const state = makeHealth({ lastActivityAt: now - MERGE_HEALTH_WARNING_THRESHOLD_MS });
		expect(classifyMergeHealth(true, false, state, now)).toBe("warning");
	});

	test("stuck at exactly the stuck threshold", () => {
		const now = 9_000_000;
		const state = makeHealth({ lastActivityAt: now - MERGE_HEALTH_STUCK_THRESHOLD_MS });
		expect(classifyMergeHealth(true, false, state, now)).toBe("stuck");
	});

	test("stuck beats warning when both thresholds are exceeded", () => {
		const now = 20_000_000;
		const state = makeHealth({
			lastActivityAt: now - (MERGE_HEALTH_STUCK_THRESHOLD_MS + 1_000),
		});
		expect(classifyMergeHealth(true, false, state, now)).toBe("stuck");
	});
});
