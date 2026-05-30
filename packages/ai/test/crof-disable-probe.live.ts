#!/usr/bin/env bun
/**
 * Verifies that `disableReasoning: true` produces the expected native disable
 * wire shape per host AND that the upstream actually returns ~0 reasoning
 * tokens (true disable, not a token sink masquerading as one).
 *
 * Usage:  CROF_API_KEY=... DEEPSEEK_API_KEY=... bun test/crof-disable-probe.live.ts
 */
import { resolveProviderModels } from "../src/model-manager";
import { crofModelManagerOptions, deepseekModelManagerOptions } from "../src/provider-models/openai-compat";
import { stream } from "../src/stream";
import type { Model } from "../src/types";

const crofKey = process.env.CROF_API_KEY;
const deepseekKey = process.env.DEEPSEEK_API_KEY;

async function pickAll(
	label: string,
	options: ReturnType<typeof crofModelManagerOptions> | ReturnType<typeof deepseekModelManagerOptions>,
	ids: readonly string[],
): Promise<Model<"openai-completions">[]> {
	const { models } = await resolveProviderModels(options, "online");
	return ids.map(id => {
		const m = models.find(x => x.id === id);
		if (!m) throw new Error(`${label}: ${id} not in catalog (got ${models.length} models)`);
		return m as Model<"openai-completions">;
	});
}

async function probeDisable(label: string, model: Model<"openai-completions">) {
	console.log(`\n=== ${label} ===`);
	let captured: Record<string, unknown> | undefined;
	let reasoningChars = 0;
	let textChars = 0;
	let usage: Record<string, unknown> | undefined;

	for await (const ev of stream(
		model,
		{
			systemPrompt: ["Reply with only the integer."],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "9 + 8?" }],
					timestamp: Date.now(),
				},
			],
		},
		{
			disableReasoning: true,
			onPayload: (payload: unknown) => {
				captured = payload as Record<string, unknown>;
			},
		},
	)) {
		if (ev.type === "text_delta") textChars += ev.delta.length;
		else if (ev.type === "thinking_delta") reasoningChars += ev.delta.length;
		else if (ev.type === "done") {
			usage = ev.message.usage as unknown as Record<string, unknown>;
			break;
		} else if (ev.type === "error") {
			console.error("ERROR:", ev.reason, JSON.stringify(ev.error));
			return;
		}
	}

	console.log("  wire shape :", {
		reasoning_effort: captured?.reasoning_effort,
		thinking: captured?.thinking,
	});
	console.log("  reasoning_chars (assistant deltas):", reasoningChars);
	console.log("  text_chars:", textChars);
	console.log("  usage:", JSON.stringify(usage));
}

const ids = ["deepseek-v4-pro", "deepseek-v4-flash"] as const;

if (crofKey) {
	const models = await pickAll("crof", crofModelManagerOptions({ apiKey: crofKey }), ids);
	for (const model of models) {
		await probeDisable(`Crof   ${model.id.padEnd(20)} (expect re:none, no thinking, ~0 reasoning chars)`, model);
	}
}
if (deepseekKey) {
	const models = await pickAll("deepseek", deepseekModelManagerOptions({ apiKey: deepseekKey }), ids);
	for (const model of models) {
		await probeDisable(
			`Direct ${model.id.padEnd(20)} (expect thinking:disabled, no effort, ~0 reasoning chars)`,
			model,
		);
	}
}
if (!crofKey && !deepseekKey) {
	console.error("set CROF_API_KEY and/or DEEPSEEK_API_KEY");
	process.exit(1);
}
