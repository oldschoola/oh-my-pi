/**
 * Shared formatters for dashboard components.
 *
 * Every component renders durations, token counts, percentages, and relative
 * timestamps the same way — duplicating these helpers per file caused visible
 * UI inconsistency (one variant dropped seconds at >=1h, others didn't).
 */

import { formatDistanceToNow } from "date-fns";

/**
 * Format a millisecond duration as `"Xs"`, `"Xm Ys"`, or `"Xh Ym Zs"`.
 * Negative or zero input returns `"0s"`.
 */
export function formatDuration(ms: number): string {
	if (ms <= 0) return "0s";
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	if (m < 60) return `${m}m ${s}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m ${s}s`;
}

/**
 * Like {@link formatDuration} but returns `null` for `undefined`/`null` input
 * or negative durations. Used in history cards where the duration column
 * should be left blank rather than rendered as `"0s"`.
 */
export function formatDurationOrNull(ms?: number | null): string | null {
	if (ms === undefined || ms === null) return null;
	if (ms < 0) return null;
	return formatDuration(ms);
}

/** Format a token count compactly: `"0"`, `"123"`, `"1.2k"`, `"3.4M"`. */
export function formatTokens(n: number): string {
	if (n === 0) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/** Map a 0-100 percentage onto the dashboard's progress-bar fill class. */
export function pctClass(pct: number): string {
	if (pct >= 100) return "pct-hi";
	if (pct >= 50) return "pct-mid";
	if (pct > 0) return "pct-low";
	return "pct-0";
}

/**
 * Render a timestamp as `"about 2 hours ago"`. Empty string for `undefined`,
 * raw stringified input for unparseable values.
 */
export function formatRelative(iso?: string | number | null): string {
	if (iso === undefined || iso === null) return "";
	try {
		return formatDistanceToNow(new Date(iso), { addSuffix: true });
	} catch {
		return String(iso);
	}
}
