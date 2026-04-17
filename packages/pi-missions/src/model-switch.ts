// src/model-switch.ts — Shared phase-role → model auto-switching
//
// Both the message_end lifecycle path (index.ts) and the manual /mission-next
// command (commands.ts) need to switch the active model when a new phase
// activates. Keeping a single implementation here makes the behavior uniform:
//   - `provider/id` selector is the source of truth (disambiguates identical
//     model IDs across providers, e.g. openai/gpt-4o vs nanogpt/gpt-4o)
//   - Bare IDs are tolerated for backwards compatibility with older saved
//     defaults, but `provider/id` is what the picker writes today
//   - The registry is filtered to `getAvailable()` so we never silently switch
//     to a model the user has no auth for
//   - All failure modes surface via `ctx.ui.notify` so the user learns the
//     mission is running on the wrong model — silent fallback is the bug this
//     helper exists to prevent.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import { resolvePhaseRole } from "./config";
import type { MissionState } from "./types";

/** Narrow context shape the model-switch flow actually reads. */
export type ModelSwitchCtx = Pick<ExtensionContext, "modelRegistry" | "ui">;

/**
 * Switch to the assigned model for the current phase role, if configured.
 *
 * `state.modelAssignment[role]` is a `provider/id` selector (e.g.
 * `anthropic/claude-sonnet-4`). Bare IDs are accepted as a backwards-compat
 * fallback for older saved defaults.
 *
 * Behaviour:
 *   - No assignment or no active phase → no-op.
 *   - Model not available in the registry → notify error, do nothing.
 *   - `pi.setModel` returns false (no auth) → notify error.
 *   - `pi.setModel` throws → notify error, log.
 *   - Otherwise → model switched, silent success.
 *
 * Safe to call every turn — `setModel` is a no-op when the target already
 * matches the current model.
 */
export async function maybeSwitchModel(pi: ExtensionAPI, state: MissionState, ctx: ModelSwitchCtx): Promise<void> {
	if (Object.keys(state.modelAssignment).length === 0) return;

	const activePhase = state.phases.find(p => p.status === "active");
	if (!activePhase) return;

	const role = resolvePhaseRole(activePhase.name);

	const targetModelId = state.modelAssignment[role];
	if (!targetModelId) return;

	const allModels = ctx.modelRegistry.getAvailable();
	const slashIndex = targetModelId.indexOf("/");
	let model: (typeof allModels)[number] | undefined;
	if (slashIndex === -1) {
		model = allModels.find(m => m.id === targetModelId);
	} else {
		const provider = targetModelId.substring(0, slashIndex).toLowerCase();
		const modelId = targetModelId.substring(slashIndex + 1);
		model = allModels.find(m => m.provider.toLowerCase() === provider && m.id === modelId);
	}

	if (!model) {
		const msg = `Mission model not available: ${targetModelId} (role: ${role}). Run /mission to reassign.`;
		logger.error("[pi-mission] model switch: model not found", { targetModelId, role });
		ctx.ui.notify(msg, "error");
		return;
	}

	try {
		const ok = await pi.setModel(model);
		if (!ok) {
			const msg = `Mission model switch failed: no auth for ${model.provider} (${model.id}). Run /login to add an API key.`;
			logger.error("[pi-mission] model switch: setModel returned false", {
				provider: model.provider,
				modelId: model.id,
				role,
			});
			ctx.ui.notify(msg, "error");
		}
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		logger.error("[pi-mission] model switch threw", {
			error: errMsg,
			provider: model.provider,
			modelId: model.id,
			role,
		});
		ctx.ui.notify(`Mission model switch failed: ${errMsg}`, "error");
	}
}
