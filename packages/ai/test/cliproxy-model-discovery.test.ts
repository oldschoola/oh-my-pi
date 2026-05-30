import { afterEach, describe, expect, it, vi } from "bun:test";
import { cliproxyModelManagerOptions } from "../src/provider-models/openai-compat";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

async function discoverCliproxyModels(
	payload: unknown,
	apiKey = "sk-cliproxy-test",
	baseUrl = "https://cli-proxy.example.com/v1",
) {
	const fetchMock = vi.fn(async (input: string | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toBe(`${baseUrl}/models`);
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	global.fetch = fetchMock as unknown as typeof fetch;

	const options = cliproxyModelManagerOptions({ apiKey, baseUrl });
	expect(options.fetchDynamicModels).toBeDefined();
	const models = await options.fetchDynamicModels?.();
	expect(models).not.toBeNull();
	return { models: models ?? [], fetchMock };
}

describe("cliproxy model discovery", () => {
	it("surfaces every model with provider=cliproxy and the configured baseUrl", async () => {
		const { models } = await discoverCliproxyModels({
			data: [
				{ id: "claude-opus-4-7", object: "model", created: 1776297600, owned_by: "anthropic" },
				{ id: "gpt-5.4", object: "model", created: 1772668800, owned_by: "openai" },
			],
			object: "list",
		});
		expect(models).toHaveLength(2);
		for (const model of models) {
			expect(model.api).toBe("openai-completions");
			expect(model.provider).toBe("cliproxy");
			expect(model.baseUrl).toBe("https://cli-proxy.example.com/v1");
		}
	});

	it("marks Claude and gpt-5.x / codex-* ids as reasoning-capable, leaves image-gen alone", async () => {
		const { models } = await discoverCliproxyModels({
			data: [
				{ id: "claude-opus-4-7", object: "model" },
				{ id: "claude-sonnet-4-6", object: "model" },
				{ id: "gpt-5.4", object: "model" },
				{ id: "codex-auto-review", object: "model" },
				{ id: "gpt-image-2", object: "model" },
			],
			object: "list",
		});
		const byId = new Map(models.map(m => [m.id, m]));
		expect(byId.get("claude-opus-4-7")?.reasoning).toBe(true);
		expect(byId.get("claude-sonnet-4-6")?.reasoning).toBe(true);
		expect(byId.get("gpt-5.4")?.reasoning).toBe(true);
		expect(byId.get("codex-auto-review")?.reasoning).toBe(true);
		expect(byId.get("gpt-image-2")?.reasoning).toBe(false);
	});

	it("defaults baseUrl to the loopback CLIProxyAPI port when none provided", () => {
		const options = cliproxyModelManagerOptions({ apiKey: "sk-test" });
		expect(options.providerId).toBe("cliproxy");
		expect(options.fetchDynamicModels).toBeDefined();
	});

	it("returns no dynamic fetcher when apiKey is missing", () => {
		const options = cliproxyModelManagerOptions();
		expect(options.providerId).toBe("cliproxy");
		expect(options.fetchDynamicModels).toBeUndefined();
	});
});
