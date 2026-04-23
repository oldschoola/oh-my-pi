/**
 * Track H3: milestone validator resume reconciliation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	enrichResumePointWithMilestoneValidators,
	type MilestoneValidatorOutput,
	type ResumePoint,
	reconcileMilestoneValidators,
	validationOutputPath,
} from "../src/missioncontrol";
import type { Milestone, PersistedBatchState } from "../src/missioncontrol/types";

let sandbox: string;

function seedBatch(milestones: Milestone[], batchId = "batch-A"): PersistedBatchState {
	return {
		schemaVersion: 5,
		phase: "executing",
		batchId,
		lanes: [],
		tasks: [],
		wavePlan: [],
		milestones,
	};
}

function writeValidatorOutput(
	batchId: string,
	milestoneId: string,
	round: number,
	kind: "scrutiny" | "user-testing",
	verdict: MilestoneValidatorOutput["verdict"] = "pass",
): string {
	const target = validationOutputPath(sandbox, batchId, milestoneId, round, kind);
	mkdirSync(dirname(target), { recursive: true });
	const payload: MilestoneValidatorOutput = {
		schemaVersion: 1,
		validator: kind,
		milestoneId,
		round,
		startedAt: 0,
		completedAt: 1,
		verdict,
		summary: `${kind} round ${round}`,
		findings: [],
		lessons: [],
	};
	writeFileSync(target, JSON.stringify(payload), "utf-8");
	return target;
}

function milestone(id: string, overrides: Partial<Milestone> = {}): Milestone {
	return {
		id,
		name: id,
		featureIds: [],
		assertionIds: [],
		status: "validating",
		validationRounds: 1,
		maxValidationRounds: 4,
		...overrides,
	};
}

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-milestone-resume-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

describe("reconcileMilestoneValidators", () => {
	test("skips milestones not in validating status", async () => {
		const batch = seedBatch([
			milestone("M-001", { status: "pending" }),
			milestone("M-002", { status: "in_progress" }),
			milestone("M-003", { status: "passed" }),
			milestone("M-004", { status: "failed" }),
		]);
		const out = await reconcileMilestoneValidators(batch, sandbox);
		expect(out).toEqual([]);
	});

	test("missing outputs schedule both re-spawns", async () => {
		const batch = seedBatch([milestone("M-001")]);
		const out = await reconcileMilestoneValidators(batch, sandbox);
		expect(out).toHaveLength(1);
		const rec = out[0];
		expect(rec?.round).toBe(1);
		expect(rec?.slots).toHaveLength(2);
		expect(rec?.slots.every(s => s.needsRespawn)).toBe(true);
		expect(rec?.slots.map(s => s.kind)).toEqual(["scrutiny", "user-testing"]);
	});

	test("existing parseable output skips re-spawn", async () => {
		const batch = seedBatch([milestone("M-001")]);
		writeValidatorOutput("batch-A", "M-001", 1, "scrutiny");
		writeValidatorOutput("batch-A", "M-001", 1, "user-testing");
		const out = await reconcileMilestoneValidators(batch, sandbox);
		expect(out[0]?.slots.every(s => !s.needsRespawn)).toBe(true);
	});

	test("only one output present → the other schedules re-spawn", async () => {
		const batch = seedBatch([milestone("M-001")]);
		writeValidatorOutput("batch-A", "M-001", 1, "scrutiny");
		const out = await reconcileMilestoneValidators(batch, sandbox);
		const scrutiny = out[0]?.slots.find(s => s.kind === "scrutiny");
		const userTesting = out[0]?.slots.find(s => s.kind === "user-testing");
		expect(scrutiny?.needsRespawn).toBe(false);
		expect(userTesting?.needsRespawn).toBe(true);
		expect(userTesting?.parseError).toBeDefined();
	});

	test("malformed JSON schedules re-spawn with parseError", async () => {
		const batch = seedBatch([milestone("M-001")]);
		const target = validationOutputPath(sandbox, "batch-A", "M-001", 1, "scrutiny");
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, "{ not valid json", "utf-8");
		const out = await reconcileMilestoneValidators(batch, sandbox);
		const scrutiny = out[0]?.slots.find(s => s.kind === "scrutiny");
		expect(scrutiny?.needsRespawn).toBe(true);
		expect(scrutiny?.parseError).toContain("JSON");
	});

	test("wrong-kind output (scrutiny written at user-testing path) schedules re-spawn", async () => {
		const batch = seedBatch([milestone("M-001")]);
		// Write a scrutiny payload at the user-testing output path.
		const target = validationOutputPath(sandbox, "batch-A", "M-001", 1, "user-testing");
		mkdirSync(dirname(target), { recursive: true });
		const payload: MilestoneValidatorOutput = {
			schemaVersion: 1,
			validator: "scrutiny",
			milestoneId: "M-001",
			round: 1,
			startedAt: 0,
			completedAt: 1,
			verdict: "pass",
			summary: "scrutiny",
			findings: [],
			lessons: [],
		};
		writeFileSync(target, JSON.stringify(payload), "utf-8");
		const out = await reconcileMilestoneValidators(batch, sandbox);
		const userTesting = out[0]?.slots.find(s => s.kind === "user-testing");
		expect(userTesting?.needsRespawn).toBe(true);
		expect(userTesting?.parseError).toContain("expected user-testing output");
	});

	test("corrupt round=0 returns slots marked for re-spawn at round=1", async () => {
		const batch = seedBatch([milestone("M-001", { validationRounds: 0 })]);
		const out = await reconcileMilestoneValidators(batch, sandbox);
		expect(out[0]?.round).toBe(1);
		expect(out[0]?.slots.every(s => s.needsRespawn)).toBe(true);
	});

	test("multiple milestones produce distinct reconciliations", async () => {
		const batch = seedBatch([
			milestone("M-001", { validationRounds: 2 }),
			milestone("M-002", { validationRounds: 3 }),
		]);
		writeValidatorOutput("batch-A", "M-001", 2, "scrutiny");
		writeValidatorOutput("batch-A", "M-001", 2, "user-testing");
		const out = await reconcileMilestoneValidators(batch, sandbox);
		expect(out).toHaveLength(2);
		expect(out[0]?.milestoneId).toBe("M-001");
		expect(out[0]?.round).toBe(2);
		expect(out[0]?.slots.every(s => !s.needsRespawn)).toBe(true);
		expect(out[1]?.milestoneId).toBe("M-002");
		expect(out[1]?.round).toBe(3);
		expect(out[1]?.slots.every(s => s.needsRespawn)).toBe(true);
	});

	test("empty milestones array yields empty reconciliation", async () => {
		const batch = seedBatch([]);
		expect(await reconcileMilestoneValidators(batch, sandbox)).toEqual([]);
	});

	test("respects injected parseResult override for tests", async () => {
		const batch = seedBatch([milestone("M-001")]);
		const calls: string[] = [];
		const out = await reconcileMilestoneValidators(batch, sandbox, {
			parseResult: async path => {
				calls.push(path);
				return {
					schemaVersion: 1,
					validator: path.includes("scrutiny") ? "scrutiny" : "user-testing",
					milestoneId: "M-001",
					round: 1,
					startedAt: 0,
					completedAt: 1,
					verdict: "pass",
					summary: "ok",
					findings: [],
					lessons: [],
				};
			},
		});
		expect(calls).toHaveLength(2);
		expect(out[0]?.slots.every(s => !s.needsRespawn)).toBe(true);
	});
});

describe("enrichResumePointWithMilestoneValidators", () => {
	const baseResumePoint: ResumePoint = {
		resumeWaveIndex: 0,
		completedTaskIds: [],
		pendingTaskIds: [],
		failedTaskIds: [],
		reconnectTaskIds: [],
		reExecuteTaskIds: [],
		mergeRetryWaveIndexes: [],
	};

	test("passthrough when no milestones need reconciliation", async () => {
		const batch = seedBatch([milestone("M-001", { status: "pending" })]);
		const enriched = await enrichResumePointWithMilestoneValidators(baseResumePoint, batch, sandbox);
		expect(enriched.milestoneValidatorActions).toBeUndefined();
		expect(enriched).toBe(baseResumePoint);
	});

	test("attaches reconciliation when milestones are validating", async () => {
		const batch = seedBatch([milestone("M-001")]);
		const enriched = await enrichResumePointWithMilestoneValidators(baseResumePoint, batch, sandbox);
		expect(enriched.milestoneValidatorActions).toHaveLength(1);
		expect(enriched.milestoneValidatorActions?.[0]?.milestoneId).toBe("M-001");
		// Original ResumePoint untouched.
		expect(baseResumePoint.milestoneValidatorActions).toBeUndefined();
	});
});
