import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * A model that keeps emitting malformed todo_write args (e.g. Claude Opus 4.8
 * truncated tool_use JSON) produces a stream of error tool_results. The session
 * nudges the model to fix-and-retry, but must CAP that nudge: after
 * MAX_TODO_WRITE_RETRY_NUDGES (3) consecutive failures it sends one terminal
 * "known issue, stop retrying" reminder and then goes silent, instead of
 * re-prompting forever. A successful todo_write resets the streak.
 */

function failingTodoResult(id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "todo_write",
		content: [{ type: "text", text: "ops: array must contain at least 1 element" }],
		isError: true,
		timestamp: Date.now(),
	};
}

function succeedingTodoResult(id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "todo_write",
		content: [{ type: "text", text: "Phases set" }],
		details: { phases: [{ name: "Phase 1", tasks: [{ content: "do work", status: "in_progress" }] }] },
		isError: false,
		timestamp: Date.now(),
	};
}

describe("AgentSession todo_write nudge cap", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let nudges: string[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-todo-nudge-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({ agent, sessionManager, settings: Settings.isolated(), modelRegistry });

		nudges = [];
		vi.spyOn(session, "sendCustomMessage").mockImplementation(async message => {
			if (message.customType === "todo-write-error-reminder" && typeof message.content === "string") {
				nudges.push(message.content);
			}
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	async function emitToolResult(message: ToolResultMessage): Promise<void> {
		session.agent.emitExternalEvent({ type: "message_end", message });
		// #handleAgentEvent runs as an unawaited async listener; flush it.
		await Bun.sleep(5);
	}

	it("caps retry nudges and emits a terminal known-issue reminder", async () => {
		for (let i = 0; i < 5; i++) {
			await emitToolResult(failingTodoResult(`fail-${i}`));
		}

		// Only 3 nudges total: 2 fix-and-retry, then 1 terminal — failures 4 & 5 are silent.
		expect(nudges).toHaveLength(3);
		expect(nudges[0]).toContain("Fix the todo payload");
		expect(nudges[1]).toContain("Fix the todo payload");
		expect(nudges[2]).toContain("Claude Opus 4.8");
		expect(nudges[2]).toContain("Stop retrying todo_write");
		expect(nudges[2]).not.toContain("Fix the todo payload and call todo_write again");
	});

	it("resets the streak after a successful todo_write", async () => {
		// Exhaust the budget first.
		for (let i = 0; i < 4; i++) {
			await emitToolResult(failingTodoResult(`fail-${i}`));
		}
		expect(nudges).toHaveLength(3);

		// A success resets the streak; the next failure nudges fix-and-retry again.
		await emitToolResult(succeedingTodoResult("ok-1"));
		await emitToolResult(failingTodoResult("fail-after-reset"));

		expect(nudges).toHaveLength(4);
		expect(nudges[3]).toContain("Fix the todo payload");
		// The successful todo_write also updated the rendered phases.
		expect(session.getTodoPhases().map(phase => phase.name)).toEqual(["Phase 1"]);
	});
});
