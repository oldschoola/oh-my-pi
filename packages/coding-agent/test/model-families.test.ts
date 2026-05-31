import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { isKimiClassModel, isKimiClassModelString } from "../src/model-families";

function fakeModel(id: string): Model {
	return { id, provider: "test" } as unknown as Model;
}

describe("isKimiClassModelString", () => {
	it("accepts canonical kimi-class identifiers", () => {
		const accepted = [
			"kimi-k2",
			"kimi-k2.5",
			"kimi-k2.6-turbo",
			"kimi_k2",
			"glm-4.7",
			"glm-5",
			"glm-5.1",
			"glm_5",
			"qwen",
			"qwen3",
			"qwen3-coder-plus",
			"qwen3.5-plus",
			"qwen-vl",
			"qwen-2.5-72b-instruct",
			"qwen2.5-coder-32b-instruct",
			// path-anchored variants exercised in models.json
			"openrouter/kimi-k2",
			"google-vertex/qwen3-32b",
			"qwen/qwen3-32b",
			"qwen/qwq-32b",
			// vendor-prefixed bedrock ids (`qwen.qwen3-…`) must still classify
			"qwen.qwen3-235b-a22b-2507-v1:0",
			"qwen.qwen3-coder-30b-a3b-v1:0",
		];
		for (const id of accepted) {
			expect(isKimiClassModelString(id)).toBe(true);
		}
	});

	it("rejects accidental prefixes that share the family stem", () => {
		// These would have matched the pre-tightening regex (`kimi|glm-|qwen`) but
		// are not in the kimi/glm/qwen family — the boundary contract excludes
		// them so unrelated providers don't pick up kimi-class behavior bundles.
		const rejected = [
			"qweniverse",
			"qweniverse/foo",
			"qwentastic-7b",
			"kimibara-mini",
			"kimi",
			"glm",
			"glmnopq-7b",
			// non-delimited continuation must not match even mid-path
			"openrouter/qweniverse",
			"openrouter/kimibara",
		];
		for (const id of rejected) {
			expect(isKimiClassModelString(id)).toBe(false);
		}
	});

	it("handles empty / undefined identifiers", () => {
		expect(isKimiClassModelString(undefined)).toBe(false);
		expect(isKimiClassModelString(null)).toBe(false);
		expect(isKimiClassModelString("")).toBe(false);
	});
});

describe("isKimiClassModel", () => {
	it("delegates to the same boundary contract via Model.id", () => {
		expect(isKimiClassModel(fakeModel("kimi-k2.5"))).toBe(true);
		expect(isKimiClassModel(fakeModel("qwen3"))).toBe(true);
		expect(isKimiClassModel(fakeModel("qweniverse"))).toBe(false);
		expect(isKimiClassModel(undefined)).toBe(false);
	});
});
