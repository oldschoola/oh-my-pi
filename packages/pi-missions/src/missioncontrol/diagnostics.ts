/**
 * Exit classification for mission task sessions — ported verbatim from
 * taskplane `extensions/taskplane/diagnostics.ts`. Pure logic, no I/O.
 *
 * `classifyExit()` is deterministic: given the same signals it always
 * returns the same classification. Used by the engine to decide retry
 * behaviour, and by the dashboard to colour-code outcomes.
 */

export interface SessionTokenCounts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export type ExitClassification =
	| "completed"
	| "api_error"
	| "model_access_error"
	| "context_overflow"
	| "wall_clock_timeout"
	| "process_crash"
	| "session_vanished"
	| "stall_timeout"
	| "user_killed"
	| "unknown";

export const EXIT_CLASSIFICATIONS: readonly ExitClassification[] = [
	"completed",
	"api_error",
	"model_access_error",
	"context_overflow",
	"wall_clock_timeout",
	"process_crash",
	"session_vanished",
	"stall_timeout",
	"user_killed",
	"unknown",
] as const;

export interface DiagnosticRetryRecord {
	attempt: number;
	error: string;
	delayMs: number;
	succeeded: boolean;
}

export interface DiagnosticExitSummary {
	exitCode?: number | null;
	exitSignal?: string | null;
	tokens: SessionTokenCounts | null;
	cost: number | null;
	toolCalls: number;
	retries: DiagnosticRetryRecord[];
	compactions: number;
	durationSec: number;
	lastToolCall: string | null;
	error: string | null;
}

export interface ExitClassificationInput {
	exitSummary: DiagnosticExitSummary | null;
	doneFileFound: boolean;
	timerKilled: boolean;
	contextKilled?: boolean;
	stallDetected: boolean;
	userKilled: boolean;
	contextPct: number | null;
}

export interface TaskExitDiagnostic {
	classification: ExitClassification;
	exitCode: number | null;
	errorMessage: string | null;
	tokensUsed: SessionTokenCounts | null;
	contextPct: number | null;
	partialProgressCommits: number;
	partialProgressBranch: string | null;
	durationSec: number;
	lastKnownStep: number | null;
	lastKnownCheckbox: string | null;
	repoId: string;
}

export const CONTEXT_OVERFLOW_THRESHOLD_PCT = 90;

export const MODEL_ACCESS_ERROR_PATTERNS: readonly RegExp[] = [
	/\b(?:401|403)\b/,
	/\b429\b/,
	/model[_ ]not[_ ]found/i,
	/model[_ ](?:is[_ ])?unavailable/i,
	/model[_ ](?:has[_ ]been[_ ])?deprecated/i,
	/api[_ ]key[_ ](?:expired|invalid|revoked)/i,
	/invalid[_ ]api[_ ]key/i,
	/authentication[_ ](?:failed|error|required)/i,
	/authorization[_ ](?:failed|error|denied)/i,
	/access[_ ]denied/i,
	/permission[_ ]denied/i,
	/quota[_ ]exceeded/i,
	/rate[_ ]limit/i,
	/insufficient[_ ]quota/i,
];

export function isModelAccessError(errorMessage: string): boolean {
	if (!errorMessage) return false;
	return MODEL_ACCESS_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage));
}

export function classifyExit(input: ExitClassificationInput): ExitClassification {
	const { exitSummary, doneFileFound, timerKilled, stallDetected, userKilled, contextPct } = input;
	const contextKilled = input.contextKilled ?? false;

	if (doneFileFound) return "completed";

	if (exitSummary?.retries && exitSummary.retries.length > 0) {
		const lastRetry = exitSummary.retries[exitSummary.retries.length - 1];
		if (lastRetry && !lastRetry.succeeded) {
			if (isModelAccessError(lastRetry.error)) return "model_access_error";
			return "api_error";
		}
	}

	if (exitSummary?.error && isModelAccessError(exitSummary.error)) {
		return "model_access_error";
	}

	if (exitSummary && exitSummary.compactions > 0) {
		const effectivePct = contextPct ?? 0;
		if (effectivePct >= CONTEXT_OVERFLOW_THRESHOLD_PCT) return "context_overflow";
	}

	if (contextKilled) return "context_overflow";
	if (timerKilled) return "wall_clock_timeout";

	if (exitSummary && typeof exitSummary.exitCode === "number" && exitSummary.exitCode !== 0) {
		return "process_crash";
	}

	if (exitSummary === null) return "session_vanished";
	if (stallDetected) return "stall_timeout";
	if (userKilled) return "user_killed";
	return "unknown";
}
