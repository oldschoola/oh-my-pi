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
 * channel. Kimi K2.x, GLM-5.x, Qwen, and Xiaomi MiMo are trained to emit these
 * blocks even when the API reasoning toggle is off. The agent applies a bundle
 * of narrowly-targeted mitigations gated on this predicate:
 *  - system-prompt addendum suppressing `<thinking>` tags
 *  - past-turn `<thinking>` strip before LLM replay
 *  - per-attempt content-character cap to bound wall-clock
 *  - tighter structural-summary inline-body threshold
 *  - softer elision-footer wording
 *
 * Boundary contract — every alternation requires a non-alphabetic delimiter
 * after the family stem so an accidental prefix can never satisfy the
 * predicate. After the path anchor `(?:^|\/)`:
 *  - `kimi[-_]` / `glm[-_]`: the family stem MUST be followed by `-` or `_`.
 *    Every shipped id is `kimi-…` / `glm-…`; the bare stems never appear and
 *    requiring the delimiter blocks `kimibara`, `glmnopq`, …
 *  - `qwen(?![a-z])` / `mimo(?![a-z])`: the family stem MUST NOT be followed
 *    by another ASCII letter. The negative lookahead lets EVERY shipped
 *    boundary through — `-`, `_`, digits, `.` (vendor-prefixed bedrock ids
 *    like `qwen.qwen3-…`), `/` (path-style `qwen/qwq-32b`, `xiaomi/mimo-7b`),
 *    `:`, end-of-string (bare `qwen` / `mimo`) — while rejecting unrelated
 *    prefixes such as `qweniverse`, `qwentastic-7b`, `mimosa`, `mimography`.
 *    `/i` makes the lookahead case-insensitive too, so `qwenIverse` and
 *    `MiMography` are also excluded.
 *
 * Intentional matches (sampled across `packages/ai/src/models.json`):
 *   kimi-k2.5, kimi-k2.6-turbo, glm-4.7, glm-5, glm-5.1,
 *   qwen, qwen3, qwen3-coder-plus, qwen3.5-plus, qwen-vl,
 *   qwen2.5-coder-32b-instruct, qwen.qwen3-235b-a22b-2507-v1:0,
 *   qwen/qwq-32b, qwen/qwen3-32b, openrouter/kimi-k2,
 *   xiaomi/mimo-7b, mimo-coder-7b, crof/mimo-v2.5-pro.
 */
const KIMI_CLASS_MODEL_REGEX = /(?:^|\/)(kimi[-_]|glm[-_]|qwen(?![a-z])|mimo(?![a-z]))/i;

/** True when the given resolved model belongs to the kimi/glm/qwen/mimo family. */
export function isKimiClassModel(m: Model | undefined): boolean {
	if (!m) return false;
	return KIMI_CLASS_MODEL_REGEX.test(m.id);
}

/** True when the given model identifier string belongs to the kimi/glm/qwen/mimo family. */
export function isKimiClassModelString(id: string | undefined | null): boolean {
	if (!id) return false;
	return KIMI_CLASS_MODEL_REGEX.test(id);
}

/**
 * GLM-specific predicate. Used for behaviors that empirically help glm-5.x but
 * regress kimi (e.g. the retry-context diff-direction addendum bullet — glm
 * benefits from explicit `-`/`+` interpretation while kimi handles it natively).
 * Strict subset of `isKimiClassModel`.
 */
const GLM_MODEL_REGEX = /(?:^|\/)glm-/i;

/** True when the given resolved model belongs to the GLM family specifically. */
export function isGlmModel(m: Model | undefined): boolean {
	if (!m) return false;
	return GLM_MODEL_REGEX.test(m.id);
}

/**
 * DeepSeek-V3/V4 family predicate. DeepSeek's official coder guidance recommends
 * `temperature=0.0` for code generation (deterministic decoding); provider
 * defaults are conversational (~1.0) and empirically too noisy for tool-calling
 * loops. Disjoint from `isKimiClassModel` — DeepSeek doesn't emit inline
 * `<thinking>` content, so the kimi-class mitigations don't apply; only the
 * sampling override does.
 *
 * Boundary: `deepseek(?![a-z])` mirrors the qwen/mimo pattern — accepts every
 * shipped id (`deepseek-coder`, `deepseek-v3`, `deepseek-r1-distill-…`,
 * vendor-prefixed `crof/deepseek-v4-pro-precision`) while rejecting hypothetical
 * `deepseekend` or `deepseekery` prefixes.
 */
const DEEPSEEK_MODEL_REGEX = /(?:^|\/)deepseek(?![a-z])/i;

/** True when the given resolved model belongs to the DeepSeek family. */
export function isDeepseekModel(m: Model | undefined): boolean {
	if (!m) return false;
	return DEEPSEEK_MODEL_REGEX.test(m.id);
}
