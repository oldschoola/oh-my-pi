/**
 * Exit summary JSON writer. Persists final mission/agent outcome — tokens,
 * cost, tool calls, retries, errors — with full redaction applied.
 */

import { type ExitSummaryLike, redactSummary } from "./redaction";

export interface TokenCounts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface RetryRecord {
	attempt: number;
	delayMs: number;
	error?: string;
	errorType?: string;
}

export interface ExitSummary extends ExitSummaryLike {
	exitCode: number;
	exitSignal: string | null;
	tokens: TokenCounts;
	cost: number;
	toolCalls: number;
	compactions: number;
	retries: RetryRecord[];
	lastToolCall: string | null;
	error: string | null;
	durationMs: number;
}

export async function writeExitSummary(path: string, summary: ExitSummary): Promise<void> {
	const redacted = redactSummary(summary);
	await Bun.write(path, JSON.stringify(redacted, null, 2));
}

export async function readExitSummary(path: string): Promise<ExitSummary | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	try {
		return (await file.json()) as ExitSummary;
	} catch {
		return null;
	}
}

export function emptyExitSummary(): ExitSummary {
	return {
		exitCode: 0,
		exitSignal: null,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		cost: 0,
		toolCalls: 0,
		compactions: 0,
		retries: [],
		lastToolCall: null,
		error: null,
		durationMs: 0,
	};
}
