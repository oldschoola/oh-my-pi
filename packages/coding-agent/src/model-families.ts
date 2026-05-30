/**
 * Shared model-family predicates used to gate behavior across the coding-agent
 * runtime. Keeping the regex in one place avoids drift between sdk.ts,
 * agent-session.ts, and the tool-output renderers — adding a new family is now
 * a one-line change here.
 */
import type { Model } from "@oh-my-pi/pi-ai";

/**
 * Model families that emit verbose inline `<thinking>...</thinking>` text in
 * their assistant content stream rather than using a provider-side reasoning
 * channel. Kimi K2.x, GLM-5.x, and Qwen are trained to emit these blocks even
 * when the API reasoning toggle is off. The agent applies a bundle of
 * narrowly-targeted mitigations gated on this predicate:
 *  - system-prompt addendum suppressing `<thinking>` tags
 *  - past-turn `<thinking>` strip before LLM replay
 *  - per-attempt content-character cap to bound wall-clock
 *  - tighter structural-summary inline-body threshold
 *  - softer elision-footer wording
 */
const KIMI_CLASS_MODEL_REGEX = /(?:^|\/)(kimi|glm-|qwen)/i;

/** True when the given resolved model belongs to the kimi/glm/qwen family. */
export function isKimiClassModel(m: Model | undefined): boolean {
	if (!m) return false;
	return KIMI_CLASS_MODEL_REGEX.test(m.id);
}

/** True when the given model identifier string belongs to the kimi/glm/qwen family. */
export function isKimiClassModelString(id: string | undefined | null): boolean {
	if (!id) return false;
	return KIMI_CLASS_MODEL_REGEX.test(id);
}
