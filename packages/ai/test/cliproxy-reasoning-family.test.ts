import { afterEach, describe, expect, it, vi } from "bun:test";
import { cliproxyModelManagerOptions } from "../src/provider-models/openai-compat";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

async function classify(ids: readonly string[]) {
	const fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify({ data: ids.map(id => ({ id, object: "model" })), object: "list" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	global.fetch = fetchMock as unknown as typeof fetch;
	const options = cliproxyModelManagerOptions({
		apiKey: "sk-cliproxy-test",
		baseUrl: "https://cli-proxy.example.com/v1",
	});
	const models = (await options.fetchDynamicModels?.()) ?? [];
	return new Map(models.map(m => [m.id, m.reasoning]));
}

describe("cliproxy reasoning-family regex", () => {
	it("classifies gpt-5 exact, gpt-5-*, gpt-5.* as reasoning", async () => {
		const r = await classify(["gpt-5", "gpt-5-turbo", "gpt-5-mini", "gpt-5.4"]);
		expect(r.get("gpt-5")).toBe(true);
		expect(r.get("gpt-5-turbo")).toBe(true);
		expect(r.get("gpt-5-mini")).toBe(true);
		expect(r.get("gpt-5.4")).toBe(true);
	});

	it("does not misclassify suffixed siblings like gpt-5o or gpt-50 as reasoning", async () => {
		// The boundary class `[-.]|$` in the regex is what keeps these out.
		// Without it, the previous `/^(gpt-5\.|codex-)/` was already safe for
		// `gpt-5o` (no dot) but a naive widening to `/^gpt-5/` would catch it.
		const r = await classify(["gpt-5o", "gpt-50", "gpt-5xyz"]);
		expect(r.get("gpt-5o")).toBe(false);
		expect(r.get("gpt-50")).toBe(false);
		expect(r.get("gpt-5xyz")).toBe(false);
	});

	it("matches case-insensitively for gpt-5 and codex-", async () => {
		const r = await classify(["GPT-5", "GPT-5-Mini", "Codex-Auto"]);
		expect(r.get("GPT-5")).toBe(true);
		expect(r.get("GPT-5-Mini")).toBe(true);
		expect(r.get("Codex-Auto")).toBe(true);
	});
});
