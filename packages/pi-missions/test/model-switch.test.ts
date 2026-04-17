/**
 * Contract tests for `maybeSwitchModel`.
 *
 * The refactor that created this module exists specifically to replace a
 * silent-failure `/mission-next` path with one that surfaces errors via
 * `ctx.ui.notify`. These tests defend that contract:
 *
 *   - No-op cases (no assignment, no active phase, no role mapping) stay silent
 *   - Missing-model, setModel-returns-false, and setModel-throws all call notify
 *   - Both `provider/id` and bare-ID (backwards-compat) selectors resolve
 */

import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type ModelSwitchCtx, maybeSwitchModel } from "../src/model-switch";
import type { MissionState } from "../src/types";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface RegistryModel {
	id: string;
	name?: string;
	provider: string;
}

interface NotifyCall {
	message: string;
	level: string;
}

interface HarnessSetup {
	/** Models the registry should return from `getAvailable()` */
	availableModels?: RegistryModel[];
	/** What `pi.setModel` should return */
	setModelReturns?: boolean;
	/** Whether `pi.setModel` should throw instead of returning */
	setModelThrows?: Error;
}

function makeHarness(setup: HarnessSetup = {}) {
	const setModelCalls: RegistryModel[] = [];
	const notifyCalls: NotifyCall[] = [];

	const pi = {
		setModel: async (model: RegistryModel) => {
			setModelCalls.push(model);
			if (setup.setModelThrows) throw setup.setModelThrows;
			return setup.setModelReturns ?? true;
		},
	} as unknown as ExtensionAPI;

	const ctx: ModelSwitchCtx = {
		ui: {
			notify: (message: string, level: string) => {
				notifyCalls.push({ message, level });
			},
		} as unknown as ModelSwitchCtx["ui"],
		modelRegistry: {
			getAvailable: () => setup.availableModels ?? [],
		} as unknown as ModelSwitchCtx["modelRegistry"],
	};

	return { pi, ctx, setModelCalls, notifyCalls };
}

function makeState(overrides: Partial<MissionState> = {}): MissionState {
	return {
		description: "Test",
		mode: "simple",
		phases: [
			{ name: "Architect", emoji: "📐", status: "active", startedAt: new Date().toISOString() },
			{ name: "Implement", emoji: "🔨", status: "pending" },
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
// No-op paths — must not call setModel or notify
// ---------------------------------------------------------------------------

describe("maybeSwitchModel — no-op cases", () => {
	it("does nothing when modelAssignment is empty", async () => {
		const h = makeHarness();
		await maybeSwitchModel(h.pi, makeState({ modelAssignment: {} }), h.ctx);
		expect(h.setModelCalls).toHaveLength(0);
		expect(h.notifyCalls).toHaveLength(0);
	});

	it("does nothing when no phase is active", async () => {
		const h = makeHarness({
			availableModels: [{ id: "claude-sonnet-4", provider: "anthropic" }],
		});
		const state = makeState({
			phases: [
				{ name: "Architect", emoji: "📐", status: "done" },
				{ name: "Implement", emoji: "🔨", status: "pending" },
			],
			modelAssignment: { planner: "anthropic/claude-sonnet-4" },
		});
		await maybeSwitchModel(h.pi, state, h.ctx);
		expect(h.setModelCalls).toHaveLength(0);
		expect(h.notifyCalls).toHaveLength(0);
	});

	it("does nothing when the active phase's role has no assignment", async () => {
		const h = makeHarness({
			availableModels: [{ id: "claude-sonnet-4", provider: "anthropic" }],
		});
		// active phase is Architect → role 'planner'; but assignment is for 'coder'
		const state = makeState({
			modelAssignment: { coder: "anthropic/claude-sonnet-4" },
		});
		await maybeSwitchModel(h.pi, state, h.ctx);
		expect(h.setModelCalls).toHaveLength(0);
		expect(h.notifyCalls).toHaveLength(0);
	});

	it("does nothing when the active phase name is not in PHASE_ROLE_MAP", async () => {
		const h = makeHarness({
			availableModels: [{ id: "claude-sonnet-4", provider: "anthropic" }],
		});
		const state = makeState({
			phases: [{ name: "CustomPhase", emoji: "🧪", status: "active", startedAt: new Date().toISOString() }],
			modelAssignment: { planner: "anthropic/claude-sonnet-4" },
		});
		await maybeSwitchModel(h.pi, state, h.ctx);
		expect(h.setModelCalls).toHaveLength(0);
		expect(h.notifyCalls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Selector resolution — provider/id vs bare ID
// ---------------------------------------------------------------------------

describe("maybeSwitchModel — selector resolution", () => {
	it("resolves provider/id selector against the registry and calls setModel", async () => {
		const target = { id: "claude-sonnet-4", provider: "anthropic" };
		const h = makeHarness({
			availableModels: [
				{ id: "gpt-4o", provider: "openai" }, // same id might exist under another provider
				target,
				{ id: "claude-sonnet-4", provider: "nanogpt" }, // same id, different provider
			],
		});
		const state = makeState({
			modelAssignment: { planner: "anthropic/claude-sonnet-4" },
		});
		await maybeSwitchModel(h.pi, state, h.ctx);
		expect(h.setModelCalls).toEqual([target]);
		expect(h.notifyCalls).toHaveLength(0);
	});

	it("accepts a bare ID for backwards compat with older saved defaults", async () => {
		const target = { id: "claude-sonnet-4", provider: "anthropic" };
		const h = makeHarness({ availableModels: [target] });
		const state = makeState({
			modelAssignment: { planner: "claude-sonnet-4" },
		});
		await maybeSwitchModel(h.pi, state, h.ctx);
		expect(h.setModelCalls).toEqual([target]);
		expect(h.notifyCalls).toHaveLength(0);
	});

	it("provider/id match is case-insensitive on the provider segment", async () => {
		// The YAML the picker writes uses lowercase provider names, but legacy
		// entries from other tooling may vary. The resolver lowercases both.
		const target = { id: "claude-sonnet-4", provider: "Anthropic" };
		const h = makeHarness({ availableModels: [target] });
		const state = makeState({
			modelAssignment: { planner: "anthropic/claude-sonnet-4" },
		});
		await maybeSwitchModel(h.pi, state, h.ctx);
		expect(h.setModelCalls).toEqual([target]);
	});
});

// ---------------------------------------------------------------------------
// Failure surfacing — the whole reason this module exists
// ---------------------------------------------------------------------------

describe("maybeSwitchModel — failure surfacing", () => {
	it("notifies error when the assigned model is not in the registry", async () => {
		const h = makeHarness({
			availableModels: [{ id: "gpt-4o", provider: "openai" }],
		});
		const state = makeState({
			modelAssignment: { planner: "anthropic/claude-sonnet-4" },
		});
		await maybeSwitchModel(h.pi, state, h.ctx);
		expect(h.setModelCalls).toHaveLength(0);
		expect(h.notifyCalls).toHaveLength(1);
		expect(h.notifyCalls[0].level).toBe("error");
		expect(h.notifyCalls[0].message).toContain("not available");
		expect(h.notifyCalls[0].message).toContain("anthropic/claude-sonnet-4");
	});

	it("notifies error when setModel returns false (no auth)", async () => {
		const target = { id: "claude-sonnet-4", provider: "anthropic" };
		const h = makeHarness({
			availableModels: [target],
			setModelReturns: false,
		});
		const state = makeState({
			modelAssignment: { planner: "anthropic/claude-sonnet-4" },
		});
		await maybeSwitchModel(h.pi, state, h.ctx);
		expect(h.setModelCalls).toEqual([target]);
		expect(h.notifyCalls).toHaveLength(1);
		expect(h.notifyCalls[0].level).toBe("error");
		expect(h.notifyCalls[0].message).toContain("no auth");
		expect(h.notifyCalls[0].message).toContain("/login");
	});

	it("notifies error when setModel throws", async () => {
		const target = { id: "claude-sonnet-4", provider: "anthropic" };
		const h = makeHarness({
			availableModels: [target],
			setModelThrows: new Error("network down"),
		});
		const state = makeState({
			modelAssignment: { planner: "anthropic/claude-sonnet-4" },
		});
		await maybeSwitchModel(h.pi, state, h.ctx);
		expect(h.setModelCalls).toEqual([target]);
		expect(h.notifyCalls).toHaveLength(1);
		expect(h.notifyCalls[0].level).toBe("error");
		expect(h.notifyCalls[0].message).toContain("network down");
	});
});
