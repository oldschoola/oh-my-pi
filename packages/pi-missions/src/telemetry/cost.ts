/**
 * Token → USD cost calculation for mission telemetry.
 *
 * Prices expressed in USD per 1M tokens. Ported from taskplane
 * `extensions/taskplane/telemetry.ts`. Keep in sync with Anthropic
 * and OpenAI published rates.
 */

export interface ModelPricing {
	inputPerMillion: number;
	outputPerMillion: number;
	cacheReadPerMillion: number;
	cacheWritePerMillion: number;
}

const PRICING: Record<string, ModelPricing> = {
	"claude-opus-4": {
		inputPerMillion: 15,
		outputPerMillion: 75,
		cacheReadPerMillion: 1.5,
		cacheWritePerMillion: 18.75,
	},
	"claude-opus-4-1": {
		inputPerMillion: 15,
		outputPerMillion: 75,
		cacheReadPerMillion: 1.5,
		cacheWritePerMillion: 18.75,
	},
	"claude-opus-4-5": {
		inputPerMillion: 15,
		outputPerMillion: 75,
		cacheReadPerMillion: 1.5,
		cacheWritePerMillion: 18.75,
	},
	"claude-opus-4-6": {
		inputPerMillion: 15,
		outputPerMillion: 75,
		cacheReadPerMillion: 1.5,
		cacheWritePerMillion: 18.75,
	},
	"claude-opus-4-7": {
		inputPerMillion: 15,
		outputPerMillion: 75,
		cacheReadPerMillion: 1.5,
		cacheWritePerMillion: 18.75,
	},
	"claude-sonnet-4": {
		inputPerMillion: 3,
		outputPerMillion: 15,
		cacheReadPerMillion: 0.3,
		cacheWritePerMillion: 3.75,
	},
	"claude-sonnet-4-5": {
		inputPerMillion: 3,
		outputPerMillion: 15,
		cacheReadPerMillion: 0.3,
		cacheWritePerMillion: 3.75,
	},
	"claude-sonnet-4-6": {
		inputPerMillion: 3,
		outputPerMillion: 15,
		cacheReadPerMillion: 0.3,
		cacheWritePerMillion: 3.75,
	},
	"claude-haiku-4-5": {
		inputPerMillion: 1,
		outputPerMillion: 5,
		cacheReadPerMillion: 0.1,
		cacheWritePerMillion: 1.25,
	},
};

const DEFAULT_PRICING: ModelPricing = {
	inputPerMillion: 3,
	outputPerMillion: 15,
	cacheReadPerMillion: 0.3,
	cacheWritePerMillion: 3.75,
};

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export function getPricingFor(model: string): ModelPricing {
	for (const [prefix, price] of Object.entries(PRICING)) {
		if (model.includes(prefix)) return price;
	}
	return DEFAULT_PRICING;
}

export function calculateCost(usage: TokenUsage, model: string): number {
	const p = getPricingFor(model);
	return (
		(usage.input * p.inputPerMillion) / 1_000_000 +
		(usage.output * p.outputPerMillion) / 1_000_000 +
		(usage.cacheRead * p.cacheReadPerMillion) / 1_000_000 +
		(usage.cacheWrite * p.cacheWritePerMillion) / 1_000_000
	);
}

export function formatCost(cost: number): string {
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}
