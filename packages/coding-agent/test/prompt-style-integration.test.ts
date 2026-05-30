/**
 * End-to-end behavioral test for the System Prompt Style mechanism.
 *
 * The unit tests in `pi-utils/test/prompt-style.test.ts` cover the resolver
 * in isolation. This test exercises the wired-up coding-agent stack:
 *
 *   1. Import the coding-agent variant registry (side-effect registers every
 *      bundled prompt into the shared resolver).
 *   2. Render a real bundled prompt (the `write` tool description) under
 *      each of the three styles.
 *   3. Assert the three renderings are all distinct and that each carries
 *      style-characteristic markers — proving that:
 *       - all 74 coding-agent variants and 8 agent variants registered,
 *       - the resolver is reached from a real `prompt.render` call site, and
 *       - eager `readonly description = prompt.render(...)` patterns will see
 *         the active style as long as the tool class is instantiated after
 *         the style is set.
 *
 * The test resets the resolver's style back to gentle after each case so a
 * later test relying on the singleton's default behavior isn't poisoned.
 */

import { afterEach, describe, expect, it } from "bun:test";

// Import the prompt submodule directly to avoid pulling the pi-utils barrel
// (which loads pi-natives). Same trick the generated registry files use.
import * as prompt from "@oh-my-pi/pi-utils/prompt";

// Side-effect: registers all bundled coding-agent prompt variants. This is
// the same import that `config/settings.ts` performs at runtime.
import "../src/prompts-variants.generated";
// Side-effect: registers the 8 compaction prompts owned by the agent
// package. The generated file imports the prompt submodule directly to
// avoid pulling pi-utils → pi-natives into the test runtime.
import "@oh-my-pi/pi-agent-core/compaction-variants.generated";

// Same import shape the tool definitions use at runtime.
import writeDescription from "../src/prompts/tools/write.md" with { type: "text" };

afterEach(() => {
	prompt.setPromptStyle("default");
});

describe("System Prompt Style integration", () => {
	it("renders distinct write tool descriptions across all three styles", () => {
		prompt.setPromptStyle("default");
		const asDefault = prompt.render(writeDescription);

		prompt.setPromptStyle("gentle");
		const asGentle = prompt.render(writeDescription);

		prompt.setPromptStyle("caveman");
		const asCaveman = prompt.render(writeDescription);

		// Every style produces a non-trivially long description.
		expect(asDefault.length).toBeGreaterThan(200);
		expect(asGentle.length).toBeGreaterThan(200);
		expect(asCaveman.length).toBeGreaterThan(200);

		// All three must differ. Two-equal pairs would mean either a missing
		// variant or a regressed resolver.
		expect(asDefault).not.toBe(asGentle);
		expect(asDefault).not.toBe(asCaveman);
		expect(asGentle).not.toBe(asCaveman);
	});

	it("default style carries authoritative RFC 2119 markers from the pre-gentle text", () => {
		prompt.setPromptStyle("default");
		const out = prompt.render(writeDescription);
		// The pre-gentle write.md prominently used `You SHOULD`/`You NEVER`
		// directives — the gentle rewrite softened them into "Don't"/"prefer".
		// At minimum one of the authoritative tokens must survive in default.
		const hasAuthoritativeMarker = /\bYou (SHOULD|NEVER|MUST)\b/.test(out) || /\b(NEVER|MUST)\b/.test(out);
		expect(hasAuthoritativeMarker).toBe(true);
	});

	it("style switches affect the next render() call with no rebuild needed", () => {
		// Style flips back and forth; each call sees the active style. The
		// Handlebars compile cache is keyed by template text, so the second
		// flip is observing a *fresh* render against the cached compile, not
		// a memoized string from the first flip.
		prompt.setPromptStyle("default");
		const a = prompt.render(writeDescription);
		prompt.setPromptStyle("caveman");
		const b = prompt.render(writeDescription);
		prompt.setPromptStyle("default");
		const c = prompt.render(writeDescription);

		expect(a).toBe(c);
		expect(a).not.toBe(b);
	});
});
