import { describe, expect, test } from "bun:test";

import { StateFileError, validatePersistedState } from "../src/missioncontrol";

// ── Fixture builders ────────────────────────────────────────────────────────

function mkLane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		laneNumber: 1,
		laneId: "l-1",
		laneSessionId: "lane-1-sess",
		worktreePath: "/wt/1",
		branch: "lane-1",
		taskIds: ["t-1"],
		...overrides,
	};
}

function mkTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		taskId: "t-1",
		laneNumber: 1,
		sessionName: "sess-1",
		status: "pending",
		taskFolder: "tasks/t-1",
		startedAt: null,
		endedAt: null,
		doneFileFound: false,
		exitReason: "",
		...overrides,
	};
}

function mkV4(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
		totalTasks: 1,
		succeededTasks: 0,
		failedTasks: 0,
		skippedTasks: 0,
		blockedTasks: 0,
		blockedTaskIds: [],
		wavePlan: [["t-1"]],
		lanes: [mkLane()],
		tasks: [mkTask()],
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

// ── Top-level shape ─────────────────────────────────────────────────────────

describe("validatePersistedState — non-object / null", () => {
	test("null throws STATE_SCHEMA_INVALID", () => {
		expect(() => validatePersistedState(null)).toThrow(StateFileError);
	});

	test("primitive throws STATE_SCHEMA_INVALID", () => {
		expect(() => validatePersistedState("not-an-object")).toThrow(StateFileError);
		expect(() => validatePersistedState(42)).toThrow(StateFileError);
	});
});

describe("validatePersistedState — schemaVersion", () => {
	test("missing schemaVersion rejected", () => {
		const obj = mkV4();
		delete obj.schemaVersion;
		expect(() => validatePersistedState(obj)).toThrow(/schemaVersion/);
	});

	test("unsupported schemaVersion 6 rejected", () => {
		expect(() => validatePersistedState(mkV4({ schemaVersion: 6 }))).toThrow(/Unsupported schema version 6/);
	});

	test("accepts v1, v2, v3, v4, v5", () => {
		// v5 (current schema) = happy path — milestones field is optional.
		expect(() => validatePersistedState(mkV4({ schemaVersion: 5 }))).not.toThrow();

		// v4 missing milestones → upconvert seeds them.
		expect(() => validatePersistedState(mkV4())).not.toThrow();

		// v3 missing segments → upconvert fills [].
		const v3 = mkV4({ schemaVersion: 3 });
		delete v3.segments;
		expect(() => validatePersistedState(v3)).not.toThrow();

		// v2 missing resilience/diagnostics/segments → upconvert fills defaults.
		const v2 = mkV4({ schemaVersion: 2 });
		delete v2.resilience;
		delete v2.diagnostics;
		delete v2.segments;
		expect(() => validatePersistedState(v2)).not.toThrow();

		// v1 missing mode (and everything v2+) → upconvert chain fills defaults.
		const v1 = mkV4({ schemaVersion: 1 });
		delete v1.mode;
		delete v1.resilience;
		delete v1.diagnostics;
		delete v1.segments;
		expect(() => validatePersistedState(v1)).not.toThrow();
	});
});

// ── Enum fields ─────────────────────────────────────────────────────────────

describe("validatePersistedState — enum fields", () => {
	test("rejects invalid phase", () => {
		expect(() => validatePersistedState(mkV4({ phase: "bogus" }))).toThrow(/Invalid "phase" value/);
	});

	test("rejects invalid task status", () => {
		expect(() => validatePersistedState(mkV4({ tasks: [mkTask({ status: "weird" })] }))).toThrow(
			/tasks\[0\].status is invalid/,
		);
	});

	test("rejects invalid merge result status", () => {
		const bad = mkV4({
			mergeResults: [{ waveIndex: 0, status: "garbage", failedLane: null, failureReason: null }],
		});
		expect(() => validatePersistedState(bad)).toThrow(/mergeResults\[0\].status is invalid/);
	});

	test("rejects invalid mode value", () => {
		expect(() => validatePersistedState(mkV4({ mode: "bogus" }))).toThrow(/Invalid "mode" value/);
	});
});

// ── Required fields ─────────────────────────────────────────────────────────

describe("validatePersistedState — required primitives", () => {
	test("missing batchId rejected", () => {
		const obj = mkV4();
		delete obj.batchId;
		expect(() => validatePersistedState(obj)).toThrow(/batchId/);
	});

	test("missing totalWaves rejected", () => {
		const obj = mkV4();
		delete obj.totalWaves;
		expect(() => validatePersistedState(obj)).toThrow(/totalWaves/);
	});

	test("endedAt number or null only — string rejected", () => {
		expect(() => validatePersistedState(mkV4({ endedAt: "later" }))).toThrow(/endedAt/);
	});

	test("orchBranch defaulted to '' when missing", () => {
		const obj = mkV4();
		delete obj.orchBranch;
		const result = validatePersistedState(obj) as unknown as { orchBranch: string };
		expect(result.orchBranch).toBe("");
	});
});

// ── Array shape ─────────────────────────────────────────────────────────────

describe("validatePersistedState — array fields", () => {
	test("rejects non-array wavePlan", () => {
		expect(() => validatePersistedState(mkV4({ wavePlan: "nope" }))).toThrow(/wavePlan/);
	});

	test("rejects non-array wavePlan entries", () => {
		expect(() => validatePersistedState(mkV4({ wavePlan: ["not-an-array"] }))).toThrow(
			/wavePlan\[0\] is not an array/,
		);
	});

	test("rejects non-string tasks in wavePlan[n]", () => {
		expect(() => validatePersistedState(mkV4({ wavePlan: [[1, 2, 3]] }))).toThrow(
			/wavePlan\[0\] contains non-string/,
		);
	});

	test("rejects non-string in blockedTaskIds", () => {
		expect(() => validatePersistedState(mkV4({ blockedTaskIds: [1] }))).toThrow(/blockedTaskIds/);
	});

	test("rejects non-string in errors", () => {
		expect(() => validatePersistedState(mkV4({ errors: [{ not: "a string" }] }))).toThrow(/errors array/);
	});
});

// ── Lanes ───────────────────────────────────────────────────────────────────

describe("validatePersistedState — lane records", () => {
	test("rejects missing laneSessionId + tmuxSessionName", () => {
		const laneNoSess = mkLane();
		delete (laneNoSess as Record<string, unknown>).laneSessionId;
		expect(() => validatePersistedState(mkV4({ lanes: [laneNoSess] }))).toThrow(
			/must include either laneSessionId or tmuxSessionName/,
		);
	});

	test("accepts legacy tmuxSessionName lane (normalized in place)", () => {
		const legacyLane = mkLane({ laneSessionId: undefined, tmuxSessionName: "orch-lane-1" });
		delete (legacyLane as Record<string, unknown>).laneSessionId;
		const obj = mkV4({ lanes: [legacyLane] });
		expect(() => validatePersistedState(obj)).not.toThrow();
		// normalizeLaneSessionAlias runs during validation — laneSessionId should now be set
		const lanes = (obj as { lanes: Array<Record<string, unknown>> }).lanes;
		expect(typeof lanes[0]?.laneSessionId).toBe("string");
	});

	test("rejects non-number laneNumber", () => {
		expect(() => validatePersistedState(mkV4({ lanes: [mkLane({ laneNumber: "one" })] }))).toThrow(
			/lanes\[0\].laneNumber/,
		);
	});

	test("rejects non-array taskIds", () => {
		expect(() => validatePersistedState(mkV4({ lanes: [mkLane({ taskIds: "t-1" })] }))).toThrow(/lanes\[0\].taskIds/);
	});
});

// ── Resilience ──────────────────────────────────────────────────────────────

describe("validatePersistedState — resilience section", () => {
	test("rejects non-boolean resumeForced", () => {
		const r = { resumeForced: "yes", retryCountByScope: {}, lastFailureClass: null, repairHistory: [] };
		expect(() => validatePersistedState(mkV4({ resilience: r }))).toThrow(/resilience.resumeForced/);
	});

	test("rejects non-object retryCountByScope", () => {
		const r = { resumeForced: false, retryCountByScope: [1, 2], lastFailureClass: null, repairHistory: [] };
		expect(() => validatePersistedState(mkV4({ resilience: r }))).toThrow(/retryCountByScope/);
	});

	test("rejects non-number retryCountByScope values", () => {
		const r = {
			resumeForced: false,
			retryCountByScope: { "T-1:w0:l1": "two" },
			lastFailureClass: null,
			repairHistory: [],
		};
		expect(() => validatePersistedState(mkV4({ resilience: r }))).toThrow(/retryCountByScope\["T-1:w0:l1"\]/);
	});

	test("rejects invalid repair history status", () => {
		const r = {
			resumeForced: false,
			retryCountByScope: {},
			lastFailureClass: null,
			repairHistory: [{ id: "r-1", strategy: "cleanup", status: "not-a-status", startedAt: 1, endedAt: 2 }],
		};
		expect(() => validatePersistedState(mkV4({ resilience: r }))).toThrow(/repairHistory\[0\].status/);
	});

	test("accepts valid repair history entry", () => {
		const r = {
			resumeForced: true,
			retryCountByScope: { "T-1:w0:l1": 2 },
			lastFailureClass: "transient-network-error",
			repairHistory: [
				{ id: "r-1", strategy: "stale-worktree-cleanup", status: "succeeded", startedAt: 1, endedAt: 2 },
			],
		};
		expect(() => validatePersistedState(mkV4({ resilience: r }))).not.toThrow();
	});
});

// ── Diagnostics ─────────────────────────────────────────────────────────────

describe("validatePersistedState — diagnostics section", () => {
	test("rejects non-object taskExits", () => {
		const d = { taskExits: [], batchCost: 0 };
		expect(() => validatePersistedState(mkV4({ diagnostics: d }))).toThrow(/diagnostics.taskExits/);
	});

	test("rejects taskExits entry missing classification", () => {
		const d = { taskExits: { "T-1": { cost: 0.5, durationSec: 10 } }, batchCost: 0.5 };
		expect(() => validatePersistedState(mkV4({ diagnostics: d }))).toThrow(/taskExits\["T-1"\].classification/);
	});

	test("rejects non-number batchCost", () => {
		const d = { taskExits: {}, batchCost: "free" };
		expect(() => validatePersistedState(mkV4({ diagnostics: d }))).toThrow(/diagnostics.batchCost/);
	});

	test("accepts valid diagnostics", () => {
		const d = {
			taskExits: { "T-1": { classification: "success", cost: 0.1, durationSec: 5, retries: 0 } },
			batchCost: 0.1,
		};
		expect(() => validatePersistedState(mkV4({ diagnostics: d }))).not.toThrow();
	});
});

// ── Segments ────────────────────────────────────────────────────────────────

describe("validatePersistedState — segments section", () => {
	test("rejects non-array segments at v4", () => {
		expect(() => validatePersistedState(mkV4({ segments: "not-array" }))).toThrow(/segments/);
	});

	test("rejects segments[n] missing required string field", () => {
		const s = {
			segmentId: "s-1",
			taskId: "T-1",
			repoId: "api",
			// laneId missing
			sessionName: "sess-1",
			worktreePath: "/wt/1",
			branch: "lane-1",
			exitReason: "",
			status: "pending",
			startedAt: null,
			endedAt: null,
			retries: 0,
			dependsOnSegmentIds: [],
		};
		expect(() => validatePersistedState(mkV4({ segments: [s] }))).toThrow(/segments\[0\].laneId/);
	});

	test("rejects segments[n].status invalid", () => {
		const s = {
			segmentId: "s-1",
			taskId: "T-1",
			repoId: "api",
			laneId: "l-1",
			sessionName: "sess-1",
			worktreePath: "/wt/1",
			branch: "lane-1",
			exitReason: "",
			status: "made-up",
			startedAt: null,
			endedAt: null,
			retries: 0,
			dependsOnSegmentIds: [],
		};
		expect(() => validatePersistedState(mkV4({ segments: [s] }))).toThrow(/segments\[0\].status is invalid/);
	});

	test("accepts valid segment record", () => {
		const s = {
			segmentId: "s-1",
			taskId: "T-1",
			repoId: "api",
			laneId: "l-1",
			sessionName: "sess-1",
			worktreePath: "/wt/1",
			branch: "lane-1",
			exitReason: "",
			status: "running",
			startedAt: 1,
			endedAt: null,
			retries: 0,
			dependsOnSegmentIds: ["s-0"],
			expansionRequestId: "req-123",
		};
		expect(() => validatePersistedState(mkV4({ segments: [s] }))).not.toThrow();
	});
});

// ── _extraFields capture ────────────────────────────────────────────────────

describe("validatePersistedState — unknown field preservation", () => {
	test("captures unknown top-level fields into _extraFields", () => {
		const obj = mkV4({ somethingCustom: { a: 1 }, anotherKey: 42 });
		const result = validatePersistedState(obj) as unknown as { _extraFields?: Record<string, unknown> };
		expect(result._extraFields).toBeDefined();
		expect(result._extraFields?.somethingCustom).toEqual({ a: 1 });
		expect(result._extraFields?.anotherKey).toBe(42);
	});

	test("no _extraFields when every key is known", () => {
		const result = validatePersistedState(mkV4()) as unknown as { _extraFields?: Record<string, unknown> };
		expect(result._extraFields).toBeUndefined();
	});
});

// ── Returned object identity ────────────────────────────────────────────────

describe("validatePersistedState — return value", () => {
	test("returns the same object reference (in-memory upconvert)", () => {
		const obj = mkV4();
		const result = validatePersistedState(obj);
		expect(result).toBe(obj as unknown as typeof result);
	});

	test("v1 input is upconverted to current schema in place", () => {
		const v1 = mkV4({ schemaVersion: 1 });
		delete v1.mode;
		delete v1.resilience;
		delete v1.diagnostics;
		delete v1.segments;
		validatePersistedState(v1);
		expect(v1.schemaVersion).toBe(5);
		expect(v1.mode).toBe("repo");
		expect(v1.segments).toEqual([]);
		expect(Array.isArray(v1.milestones)).toBe(true);
	});
});
