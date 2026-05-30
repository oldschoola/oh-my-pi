#!/usr/bin/env bun
/**
 * Verifies that runtime `options.reasoning` translates into a `reasoning_effort`
 * wire field for Crof's deepseek-v4-pro, and that the effort map (DeepSeek family
 * collapses minimal/low/medium/high → "high"; xhigh → "max") behaves end-to-end.
 *
 * Run with PI_REQ_DEBUG=1 to dump the outbound body.
 */
import { resolveProviderModels } from "../src/model-manager";
import { Effort } from "../src/model-thinking";
import { crofModelManagerOptions } from "../src/provider-models/openai-compat";
import { stream } from "../src/stream";
import type { Model } from "../src/types";

const apiKey = process.env.CROF_API_KEY;
if (!apiKey) {
	console.error("CROF_API_KEY not set");
	process.exit(1);
}

const { models } = await resolveProviderModels(crofModelManagerOptions({ apiKey }), "online");
const model = models.find(m => m.id === "deepseek-v4-pro") as Model<"openai-completions">;
if (!model) {
	console.error("deepseek-v4-pro missing from catalog");
	process.exit(1);
}

const efforts: Effort[] = [Effort.Low, Effort.High, Effort.XHigh];
for (const reasoning of efforts) {
	console.log(`\n=== reasoning=${reasoning} ===`);
	let text = "";
	let reasoningText = "";
	for await (const ev of stream(
		model,
		{
			systemPrompt: ["Reply with only the integer."],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "12 * 13?" }],
					timestamp: Date.now(),
				},
			],
		},
		{ reasoning },
	)) {
		if (ev.type === "text_delta") text += ev.delta;
		else if (ev.type === "thinking_delta") reasoningText += ev.delta;
		else if (ev.type === "done") {
			console.log("stop:", ev.message.stopReason, "usage:", JSON.stringify(ev.message.usage));
			break;
		} else if (ev.type === "error") {
			console.error("error:", ev.reason, JSON.stringify(ev.error));
			process.exit(1);
		}
	}
	console.log("reasoning_tokens preview:", reasoningText.slice(0, 80).replace(/\n/g, " "));
	console.log("text:", text.trim().slice(0, 80));
	if (!text.includes("156")) {
		console.error(`expected 156 in output for effort=${reasoning}`);
		process.exit(1);
	}
}

console.log("\n\u2714 all efforts produced answer 156");
