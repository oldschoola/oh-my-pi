/**
 * Unit tests for the v4→v5 schema upconvert (Track A2).
 *
 * Complements persistence-upconvert.test.ts; exercises only the new v5
 * path (milestones + per-task milestoneId) without re-covering v1–v4.
 */

import { describe, expect, test } from "bun:test";
import {
	BATCH_STATE_SCHEMA_VERSION,
	StateFileError,
	upconvertV1toV2,
	upconvertV2toV3,
	upconvertV3toV4,
	upconvertV4toV5,
	validatePersistedState,
} from "../src/missioncontrol";

function v4(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 4,
		phase: "paused",
		batchId: "b-1",
		baseBranch: "main",
		orchBranch: "",
		mode: "repo",
		startedAt: 1,
		updatedAt: 2,
		endedAt: null,
		currentWaveIndex: 0,
		totalWaves: 1,
		totalTasks: 2,
		succeededTasks: 0,
		failedTasks: 0,
		skippedTasks: 0,
		blockedTasks: 0,
		blockedTaskIds: [],
		wavePlan: [["t-1", "t-2"]],
		lanes: [
			{
				laneNumber: 1,
				laneId: "l-1",
				laneSessionId: "sess-1",
				worktreePath: "/wt/1",
				branch: "b1",
				taskIds: ["t-1", "t-2"],
			},
		],
		tasks: [
			{
				taskId: "t-1",
				laneNumber: 1,
				sessionName: "s",
				status: "pending",
				taskFolder: "tasks/t-1",
				startedAt: null,
				endedAt: null,
				doneFileFound: false,
				exitReason: "",
			},
			{
				taskId: "t-2",
				laneNumber: 1,
				sessionName: "s",
				status: "pending",
				taskFolder: "tasks/t-2",
				startedAt: null,
				endedAt: null,
				doneFileFound: false,
				exitReason: "",
			},
		],
		mergeResults: [],
		errors: [],
		lastError: null,
		resilience: {
			resumeForced: false,
			retryCountByScope: {},
			lastFailureClass: null,
			repairHistory: [],
		},
		diagnostics: { taskExits: {}, batchCost: 0 },
		segments: [],
		...overrides,
	};
}

describe("upconvertV4toV5", () => {
	test("bumps schemaVersion to 5", () => {
		const obj = v4();
		upconvertV4toV5(obj);
		expect(obj.schemaVersion).toBe(5);
	});

	test("adds a single M-001 milestone spanning all wavePlan tasks", () => {
		const obj = v4();
		upconvertV4toV5(obj);
		const milestones = obj.milestones as Array<{ id: string; featureIds: string[]; status: string }>;
		expect(milestones).toHaveLength(1);
		expect(milestones[0]).toMatchObject({
			id: "M-001",
			name: "Mission",
			featureIds: ["t-1", "t-2"],
			assertionIds: [],
			status: "pending",
			validationRounds: 0,
			maxValidationRounds: 4,
		});
	});

	test("backfills milestoneId on every task record", () => {
		const obj = v4();
		upconvertV4toV5(obj);
		for (const t of obj.tasks as Array<{ milestoneId: string }>) {
			expect(t.milestoneId).toBe("M-001");
		}
	});

	test("preserves existing milestones when present", () => {
		const existing = [
			{
				id: "M-042",
				name: "Custom",
				featureIds: ["t-1"],
				assertionIds: [],
				status: "in_progress",
				validationRounds: 1,
				maxValidationRounds: 3,
			},
		];
		const obj = v4({ milestones: existing });
		upconvertV4toV5(obj);
		expect(obj.milestones).toBe(existing);
	});

	test("preserves existing task milestoneId when set", () => {
		const obj = v4();
		(obj.tasks as Array<Record<string, unknown>>)[0]!.milestoneId = "M-999";
		upconvertV4toV5(obj);
		expect((obj.tasks as Array<Record<string, unknown>>)[0]!.milestoneId).toBe("M-999");
		// Second task falls back to implicit M-001.
		expect((obj.tasks as Array<Record<string, unknown>>)[1]!.milestoneId).toBe("M-001");
	});

	test("is a no-op on already-v5 object", () => {
		const obj: Record<string, unknown> = { ...v4(), schemaVersion: 5 };
		upconvertV4toV5(obj);
		expect(obj.schemaVersion).toBe(5);
		// No milestones implicitly added when already v5.
		expect(obj.milestones).toBeUndefined();
	});

	test("is idempotent when called twice", () => {
		const obj = v4();
		upconvertV4toV5(obj);
		const snapshot = JSON.parse(JSON.stringify(obj));
		upconvertV4toV5(obj);
		expect(obj).toEqual(snapshot);
	});

	test("handles empty wavePlan", () => {
		const obj = v4({ wavePlan: [] });
		upconvertV4toV5(obj);
		const milestones = obj.milestones as Array<{ featureIds: string[] }>;
		expect(milestones[0]?.featureIds).toEqual([]);
	});
});

describe("chained upconvert v1 → v5", () => {
	test("produces a fully populated v5 object from a v1 object", () => {
		const obj: Record<string, unknown> = {
			schemaVersion: 1,
			phase: "idle",
			batchId: "b-1",
			lanes: [],
			tasks: [],
			wavePlan: [],
		};
		upconvertV1toV2(obj);
		upconvertV2toV3(obj);
		upconvertV3toV4(obj);
		upconvertV4toV5(obj);
		expect(obj.schemaVersion).toBe(BATCH_STATE_SCHEMA_VERSION);
		expect(Array.isArray(obj.milestones)).toBe(true);
		expect(obj.segments).toEqual([]);
	});
});

describe("validatePersistedState accepts v5", () => {
	test("round-trips a v5 state with milestones + fix features", () => {
		const v5 = v4({
			schemaVersion: 5,
			milestones: [
				{
					id: "M-001",
					name: "Core loop",
					featureIds: ["t-1", "t-2"],
					assertionIds: ["VA-001"],
					status: "validating",
					validationRounds: 2,
					maxValidationRounds: 4,
					startedAt: 100,
				},
			],
		});
		(v5.tasks as Array<Record<string, unknown>>)[0]!.milestoneId = "M-001";
		(v5.tasks as Array<Record<string, unknown>>)[0]!.fulfillsAssertionIds = ["VA-001"];
		(v5.tasks as Array<Record<string, unknown>>)[1]!.milestoneId = "M-001";
		(v5.tasks as Array<Record<string, unknown>>)[1]!.isFixFeature = true;
		(v5.tasks as Array<Record<string, unknown>>)[1]!.parentFeatureId = "t-1";
		expect(() => validatePersistedState(v5)).not.toThrow();
	});

	test("rejects milestone without required fields", () => {
		const v5 = v4({
			schemaVersion: 5,
			milestones: [
				{
					id: "",
					name: "",
					status: "",
					featureIds: [],
					assertionIds: [],
					validationRounds: 0,
					maxValidationRounds: 1,
				},
			],
		});
		expect(() => validatePersistedState(v5)).toThrow(StateFileError);
	});

	test("rejects duplicate milestone ids", () => {
		const dupe = {
			id: "M-001",
			name: "a",
			status: "pending",
			featureIds: [],
			assertionIds: [],
			validationRounds: 0,
			maxValidationRounds: 1,
		};
		const v5 = v4({ schemaVersion: 5, milestones: [dupe, { ...dupe }] });
		expect(() => validatePersistedState(v5)).toThrow(/duplicate milestone id/);
	});

	test("rejects milestone with invalid status", () => {
		const v5 = v4({
			schemaVersion: 5,
			milestones: [
				{
					id: "M-001",
					name: "a",
					status: "unknown-status",
					featureIds: [],
					assertionIds: [],
					validationRounds: 0,
					maxValidationRounds: 1,
				},
			],
		});
		expect(() => validatePersistedState(v5)).toThrow(/milestones\[0\].status invalid/);
	});

	test("rejects non-array fulfillsAssertionIds on task", () => {
		const v5 = v4({ schemaVersion: 5 });
		(v5.tasks as Array<Record<string, unknown>>)[0]!.fulfillsAssertionIds = "VA-001" as unknown as string[];
		expect(() => validatePersistedState(v5)).toThrow(/fulfillsAssertionIds is not an array/);
	});

	test("rejects maxValidationRounds of 0", () => {
		const v5 = v4({
			schemaVersion: 5,
			milestones: [
				{
					id: "M-001",
					name: "a",
					status: "pending",
					featureIds: [],
					assertionIds: [],
					validationRounds: 0,
					maxValidationRounds: 0,
				},
			],
		});
		expect(() => validatePersistedState(v5)).toThrow(/maxValidationRounds/);
	});
});
