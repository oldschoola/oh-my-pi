import { afterEach, describe, expect, it, vi } from "bun:test";
import { crofModelManagerOptions } from "../src/provider-models/openai-compat";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

async function discoverCrofModels(payload: unknown, apiKey = "crof-test-key") {
	const baseUrl = "https://crof.ai/v1";
	const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toBe(`${baseUrl}/models`);
		expect(init?.headers).toEqual({
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
		});
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	global.fetch = fetchMock as unknown as typeof fetch;

	const options = crofModelManagerOptions({ apiKey });
	expect(options.fetchDynamicModels).toBeDefined();
	const models = await options.fetchDynamicModels?.();
	expect(models).not.toBeNull();
	return { models: models ?? [], fetchMock };
}

describe("crof model discovery", () => {
	// Crof.ai's /v1/models returns pricing as $/million tokens directly (e.g.
	// `prompt: "0.30"` = $0.30/M). The OpenRouter pattern of multiplying by 1M
	// would inflate prices a million-fold, so the mapper must NOT scale.
	it("parses pricing as dollars per million tokens without scaling", async () => {
		const { models } = await discoverCrofModels({
			data: [
				{
					id: "deepseek-v4-pro",
					name: "DeepSeek: DeepSeek V4 Pro",
					context_length: 1_000_000,
					max_completion_tokens: 131_072,
					custom_reasoning: true,
					reasoning_effort: true,
					pricing: { prompt: "0.30", completion: "0.50", cache_prompt: "0.003" },
				},
			],
		});

		const model = models.find(m => m.id === "deepseek-v4-pro");
		expect(model).toBeDefined();
		expect(model?.api).toBe("openai-completions");
		expect(model?.provider).toBe("crof");
		expect(model?.baseUrl).toBe("https://crof.ai/v1");
		expect(model?.cost).toEqual({
			input: 0.3,
			output: 0.5,
			cacheRead: 0.003,
			cacheWrite: 0,
		});
		expect(model?.contextWindow).toBe(1_000_000);
		expect(model?.maxTokens).toBe(131_072);
	});

	it("marks models with custom_reasoning or reasoning_effort as reasoning-capable", async () => {
		const { models } = await discoverCrofModels({
			data: [
				{
					id: "deepseek-v4-pro",
					context_length: 1_000_000,
					custom_reasoning: true,
					reasoning_effort: true,
					pricing: { prompt: "0.30", completion: "0.50" },
				},
				{
					id: "deepseek-v3.2",
					context_length: 163_840,
					custom_reasoning: false,
					pricing: { prompt: "0.28", completion: "0.38" },
				},
				{
					id: "qwen3.5-9b",
					context_length: 262_144,
					reasoning_effort: true,
					pricing: { prompt: "0.04", completion: "0.15" },
				},
			],
		});

		const reasoningByModel = Object.fromEntries(models.map(m => [m.id, m.reasoning]));
		expect(reasoningByModel).toEqual({
			"deepseek-v4-pro": true,
			"deepseek-v3.2": false,
			"qwen3.5-9b": true,
		});
	});

	it("returns no dynamic fetcher when apiKey is missing", () => {
		const options = crofModelManagerOptions();
		expect(options.providerId).toBe("crof");
		expect(options.fetchDynamicModels).toBeUndefined();
	});
});
