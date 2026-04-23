import type { ITheme } from "@xterm/xterm";
import type { TelemetryEvent } from "./types";

/**
 * Pure-functional runtime shared between `MissionTerminal` and `WorkerTerminal`.
 * Contains the ANSI palette, xterm theme builders, event classification, and
 * the one-line formatter that renders a `TelemetryEvent` into an ANSI-coded
 * string. Everything here is React-free and side-effect-free (except for
 * reading `document`/`window` for theme/font detection).
 */

// ─── ANSI / theme helpers ─────────────────────────────────────────────────

export const ANSI = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	cyanBold: "\x1b[1;36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	magenta: "\x1b[35m",
	gray: "\x1b[90m",
} as const;

export function buildTheme(dark: boolean): ITheme {
	if (dark) {
		return {
			background: "#0b0d13",
			foreground: "#d4d4d8",
			cursor: "#d4d4d8",
			cursorAccent: "#0b0d13",
			selectionBackground: "rgba(120, 170, 255, 0.35)",
			black: "#0b0d13",
			red: "#f87171",
			green: "#4ade80",
			yellow: "#fbbf24",
			blue: "#60a5fa",
			magenta: "#c084fc",
			cyan: "#22d3ee",
			white: "#e4e4e7",
			brightBlack: "#6b7280",
			brightRed: "#fca5a5",
			brightGreen: "#86efac",
			brightYellow: "#fcd34d",
			brightBlue: "#93c5fd",
			brightMagenta: "#d8b4fe",
			brightCyan: "#67e8f9",
			brightWhite: "#f4f4f5",
		};
	}
	return {
		background: "#fafafa",
		foreground: "#1f2937",
		cursor: "#1f2937",
		cursorAccent: "#fafafa",
		selectionBackground: "rgba(37, 99, 235, 0.25)",
		black: "#1f2937",
		red: "#b91c1c",
		green: "#15803d",
		yellow: "#a16207",
		blue: "#1d4ed8",
		magenta: "#7e22ce",
		cyan: "#0e7490",
		white: "#4b5563",
		brightBlack: "#6b7280",
		brightRed: "#dc2626",
		brightGreen: "#16a34a",
		brightYellow: "#ca8a04",
		brightBlue: "#2563eb",
		brightMagenta: "#9333ea",
		brightCyan: "#0891b2",
		brightWhite: "#111827",
	};
}

export function currentThemeIsDark(): boolean {
	if (typeof document === "undefined") return true;
	const attr = document.documentElement.getAttribute("data-theme");
	if (attr === "dark") return true;
	if (attr === "light") return false;
	// Fallback: follow the OS preference.
	return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

export function resolveMonoFontFamily(): string {
	const fallback = 'ui-monospace, "Cascadia Code", Consolas, "Liberation Mono", monospace';
	if (typeof document === "undefined") return fallback;
	const value = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
	return value || fallback;
}

// ─── Event formatting ─────────────────────────────────────────────────────

interface EventMeta {
	tag: string;
	ansi: string;
	dim: boolean;
}

function classifyEvent(type: string): EventMeta {
	if (type === "message_end" || type === "assistant_message") {
		return { tag: "assistant", ansi: ANSI.cyan, dim: false };
	}
	if (type === "tool_execution_start" || type === "tool_call") {
		return { tag: "tool", ansi: ANSI.yellow, dim: false };
	}
	if (type === "tool_execution_end" || type === "tool_result") {
		return { tag: "tool:done", ansi: ANSI.gray, dim: true };
	}
	if (
		type === "auto_retry_start" ||
		type === "auto_retry_end" ||
		type === "retry_started" ||
		type === "retry_finished"
	) {
		return { tag: "retry", ansi: ANSI.red, dim: true };
	}
	if (type === "auto_compaction_start" || type === "compaction_started" || type === "compaction_finished") {
		return { tag: "compact", ansi: ANSI.magenta, dim: true };
	}
	if (type === "context_pressure" || type === "context_usage") {
		return { tag: "ctx", ansi: ANSI.yellow, dim: true };
	}
	if (type === "agent_started") return { tag: "agent ↑", ansi: ANSI.green, dim: false };
	if (type === "agent_exited") return { tag: "agent ↓", ansi: ANSI.gray, dim: true };
	if (type === "agent_crashed" || type === "agent_killed" || type === "agent_timeout") {
		return { tag: "agent ✗", ansi: ANSI.red, dim: false };
	}
	if (type === "message_delivered") return { tag: "mailbox", ansi: ANSI.magenta, dim: false };
	if (type === "prompt_sent") return { tag: "prompt →", ansi: ANSI.magenta, dim: false };
	return { tag: type, ansi: ANSI.gray, dim: true };
}

/** Returns a single-line ANSI-coded string (no trailing newline). */
export function formatEventAnsi(ev: TelemetryEvent): string {
	const type = typeof ev.type === "string" ? ev.type : "event";
	const ts = formatTs(typeof ev.ts === "number" ? ev.ts : Date.now());
	const meta = classifyEvent(type);
	const body = formatEventBody(ev, type);
	const tag = padTag(meta.tag);
	const bodyColor = meta.dim ? ANSI.dim : "";
	return `${ANSI.dim}${ts}${ANSI.reset}  ${meta.ansi}${tag}${ANSI.reset}  ${bodyColor}${escapeForTerminal(body)}${ANSI.reset}`;
}

function formatEventBody(ev: TelemetryEvent, type: string): string {
	if (type === "message_end" || type === "assistant_message") {
		const role = typeof ev.role === "string" ? ev.role : null;
		const text = typeof ev.text === "string" ? ev.text : "";
		const usage = ev.usage as { input?: number; output?: number } | null | undefined;
		const extras: string[] = [];
		if (usage?.input) extras.push(`↑${usage.input.toLocaleString()}`);
		if (usage?.output) extras.push(`↓${usage.output.toLocaleString()}`);
		const ctxPct = typeof ev.contextPct === "number" ? ev.contextPct : null;
		if (ctxPct !== null) extras.push(`ctx ${ctxPct.toFixed(1)}%`);
		const rolePrefix = role && role !== "assistant" ? `[${role}] ` : "";
		const msg = truncate(text.replace(/\s+/g, " ").trim(), 600);
		return `${rolePrefix}${msg}${extras.length > 0 ? `  ${extras.join(" · ")}` : ""}`;
	}
	if (type === "tool_execution_start" || type === "tool_call") {
		const name = typeof ev.toolName === "string" ? ev.toolName : "tool";
		const preview = typeof ev.argsPreview === "string" ? ev.argsPreview : null;
		return preview ? `${name}(${truncate(preview, 200)})` : `${name}(…)`;
	}
	if (type === "tool_execution_end" || type === "tool_result") {
		const name = typeof ev.toolName === "string" ? ev.toolName : "tool";
		const isError = !!ev.isError;
		return `${name} ${isError ? "failed" : "ok"}`;
	}
	if (type === "auto_retry_start" || type === "retry_started") {
		const attempt = typeof ev.attempt === "number" ? ev.attempt : null;
		const maxAttempts = typeof ev.maxAttempts === "number" ? ev.maxAttempts : null;
		const delayMs = typeof ev.delayMs === "number" ? ev.delayMs : null;
		const parts: string[] = [];
		if (attempt && maxAttempts) parts.push(`${attempt}/${maxAttempts}`);
		if (delayMs !== null) parts.push(`backoff ${formatDelay(delayMs)}`);
		const errMsg = typeof ev.errorMessage === "string" ? ev.errorMessage : null;
		if (errMsg) parts.push(truncate(errMsg, 200));
		return parts.join(" · ") || "retry";
	}
	if (type === "auto_retry_end" || type === "retry_finished") {
		const ok = ev.success === true;
		const finalError = typeof ev.finalError === "string" ? ev.finalError : null;
		return ok ? "resolved" : (finalError ?? "failed");
	}
	if (type === "context_pressure" || type === "context_usage") {
		const pct =
			typeof ev.percent === "number" ? ev.percent : typeof ev.percentUsed === "number" ? ev.percentUsed : null;
		return pct !== null ? `${pct.toFixed(1)}%` : "pressure";
	}
	if (type === "agent_exited") {
		const exitCode = typeof ev.exitCode === "number" ? ev.exitCode : null;
		return exitCode !== null ? `code ${exitCode}` : "exit";
	}
	if (type === "agent_started") {
		const name = typeof ev.agentId === "string" ? ev.agentId : typeof ev.name === "string" ? ev.name : "agent";
		return name;
	}
	if (type === "prompt_sent" || type === "message_delivered") {
		const content =
			typeof ev.content === "string"
				? ev.content
				: typeof ev.text === "string"
					? ev.text
					: typeof ev.message === "string"
						? ev.message
						: "";
		return truncate(content.replace(/\s+/g, " ").trim(), 300);
	}
	return truncate(summarize(ev), 300);
}

function padTag(tag: string): string {
	const width = 10;
	if (tag.length >= width) return tag;
	return tag + " ".repeat(width - tag.length);
}

function formatTs(ms: number): string {
	try {
		const d = new Date(ms);
		const hh = String(d.getHours()).padStart(2, "0");
		const mm = String(d.getMinutes()).padStart(2, "0");
		const ss = String(d.getSeconds()).padStart(2, "0");
		return `${hh}:${mm}:${ss}`;
	} catch {
		return "--:--:--";
	}
}

function formatDelay(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - 1)}…`;
}

function summarize(ev: TelemetryEvent): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(ev)) {
		if (k === "ts" || k === "type") continue;
		if (v === null || v === undefined) continue;
		let rendered: string;
		if (typeof v === "string") rendered = v;
		else if (typeof v === "number" || typeof v === "boolean") rendered = String(v);
		else rendered = JSON.stringify(v);
		parts.push(`${k}=${rendered}`);
		if (parts.join(" ").length > 240) break;
	}
	return parts.join(" ");
}

/**
 * Strip characters that would corrupt the xterm buffer if present in an
 * untrusted event body: C0 controls other than tab, and ESC (which would start
 * an ANSI sequence). Newlines are collapsed to spaces so one event stays on one
 * row; we emit the row terminator ourselves via `\r\n`.
 */
export function escapeForTerminal(text: string): string {
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").replace(/[\r\n]+/g, " ");
}
