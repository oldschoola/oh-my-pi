/**
 * Tests for the System Prompt Style resolver in `src/prompt.ts`.
 *
 * Contracts under test:
 * - `setPromptStyle/getPromptStyle` round-trip the active style.
 * - `registerPromptVariants` records variants keyed by gentle template text.
 * - `render()` returns the registered variant for the active style.
 * - When no variant is registered for a template, `render()` falls back to
 *   the input text (identity passthrough).
 * - Re-registering the same gentle key with a *conflicting* variant throws,
 *   so a buggy generator catches collisions instead of silently shadowing.
 * - Re-registering with *identical* variants is a no-op (idempotent loaders).
 *
 * Each test resets the resolver state via the dedicated test-only helper to
 * stay full-suite safe — other tests that touch `prompt.render` must not see
 * leftover variants.
 */

import { afterEach, describe, expect, it } from "bun:test";

import {
	_resetPromptVariantsForTesting,
	getPromptStyle,
	registerPromptVariants,
	render,
	setPromptStyle,
} from "../src/prompt";

afterEach(() => {
	_resetPromptVariantsForTesting();
});

describe("prompt style resolver", () => {
	it("defaults to default and round-trips style changes", () => {
		expect(getPromptStyle()).toBe("default");
		setPromptStyle("gentle");
		expect(getPromptStyle()).toBe("gentle");
		setPromptStyle("caveman");
		expect(getPromptStyle()).toBe("caveman");
		setPromptStyle("default");
		expect(getPromptStyle()).toBe("default");
	});

	it("renders the variant for the active style when the template is registered", () => {
		const gentle = "gentle voice";
		registerPromptVariants([[gentle, { default: "default voice", caveman: "caveman voice" }]]);

		setPromptStyle("default");
		expect(render(gentle)).toBe("default voice");
		setPromptStyle("caveman");
		expect(render(gentle)).toBe("caveman voice");
		setPromptStyle("gentle");
		// No "gentle" entry was supplied; resolver falls through to the input
		// text — that *is* the gentle variant, so identity is correct.
		expect(render(gentle)).toBe(gentle);
	});

	it("uses identity fallback for templates with no registered variants", () => {
		// No registerPromptVariants call.
		setPromptStyle("default");
		const text = "unregistered template body";
		expect(render(text)).toBe(text);
		setPromptStyle("caveman");
		expect(render(text)).toBe(text);
	});

	it("uses identity fallback when the active style has no entry in the variant set", () => {
		// Variant set only carries `default`. Selecting caveman must fall back
		// to the gentle key (input text), not return undefined or throw.
		registerPromptVariants([["pure gentle", { default: "pure default" }]]);
		setPromptStyle("caveman");
		expect(render("pure gentle")).toBe("pure gentle");
	});

	it("merges repeated registrations when variants agree", () => {
		registerPromptVariants([["key", { default: "D" }]]);
		registerPromptVariants([["key", { caveman: "C" }]]);
		setPromptStyle("default");
		expect(render("key")).toBe("D");
		setPromptStyle("caveman");
		expect(render("key")).toBe("C");
	});

	it("throws on conflicting re-registration for the same gentle key + style", () => {
		registerPromptVariants([["key", { default: "D1" }]]);
		expect(() => registerPromptVariants([["key", { default: "D2" }]])).toThrow(/collision/i);
	});

	it("passes Handlebars context through to the resolved variant", () => {
		registerPromptVariants([["hello {{name}}", { default: "DEFAULT {{name}}" }]]);
		setPromptStyle("default");
		expect(render("hello {{name}}", { name: "world" })).toBe("DEFAULT world");
	});
});
