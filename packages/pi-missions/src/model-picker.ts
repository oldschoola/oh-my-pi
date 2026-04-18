// src/model-picker.ts — Scrollable, searchable model picker overlay
//
// Replaces raw ctx.ui.select() for model lists that can grow large (50+ items).
// Uses SelectList from @oh-my-pi/pi-tui for fuzzy search and scrolling.

import {
	DynamicBorder,
	type ExtensionCommandContext,
	type ExtensionContext,
	getSelectListTheme,
} from "@oh-my-pi/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";

/** A model entry with display label and underlying ID for storage. */
export interface ModelOption {
	label: string;
	id: string;
}

/** Maximum visible items before the list scrolls */
const MAX_VISIBLE = 10;

/**
 * Show a scrollable, searchable model picker overlay.
 *
 * @param ctx   Extension command or event context (needs ctx.ui.custom)
 * @param title Header displayed above the list
 * @param models Array of model options — first match wins on enter
 * @returns The selected ModelOption, or null if cancelled
 */
export async function showModelPicker(
	ctx: ExtensionCommandContext | ExtensionContext,
	title: string,
	models: ModelOption[],
): Promise<ModelOption | null> {
	const items: SelectItem[] = models.map(m => ({
		value: m.id,
		label: m.label,
	}));

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();

		// Top border
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Spacer(1));

		// Title
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		// Hint
		container.addChild(new Text(theme.fg("muted", "Type to filter · ↑↓ navigate · enter select · esc cancel"), 1, 0));
		container.addChild(new Spacer(1));

		// SelectList — scrollable with fuzzy search built-in
		const selectList = new SelectList(items, Math.min(items.length, MAX_VISIBLE), {
			...getSelectListTheme(),
			noMatch: t => theme.fg("warning", t),
		});
		selectList.onSelect = item => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);

		container.addChild(new Spacer(1));

		// Bottom border
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (result === null) return null;

	// Map back to the full ModelOption
	return models.find(m => m.id === result) ?? null;
}

/**
 * Model IDs known to be deprecated or removed upstream. These are filtered out
 * of the picker so users cannot pick a model that will 404 on first use.
 * Stored as bare IDs (matches any provider carrying that ID).
 */
const DEPRECATED_MODEL_IDS = new Set<string>([
	"claude-3-5-sonnet-20240620",
	"claude-3-5-sonnet-20241022",
	"claude-3-opus-20240229",
	"claude-3-haiku-20240307",
]);

/**
 * Build model options from the model registry.
 *
 * Each option's `id` is stored as `provider/id` (e.g. `anthropic/claude-sonnet-4`)
 * to disambiguate identical model IDs offered by multiple providers (e.g. `gpt-4o`
 * exists under both `openai` and `nanogpt`). The label shows the model name with
 * provider suffix for clarity.
 *
 * Deprecated models (see `DEPRECATED_MODEL_IDS`) are filtered out.
 *
 * Always includes "(current model)" as the first option with an empty id.
 */
export function getAvailableModelOptions(ctx: ExtensionCommandContext | ExtensionContext): ModelOption[] {
	try {
		const allModels = ctx.modelRegistry.getAvailable();
		if (allModels.length > 0) {
			const filtered = allModels
				.filter(m => !DEPRECATED_MODEL_IDS.has(m.id))
				.map(m => {
					const rawName = m.name ?? m.id;
					const cleanName = rawName.replace(/\s*\(latest\)\s*$/i, "").trim() || (m.id as string);
					return {
						provider: m.provider as string,
						cleanName,
						id: `${m.provider}/${m.id}`,
					};
				});

			filtered.sort((a, b) => {
				const byProvider = a.provider.localeCompare(b.provider);
				if (byProvider !== 0) return byProvider;
				return a.cleanName.localeCompare(b.cleanName);
			});

			return [
				{ label: "(current model)", id: "" },
				...filtered.map(m => ({
					label: `${m.cleanName} — ${m.provider}`,
					id: m.id,
				})),
			];
		}
	} catch (err) {
		logger.debug("[pi-mission] model registry unavailable, using fallback list", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
	return [
		{ label: "(current model)", id: "" },
		{ label: "Claude Sonnet 4 — anthropic", id: "anthropic/claude-sonnet-4" },
		{ label: "Claude Sonnet 4.5 — anthropic", id: "anthropic/claude-sonnet-4-5" },
		{ label: "Claude Haiku 4.5 — anthropic", id: "anthropic/claude-haiku-4-5" },
		{ label: "GPT-4o — openai", id: "openai/gpt-4o" },
		{ label: "GPT-4o mini — openai", id: "openai/gpt-4o-mini" },
	];
}
