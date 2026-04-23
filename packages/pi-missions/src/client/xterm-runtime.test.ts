/**
 * Unit tests for the xterm telemetry rendering runtime used by
 * `MissionTerminal` and `WorkerTerminal`. These tests lock in the contract
 * between telemetry event shapes and the ANSI-coded lines that the xterm
 * surface receives — the "terminal displays telemetry events" validation
 * assertion (VAL-TERMINAL-003) depends on this mapping being stable.
 */

import { describe, expect, test } from "bun:test";
import type { TelemetryEvent } from "./types";
import { ANSI, buildTheme, escapeForTerminal, formatEventAnsi } from "./xterm-runtime";

function stripAnsi(s: string): string {
	return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("formatEventAnsi", () => {
	test("assistant messages render role/text body and include cyan tag", () => {
		const ev: TelemetryEvent = { ts: 1700000000000, type: "assistant_message", text: "hello world" };
		const line = formatEventAnsi(ev);
		expect(line).toContain(ANSI.cyan);
		const plain = stripAnsi(line);
		expect(plain).toContain("assistant");
		expect(plain).toContain("hello world");
	});

	test("tool_call body shows toolName and argsPreview", () => {
		const ev: TelemetryEvent = {
			ts: 1700000000000,
			type: "tool_execution_start",
			toolName: "read",
			argsPreview: "src/app.ts",
		};
		const plain = stripAnsi(formatEventAnsi(ev));
		expect(plain).toContain("tool");
		expect(plain).toContain("read(src/app.ts)");
	});

	test("tool_result shows ok/failed status from isError flag", () => {
		const okLine = stripAnsi(
			formatEventAnsi({ ts: 1700000000000, type: "tool_execution_end", toolName: "read", isError: false }),
		);
		const failLine = stripAnsi(
			formatEventAnsi({ ts: 1700000000000, type: "tool_execution_end", toolName: "read", isError: true }),
		);
		expect(okLine).toContain("read ok");
		expect(failLine).toContain("read failed");
	});

	test("unknown event type falls back to key=value summary (no crash)", () => {
		const ev: TelemetryEvent = { ts: 1700000000000, type: "custom_event", foo: "bar", n: 5 };
		const plain = stripAnsi(formatEventAnsi(ev));
		expect(plain).toContain("custom_event");
		expect(plain).toContain("foo=bar");
	});

	test("output is single-line: newlines in body are collapsed", () => {
		const ev: TelemetryEvent = { ts: 1700000000000, type: "assistant_message", text: "line1\nline2\r\nline3" };
		const line = formatEventAnsi(ev);
		// The formatter itself must not emit CR/LF; the terminal writer adds them.
		expect(line.includes("\n")).toBe(false);
		expect(line.includes("\r")).toBe(false);
	});

	test("timestamp prefix uses HH:MM:SS format", () => {
		const plain = stripAnsi(
			formatEventAnsi({ ts: new Date(2024, 0, 1, 13, 5, 9).getTime(), type: "assistant_message", text: "x" }),
		);
		expect(plain).toMatch(/^13:05:09\s/);
	});
});

describe("escapeForTerminal", () => {
	test("strips ANSI escape introducer so untrusted content cannot hijack colors", () => {
		const out = escapeForTerminal("hi \x1b[31mred\x1b[0m");
		expect(out.includes("\x1b")).toBe(false);
	});

	test("collapses newlines to spaces so events stay on one row", () => {
		const out = escapeForTerminal("a\nb\r\nc");
		expect(out.includes("\n")).toBe(false);
		expect(out.includes("\r")).toBe(false);
		expect(out.startsWith("a")).toBe(true);
		expect(out.endsWith("c")).toBe(true);
	});

	test("preserves tabs (xterm renders them as spacing) and printable chars", () => {
		expect(escapeForTerminal("col1\tcol2")).toContain("\t");
		expect(escapeForTerminal("normal text")).toBe("normal text");
	});
});

describe("buildTheme", () => {
	test("dark theme uses dark background; light theme uses light background", () => {
		const dark = buildTheme(true);
		const light = buildTheme(false);
		expect(dark.background).toBe("#0b0d13");
		expect(light.background).toBe("#fafafa");
		// Foreground must contrast with background (different from bg).
		expect(dark.foreground).not.toBe(dark.background);
		expect(light.foreground).not.toBe(light.background);
	});
});
