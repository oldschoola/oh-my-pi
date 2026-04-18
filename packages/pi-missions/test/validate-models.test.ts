/**
 * Unit tests for `validateModelAvailability` — the pure resolver used by
 * `/mission-settings` to flag missing / typo'd per-role model overrides.
 */

import { describe, expect, test } from "bun:test";

import type { ModelCheckEntry, ResolvedModelInfo } from "../src/missioncontrol/types";
import type { ValidateModelDeps } from "../src/missioncontrol/validate-models";
import { validateModelAvailability } from "../src/missioncontrol/validate-models";

function makeDeps(over: Partial<ValidateModelDeps> = {}): ValidateModelDeps {
	return {
		resolveModel: () => null,
		sessionModel: null,
		...over,
	};
}

describe("validateModelAvailability", () => {
	test("empty modelStr → inherit row uses session model's provider/id", () => {
		const entries: ModelCheckEntry[] = [{ role: "Worker", modelStr: "" }];
		const sessionModel: ResolvedModelInfo = { id: "sonnet-4", provider: "anthropic" };
		const result = validateModelAvailability(entries, makeDeps({ sessionModel }));
		expect(result).toEqual([
			{
				role: "Worker",
				modelStr: "(inherit)",
				status: "inherit",
				resolvedName: "anthropic/sonnet-4",
			},
		]);
	});

	test("empty modelStr with null sessionModel falls back to 'session default'", () => {
		const entries: ModelCheckEntry[] = [{ role: "Worker", modelStr: "" }];
		const result = validateModelAvailability(entries, makeDeps({ sessionModel: null }));
		expect(result[0]?.resolvedName).toBe("session default");
		expect(result[0]?.status).toBe("inherit");
	});

	test("session model without provider drops the leading slash", () => {
		const entries: ModelCheckEntry[] = [{ role: "Worker", modelStr: "" }];
		const sessionModel: ResolvedModelInfo = { id: "opus-4" };
		const result = validateModelAvailability(entries, makeDeps({ sessionModel }));
		expect(result[0]?.resolvedName).toBe("opus-4");
	});

	test("explicit model resolves → found row with provider/id", () => {
		const entries: ModelCheckEntry[] = [{ role: "Reviewer", modelStr: "anthropic/sonnet" }];
		const deps = makeDeps({
			resolveModel: s => (s === "anthropic/sonnet" ? { id: "sonnet", provider: "anthropic" } : null),
		});
		const result = validateModelAvailability(entries, deps);
		expect(result[0]).toEqual({
			role: "Reviewer",
			modelStr: "anthropic/sonnet",
			status: "found",
			resolvedName: "anthropic/sonnet",
		});
	});

	test("resolver returns provider-less model → resolvedName drops leading slash", () => {
		const entries: ModelCheckEntry[] = [{ role: "Merger", modelStr: "bare-id" }];
		const deps = makeDeps({ resolveModel: () => ({ id: "bare-id" }) });
		const result = validateModelAvailability(entries, deps);
		expect(result[0]?.resolvedName).toBe("bare-id");
	});

	test("explicit model does not resolve → not-found (no resolvedName)", () => {
		const entries: ModelCheckEntry[] = [{ role: "Supervisor", modelStr: "vendor/missing" }];
		const result = validateModelAvailability(entries, makeDeps());
		expect(result[0]).toEqual({
			role: "Supervisor",
			modelStr: "vendor/missing",
			status: "not-found",
		});
	});

	test("preserves entry ordering in results", () => {
		const entries: ModelCheckEntry[] = [
			{ role: "Worker", modelStr: "" },
			{ role: "Reviewer", modelStr: "good" },
			{ role: "Merger", modelStr: "bad" },
			{ role: "Supervisor", modelStr: "" },
		];
		const deps = makeDeps({
			resolveModel: s => (s === "good" ? { id: "good-id", provider: "p" } : null),
			sessionModel: { id: "s", provider: "p" },
		});
		const result = validateModelAvailability(entries, deps);
		expect(result.map(r => [r.role, r.status])).toEqual([
			["Worker", "inherit"],
			["Reviewer", "found"],
			["Merger", "not-found"],
			["Supervisor", "inherit"],
		]);
	});

	test("empty entries returns empty array", () => {
		expect(validateModelAvailability([], makeDeps())).toEqual([]);
	});
});
