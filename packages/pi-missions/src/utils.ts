// src/utils.ts — Shared utility functions for pi-mission

import type { MessageLike } from "./types";

/**
 * Format milliseconds into a human-readable duration string.
 * Examples: '5s', '3m 20s', '1h 15m'
 */
export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

/**
 * Map a phase status to its corresponding emoji icon.
 */
export function getPhaseIcon(status: string): string {
	switch (status) {
		case "done":
			return "✅";
		case "active":
			return "🔄";
		case "skipped":
			return "⏭️";
		default:
			return "⬜";
	}
}

/**
 * Extract text content from an agent message.
 * Filters for content blocks with type 'text', joins them, and lowercases.
 * DRY helper used by the phase-transition detector.
 */
export function extractTextFromMessage(message: MessageLike | null | undefined): string {
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
		.filter(c => c.type === "text" && typeof c.text === "string")
		.map(c => c.text ?? "")
		.join(" ")
		.toLowerCase();
}

/**
 * Extract raw text content from an agent message, **preserving original case**.
 *
 * Use when downstream parsing cares about casing (e.g. phase names and
 * emojis in adaptive-mode proposals). For phase-transition regex matching,
 * use {@link extractTextFromMessage} instead.
 */
export function extractRawTextFromMessage(message: MessageLike | null | undefined): string {
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
		.filter(c => c.type === "text" && typeof c.text === "string")
		.map(c => c.text ?? "")
		.join("\n");
}

/**
 * Truncate a string to a maximum length, adding ellipsis if needed.
 */
export function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return `${str.slice(0, max - 1)}…`;
}
