/**
 * Context window resolution when spawning worker agents.
 *
 * Ported from taskplane `extensions/taskplane/context-window.ts`. The
 * pi-coding-agent `ExtensionContext` provides `model.contextWindow`
 * which we prefer over any explicit fallback.
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const FALLBACK_CONTEXT_WINDOW = 200_000;

export function resolveContextWindow(
	configuredWindow: number | undefined,
	ctx: Pick<ExtensionContext, "model"> | null,
): { contextWindow: number; source: string } {
	if (configuredWindow && configuredWindow > 0) {
		return { contextWindow: configuredWindow, source: "explicit config" };
	}

	const modelWindow = ctx?.model?.contextWindow;
	if (modelWindow && modelWindow > 0) {
		const modelId = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
		return { contextWindow: modelWindow, source: `auto-detected from ${modelId}` };
	}

	return { contextWindow: FALLBACK_CONTEXT_WINDOW, source: `fallback ${FALLBACK_CONTEXT_WINDOW}` };
}
