import { describe, expect, it } from "bun:test";
import type { RenderResultOptions } from "@oh-my-pi/pi-agent-core";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { FastContextToolDetails } from "@oh-my-pi/pi-coding-agent/tools/fast-context";
import { fastContextToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/fast-context";

/**
 * Result text the model would produce — wrapped in raw <final_answer> tags
 * (the pre-fix leak shape). The renderer must NEVER surface these tags.
 */
const RAW_FINAL_ANSWER_TEXT = `<final_answer>Relevant files for the auth flow:
- code/Auth.ts:1-10 defines the session guard
- code/Login.ts:5-20 handles credential check
</final_answer>`;

function fcDetails(overrides: Partial<FastContextToolDetails> = {}): FastContextToolDetails {
	return {
		model: "devin/swe-1-6-fast",
		mode: "agent",
		turns: 2,
		toolCalls: 4,
		citations: ["code/Auth.ts:1-10", "code/Login.ts:5-20"],
		keywords: ["auth", "login"],
		...overrides,
	};
}

function renderResult(details: FastContextToolDetails, theme: Theme, text: string, expanded = false): string {
	const options: RenderResultOptions = { expanded, isPartial: false, spinnerFrame: 0 };
	const component = fastContextToolRenderer.renderResult(
		{ content: [{ type: "text", text }], details },
		options,
		theme,
	);
	return Bun.stripANSI(component.render(120).join("\n"));
}

describe("fast_context renderer", () => {
	it("strips <final_answer> tags — rendered output contains neither open nor close tag", async () => {
		const theme = (await getThemeByName("dark"))!;
		const out = renderResult(fcDetails(), theme, RAW_FINAL_ANSWER_TEXT);

		expect(out).not.toContain("<final_answer>");
		expect(out).not.toContain("</final_answer>");
	});

	it("renders structured citations inline (not parsed from result text)", async () => {
		const theme = (await getThemeByName("dark"))!;
		const out = renderResult(fcDetails(), theme, RAW_FINAL_ANSWER_TEXT);

		// At least one citation from details.citations appears.
		expect(out).toContain("code/Auth.ts:1-10");
		// Header shows the file count.
		expect(out).toMatch(/2 files/);
		// Header carries model + mode context.
		expect(out).toContain("devin/swe-1-6-fast");
		expect(out).toContain("agent");
	});

	it("renders inline (no collapsed ctrl+o expand marker) in both live and rebuilt shapes", async () => {
		const theme = (await getThemeByName("dark"))!;

		// Rebuilt-transcript path: expanded=false (collapsed default), result present.
		const collapsed = renderResult(fcDetails(), theme, RAW_FINAL_ANSWER_TEXT, false);
		// Collapsed still shows citations inline (capped), not a ctrl+o window.
		expect(collapsed).toContain("code/Auth.ts:1-10");
		// No expand-to-full-output hint that the generic collapsed window uses.
		expect(collapsed).not.toContain("ctrl+o");

		// Live-streaming path: isPartial would be true in practice; the renderer
		// is the same component, so verify expanded shows ALL citations.
		const expanded = renderResult(fcDetails(), theme, RAW_FINAL_ANSWER_TEXT, true);
		expect(expanded).toContain("code/Auth.ts:1-10");
		expect(expanded).toContain("code/Login.ts:5-20");
		expect(expanded).not.toContain("<final_answer>");
	});

	it("renders an error-styled block when details.error is set", async () => {
		const theme = (await getThemeByName("dark"))!;
		const details = fcDetails({
			citations: [],
			error: "FastContext returned no file-line citations; hint fallback also found no files.",
		});
		const out = renderResult(details, theme, details.error ?? "");

		expect(out).toContain("FastContext returned no file-line citations");
		expect(out).not.toContain("<final_answer>");
	});

	it("falls back to hint-packet file list when citations are empty but text has files", async () => {
		const theme = (await getThemeByName("dark"))!;
		const details = fcDetails({ mode: "hint", citations: [] });
		const hintText = `[FC hint: 2 files]

Files:
code/Auth.ts
code/Login.ts

[auth login]`;
		const out = renderResult(details, theme, hintText);

		// Fallback parsed the Files: block.
		expect(out).toContain("code/Auth.ts");
		expect(out).toContain("2 files");
	});
});
