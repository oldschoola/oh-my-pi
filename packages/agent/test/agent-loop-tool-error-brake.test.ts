import { describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	StreamFn,
} from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import type { MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as z from "zod/v4";
import { createUserMessage } from "./helpers";

/**
 * Anti-spam brake: when a model issues tool calls but every one errors (e.g.
 * malformed tool_use JSON that fails arg validation), the loop must not
 * re-prompt forever. After MAX_CONSECUTIVE_ALL_ERROR_TOOL_TURNS (6) all-error
 * turns with zero successful tool calls, the loop breaks with a terminal error.
 * Any successful tool call resets the streak, so mixed work is never affected.
 */

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const emptySchema = z.object({});
const boomTool: AgentTool<typeof emptySchema, Record<string, never>> = {
	name: "boom",
	label: "Boom",
	description: "Always throws",
	parameters: emptySchema,
	async execute() {
		throw new Error("kaboom");
	},
};

const okTool: AgentTool<typeof emptySchema, Record<string, never>> = {
	name: "ok",
	label: "Ok",
	description: "Always succeeds",
	parameters: emptySchema,
	async execute() {
		return { content: [{ type: "text", text: "ok" }], details: {} };
	},
};

async function drain(
	context: AgentContext,
	config: AgentLoopConfig,
	streamFn: StreamFn,
): Promise<{ events: AgentEvent[]; error: unknown }> {
	const events: AgentEvent[] = [];
	let error: unknown;
	const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
	try {
		for await (const event of stream) events.push(event);
		await stream.result();
	} catch (e) {
		error = e;
	}
	return { events, error };
}

describe("agent loop — all-error tool-turn brake", () => {
	it("halts an otherwise-infinite stream of failing tool calls at the budget", async () => {
		// The model emits a failing tool call forever. Without the brake this
		// loops unbounded; with it, the loop stops after exactly 6 all-error turns.
		function* infiniteFailingCalls(): Generator<MockResponse> {
			let i = 0;
			while (true) {
				yield { content: [{ type: "toolCall", id: `boom-${i++}`, name: "boom", arguments: {} }] };
			}
		}
		const mock = createMockModel({ responses: infiniteFailingCalls() });
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [boomTool] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const { events, error } = await drain(context, config, mock.stream);

		const toolEnds = events.filter(e => e.type === "tool_execution_end");
		expect(toolEnds.length).toBe(6);
		expect(toolEnds.every(e => e.type === "tool_execution_end" && e.isError)).toBe(true);
		expect(mock.calls.length).toBe(6);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("every tool call failed");
	});

	it("does not trip when each turn mixes a failing and a successful tool call", async () => {
		// Seven mixed turns (one success each) then a plain text turn. Every mixed
		// turn resets the streak, so the loop completes normally despite errors.
		const responses: MockResponse[] = [];
		for (let i = 0; i < 7; i++) {
			responses.push({
				content: [
					{ type: "toolCall", id: `boom-${i}`, name: "boom", arguments: {} },
					{ type: "toolCall", id: `ok-${i}`, name: "ok", arguments: {} },
				],
			});
		}
		responses.push({ content: ["done"] });
		const mock = createMockModel({ responses });
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [boomTool, okTool] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const { events, error } = await drain(context, config, mock.stream);

		expect(error).toBeUndefined();
		expect(events.map(e => e.type)).toContain("agent_end");
		// All 8 turns ran — never short-circuited by the brake.
		expect(mock.calls.length).toBe(8);
	});

	it("resets the streak after a single successful tool turn", async () => {
		// 5 failing turns, then one fully-successful turn (resets), then text done.
		// The streak never reaches 6, so no brake fires.
		const responses: MockResponse[] = [];
		for (let i = 0; i < 5; i++) {
			responses.push({ content: [{ type: "toolCall", id: `boom-${i}`, name: "boom", arguments: {} }] });
		}
		responses.push({ content: [{ type: "toolCall", id: "ok-1", name: "ok", arguments: {} }] });
		for (let i = 5; i < 10; i++) {
			responses.push({ content: [{ type: "toolCall", id: `boom-${i}`, name: "boom", arguments: {} }] });
		}
		responses.push({ content: ["done"] });
		const mock = createMockModel({ responses });
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [boomTool, okTool] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const { events, error } = await drain(context, config, mock.stream);

		expect(error).toBeUndefined();
		expect(events.map(e => e.type)).toContain("agent_end");
		expect(mock.calls.length).toBe(12);
	});
});
