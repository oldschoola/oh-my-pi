/**
 * Tests for `generateBatchSummary` ported from taskplane
 * `extensions/taskplane/supervisor.ts:1779`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	generateBatchSummary,
	type MissionBatchRuntimeState,
	missionBatchPath,
	projectDir,
	supervisorDir,
} from "../src/missioncontrol";

function sandbox(label: string): string {
	return mkdtempSync(join(tmpdir(), `omp-gen-summary-${label}-`));
}

function runtimeState(overrides?: Partial<MissionBatchRuntimeState>): MissionBatchRuntimeState {
	return {
		batchId: "b-sum-1",
		phase: "completed",
		baseBranch: "main",
		orchBranch: "mission/b-sum-1",
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_300_000,
		currentWaveIndex: 1,
		totalWaves: 1,
		totalTasks: 3,
		succeededTasks: 3,
		failedTasks: 0,
		skippedTasks: 0,
		blockedTasks: 0,
		waveResults: [],
		...overrides,
	} as MissionBatchRuntimeState;
}

describe("generateBatchSummary", () => {
	test("returns markdown containing batch id + result line", () => {
		const dir = sandbox("happy");
		try {
			const md = generateBatchSummary(runtimeState(), dir, "op-42");
			expect(md).toContain("# Batch Summary: b-sum-1");
			expect(md).toContain("3/3 tasks succeeded");
			expect(md).toContain("**Phase:** completed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("writes summary to <.omp>/supervisor/<opId>-<batchId>-summary.md", () => {
		const dir = sandbox("writes");
		try {
			generateBatchSummary(runtimeState(), dir, "op-99");
			const expected = join(supervisorDir(dir), "op-99-b-sum-1-summary.md");
			expect(existsSync(expected)).toBe(true);
			const contents = readFileSync(expected, "utf-8");
			expect(contents).toContain("Batch Summary: b-sum-1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("best-effort: swallows write failure when .omp is a file", () => {
		const dir = sandbox("fail");
		try {
			// Create `.omp` as a file so mkdirSync throws
			const ompPath = projectDir(dir);
			require("node:fs").writeFileSync(ompPath, "blocker", "utf-8");
			const md = generateBatchSummary(runtimeState(), dir, "op-bad");
			expect(md).toContain("Batch Summary: b-sum-1");
			// No assertion about file contents — write failed silently
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("markdown omits cost line as '$0.00' when diagnostics.batchCost > 0", () => {
		const dir = sandbox("cost");
		try {
			const md = generateBatchSummary(runtimeState(), dir, "op-c", {
				taskExits: {},
				batchCost: 1.23,
			});
			expect(md).toContain("**Cost:** $1.23");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("handles empty mergeResults + null diagnostics", () => {
		const dir = sandbox("empty");
		try {
			const md = generateBatchSummary(runtimeState(), dir, "op-e", null, []);
			expect(md).toContain("Batch Summary: b-sum-1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// Keep lint happy — ensure missionBatchPath is used (imported for completeness).
void missionBatchPath;
