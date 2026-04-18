import { describe, expect, test } from "bun:test";
import { classifyExit, type DiagnosticExitSummary, isModelAccessError } from "../src/missioncontrol/diagnostics";

function summary(partial: Partial<DiagnosticExitSummary> = {}): DiagnosticExitSummary {
	return {
		exitCode: 0,
		exitSignal: null,
		tokens: null,
		cost: null,
		toolCalls: 0,
		retries: [],
		compactions: 0,
		durationSec: 0,
		lastToolCall: null,
		error: null,
		...partial,
	};
}

describe("isModelAccessError", () => {
	test("matches 401", () => {
		expect(isModelAccessError("request failed with status 401")).toBe(true);
	});
	test("matches model not found", () => {
		expect(isModelAccessError("model_not_found for claude-foo")).toBe(true);
	});
	test("matches rate limit", () => {
		expect(isModelAccessError("rate limit exceeded")).toBe(true);
	});
	test("returns false for empty", () => {
		expect(isModelAccessError("")).toBe(false);
	});
	test("returns false for generic crash", () => {
		expect(isModelAccessError("segfault in module")).toBe(false);
	});
});

describe("classifyExit precedence", () => {
	test("completed wins when DONE file present", () => {
		const result = classifyExit({
			exitSummary: summary({ exitCode: 1, error: "401 unauthorized" }),
			doneFileFound: true,
			timerKilled: true,
			stallDetected: true,
			userKilled: true,
			contextPct: 95,
		});
		expect(result).toBe("completed");
	});

	test("model_access_error beats api_error on retry failure", () => {
		const result = classifyExit({
			exitSummary: summary({
				retries: [{ attempt: 1, error: "401 unauthorized", delayMs: 1000, succeeded: false }],
			}),
			doneFileFound: false,
			timerKilled: false,
			stallDetected: false,
			userKilled: false,
			contextPct: null,
		});
		expect(result).toBe("model_access_error");
	});

	test("api_error when last retry failed without model pattern", () => {
		const result = classifyExit({
			exitSummary: summary({
				retries: [{ attempt: 1, error: "500 internal error", delayMs: 1000, succeeded: false }],
			}),
			doneFileFound: false,
			timerKilled: false,
			stallDetected: false,
			userKilled: false,
			contextPct: null,
		});
		expect(result).toBe("api_error");
	});

	test("context_overflow when compactions>0 and context >= 90%", () => {
		const result = classifyExit({
			exitSummary: summary({ compactions: 2 }),
			doneFileFound: false,
			timerKilled: false,
			stallDetected: false,
			userKilled: false,
			contextPct: 92,
		});
		expect(result).toBe("context_overflow");
	});

	test("wall_clock_timeout when timer killed", () => {
		const result = classifyExit({
			exitSummary: summary(),
			doneFileFound: false,
			timerKilled: true,
			stallDetected: false,
			userKilled: false,
			contextPct: null,
		});
		expect(result).toBe("wall_clock_timeout");
	});

	test("process_crash on non-zero exit code with no API error", () => {
		const result = classifyExit({
			exitSummary: summary({ exitCode: 139 }),
			doneFileFound: false,
			timerKilled: false,
			stallDetected: false,
			userKilled: false,
			contextPct: null,
		});
		expect(result).toBe("process_crash");
	});

	test("session_vanished when no summary available", () => {
		const result = classifyExit({
			exitSummary: null,
			doneFileFound: false,
			timerKilled: false,
			stallDetected: false,
			userKilled: false,
			contextPct: null,
		});
		expect(result).toBe("session_vanished");
	});

	test("stall_timeout falls through when no other signal", () => {
		const result = classifyExit({
			exitSummary: summary(),
			doneFileFound: false,
			timerKilled: false,
			stallDetected: true,
			userKilled: false,
			contextPct: null,
		});
		expect(result).toBe("stall_timeout");
	});

	test("user_killed lowest of non-unknown", () => {
		const result = classifyExit({
			exitSummary: summary(),
			doneFileFound: false,
			timerKilled: false,
			stallDetected: false,
			userKilled: true,
			contextPct: null,
		});
		expect(result).toBe("user_killed");
	});

	test("unknown catch-all", () => {
		const result = classifyExit({
			exitSummary: summary(),
			doneFileFound: false,
			timerKilled: false,
			stallDetected: false,
			userKilled: false,
			contextPct: null,
		});
		expect(result).toBe("unknown");
	});
});
