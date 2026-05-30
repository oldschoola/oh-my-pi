import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, getBundledModel } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

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
});
