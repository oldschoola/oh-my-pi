/**
 * Unit tests for mission-checkpoint (Track H5).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PersistedBatchState, PersistedTaskRecord, ValidationContract } from "../src/missioncontrol";
import {
	CHECKPOINTS_DIRNAME,
	checkpointPath,
	checkpointsDir,
	renderCheckpointMarkdown,
	timestampSlug,
	writeMissionCheckpoint,
} from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-checkpoint-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function task(overrides: Partial<PersistedTaskRecord> = {}): PersistedTaskRecord {
	return {
		taskId: "F-001",
		laneNumber: 1,
		sessionName: "s",
		status: "succeeded",
		taskFolder: "tasks/F-001",
		startedAt: 100,
		endedAt: 500,
		doneFileFound: true,
		exitReason: "",
		...overrides,
	};
}

function mkState(overrides: Partial<PersistedBatchState> = {}): PersistedBatchState {
	return {
		schemaVersion: 5,
		batchId: "batch-042",
		phase: "executing",
		lanes: [],
		tasks: [task()],
		wavePlan: [["F-001"]],
		startedAt: Date.parse("2026-04-20T08:00:00.000Z"),
		updatedAt: Date.parse("2026-04-22T09:30:00.000Z"),
		totalTasks: 1,
		succeededTasks: 1,
		failedTasks: 0,
		skippedTasks: 0,
		blockedTasks: 0,
		...overrides,
	};
}

function mkContract(): ValidationContract {
	return {
		schemaVersion: 1,
		missionId: "batch-042",
		createdAt: 0,
		updatedAt: 1,
		assertions: [
			{
				id: "VA-001",
				area: "cli",
				title: "Help renders",
				description: "CLI --help prints usage.",
				acceptanceCriteria: ["exit 0", "contains usage"],
			},
		],
	};
}

describe("timestampSlug + checkpointPath + checkpointsDir", () => {
	test("timestampSlug follows YYYYMMDDThhmmss pattern", () => {
		const slug = timestampSlug(new Date("2026-04-22T10:15:30.000Z"));
		expect(slug).toBe("20260422T101530");
	});

	test("checkpointPath includes sanitised batchId + slug", () => {
		const p = checkpointPath(sandbox, "batch/42:", new Date("2026-04-22T10:15:30.000Z"));
		expect(p).toBe(join(checkpointsDir(sandbox), "batch_42_-20260422T101530.md"));
	});

	test("checkpointsDir resolves under <projectDir>/checkpoints/", () => {
		expect(checkpointsDir(sandbox).endsWith(CHECKPOINTS_DIRNAME)).toBe(true);
	});
});

describe("renderCheckpointMarkdown", () => {
	test("includes batchId, phase, tallies, and tasks", () => {
		const md = renderCheckpointMarkdown({
			state: mkState(),
			now: new Date("2026-04-22T10:15:00.000Z"),
		});
		expect(md).toContain("# Mission Checkpoint \u2014 batch-042");
		expect(md).toContain("**Phase:** executing");
		expect(md).toContain("- F-001: succeeded");
		expect(md).toContain("Succeeded: 1");
		expect(md).toContain("Total: 1");
	});

	test("renders day count relative to now", () => {
		const md = renderCheckpointMarkdown({
			state: mkState(),
			now: new Date("2026-04-22T10:00:00.000Z"),
		});
		expect(md).toContain("2 days ago");
	});

	test("renders milestones when present", () => {
		const md = renderCheckpointMarkdown({
			state: mkState({
				milestones: [
					{
						id: "M-001",
						name: "Core",
						featureIds: ["F-001"],
						assertionIds: ["VA-001"],
						status: "in_progress",
						validationRounds: 1,
						maxValidationRounds: 4,
					},
				],
			}),
			now: new Date("2026-04-22T10:00:00.000Z"),
		});
		expect(md).toContain("- M-001 (Core) \u2014 status: in_progress, rounds 1/4");
	});

	test("renders validation contract assertions when provided", () => {
		const md = renderCheckpointMarkdown({
			state: mkState(),
			contract: mkContract(),
			now: new Date("2026-04-22T10:00:00.000Z"),
		});
		expect(md).toContain("## Validation Contract");
		expect(md).toContain("- VA-001 [cli]: Help renders");
	});

	test("flags fix features in the feature list", () => {
		const md = renderCheckpointMarkdown({
			state: mkState({
				tasks: [
					task({ taskId: "F-001" }),
					task({ taskId: "FIX-001-001", isFixFeature: true, parentFeatureId: "F-001", status: "pending" }),
				],
			}),
			now: new Date("2026-04-22T10:00:00.000Z"),
		});
		expect(md).toContain("- FIX-001-001: pending [fix feature] (parent: F-001)");
	});

	test("appends operator note when supplied", () => {
		const md = renderCheckpointMarkdown({
			state: mkState(),
			note: "Handoff to EU shift.",
			now: new Date("2026-04-22T10:00:00.000Z"),
		});
		expect(md).toContain("## Operator Note");
		expect(md).toContain("Handoff to EU shift.");
	});

	test("elides operator note section when absent or blank", () => {
		const md = renderCheckpointMarkdown({
			state: mkState(),
			note: "   ",
			now: new Date("2026-04-22T10:00:00.000Z"),
		});
		expect(md).not.toContain("## Operator Note");
	});
});

describe("writeMissionCheckpoint", () => {
	test("writes a Markdown file to <projectDir>/checkpoints/", async () => {
		const now = new Date("2026-04-22T10:00:00.000Z");
		const filePath = await writeMissionCheckpoint(sandbox, {
			state: mkState(),
			now,
		});
		expect(existsSync(filePath)).toBe(true);
		const content = readFileSync(filePath, "utf-8");
		expect(content).toContain("# Mission Checkpoint \u2014 batch-042");
	});

	test("creates the checkpoints directory on first write", async () => {
		expect(existsSync(checkpointsDir(sandbox))).toBe(false);
		await writeMissionCheckpoint(sandbox, { state: mkState() });
		expect(existsSync(checkpointsDir(sandbox))).toBe(true);
	});
});
