/**
 * Pure CLI argument parsers for mission slash commands.
 *
 * Ported from `taskplane/extensions/taskplane/extension.ts:73-165`:
 *
 * - `parseIntegrateArgs` — drives `/mission-integrate` (ff/merge/pr modes +
 *   optional `--force` + optional branch positional).
 * - `parseResumeArgs` — drives `/mission-resume` (just `--force` / `--help`).
 *
 * Both return `{ ... } | { error }` so call sites can destructure on an
 * `error` discriminator without throwing. Error copy mentions the mission
 * slash command names explicitly so the user sees the right usage hint.
 */

// ── Integrate args ──────────────────────────────────────────────────

export type IntegrateMode = "ff" | "merge" | "pr";

export interface IntegrateArgs {
	mode: IntegrateMode;
	force: boolean;
	orchBranchArg?: string;
}

/**
 * Parse `/mission-integrate` arguments.
 *
 * Supported flags:
 *   `--merge` / `--pr`  (mutually exclusive — overrides default `ff`)
 *   `--force`
 * One optional positional: an explicit mission (orch) branch name.
 *
 * Returns parsed args on success, or `{ error }` on any validation failure
 * (unknown flag, mutual-exclusion conflict, too many positionals).
 */
export function parseIntegrateArgs(raw: string | undefined): IntegrateArgs | { error: string } {
	const input = raw?.trim() ?? "";
	const tokens = input.split(/\s+/).filter(Boolean);

	let mode: IntegrateMode = "ff";
	let force = false;
	const positionals: string[] = [];
	let hasMerge = false;
	let hasPr = false;

	for (const token of tokens) {
		if (token === "--merge") {
			hasMerge = true;
		} else if (token === "--pr") {
			hasPr = true;
		} else if (token === "--force") {
			force = true;
		} else if (token.startsWith("--")) {
			return { error: `Unknown flag: ${token}` };
		} else {
			positionals.push(token);
		}
	}

	if (hasMerge && hasPr) {
		return { error: "Cannot use --merge and --pr together. Choose one integration mode." };
	}

	if (hasMerge) mode = "merge";
	if (hasPr) mode = "pr";

	if (positionals.length > 1) {
		return { error: `Expected at most one branch argument, got ${positionals.length}: ${positionals.join(", ")}` };
	}

	return {
		mode,
		force,
		orchBranchArg: positionals[0],
	};
}

// ── Resume args ──────────────────────────────────────────────────────

export interface ResumeArgs {
	force: boolean;
}

/**
 * Parse `/mission-resume` arguments.
 *
 * Supported flags: `--force`, `--help`.
 * No positional arguments are accepted — any stray token is an error.
 *
 * `--help` returns a usage string under the `error` key so the caller can
 * print it verbatim without branching on an extra discriminator.
 */
export function parseResumeArgs(raw: string | undefined): ResumeArgs | { error: string } {
	const input = raw?.trim() ?? "";
	if (!input) return { force: false };

	const tokens = input.split(/\s+/).filter(Boolean);
	let force = false;

	for (const token of tokens) {
		if (token === "--force") {
			force = true;
		} else if (token === "--help") {
			return {
				error:
					"Usage: /mission-resume [--force]\n\n" +
					"  --force   Resume from stopped or failed state (runs pre-resume diagnostics first)",
			};
		} else if (token.startsWith("--")) {
			return { error: `Unknown flag: ${token}\n\nUsage: /mission-resume [--force]` };
		} else {
			return { error: `Unexpected argument: ${token}\n\nUsage: /mission-resume [--force]` };
		}
	}

	return { force };
}
