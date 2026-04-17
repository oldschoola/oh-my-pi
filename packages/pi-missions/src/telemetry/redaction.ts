/**
 * Token and secret redaction for mission telemetry.
 *
 * Ported from taskplane `bin/rpc-wrapper.mjs` (lines 121-253). Policy preserved
 * byte-for-byte — this is the source of truth for secret handling in missions.
 *
 * Applied before any sidecar event or exit summary is written to disk.
 */

const SECRET_ENV_PATTERN = /(_KEY|_TOKEN|_SECRET)$/i;

const MAX_TOOL_ARG_LENGTH = 500;

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._\-~+/]+=*/gi;
const API_KEY_PATTERN = /\b(sk-|key-|token-)[A-Za-z0-9_-]{16,}\b/gi;

export function redactString(input: string): string {
	let out = input.replace(BEARER_PATTERN, "Bearer [REDACTED]");
	out = out.replace(API_KEY_PATTERN, "[REDACTED]");
	return out;
}

export function redactValue(val: unknown): unknown {
	if (val === null || val === undefined) return val;

	if (typeof val === "string") {
		const truncated = val.length > MAX_TOOL_ARG_LENGTH ? `${val.slice(0, MAX_TOOL_ARG_LENGTH)}…[truncated]` : val;
		return redactString(truncated);
	}

	if (Array.isArray(val)) {
		return val.map(item => redactValue(item));
	}

	if (typeof val === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(val as Record<string, unknown>)) {
			if (SECRET_ENV_PATTERN.test(key) && typeof v === "string") {
				result[key] = "[REDACTED]";
			} else {
				result[key] = redactValue(v);
			}
		}
		return result;
	}

	return val;
}

export function redactEvent<T extends Record<string, unknown>>(event: T): T;
export function redactEvent(event: null): null;
export function redactEvent(event: undefined): undefined;
export function redactEvent(
	event: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
	if (!event || typeof event !== "object") return event;

	const redacted: Record<string, unknown> = { ...event };

	if (redacted.args !== undefined) {
		redacted.args = redactValue(redacted.args);
	}

	if (redacted.result && typeof redacted.result === "object") {
		redacted.result = redactValue(redacted.result);
	}

	if (typeof redacted.error === "string") {
		redacted.error = redactString(redacted.error);
	}
	if (typeof redacted.errorMessage === "string") {
		redacted.errorMessage = redactString(redacted.errorMessage);
	}
	if (typeof redacted.finalError === "string") {
		redacted.finalError = redactString(redacted.finalError);
	}

	return redacted;
}

export interface RetryEntry {
	error?: unknown;
}

export interface ExitSummaryLike {
	error?: unknown;
	lastToolCall?: unknown;
	retries?: RetryEntry[];
}

export function redactSummary<T extends ExitSummaryLike>(summary: T): T;
export function redactSummary(summary: null): null;
export function redactSummary(summary: undefined): undefined;
export function redactSummary(summary: ExitSummaryLike | null | undefined): ExitSummaryLike | null | undefined {
	if (!summary || typeof summary !== "object") return summary;

	const redacted: ExitSummaryLike = { ...summary };

	if (typeof redacted.error === "string") {
		redacted.error = redactString(redacted.error);
	}

	if (typeof redacted.lastToolCall === "string") {
		const str = redacted.lastToolCall;
		const truncated = str.length > MAX_TOOL_ARG_LENGTH ? `${str.slice(0, MAX_TOOL_ARG_LENGTH)}…[truncated]` : str;
		redacted.lastToolCall = redactString(truncated);
	}

	if (Array.isArray(redacted.retries)) {
		redacted.retries = redacted.retries.map(r => ({
			...r,
			error: typeof r.error === "string" ? redactString(r.error) : r.error,
		}));
	}

	return redacted;
}

export { MAX_TOOL_ARG_LENGTH, SECRET_ENV_PATTERN };
