import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { sanitizeKimiClassAssistantMessage } from "../../src/session/messages";

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-messages",
		provider: "openai",
		model: "kimi-k2",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("sanitizeKimiClassAssistantMessage", () => {
	it("returns the same message when no vacuous text blocks exist", () => {
		const msg = makeAssistantMessage([
			{ type: "text", text: "Let me help you with that." },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "foo.ts" } },
		]);
		const result = sanitizeKimiClassAssistantMessage(msg);
		expect(result).toBe(msg);
	});

	it("removes a lone '.' between thinking and toolCall", () => {
		const msg = makeAssistantMessage([
			{ type: "thinking", thinking: "I need to read the file." },
			{ type: "text", text: "." },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "foo.ts" } },
		]);
		const result = sanitizeKimiClassAssistantMessage(msg);
		expect(result.content).toHaveLength(2);
		expect(result.content[0]!.type).toBe("thinking");
		expect(result.content[1]!.type).toBe("toolCall");
	});

	it("removes a lone '\\\"' between thinking and toolCall", () => {
		const msg = makeAssistantMessage([
			{ type: "thinking", thinking: "I need to read the file." },
			{ type: "text", text: '"' },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "foo.ts" } },
		]);
		const result = sanitizeKimiClassAssistantMessage(msg);
		expect(result.content).toHaveLength(2);
		expect(result.content[0]!.type).toBe("thinking");
		expect(result.content[1]!.type).toBe("toolCall");
	});

	it("removes whitespace-only text between thinking and toolCall", () => {
		const msg = makeAssistantMessage([
			{ type: "thinking", thinking: "I need to read the file." },
			{ type: "text", text: "   \n\t  " },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "foo.ts" } },
		]);
		const result = sanitizeKimiClassAssistantMessage(msg);
		expect(result.content).toHaveLength(2);
	});

	it("removes trailing vacuous text after the last thinking block", () => {
		const msg = makeAssistantMessage([
			{ type: "thinking", thinking: "I need to read the file." },
			{ type: "text", text: "…" },
		]);
		const result = sanitizeKimiClassAssistantMessage(msg);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]!.type).toBe("thinking");
	});

	it("removes vacuous text between two thinking blocks", () => {
		const msg = makeAssistantMessage([
			{ type: "thinking", thinking: "First thought." },
			{ type: "text", text: "!" },
			{ type: "thinking", thinking: "Second thought." },
		]);
		const result = sanitizeKimiClassAssistantMessage(msg);
		expect(result.content).toHaveLength(2);
		expect(result.content[0]!.type).toBe("thinking");
		expect(result.content[1]!.type).toBe("thinking");
	});

	it("preserves meaningful text between thinking and toolCall", () => {
		const msg = makeAssistantMessage([
			{ type: "thinking", thinking: "I need to read the file." },
			{ type: "text", text: "Let me fetch that for you." },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "foo.ts" } },
		]);
		const result = sanitizeKimiClassAssistantMessage(msg);
		expect(result.content).toHaveLength(3);
		expect(result.content[1]!.type).toBe("text");
		expect((result.content[1] as { type: "text"; text: string }).text).toBe("Let me fetch that for you.");
	});

	it("preserves vacuous text that is not adjacent to thinking", () => {
		const msg = makeAssistantMessage([
			{ type: "text", text: "." },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "foo.ts" } },
		]);
		const result = sanitizeKimiClassAssistantMessage(msg);
		expect(result.content).toHaveLength(2);
		expect(result.content[0]!.type).toBe("text");
	});

	it("returns the same message when content has fewer than 2 blocks", () => {
		const msg = makeAssistantMessage([{ type: "text", text: "Hello." }]);
		const result = sanitizeKimiClassAssistantMessage(msg);
		expect(result).toBe(msg);
	});

	it("removes multiple vacuous text blocks in one pass", () => {
		const msg = makeAssistantMessage([
			{ type: "thinking", thinking: "First." },
			{ type: "text", text: "." },
			{ type: "thinking", thinking: "Second." },
			{ type: "text", text: "?" },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "foo.ts" } },
		]);
		const result = sanitizeKimiClassAssistantMessage(msg);
		expect(result.content).toHaveLength(3);
		expect(result.content[0]!.type).toBe("thinking");
		expect(result.content[1]!.type).toBe("thinking");
		expect(result.content[2]!.type).toBe("toolCall");
	});
});
