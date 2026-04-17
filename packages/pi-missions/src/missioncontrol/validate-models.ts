/**
 * Pure model-availability check behind `/mission-settings`.
 *
 * Ported from `taskplane/extensions/taskplane/extension.ts:844-893`.
 * Decoupled from `ExtensionContext`: callers pass the session model plus a
 * `resolveModel(modelStr)` callback, so the resolver can be backed by the
 * real `@oh-my-pi/pi-ai` registry in production or by a stub in tests.
 *
 * The function never mutates config — it only reports which roles
 * inherit, which resolve cleanly, and which point at missing models so
 * the UI layer (`formatModelValidation`) can surface the ❌ rows and the
 * fix-hint pointing at `.omp/mission.json`.
 */

import type { ModelCheckResult } from "./formatting";
import type { ModelCheckEntry, ResolvedModelInfo } from "./types";

export interface ValidateModelDeps {
	/** Return the host-resolved model for the given override string, or null when not found. */
	resolveModel: (modelStr: string) => ResolvedModelInfo | null;
	/** The current session's model — used to format the `inherit` row's resolved name. */
	sessionModel: ResolvedModelInfo | null;
}

/**
 * Validate the per-role model overrides against the host model registry.
 *
 * Empty `modelStr` means "inherit the session model" and always resolves;
 * a non-empty string that does not resolve is reported as `not-found`.
 * API-key availability is not checked here — this only catches typos and
 * missing-registration bugs.
 */
export function validateModelAvailability(entries: ModelCheckEntry[], deps: ValidateModelDeps): ModelCheckResult[] {
	const results: ModelCheckResult[] = [];

	for (const entry of entries) {
		if (!entry.modelStr) {
			results.push({
				role: entry.role,
				modelStr: "(inherit)",
				status: "inherit",
				resolvedName: formatResolvedName(deps.sessionModel) ?? "session default",
			});
			continue;
		}

		const resolved = deps.resolveModel(entry.modelStr);
		if (resolved) {
			results.push({
				role: entry.role,
				modelStr: entry.modelStr,
				status: "found",
				resolvedName: formatResolvedName(resolved) ?? entry.modelStr,
			});
		} else {
			results.push({
				role: entry.role,
				modelStr: entry.modelStr,
				status: "not-found",
			});
		}
	}

	return results;
}

function formatResolvedName(model: ResolvedModelInfo | null): string | null {
	if (!model) return null;
	return `${model.provider ?? ""}/${model.id}`.replace(/^\//, "");
}
