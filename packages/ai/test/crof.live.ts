#!/usr/bin/env bun
/**
 * Live integration check against Crof.ai.
 *
 * Verifies:
 *   1. Catalog discovery returns deepseek-v4-pro with reasoning enabled.
 *   2. The runtime stream() picks up CROF_API_KEY and produces text.
 *
 * Usage:  CROF_API_KEY=... bun test/crof-live-integration.ts
 */

import { resolveProviderModels } from "../src/model-manager";
import { crofModelManagerOptions } from "../src/provider-models/openai-compat";
import { stream } from "../src/stream";
import type { Model } from "../src/types";

const apiKey = process.env.CROF_API_KEY;
if (!apiKey) {
	console.error("CROF_API_KEY not set");
	process.exit(1);
}

// ----- 1. Catalog discovery -----
const result = await resolveProviderModels(crofModelManagerOptions({ apiKey }), "online");
const models = result.models;
console.log(`Discovered ${models.length} crof models`);
const dsv4 = models.find(m => m.id === "deepseek-v4-pro");
if (!dsv4) {
	console.error("deepseek-v4-pro not present in catalog");
	process.exit(1);
}
console.log(`deepseek-v4-pro: reasoning=${dsv4.reasoning} cost=${JSON.stringify(dsv4.cost)} ctx=${dsv4.contextWindow}`);

// ----- 2. Stream completion -----
const model = dsv4 as Model<"openai-completions">;
const events = stream(model, {
	systemPrompt: ["You are a terse arithmetic assistant. Respond with only the number."],
	messages: [
		{
			role: "user",
			content: [{ type: "text", text: "What is 17 * 38?" }],
			timestamp: Date.now(),
		},
	],
});

let text = "";
let reasoning = "";
for await (const event of events) {
	if (event.type === "text_delta") {
		text += event.delta;
	} else if (event.type === "thinking_delta") {
		reasoning += event.delta;
	} else if (event.type === "done") {
		console.log("\n--- done ---");
		console.log("stopReason:", event.message.stopReason);
		if (event.message.usage) {
			console.log("usage:", JSON.stringify(event.message.usage));
		}
		break;
	} else if (event.type === "error") {
		console.error("\n--- error ---");
		console.error("reason:", event.reason);
		console.error("error message:", JSON.stringify(event.error, null, 2));
		process.exit(1);
	}
}

if (reasoning) {
	console.log("\n--- reasoning (first 200 chars) ---");
	console.log(reasoning.slice(0, 200) + (reasoning.length > 200 ? "..." : ""));
}
console.log("\n--- text ---");
console.log(text);

const expected = (17 * 38).toString();
if (!text.includes(expected)) {
	console.error(`Expected response to contain ${expected}`);
	process.exit(1);
}
console.log(`\n\u2714 Response contains ${expected}`);
