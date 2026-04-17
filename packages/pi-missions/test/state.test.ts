import { describe, expect, it } from "bun:test";
import { addProgressEvent, advancePhase, completeMission, expandPhases, restoreMissionState } from "../src/state";
import type { MissionState, SessionEntryLike } from "../src/types";

// ---------------------------------------------------------------------------
// Minimal state factory
// ---------------------------------------------------------------------------

function makeSimpleState(overrides: Partial<MissionState> = {}): MissionState {
	return {
		description: "Test mission",
		mode: "simple",
		phases: [
			{
				name: "Architect",
				emoji: "📐",
				status: "active",
				startedAt: new Date().toISOString(),
			},
			{ name: "Implement", emoji: "🔨", status: "pending" },
			{ name: "Verify", emoji: "✅", status: "pending" },
		],
		autonomy: "medium",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: new Date().toISOString(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// restoreMissionState
// ---------------------------------------------------------------------------

describe("restoreMissionState", () => {
	it("returns null for empty entries", () => {
		expect(restoreMissionState([])).toBeNull();
	});

	it("returns null when no mission-state entries", () => {
		const entries: SessionEntryLike[] = [{ type: "message" }, { type: "custom", customType: "other-type", data: {} }];
		expect(restoreMissionState(entries)).toBeNull();
	});

	it("returns null for null data (reset marker)", () => {
		const entries: SessionEntryLike[] = [{ type: "custom", customType: "mission-state", data: null }];
		expect(restoreMissionState(entries)).toBeNull();
	});

	it("returns null for undefined data", () => {
		const entries: SessionEntryLike[] = [{ type: "custom", customType: "mission-state", data: undefined }];
		expect(restoreMissionState(entries)).toBeNull();
	});

	it("returns null for schema-invalid data", () => {
		const entries: SessionEntryLike[] = [
			{
				type: "custom",
				customType: "mission-state",
				data: { description: "no required fields" },
			},
		];
		expect(restoreMissionState(entries)).toBeNull();
	});

	it("returns latest valid state from entries", () => {
		const state = makeSimpleState({ description: "latest" });
		const entries: SessionEntryLike[] = [
			{
				type: "custom",
				customType: "mission-state",
				data: makeSimpleState({ description: "old" }),
			},
			{ type: "custom", customType: "mission-state", data: state },
		];
		const result = restoreMissionState(entries);
		expect(result?.description).toBe("latest");
	});

	it("skips corrupted entries and finds last valid", () => {
		const validState = makeSimpleState();
		const entries: SessionEntryLike[] = [
			{ type: "custom", customType: "mission-state", data: validState },
			{ type: "custom", customType: "mission-state", data: { bad: "data" } },
		];
		const result = restoreMissionState(entries);
		expect(result?.description).toBe("Test mission");
	});

	it("null reset marker stops scan (returns null even with valid earlier entries)", () => {
		const entries: SessionEntryLike[] = [
			{ type: "custom", customType: "mission-state", data: makeSimpleState() },
			{ type: "custom", customType: "mission-state", data: null },
		];
		expect(restoreMissionState(entries)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// advancePhase
// ---------------------------------------------------------------------------

describe("advancePhase", () => {
	it("marks active phase as done and activates next", () => {
		const state = makeSimpleState();
		const { state: result, completedPhaseName } = advancePhase(state);

		expect(completedPhaseName).toBe("Architect");
		expect(result.phases[0].status).toBe("done");
		expect(result.phases[0].completedAt).toBeDefined();
		expect(result.phases[1].status).toBe("active");
		expect(result.phases[1].startedAt).toBeDefined();
		expect(result.completedAt).toBeUndefined();
	});

	it("marks active phase as skipped when outcome is 'skipped'", () => {
		const state = makeSimpleState();
		const { state: result, completedPhaseName } = advancePhase(state, "skipped");

		expect(completedPhaseName).toBe("Architect");
		expect(result.phases[0].status).toBe("skipped");
		expect(result.phases[0].completedAt).toBeDefined();
		expect(result.phases[1].status).toBe("active");
		expect(result.completedAt).toBeUndefined();
	});

	it("sets completedAt when last phase completes", () => {
		const state = makeSimpleState({
			phases: [
				{
					name: "Architect",
					emoji: "📐",
					status: "done",
					startedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
				},
				{
					name: "Implement",
					emoji: "🔨",
					status: "done",
					startedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
				},
				{
					name: "Verify",
					emoji: "✅",
					status: "active",
					startedAt: new Date().toISOString(),
				},
			],
		});
		const { state: result, completedPhaseName } = advancePhase(state);

		expect(completedPhaseName).toBe("Verify");
		expect(result.phases[2].status).toBe("done");
		expect(result.completedAt).toBeDefined();
	});

	it("returns unchanged state when no active phase", () => {
		const state = makeSimpleState({
			phases: [
				{ name: "Architect", emoji: "📐", status: "done" },
				{ name: "Implement", emoji: "🔨", status: "done" },
			],
		});
		const { state: result, completedPhaseName } = advancePhase(state);
		expect(result).toBe(state);
		expect(completedPhaseName).toBeNull();
	});

	it("updates currentPhase to next phase name", () => {
		const state = makeSimpleState();
		const { state: result } = advancePhase(state);
		expect(result.currentPhase).toBe("Implement");
	});

	it("does not mutate the original state", () => {
		const state = makeSimpleState();
		const original = JSON.stringify(state);
		advancePhase(state);
		expect(JSON.stringify(state)).toBe(original);
	});
});

// ---------------------------------------------------------------------------
// addProgressEvent
// ---------------------------------------------------------------------------

describe("addProgressEvent", () => {
	it("returns a new state with the event appended", () => {
		const state = makeSimpleState();
		const next = addProgressEvent(state, "phase_start", "Starting Architect");
		expect(next.progressLog).toHaveLength(1);
		expect(next.progressLog[0].type).toBe("phase_start");
		expect(next.progressLog[0].detail).toBe("Starting Architect");
		// Original state is not mutated
		expect(state.progressLog).toHaveLength(0);
	});

	it("timestamp is a valid ISO-8601 string", () => {
		const next = addProgressEvent(makeSimpleState(), "mission_complete", "Done");
		const ts = next.progressLog[0].timestamp;
		expect(new Date(ts).toISOString()).toBe(ts);
	});

	it("accumulates events when chained", () => {
		let s = makeSimpleState();
		s = addProgressEvent(s, "phase_start", "Start");
		s = addProgressEvent(s, "phase_complete", "Complete");
		s = addProgressEvent(s, "mission_complete", "Done");
		expect(s.progressLog).toHaveLength(3);
		expect(s.progressLog.map(e => e.type)).toEqual(["phase_start", "phase_complete", "mission_complete"]);
	});
});

// ---------------------------------------------------------------------------
// completeMission
// ---------------------------------------------------------------------------

describe("completeMission", () => {
	it("marks active phase done and pending phases skipped, stamps completedAt", () => {
		const state = makeSimpleState(); // active Architect + 2 pending
		const result = completeMission(state);
		expect(result.phases[0].status).toBe("done");
		expect(result.phases[0].completedAt).toBeDefined();
		expect(result.phases[1].status).toBe("skipped");
		expect(result.phases[2].status).toBe("skipped");
		expect(result.completedAt).toBeDefined();
	});

	it("handles state with no active phase — all pending become skipped", () => {
		const state = makeSimpleState({
			phases: [
				{ name: "A", emoji: "📐", status: "pending" },
				{ name: "B", emoji: "🔨", status: "pending" },
			],
		});
		const result = completeMission(state);
		expect(result.phases.every(p => p.status === "skipped")).toBe(true);
		expect(result.completedAt).toBeDefined();
	});

	it("preserves already-done phases verbatim", () => {
		const doneAt = new Date(Date.now() - 60_000).toISOString();
		const state = makeSimpleState({
			phases: [
				{ name: "A", emoji: "📐", status: "done", startedAt: doneAt, completedAt: doneAt },
				{ name: "B", emoji: "🔨", status: "active", startedAt: new Date().toISOString() },
				{ name: "C", emoji: "✅", status: "pending" },
			],
		});
		const result = completeMission(state);
		expect(result.phases[0].completedAt).toBe(doneAt);
		expect(result.phases[0].status).toBe("done");
		expect(result.phases[1].status).toBe("done");
		expect(result.phases[1].completedAt).toBeDefined();
		expect(result.phases[2].status).toBe("skipped");
	});

	it("does not mutate the original state", () => {
		const state = makeSimpleState();
		const original = JSON.stringify(state);
		completeMission(state);
		expect(JSON.stringify(state)).toBe(original);
	});
});

// ---------------------------------------------------------------------------
// expandPhases (adaptive)
// ---------------------------------------------------------------------------

describe("expandPhases", () => {
	function makeAdaptiveSeed(): MissionState {
		const nowIso = new Date().toISOString();
		return {
			description: "Adaptive mission",
			mode: "simple",
			templateKey: "adaptive",
			phases: [{ name: "Plan", emoji: "📐", status: "active", startedAt: nowIso }],
			autonomy: "medium",
			modelAssignment: {},
			paused: false,
			pauseHistory: [],
			progressLog: [],
			startedAt: nowIso,
		};
	}

	it("keeps the active Plan phase and appends proposed phases as pending", () => {
		const seed = makeAdaptiveSeed();
		const expanded = expandPhases(seed, [
			{ emoji: "🔨", name: "Implement", description: "do work" },
			{ emoji: "✅", name: "Verify", description: "run tests" },
		]);

		expect(expanded.phases).toHaveLength(3);
		expect(expanded.phases[0]).toMatchObject({ name: "Plan", status: "active" });
		expect(expanded.phases[0].startedAt).toBe(seed.phases[0].startedAt);
		expect(expanded.phases[1]).toMatchObject({ name: "Implement", emoji: "🔨", status: "pending" });
		expect(expanded.phases[2]).toMatchObject({ name: "Verify", emoji: "✅", status: "pending" });
		expect(expanded.phasesExpanded).toBe(true);
	});

	it("after expansion, advancing the Plan phase activates the first proposed phase (not mission completion)", () => {
		const seed = makeAdaptiveSeed();
		const expanded = expandPhases(seed, [
			{ emoji: "🔨", name: "Implement", description: "" },
			{ emoji: "✅", name: "Verify", description: "" },
		]);

		const { state: advanced, completedPhaseName } = advancePhase(expanded);

		expect(completedPhaseName).toBe("Plan");
		expect(advanced.completedAt).toBeUndefined();
		expect(advanced.phases[0].status).toBe("done");
		expect(advanced.phases[1].status).toBe("active");
		expect(advanced.phases[1].name).toBe("Implement");
		expect(advanced.phases[2].status).toBe("pending");
	});

	it("on a single-phase proposal, Plan→single phase flow still requires two advances to complete", () => {
		const seed = makeAdaptiveSeed();
		const expanded = expandPhases(seed, [{ emoji: "🔨", name: "Implement", description: "" }]);

		// First advance: Plan → Implement, mission still in progress.
		const first = advancePhase(expanded).state;
		expect(first.completedAt).toBeUndefined();
		expect(first.phases[1].status).toBe("active");

		// Second advance: Implement done, mission completes.
		const second = advancePhase(first).state;
		expect(second.completedAt).toBeDefined();
		expect(second.phases[1].status).toBe("done");
	});

	it("returns the original state when no proposed phases are supplied", () => {
		const seed = makeAdaptiveSeed();
		expect(expandPhases(seed, [])).toBe(seed);
	});
});
