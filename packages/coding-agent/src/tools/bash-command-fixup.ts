/**
 * Conservative transforms applied to a bash command before execution.
 *
 * Three fixups are applied (in this order):
 *
 *  1. Rewrite unquoted Windows drive paths (`C:\tmp\foo` → `C:/tmp/foo`). The
 *     POSIX shell brush treats `\X` as "literal X" outside quotes, so a raw
 *     Windows path arrives at the child as `C:tmpfoo` and fails. Quoted paths
 *     are left alone — quoting is the agent's explicit signal.
 *
 *  2. Trailing `| head [args]` / `| tail [args]` (and the `|&` variant) on a
 *     top-level segment — these pipes exist purely to limit output length.
 *     The harness already truncates bash output and exposes the full result
 *     via an artifact, so they only hide content the agent wanted.
 *
 *  3. A redundant trailing `2>&1` left on a segment that has no remaining
 *     pipe or other redirect. The harness already merges stderr into stdout,
 *     so the duplication is purely cosmetic — and often a leftover after
 *     fixup (2) drops a downstream pipe.
 *
 * The heavy lifting (tokenization, quoting, heredoc handling, command
 * substitution, nested compound commands) lives in Rust under
 * `pi_shell::fixup`, driven by the real `brush-parser` AST. This module is a
 * thin sync wrapper plus user-facing notice formatting.
 */
import { applyBashFixups as nativeApplyBashFixups, type RewrittenPath } from "@oh-my-pi/pi-natives";

export type { RewrittenPath };

export interface BashFixupResult {
	/** Possibly-rewritten command. */
	command: string;
	/** Substrings that were stripped, in the order they were removed. */
	stripped: string[];
	/** Windows paths re-slashed, in source order. Empty when nothing fired. */
	rewritten: RewrittenPath[];
}

/**
 * Apply both fixups to a bash command. On any parse failure, multi-line input,
 * or no-op transform, returns the input verbatim with `stripped: []` and
 * `rewritten: []`.
 */
export function applyBashFixups(command: string): BashFixupResult {
	return nativeApplyBashFixups(command);
}

/**
 * Human-readable notice for the fixups that fired. Mirrors the shape of
 * `formatTimeoutClampNotice` so it can ride alongside the other bash notices.
 *
 * Path rewrites and strip notices are surfaced as two sentences in a single
 * `<system-warning>` block; the caller decides whether to actually emit it
 * (notice is one-shot per session).
 */
export function formatBashFixupNotice(
	stripped: readonly string[],
	rewritten: readonly RewrittenPath[] = [],
): string | undefined {
	if (!stripped.length && !rewritten.length) return undefined;
	const parts: string[] = [];
	if (rewritten.length) {
		const pairs = rewritten.map(p => `\`${p.from}\` → \`${p.to}\``).join(", ");
		parts.push(
			`Rewrote Windows-style path${rewritten.length === 1 ? "" : "s"} ${pairs} so the POSIX shell doesn't strip the backslashes as escapes. Prefer forward slashes when invoking bash on Windows.`,
		);
	}
	if (stripped.length) {
		const quoted = stripped.map(s => `\`${s}\``).join(", ");
		parts.push(
			`Stripped redundant ${quoted} — bash output is already truncated and stderr is already merged into stdout. NEVER use these patterns.`,
		);
	}
	return `<system-warning>${parts.join(" ")}</system-warning>`;
}
