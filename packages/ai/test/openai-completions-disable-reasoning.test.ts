import { afterEach, describe, expect, it } from "bun:test";
import { Effort } from "../src/model-thinking";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { Context, Model } from "../src/types";

const originalFetch = global.fetch;

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

afterEach(() => {
	global.fetch = originalFetch;
});

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createReasoningEffortModel(): Model<"openai-completions"> {
	return {
		id: "minimal-reasoner",
		name: "Minimal Reasoner",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: true,
		thinking: {
			mode: "effort",
			minLevel: Effort.Minimal,
			maxLevel: Effort.High,
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function createFireworksReasoningEffortModel(): Model<"openai-completions"> {
	return {
		...createReasoningEffortModel(),
		id: "glm-5.1",
		name: "GLM 5.1",
		provider: "fireworks",
		baseUrl: "https://api.fireworks.ai/inference/v1",
	};
}

function createCrofDeepseekModel(id = "deepseek-v4-pro"): Model<"openai-completions"> {
	return {
		...createReasoningEffortModel(),
		id,
		name: `DeepSeek: ${id}`,
		provider: "crof",
		baseUrl: "https://crof.ai/v1",
	};
}

function createDirectDeepseekModel(id = "deepseek-v4-pro"): Model<"openai-completions"> {
	return {
		...createReasoningEffortModel(),
		id,
		name: id,
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com/v1",
	};
}

async function captureStreamPayload(
	model: Model<"openai-completions">,
	options: Parameters<typeof streamOpenAICompletions>[2],
): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	global.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return createSseResponse([
				{
					id: "chatcmpl-capture",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: { content: "ok" } }],
				},
				{
					id: "chatcmpl-capture",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
				"[DONE]",
			]);
		},
		{ preconnect: originalFetch.preconnect },
	);

	const result = await streamOpenAICompletions(model, testContext, options).result();
	expect(result.stopReason).toBe("stop");
	if (!payload) throw new Error("Expected OpenAI completions request payload");
	return payload;
}

const captureDisableReasoningPayload = (model: Model<"openai-completions">) =>
	captureStreamPayload(model, { apiKey: "test-key", disableReasoning: true });

describe("OpenAI completions disableReasoning", () => {
	it("sends the lowest supported reasoning effort for generic effort-mode models", async () => {
		const payload = await captureDisableReasoningPayload(createReasoningEffortModel());

		expect(payload.reasoning_effort).toBe("minimal");
		expect(payload.reasoning).toBeUndefined();
	});

	it("maps Fireworks' lowest effort to the provider-supported none literal", async () => {
		const payload = await captureDisableReasoningPayload(createFireworksReasoningEffortModel());

		expect(payload.reasoning_effort).toBe("none");
		expect(payload.reasoning).toBeUndefined();
	});

	// Crof.ai's deepseek-v4 reasoning models accept the literal
	// `reasoning_effort: "none"` as a true disable; the Anthropic-style
	// `thinking: { type: "disabled" }` alone leaks ~100 reasoning tokens per
	// request (verified live May 2026 against both deepseek-v4-pro and
	// deepseek-v4-flash). Detection runs on `lowerId.includes("deepseek")`, so
	// any DeepSeek id Crof exposes — pro/flash/precision/lightning — picks up
	// the same disable shape.
	for (const id of ["deepseek-v4-pro", "deepseek-v4-flash"] as const) {
		it(`sends reasoning_effort:none for Crof ${id}`, async () => {
			const payload = await captureDisableReasoningPayload(createCrofDeepseekModel(id));

			expect(payload.reasoning_effort).toBe("none");
			expect(payload.thinking).toBeUndefined();
			expect(payload.reasoning).toBeUndefined();
		});
	}

	// api.deepseek.com rejects `reasoning_effort: "none"` with HTTP 400
	// ("unknown variant"), and 400s when `thinking: { type: "disabled" }` is
	// combined with any `reasoning_effort` ("thinking options type cannot be
	// disabled when reasoning_effort is set"). The only working shape is the
	// thinking toggle alone (verified live May 2026 against both deepseek-v4-pro
	// and deepseek-v4-flash; both go through the same DeepSeek backend).
	for (const id of ["deepseek-v4-pro", "deepseek-v4-flash"] as const) {
		it(`sends thinking:{type:disabled} alone for direct DeepSeek ${id}`, async () => {
			const payload = await captureDisableReasoningPayload(createDirectDeepseekModel(id));

			expect(payload.thinking).toEqual({ type: "disabled" });
			expect(payload.reasoning_effort).toBeUndefined();
			expect(payload.reasoning).toBeUndefined();
		});
	}
});

describe("OpenAI completions reasoning enabled with extraBody", () => {
	// Regression guard for DeepSeek's canonical request shape — its docs root
	// example sends BOTH `thinking: { type: "enabled" }` (from the compat
	// extraBody) AND `reasoning_effort: "high"` together. The extraBody-skip
	// guard introduced for the disable path must not interfere with the enable
	// path: when reasoning is requested, both fields must reach the wire.
	// Covers both DeepSeek V4 sizes since they share the same wire contract.
	for (const id of ["deepseek-v4-pro", "deepseek-v4-flash"] as const) {
		it(`keeps both thinking:{enabled} and reasoning_effort on direct DeepSeek ${id}`, async () => {
			const payload = await captureStreamPayload(createDirectDeepseekModel(id), {
				apiKey: "test-key",
				reasoning: Effort.High,
			});

			expect(payload.thinking).toEqual({ type: "enabled" });
			expect(payload.reasoning_effort).toBe("high");
		});
	}
});

describe("OpenAI completions extraBody precedence", () => {
	// Behavioural regression for the "skip keys already set" extraBody apply on
	// non-DeepSeek providers. The DeepSeek disable path relies on this so its
	// `extraBody: { thinking: { type: "enabled" } }` default cannot clobber an
	// explicit `thinking: { type: "disabled" }` set by `nativeReasoningDisable`.
	// These tests pin the cross-provider contract roboomp asked about
	// (`extraBody:` references across the codebase rely on this precedence
	// being consistent for `temperature`/`top_p`-shaped fields too).

	function createCustomModelWithExtraBody(extraBody: Record<string, unknown>): Model<"openai-completions"> {
		return {
			id: "non-deepseek-model",
			name: "Non-DeepSeek Model",
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://proxy.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
			compat: { extraBody },
		};
	}

	it("descriptor extraBody.temperature reaches the wire when caller omits temperature", async () => {
		const payload = await captureStreamPayload(createCustomModelWithExtraBody({ temperature: 0.42 }), {
			apiKey: "test-key",
		});

		expect(payload.temperature).toBe(0.42);
	});

	it("caller-supplied temperature wins over descriptor extraBody.temperature", async () => {
		const payload = await captureStreamPayload(createCustomModelWithExtraBody({ temperature: 0.42 }), {
			apiKey: "test-key",
			temperature: 0.7,
		});

		// The "skip keys already set" guard means extraBody never clobbers a
		// param the buildParams chain already populated from the caller's options.
		expect(payload.temperature).toBe(0.7);
	});

	it("descriptor extraBody augments unrelated fields even when caller sets temperature", async () => {
		const payload = await captureStreamPayload(
			createCustomModelWithExtraBody({ temperature: 0.42, custom_routing: "fast" }),
			{ apiKey: "test-key", temperature: 0.7 },
		);

		// Caller wins on `temperature`, but descriptor still gets to inject
		// arbitrary keys that the buildParams chain doesn't touch.
		expect(payload.temperature).toBe(0.7);
		expect(payload.custom_routing).toBe("fast");
	});
});
