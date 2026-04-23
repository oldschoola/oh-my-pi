/**
 * Secret scanner (Track I).
 *
 * Regex-based detector for common secret formats. Conservative by default
 * so false positives stay rare; projects that want deeper scanning
 * register additional patterns via {@link MissionPolicy.secretPatterns}.
 *
 * Scanner is the Droid-Shield-equivalent for outbound agent payloads \u2014
 * prompts, tool call args, env values. A call to {@link scanForSecrets}
 * returns every match found; callers combine that with the policy's
 * `secretScanner` mode (`off | warn | block`) to decide how to react.
 */

import { DEFAULT_MISSION_POLICY, type MissionPolicy } from "./config-schema";

/**
 * Built-in pattern catalogue. Each entry names the secret shape and
 * provides the matching regex. Regexes are anchored with `\b` where
 * practical so they match token boundaries, not substrings.
 */
export interface SecretPattern {
	id: string;
	label: string;
	pattern: RegExp;
}

export const BUILTIN_SECRET_PATTERNS: readonly SecretPattern[] = [
	{
		id: "aws-access-key-id",
		label: "AWS access key id",
		// AKIA + 16 uppercase alphanumerics.
		pattern: /\bAKIA[0-9A-Z]{16}\b/g,
	},
	{
		id: "aws-secret-access-key",
		label: "AWS secret access key",
		// 40 base64url chars following an explicit assignment.
		pattern: /\b(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/g,
	},
	{
		id: "github-token",
		label: "GitHub personal access token",
		pattern: /\bghp_[A-Za-z0-9]{36,}\b/g,
	},
	{
		id: "github-oauth-token",
		label: "GitHub OAuth token",
		pattern: /\bgho_[A-Za-z0-9]{36,}\b/g,
	},
	{
		id: "github-server-token",
		label: "GitHub server token",
		pattern: /\bghs_[A-Za-z0-9]{36,}\b/g,
	},
	{
		id: "openai-api-key",
		label: "OpenAI API key",
		pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
	},
	{
		id: "anthropic-api-key",
		label: "Anthropic API key",
		pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
	},
	{
		id: "slack-webhook",
		label: "Slack webhook URL",
		pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
	},
	{
		id: "stripe-secret-key",
		label: "Stripe secret key",
		pattern: /\bsk_(?:test|live)_[A-Za-z0-9]{20,}\b/g,
	},
	{
		id: "google-api-key",
		label: "Google API key",
		pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
	},
	{
		id: "private-key-block",
		label: "PEM private key block",
		pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
	},
	{
		id: "jwt",
		label: "JWT",
		pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_.+/=-]{6,}\b/g,
	},
];

/** One match returned by the scanner. */
export interface SecretMatch {
	patternId: string;
	patternLabel: string;
	match: string;
	/** Character offset into the scanned text. */
	index: number;
	/** Shortened + redacted version suitable for audit logs. */
	redacted: string;
}

/**
 * Compile a list of string patterns into `SecretPattern` entries. Each
 * string is treated as a raw regex; invalid regexes are skipped and
 * reported via `onInvalid` (callers typically log them).
 */
export function compileExtraPatterns(
	patterns: readonly string[],
	onInvalid?: (pattern: string, error: unknown) => void,
): SecretPattern[] {
	const compiled: SecretPattern[] = [];
	for (let i = 0; i < patterns.length; i++) {
		const raw = patterns[i];
		if (typeof raw !== "string" || raw.length === 0) continue;
		try {
			compiled.push({
				id: `custom-${i}`,
				label: `Custom pattern ${i + 1}`,
				pattern: new RegExp(raw, "g"),
			});
		} catch (err) {
			onInvalid?.(raw, err);
		}
	}
	return compiled;
}

/**
 * Redact a match for audit logs. Keeps the first 4 and last 2 chars with
 * a `\u2026` in between; short matches become `***`.
 */
export function redactSecret(match: string): string {
	if (match.length <= 8) return "***";
	return `${match.slice(0, 4)}\u2026${match.slice(-2)}`;
}

/**
 * Scan `text` for occurrences of every built-in + extra pattern. Returns
 * a flat list of matches in document order.
 */
export function scanForSecrets(text: string, extraPatterns: readonly SecretPattern[] = []): SecretMatch[] {
	if (typeof text !== "string" || text.length === 0) return [];
	const out: SecretMatch[] = [];
	const allPatterns = [...BUILTIN_SECRET_PATTERNS, ...extraPatterns];
	for (const p of allPatterns) {
		// Ensure global flag so repeated exec produces every match.
		const rx = p.pattern.global ? p.pattern : new RegExp(p.pattern.source, `${p.pattern.flags}g`);
		rx.lastIndex = 0;
		let m: RegExpExecArray | null = rx.exec(text);
		while (m) {
			out.push({
				patternId: p.id,
				patternLabel: p.label,
				match: m[0],
				index: m.index,
				redacted: redactSecret(m[0]),
			});
			if (rx.lastIndex === m.index) rx.lastIndex += 1;
			m = rx.exec(text);
		}
	}
	return out.sort((a, b) => a.index - b.index);
}

/** Convenience wrapper that scans using `policy.secretPatterns` + built-ins. */
export function scanWithPolicy(text: string, policy: MissionPolicy = DEFAULT_MISSION_POLICY): SecretMatch[] {
	const extras = compileExtraPatterns(policy.secretPatterns);
	return scanForSecrets(text, extras);
}

/** Scanner verdict under the policy's mode. */
export interface ScanVerdict {
	mode: MissionPolicy["secretScanner"];
	matches: SecretMatch[];
	/** Final action: `"allow" | "warn" | "block"`. */
	action: "allow" | "warn" | "block";
}

/** Apply the policy's `secretScanner` mode to a match list. */
export function verdictForMatches(matches: SecretMatch[], policy: MissionPolicy = DEFAULT_MISSION_POLICY): ScanVerdict {
	if (policy.secretScanner === "off") return { mode: "off", matches, action: "allow" };
	if (matches.length === 0) return { mode: policy.secretScanner, matches, action: "allow" };
	return {
		mode: policy.secretScanner,
		matches,
		action: policy.secretScanner === "block" ? "block" : "warn",
	};
}

/** End-to-end convenience: scan + apply policy in one call. */
export function evaluateTextForSecrets(text: string, policy?: MissionPolicy): ScanVerdict {
	const effective = policy ?? DEFAULT_MISSION_POLICY;
	return verdictForMatches(scanWithPolicy(text, effective), effective);
}
