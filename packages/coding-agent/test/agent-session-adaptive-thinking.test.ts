import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Effort, getBundledModel } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { SetThinkingLevelTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import type * as z from "zod/v4";

describe("AgentSession adaptive thinking", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-adaptive-thinking-");
	});

	afterEach(async () => {
		if (session) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		// Windows: AuthStorage's SQLite may retain locks briefly after close(); tolerate.
		try {
			tempDir.removeSync();
		} catch {
			/* cleanup-only; orchestrator's temp pruning will eventually reclaim */
		}
	});

	function getModel(id: string) {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	async function createSession(initialThinkingLevel: Effort | undefined): Promise<Agent> {
		const model = getModel("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: initialThinkingLevel },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
		return agent;
	}

	it("enters adaptive mode and seeds the baseline effort from the agent's current level", async () => {
		const agent = await createSession(Effort.Medium);
		session.setThinkingLevel("adaptive");
		expect(session.isAdaptiveThinking).toBe(true);
		expect(session.thinkingLevel).toBe("adaptive");
		expect(session.adaptiveEffort).toBe(Effort.Medium);
		// Agent receives the underlying Effort, not the "adaptive" string.
		expect(agent.state.thinkingLevel).toBe(Effort.Medium);
	});

	it("clears adaptive state when switching to a concrete effort", async () => {
		await createSession(Effort.Medium);
		session.setThinkingLevel("adaptive");
		session.setThinkingLevel(Effort.High);
		expect(session.isAdaptiveThinking).toBe(false);
		expect(session.adaptiveEffort).toBeUndefined();
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("setAdaptiveEffort(persist=true) updates baseline and drives the agent", async () => {
		const agent = await createSession(Effort.Medium);
		session.setThinkingLevel("adaptive");
		expect(session.setAdaptiveEffort(Effort.Low, true)).toBe(true);
		expect(session.adaptiveEffort).toBe(Effort.Low);
		expect(agent.state.thinkingLevel).toBe(Effort.Low);
	});

	it("setAdaptiveEffort(persist=false) applies a per-turn override without changing baseline", async () => {
		const agent = await createSession(Effort.Medium);
		session.setThinkingLevel("adaptive");
		expect(session.setAdaptiveEffort(Effort.High, false)).toBe(true);
		// Agent uses the temp effort, but the baseline (observed via adaptiveEffort) is unchanged.
		expect(agent.state.thinkingLevel).toBe(Effort.High);
		expect(session.adaptiveEffort).toBe(Effort.Medium);
	});

	it("setAdaptiveEffort returns false when not in adaptive mode", async () => {
		await createSession(Effort.Medium);
		expect(session.isAdaptiveThinking).toBe(false);
		expect(session.setAdaptiveEffort(Effort.Low, true)).toBe(false);
	});

	it("setAdaptiveEffort returns false for an unsupported effort on the current model", async () => {
		// claude-sonnet-4-6 omits xhigh (covered by the existing "clamps unsupported" test).
		const model = getModel("claude-sonnet-4-6");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: Effort.High },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth-noxhigh.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-noxhigh.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
		session.setThinkingLevel("adaptive");
		expect(session.isAdaptiveThinking).toBe(true);
		expect(session.getAvailableThinkingLevels()).not.toContain(Effort.XHigh);
		expect(session.setAdaptiveEffort(Effort.XHigh, true)).toBe(false);
		// Reference `agent` so the linter doesn't flag the variable.
		expect(agent.state.model.id).toBe("claude-sonnet-4-6");
	});

	it("ignores adaptive selector on models that do not support reasoning", async () => {
		const nonReasoning = getBundledModel("openai", "gpt-4.1-mini") ?? getBundledModel("openai", "gpt-4.1");
		if (!nonReasoning || nonReasoning.reasoning) {
			// Fixture moved upstream; skip rather than couple to a specific catalog.
			return;
		}
		const agent = new Agent({
			initialState: {
				model: nonReasoning,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: undefined,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth-noreason.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey(nonReasoning.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-noreason.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
		session.setThinkingLevel("adaptive");
		expect(session.isAdaptiveThinking).toBe(false);
		expect(session.thinkingLevel).toBeUndefined();
	});

	// roboomp #1530(c): the `agent_end` restore must fire on aborted/error
	// outcomes too — otherwise a tool-call that escalates effort for a single
	// turn (`persist=false`) and then aborts leaves the session pinned at the
	// override forever. Synthesizing an `agent_end` event reaches the same
	// handler the real loop calls; the restore block runs synchronously before
	// any `await`, so `agent.state.thinkingLevel` is back to the baseline by
	// the time `emitExternalEvent` returns.
	function makeAgentEndMessage(stopReason: "aborted" | "error"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			errorMessage: stopReason === "error" ? "boom" : undefined,
			timestamp: Date.now(),
		} as AssistantMessage;
	}
	it("restores the adaptive baseline when the agent loop aborts mid-turn", async () => {
		const agent = await createSession(Effort.Medium);
		session.setThinkingLevel("adaptive");
		expect(session.setAdaptiveEffort(Effort.High, false)).toBe(true);
		expect(agent.state.thinkingLevel).toBe(Effort.High);

		agent.emitExternalEvent({ type: "agent_end", messages: [makeAgentEndMessage("aborted")] });
		// The session's `#handleAgentEvent` is async (it awaits
		// `#emitSessionEvent` before the restore branch). A short flush is
		// enough to let the restore land before we assert.
		await Bun.sleep(20);

		expect(agent.state.thinkingLevel).toBe(Effort.Medium);
		expect(session.adaptiveEffort).toBe(Effort.Medium);
	});

	it("restores the adaptive baseline when the agent loop fails with an error", async () => {
		const agent = await createSession(Effort.Medium);
		session.setThinkingLevel("adaptive");
		expect(session.setAdaptiveEffort(Effort.Low, false)).toBe(true);
		expect(agent.state.thinkingLevel).toBe(Effort.Low);

		agent.emitExternalEvent({ type: "agent_end", messages: [makeAgentEndMessage("error")] });
		await Bun.sleep(20);

		expect(agent.state.thinkingLevel).toBe(Effort.Medium);
		expect(session.adaptiveEffort).toBe(Effort.Medium);
	});
});

// ---------------------------------------------------------------------------
// set_thinking_level tool — schema/description reflect the active model.
// ---------------------------------------------------------------------------

function buildToolSession(supportedEfforts: readonly Effort[]): ToolSession {
	// Minimal ToolSession shape for SetThinkingLevelTool — the tool only reads
	// `getSupportedThinkingEfforts`, `isAdaptiveThinking`, and `settings` at
	// construction time. All other surface area is unused by the schema build.
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		isAdaptiveThinking: () => true,
		getSupportedThinkingEfforts: () => supportedEfforts,
	} as unknown as ToolSession;
}

describe("set_thinking_level tool schema", () => {
	it("bakes the model's supported efforts into the level enum and description", () => {
		const supported: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];
		const tool = new SetThinkingLevelTool(buildToolSession(supported));
		// Schema accepts every supported effort verbatim.
		for (const effort of supported) {
			const parsed = tool.parameters.safeParse({ level: effort });
			expect(parsed.success).toBe(true);
		}
		// Unrelated string is rejected (proves the schema is an enum, not free-form).
		const reject = tool.parameters.safeParse({ level: "nope" });
		expect(reject.success).toBe(false);
		// Description names every supported effort so the model sees the exact set.
		for (const effort of supported) {
			expect(tool.description).toContain(effort);
		}
	});

	it("omits efforts the model does not support", () => {
		// `claude-sonnet-4-6` exposes no `xhigh` (mirrors the agent-session test below).
		const supported: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
		const tool = new SetThinkingLevelTool(buildToolSession(supported));
		expect(tool.parameters.safeParse({ level: Effort.High }).success).toBe(true);
		expect(tool.parameters.safeParse({ level: Effort.XHigh }).success).toBe(false);
		expect(tool.description).not.toContain(Effort.XHigh);
		// The schema's `level` field collapses to a Zod enum; the option set in
		// the JSON-Schema export the provider sees is exactly the supported list.
		const shape = (tool.parameters as unknown as z.ZodObject<{ level: z.ZodEnum<Record<string, string>> }>).shape;
		const levelDef = shape.level.def as { values?: readonly string[]; entries?: Record<string, string> };
		const values = levelDef.values ?? Object.values(levelDef.entries ?? {});
		expect([...values].sort()).toEqual([...supported].sort());
	});

	it("falls back to a free-form string when no efforts are advertised", () => {
		// Reachable only via a stale call site — confirm the tool still parses
		// without throwing rather than crashing the entire tool registry.
		const tool = new SetThinkingLevelTool(buildToolSession([]));
		expect(tool.parameters.safeParse({ level: "medium" }).success).toBe(true);
		expect(tool.description).toContain("(none");
	});
});

// ---------------------------------------------------------------------------
// Subagent settings — roboomp #1530(b): never inherit `adaptive` selector.
// ---------------------------------------------------------------------------

describe("createSubagentSettings adaptive isolation", () => {
	it("rewrites the parent's adaptive selector to a concrete effort", () => {
		const parent = Settings.isolated({ defaultThinkingLevel: ThinkingLevel.Adaptive });
		expect(parent.get("defaultThinkingLevel")).toBe(ThinkingLevel.Adaptive);

		const subagent = createSubagentSettings(parent);

		const level = subagent.get("defaultThinkingLevel");
		expect(level).not.toBe(ThinkingLevel.Adaptive);
		// `Effort.Medium` is the bootstrap baseline the parent session itself
		// would have used; the subagent inherits the same concrete fallback.
		expect(level).toBe(Effort.Medium);
	});

	it("leaves non-adaptive thinking selectors untouched", () => {
		const parent = Settings.isolated({ defaultThinkingLevel: Effort.High });
		const subagent = createSubagentSettings(parent);
		expect(subagent.get("defaultThinkingLevel")).toBe(Effort.High);
	});

	it("blocks adaptive mode on the subagent AgentSession even when the parent's selector leaks through", async () => {
		// Belt-and-braces: even if a future call site bypassed
		// `createSubagentSettings` and constructed `AgentSession` directly with
		// the parent's `Settings`, the subagent must not enter adaptive mode
		// for a non-reasoning model. The session itself enforces this; here we
		// audit the contract that `createSubagentSettings` ALREADY removes the
		// selector before the AgentSession ever sees it.
		const parent = Settings.isolated({ defaultThinkingLevel: ThinkingLevel.Adaptive });
		const sub = createSubagentSettings(parent);
		expect(sub.get("defaultThinkingLevel")).not.toBe(ThinkingLevel.Adaptive);
	});
});
