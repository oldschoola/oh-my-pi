import { describe, expect, it } from "bun:test";
import { anthropicModelNeedsBufferedToolInput } from "@oh-my-pi/pi-ai/model-thinking";
import {
	anthropicToolInputStreamingMode,
	buildAnthropicClientOptions,
	convertAnthropicMessages,
	streamAnthropic,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Context, Model, TJsonSchema, Tool, UserMessage } from "@oh-my-pi/pi-ai/types";
import { parseStreamingJson } from "@oh-my-pi/pi-ai/utils/json-parse";

/**
 * Claude Opus 4.8 frequently emits malformed / truncated tool_use JSON when
 * tool input streams without server-side buffering. The fix routes Opus 4.8 to
 * "buffered" tool-input mode (neither `eager_input_streaming` nor the
 * fine-grained-tool-streaming beta), restoring Anthropic's JSON validation so
 * only complete, valid tool input streams back. Earlier Claude models keep the
 * fast "eager" streaming they tolerate.
 * @see https://github.com/anthropics/claude-code/issues/63604
 */

const FINE_GRAINED_BETA = "fine-grained-tool-streaming-2025-05-14";

function makeModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-opus-4-8-20260528",
		name: "Claude Opus 4.8",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		maxTokens: 64000,
		contextWindow: 1000000,
		reasoning: true,
		...overrides,
	};
}

const SAMPLE_TOOL: Tool = {
	name: "todo_write",
	description: "Manage a phased task list",
	parameters: {
		type: "object",
		properties: { ops: { type: "array", items: { type: "object" }, minItems: 1 } },
		required: ["ops"],
	} as TJsonSchema,
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capturePayload(model: Model<"anthropic-messages">): Promise<{ tools?: Array<Record<string, unknown>> }> {
	const context: Context = {
		messages: [{ role: "user", content: "Plan a 3-step task", timestamp: Date.now() }],
		tools: [SAMPLE_TOOL],
	};
	const { promise, resolve } = Promise.withResolvers<{ tools?: Array<Record<string, unknown>> }>();
	streamAnthropic(model, context, {
		apiKey: "sk-ant-oat-test",
		isOAuth: true,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as { tools?: Array<Record<string, unknown>> }),
	});
	return promise;
}

function betaHeader(model: Model<"anthropic-messages">, isOAuth: boolean): string {
	const options = buildAnthropicClientOptions({
		model,
		apiKey: isOAuth ? "sk-ant-oat-test" : "sk-ant-api-test",
		extraBetas: [],
		stream: true,
		interleavedThinking: false,
		hasTools: true,
		isOAuth,
	});
	return String(options.defaultHeaders["Anthropic-Beta"] ?? "");
}

describe("anthropicModelNeedsBufferedToolInput", () => {
	it("flags Opus 4.8+ (canonical and dated, with or without provider prefix)", () => {
		expect(anthropicModelNeedsBufferedToolInput("claude-opus-4-8")).toBe(true);
		expect(anthropicModelNeedsBufferedToolInput("claude-opus-4-8-20260528")).toBe(true);
		expect(anthropicModelNeedsBufferedToolInput("anthropic/claude-opus-4-8")).toBe(true);
	});

	it("does not flag earlier Claude models or non-Claude ids", () => {
		expect(anthropicModelNeedsBufferedToolInput("claude-opus-4-7")).toBe(false);
		expect(anthropicModelNeedsBufferedToolInput("claude-opus-4-6")).toBe(false);
		expect(anthropicModelNeedsBufferedToolInput("claude-sonnet-4-5")).toBe(false);
		expect(anthropicModelNeedsBufferedToolInput("gpt-5")).toBe(false);
	});
});

describe("anthropicToolInputStreamingMode", () => {
	it("buffers tool input for Opus 4.8", () => {
		expect(anthropicToolInputStreamingMode(makeModel())).toBe("buffered");
		expect(anthropicToolInputStreamingMode(makeModel({ id: "claude-opus-4-8" }))).toBe("buffered");
	});

	it("keeps eager streaming for Opus 4.7 and Sonnet", () => {
		expect(anthropicToolInputStreamingMode(makeModel({ id: "claude-opus-4-7" }))).toBe("eager");
		expect(anthropicToolInputStreamingMode(makeModel({ id: "claude-sonnet-4-5" }))).toBe("eager");
	});

	it("honors an explicit compat.bufferToolInput override on Opus 4.8", () => {
		expect(anthropicToolInputStreamingMode(makeModel({ compat: { bufferToolInput: false } }))).toBe("eager");
	});

	it("falls back to fine-grained when eager is disabled and buffering is off", () => {
		const model = makeModel({ id: "claude-sonnet-4-5", compat: { supportsEagerToolInputStreaming: false } });
		expect(anthropicToolInputStreamingMode(model)).toBe("fine-grained");
	});
});

describe("Opus 4.8 buffered tool streaming — wire behavior", () => {
	it("omits eager_input_streaming on tools for Opus 4.8", async () => {
		const payload = await capturePayload(makeModel());
		expect(payload.tools?.length).toBeGreaterThan(0);
		for (const tool of payload.tools ?? []) {
			expect(tool.eager_input_streaming).toBeUndefined();
		}
	});

	it("keeps eager_input_streaming on tools for Sonnet 4.5 (unchanged)", async () => {
		const payload = await capturePayload(makeModel({ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }));
		expect(payload.tools?.length).toBeGreaterThan(0);
		expect(payload.tools?.[0]?.eager_input_streaming).toBe(true);
	});

	it("never sends the fine-grained-tool-streaming beta for Opus 4.8 (api key or OAuth)", () => {
		expect(betaHeader(makeModel(), false)).not.toContain(FINE_GRAINED_BETA);
		expect(betaHeader(makeModel(), true)).not.toContain(FINE_GRAINED_BETA);
	});

	it("resolves OAuth tokens while still buffering Opus 4.8 tool input", () => {
		const options = buildAnthropicClientOptions({
			model: makeModel(),
			apiKey: "sk-ant-oat-test",
			extraBetas: [],
			stream: true,
			interleavedThinking: false,
			hasTools: true,
			isOAuth: true,
		});
		expect(options.isOAuthToken).toBe(true);
		expect(String(options.defaultHeaders["Anthropic-Beta"] ?? "")).not.toContain(FINE_GRAINED_BETA);
	});

	it("still sends the fine-grained beta when eager is disabled on a non-buffered model", () => {
		const model = makeModel({ id: "claude-sonnet-4-5", compat: { supportsEagerToolInputStreaming: false } });
		expect(betaHeader(model, false)).toContain(FINE_GRAINED_BETA);
	});
});

describe("malformed tool_use JSON defect (why buffering matters)", () => {
	it("recovers args that fail todo_write validation instead of throwing on truncated tool JSON", () => {
		// A truncated input_json_delta stream (Opus 4.8's failure mode): the
		// closing braces/array never arrive. parseStreamingJson never throws — it
		// returns a best-effort object. Depending on where truncation lands, the
		// recovered args either drop the required `ops` field entirely or yield an
		// empty `ops` array. Either way todo_write's `ops: z.array(...).min(1)`
		// schema rejects them, producing the error tool_result that drives the
		// retry-nudge spam. Buffered mode removes this by only streaming complete
		// JSON in the first place.
		expect(parseStreamingJson<{ ops?: unknown[] }>('{"ops":')).toEqual({}); // value never arrived → no ops
		expect(parseStreamingJson<{ ops?: unknown[] }>('{"ops":[')).toEqual({ ops: [] }); // empty array → fails .min(1)
		expect(parseStreamingJson<{ ops?: unknown[] }>("")).toEqual({});
	});
});

describe("convertAnthropicMessages — empty signed thinking blocks", () => {
	const model = makeModel();

	function assistant(content: AssistantMessage["content"]): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
	}

	const user: UserMessage = { role: "user", content: "continue", timestamp: Date.now() };

	it("drops an empty-text signed thinking block but keeps the tool_use", () => {
		const msg = assistant([
			{ type: "thinking", thinking: "", thinkingSignature: "sig_dead" },
			{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "README.md" } },
		]);
		const params = convertAnthropicMessages([user, msg], model, false);
		const assistantParam = params.find(message => message.role === "assistant");
		expect(assistantParam?.content).toEqual([
			{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "README.md" } },
		]);
	});

	it("preserves a non-empty signed thinking block alongside the tool_use", () => {
		const msg = assistant([
			{ type: "thinking", thinking: "real analysis", thinkingSignature: "sig_live" },
			{ type: "toolCall", id: "toolu_2", name: "read", arguments: { path: "a.ts" } },
		]);
		const params = convertAnthropicMessages([user, msg], model, false);
		const assistantParam = params.find(message => message.role === "assistant");
		expect(assistantParam?.content).toEqual([
			{ type: "thinking", thinking: "real analysis", signature: "sig_live" },
			{ type: "tool_use", id: "toolu_2", name: "read", input: { path: "a.ts" } },
		]);
	});

	it("drops only the empty signed block when both empty and non-empty are present", () => {
		const msg = assistant([
			{ type: "thinking", thinking: "", thinkingSignature: "sig_dead" },
			{ type: "thinking", thinking: "kept", thinkingSignature: "sig_live" },
			{ type: "toolCall", id: "toolu_3", name: "read", arguments: { path: "b.ts" } },
		]);
		const params = convertAnthropicMessages([user, msg], model, false);
		const assistantParam = params.find(message => message.role === "assistant");
		expect(assistantParam?.content).toEqual([
			{ type: "thinking", thinking: "kept", signature: "sig_live" },
			{ type: "tool_use", id: "toolu_3", name: "read", input: { path: "b.ts" } },
		]);
	});
});
