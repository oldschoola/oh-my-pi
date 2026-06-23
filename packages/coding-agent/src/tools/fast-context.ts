import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Context, Message, Model, TextContent, Tool, ToolCall } from "@oh-my-pi/pi-ai";
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { GrepMatch } from "@oh-my-pi/pi-natives";
import { GrepOutputMode, glob, grep } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { replaceTabs, Text } from "@oh-my-pi/pi-tui";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { expandRoleAlias, getModelMatchPreferences, resolveModelFromString } from "../config/model-resolver";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import fastContextDescription from "../prompts/tools/fast-context.md" with { type: "text" };
import citationRetryPrompt from "../prompts/tools/fast-context-citation-retry.md" with { type: "text" };
import finalTurnPrompt from "../prompts/tools/fast-context-final.md" with { type: "text" };
import hintSystemPrompt from "../prompts/tools/fast-context-hint-system.md" with { type: "text" };
import fastContextSystemPrompt from "../prompts/tools/fast-context-system.md" with { type: "text" };
import { Ellipsis, fileHyperlink, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { createCachedComponent, formatErrorMessage, PREVIEW_LIMITS } from "./render-utils";
import { toolResult } from "./tool-result";

const fastContextSchema = type({
	query: type("string").describe("natural-language repository exploration query"),
	"max_turns?": type("number").describe("maximum FastContext exploration turns before forcing citations"),
	"mode?": type("'hint' | 'agent'").describe(
		"hint = single LLM turn for query expansion then native search; agent = full FastContext agentic loop. Defaults to hint.",
	),
	"include_snippets?": type("boolean").describe(
		"hint mode: include a snippet of each found file (first match context) in the result. Saves the caller from issuing separate read calls. Defaults to true.",
	),
	"snippet_lines?": type("number").describe(
		"hint mode with include_snippets: lines of context per snippet. Defaults to 10.",
	),
	"max_result_tokens?": type("number").describe(
		"hint mode: token budget for the result packet (chars/4 heuristic). Trims low-relevance files and snippets to stay within budget. Defaults to 4000.",
	),
});

export type FastContextToolInput = typeof fastContextSchema.infer;
/**
 * Resolved LLM backend for a FastContext invocation.
 *
 * - `local`: raw OpenAI-compatible `/chat/completions` endpoint (e.g. llama.cpp).
 *   `model` is the bare model id sent in the request body.
 * - `registry`: a registered provider model (Devin, z.ai, ...) resolved through
 *   the model registry and called via `completeSimple`. `modelId` is the
 *   provider-prefixed display string (`${provider}/${id}`) used for diagnostics.
 *
 * The switch is `fastContext.model`: a value containing `/` (e.g.
 * `devin/swe-1-6-slow`) selects the registry backend; a bare id or unset value
 * keeps the existing local endpoint path.
 */
type FastContextBackend =
	| { kind: "local"; url: string; model: string }
	| { kind: "registry"; model: Model<Api>; apiKey: string; modelId: string };

type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;
type ChatRole = "system" | "user" | "assistant" | "tool";
type FastContextToolName = "Read" | "Glob" | "Grep";

interface FastContextOptions {
	fetch?: FetchFunction;
	/** Registry-backend completion function. Defaults to `completeSimple`; tests inject a fake. */
	completeFn?: typeof completeSimple;
}

interface ChatMessage {
	role: ChatRole;
	content?: string | null;
	tool_calls?: FastContextToolCall[];
	tool_call_id?: string;
}

interface FastContextToolCallFunction {
	name: string;
	arguments: string;
}

interface FastContextToolCall {
	id: string;
	type: "function";
	function: FastContextToolCallFunction;
}

interface ChatCompletionChoice {
	message?: {
		role?: ChatRole;
		content?: string | null;
		tool_calls?: FastContextToolCall[] | null;
	};
}

interface ChatCompletionResponse {
	choices?: ChatCompletionChoice[];
	error?: { message?: string };
}

interface ModelsResponse {
	data?: Array<{ id?: string }>;
	error?: { message?: string };
}

export interface FastContextToolDetails {
	meta?: OutputMeta;
	baseUrl?: string;
	model: string;
	mode: "hint" | "agent";
	turns: number;
	toolCalls: number;
	citations: string[];
	keywords: string[];
	globs?: string[];
	grepPatterns?: string[];
	grepPaths?: string[];
	description?: string;
	error?: string;
}

interface ReadArguments {
	path?: string;
	offset?: number;
	limit?: number;
}

interface GlobArguments {
	directory?: string;
	pattern?: string;
}

interface GrepArguments {
	pattern?: string;
	path?: string;
	glob?: string;
	output_mode?: "content" | "files_with_matches" | "count";
	"-B"?: number;
	"-A"?: number;
	"-C"?: number;
	"-n"?: boolean;
	"-i"?: boolean;
	type?: string;
	head_limit?: number;
	multiline?: boolean;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_MAX_TURNS = 4;
const MAX_MAX_TURNS = 8;
const MAX_TOOL_LINES = 100;
const MAX_READ_LINES = Number(Bun.env.FC_MAX_READ_LINES) > 0 ? Number(Bun.env.FC_MAX_READ_LINES) : 200;
const MAX_LINE_LENGTH = 2000;
const HINT_REQUEST_TIMEOUT_MS = 30_000;
const HINT_MAX_GLOBS = 5;
const HINT_MAX_GREPS = 5;
const HINT_MAX_KEYWORDS = 8;
const HINT_DEFAULT_SNIPPET_LINES = 10;
const HINT_MAX_SNIPPET_FILES = 15;
const HINT_MAX_SNIPPET_BYTES = 12000;
const HINT_DEFAULT_MAX_RESULT_TOKENS = 4000;
const HINT_MAX_RESULT_FILES = 20;
const MAX_WORKSPACE_LISTING = 30;
const MAX_PARALLEL_TOOL_CALLS = 8;
const REQUEST_TIMEOUT_MS = 120_000;
const TOOL_TIMEOUT_MS = 10_000;
const SEARCH_TIMEOUT_MS = 10_000;
// Tool-calling turns only need a few hundred tokens (tool call JSON). The
// llama.cpp server allocates compute proportional to max_completion_tokens
// even when the model stops early, so capping this cuts per-turn latency ~33%.
const AGENT_TOOL_TURN_MAX_TOKENS = 2048;
// The final answer turn needs room for the <final_answer> block with citations.
const AGENT_FINAL_TURN_MAX_TOKENS = 4096;

const FAST_CONTEXT_TOOLS = [
	{
		type: "function",
		function: {
			name: "Read",
			description: "Read line-numbered file contents.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" },
					offset: { type: "integer" },
					limit: { type: "integer" },
				},
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "Glob",
			description: "Find files by glob.",
			parameters: {
				type: "object",
				properties: {
					directory: { type: "string" },
					pattern: { type: "string" },
				},
				required: ["pattern"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "Grep",
			description: "Search file contents with regex.",
			parameters: {
				type: "object",
				properties: {
					pattern: { type: "string" },
					path: { type: "string" },
					glob: { type: "string" },
					output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
					"-B": { type: "number" },
					"-A": { type: "number" },
					"-C": { type: "number" },
					"-n": { type: "boolean" },
					"-i": { type: "boolean" },
					type: { type: "string" },
					head_limit: { type: "number", minimum: 0 },
					multiline: { type: "boolean" },
				},
				required: ["pattern"],
			},
		},
	},
] as const;

interface HintPlan {
	keywords: string[];
	globs: string[];
	grep_patterns: string[];
	grep_paths: string[];
	description: string;
}

function parseHintPlan(text: string): HintPlan | null {
	// Try to extract JSON from the model's response. Handle markdown-fenced
	// JSON (```json ... ```) and bare JSON objects. Try the largest match first,
	// then progressively smaller ones if the largest fails to parse.
	const jsonBlocks: string[] = [];
	// Markdown-fenced JSON
	const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
	if (fenceMatch?.[1]) jsonBlocks.push(fenceMatch[1]);
	// Bare JSON objects (largest first)
	const bareMatch = text.match(/\{[\s\S]*\}/);
	if (bareMatch?.[0]) jsonBlocks.push(bareMatch[0]);
	// Try each candidate
	for (const block of jsonBlocks) {
		try {
			const raw = JSON.parse(block) as Partial<HintPlan>;
			if (!Array.isArray(raw.keywords) && !Array.isArray(raw.globs) && !Array.isArray(raw.grep_patterns)) {
				continue;
			}
			return {
				keywords: Array.isArray(raw.keywords)
					? raw.keywords.filter(k => typeof k === "string" && k.trim()).slice(0, HINT_MAX_KEYWORDS)
					: [],
				globs: Array.isArray(raw.globs)
					? raw.globs.filter(g => typeof g === "string" && g.trim()).slice(0, HINT_MAX_GLOBS)
					: [],
				grep_patterns: Array.isArray(raw.grep_patterns)
					? raw.grep_patterns.filter(p => typeof p === "string" && p.trim()).slice(0, HINT_MAX_GREPS)
					: [],
				grep_paths: raw.grep_paths
					? Array.isArray(raw.grep_paths)
						? raw.grep_paths.filter(p => typeof p === "string" && p.trim()).slice(0, 3)
						: []
					: [],
				description: typeof raw.description === "string" ? raw.description : "",
			};
		} catch {}
	}
	return null;
}

export function normalizeFastContextBaseUrl(rawBaseUrl: string | undefined): string {
	const trimmed = rawBaseUrl?.trim() || DEFAULT_BASE_URL;
	const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
	return withoutTrailingSlash.endsWith("/v1") ? withoutTrailingSlash : `${withoutTrailingSlash}/v1`;
}

function clampedTurns(value: number | undefined): number {
	if (!Number.isFinite(value ?? DEFAULT_MAX_TURNS)) return DEFAULT_MAX_TURNS;
	return Math.min(Math.max(Math.floor(value ?? DEFAULT_MAX_TURNS), 1), MAX_MAX_TURNS);
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseArguments<T>(raw: string): T {
	return asObject(JSON.parse(raw || "{}")) as T;
}

function isWithinCwd(candidate: string, cwd: string): boolean {
	// Resolve symlinks before comparing — without this, a symlink inside the
	// workspace could point outside cwd and bypass the containment check.
	// Uses sync realpath to avoid making every call site async.
	let realCandidate = candidate;
	let realCwd = cwd;
	try {
		realCandidate = realpathSync(candidate);
	} catch {}
	try {
		realCwd = realpathSync(cwd);
	} catch {}
	const relative = path.relative(realCwd, realCandidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveWorkspacePath(input: string | undefined, cwd: string): string {
	const resolved = path.resolve(cwd, input?.trim() || ".");
	if (!isWithinCwd(resolved, cwd)) {
		throw new Error(`Permission error: \`${input}\` is not within the workspace \`${cwd}\`.`);
	}
	return resolved;
}

function truncateLine(line: string): string {
	return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...` : line;
}

function splitFileLines(text: string): string[] {
	if (!text) return [];
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	if (normalized.endsWith("\n")) lines.pop();
	return lines;
}

function formatAbsolute(filePath: string, basePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(basePath, filePath);
}

async function readResponseErrorSnippet(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	const trimmed = text.trim();
	return trimmed ? `: ${trimmed.slice(0, 500)}` : "";
}

function extractFinalAnswer(text: string): string {
	const match = text.match(/<final_answer>([\s\S]*?)<\/final_answer>/i);
	return (match?.[1] ?? text).trim();
}

const CITATION_STOP_WORDS = new Set([
	// Query verbs/context
	"find",
	"where",
	"with",
	"that",
	"this",
	"from",
	"file",
	"line",
	"range",
	"code",
	"defined",
	"used",
	"declared",
	"classified",
	"calls",
	"resolved",
	"produced",
	"here",
	"there",
	"when",
	"how",
	"what",
	"which",
	"who",
	// Common English words that flood content scoring
	"and",
	"the",
	"for",
	"are",
	"not",
	"but",
	"was",
	"has",
	"had",
	"all",
	"any",
	"can",
	"her",
	"him",
	"one",
	"our",
	"out",
	"may",
	"she",
	"his",
	"they",
	"them",
	"then",
	"than",
	"been",
	"being",
	"have",
	"does",
	"will",
	"would",
	"could",
	"should",
	"into",
	"about",
	// Programming language keywords that appear in nearly every source
	// file — they don't distinguish the target file. The definition-site
	// boost uses the identifier directly (not via query keywords), so
	// filtering these doesn't affect it.
	"function",
	"class",
	"enum",
	"interface",
	"struct",
	"const",
	"export",
]);

function queryKeywords(query: string): string[] {
	const words = query
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.filter(word => word.length >= 3 && !CITATION_STOP_WORDS.has(word));
	// Also extract full identifiers (CamelCase, UPPER_SNAKE_CASE) from the
	// original query — these are more distinctive for grep than split words.
	// e.g. "READ_ONLY_TOOL_NAMES" stays intact instead of becoming ["read","only","tool","names"]
	const identifiers = query.match(/\b[A-Z][A-Z0-9_]{4,}\b/g)?.map(id => id.toLowerCase()) ?? [];
	return [...new Set([...words, ...identifiers])];
}

/**
 * Extract identifier-derived keywords from the query:
 * - UPPER_SNAKE_CASE (≥5 chars): READ_ONLY_TOOL_NAMES → read_only_tool_names
 * - CamelCase (≥4 chars, ≥1 internal capital): FastContext → fastcontext,
 *   GrepOutputMode → grepoutputmode. These are far more distinctive than
 *   generic words — a file defining `class FastContextTool` is the target,
 *   not a file mentioning "fast" and "context" separately.
 *
 * Both forms are lowercased for matching against lowercased file content.
 */
function identifierKeywords(query: string): Set<string> {
	const upperSnake = (query.match(/\b[A-Z][A-Z0-9_]{4,}\b/g) ?? []).map(id => id.toLowerCase());
	// CamelCase: starts uppercase, has ≥1 internal uppercase, ≥4 chars total.
	// Avoids matching single-word capitals like "The" or "Find".
	const camelCase = (query.match(/\b[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+\b/g) ?? []).map(id => id.toLowerCase());
	// Lower-camelCase: starts lowercase, has ≥1 internal uppercase (e.g.
	// streamSimple, isEnoent, untilAborted). These get 3x content weighting,
	// segment globs, AND trigger the definition-site boost. Three filters
	// prevent false positives:
	// 1. Dot-preceded filter: skip identifiers preceded by `.` (catches
	//    `baseUrl` in `fastContext.baseUrl`)
	// 2. Dot-followed filter: skip identifiers followed by `.` (catches
	//    `fastContext` in `fastContext.enabled`)
	// 3. Verb-position filter: skip identifiers followed by action verbs
	//    (e.g. `applyGeneratedModelPolicies sets` — the identifier is being
	//    called, not searched for). Identifiers followed by a noun (function,
	//    helper, error) are the search target.
	const actionVerbs = new Set([
		"sets",
		"calls",
		"uses",
		"returns",
		"creates",
		"handles",
		"manages",
		"produces",
		"triggers",
		"invokes",
		"executes",
		"runs",
		"starts",
		"stops",
		"updates",
		"deletes",
		"adds",
		"removes",
		"loads",
		"saves",
		"reads",
		"writes",
		"sends",
		"receives",
		"processes",
		"parses",
		"validates",
	]);
	const lowerCamelCase = (query.match(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g) ?? [])
		.filter(id => id.length >= 6)
		.filter(id => {
			const idx = query.indexOf(id);
			const nextChar = query[idx + id.length];
			const prevChar = idx > 0 ? query[idx - 1] : "";
			// Filter 1: property access — identifier preceded or followed by '.'
			// (fastContext.enabled, fastContext.baseUrl). These are qualifiers,
			// not search targets.
			if (nextChar === "." || prevChar === ".") return false;
			// Filter 2: followed by action verb (applyGeneratedModelPolicies sets)
			const rest = query.slice(idx + id.length).trim();
			const nextWord = rest.split(/\s+/)[0]?.toLowerCase();
			if (nextWord && actionVerbs.has(nextWord)) return false;
			return true;
		})
		.map(id => id.toLowerCase());
	return new Set([...upperSnake, ...camelCase, ...lowerCamelCase]);
}
async function citationMatchesQuery(
	resolvedPath: string,
	lineStart: number,
	lineEnd: number,
	keywords: string[],
	preReadText?: string,
): Promise<boolean> {
	if (keywords.length === 0) return true;
	const text = preReadText ?? (await Bun.file(resolvedPath).text());
	const lines = splitFileLines(text);
	const boundedStart = Math.max(1, Math.min(lineStart, lines.length));
	const boundedEnd = Math.max(boundedStart, Math.min(lineEnd, boundedStart + 200, lines.length));
	const snippet = lines.slice(boundedStart - 1, boundedEnd).join("\n");
	const haystack = `${resolvedPath}\n${snippet}`.toLowerCase();
	const hits = keywords.filter(keyword => haystack.includes(keyword)).length;
	const required = keywords.length <= 3 ? 1 : 2;
	return hits >= required;
}

async function parseCitations(
	text: string,
	cwd: string,
	query: string,
): Promise<{ citations: string[]; lowConfidenceCitations: string[] }> {
	const answer = extractFinalAnswer(text);
	const citations: string[] = [];
	const lowConfidenceCitations: string[] = [];
	const keywords = queryKeywords(query);
	for (const rawLine of answer.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || /https?:\/\//i.test(line)) continue;
		const match = line.match(
			/(?:^|[`*\s-])([A-Za-z]:[\\/][^`\n]+?|[\\/][^`\n]+?|(?:\.{1,2}[\\/]|[A-Za-z0-9_.-]+[\\/])[^`\n]+?|[A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9_.-]*):(\d+)(?:[-–—](\d+))?\b/,
		);
		if (!match) continue;
		const citedPath = match[1];
		const resolved = path.resolve(cwd, citedPath);
		if (!isWithinCwd(resolved, cwd)) continue;
		const stat = await fs.stat(resolved).catch(() => null);
		if (!stat?.isFile()) continue;
		const lineStart = Number(match[2]);
		const lineEnd = Number(match[3] ?? match[2]);
		// Reject invalid line ranges before clamping (PR review: should-fix)
		if (lineStart < 1 || lineEnd < lineStart) continue;
		const fileText = await Bun.file(resolved).text();
		const fileLines = splitFileLines(fileText);
		if (lineStart > fileLines.length) continue;
		const keywordMatch = await citationMatchesQuery(resolved, lineStart, lineEnd, keywords, fileText);
		if (!keywordMatch) {
			lowConfidenceCitations.push(line);
			continue;
		}
		citations.push(line);
	}
	return { citations, lowConfidenceCitations };
}

function formatReadOutput(filePath: string, offset: number, endLine: number, lines: string[]): string {
	const body = lines.map((line, index) => `${offset + index}|${truncateLine(line)}`).join("\n");
	return `\`\`\`${filePath}:${offset}-${endLine}\n${body}\n\`\`\``;
}

function formatContentMatches(
	matches: GrepMatch[],
	basePath: string,
	includeLineNumbers: boolean,
	limit: number,
): string {
	const out: string[] = [];
	let shown = 0;
	for (const match of matches) {
		if (shown >= limit) break;
		const absolutePath = formatAbsolute(match.path, basePath);
		out.push(absolutePath);
		const contexts = [...(match.contextBefore ?? []), match, ...(match.contextAfter ?? [])];
		for (const context of contexts) {
			if (shown >= limit) break;
			const prefix = includeLineNumbers ? `${context.lineNumber}|` : "";
			out.push(`${prefix}${truncateLine(context.line)}`);
			shown++;
		}
	}
	if (matches.length > 0 && shown >= limit) out.push(`Results truncated to first ${limit} lines`);
	return out.length > 0 ? out.join("\n") : "No matches found";
}
const WORKSPACE_LISTING_TTL_MS = 60_000;
let workspaceListingCache: { cwd: string; listing: string; ts: number } | null = null;

async function buildWorkspaceListing(cwd: string, signal?: AbortSignal): Promise<string> {
	// Cache with 60s TTL — the workspace structure doesn't change during a
	// session, and the listing involves two glob calls (~40ms each).
	if (workspaceListingCache?.cwd === cwd && Date.now() - workspaceListingCache.ts < WORKSPACE_LISTING_TTL_MS) {
		return workspaceListingCache.listing;
	}
	try {
		const [dirsResult, filesResult] = await Promise.all([
			glob({
				pattern: "*/",
				path: cwd,
				hidden: false,
				gitignore: true,
				maxResults: MAX_WORKSPACE_LISTING,
				sortByMtime: false,
				recursive: false,
				signal: requestSignal(signal, TOOL_TIMEOUT_MS),
				timeoutMs: TOOL_TIMEOUT_MS,
			}),
			glob({
				pattern: "**/*.{ts,js,py,rs,go,md,json,yaml,yml,toml}",
				path: cwd,
				hidden: false,
				gitignore: true,
				maxResults: MAX_WORKSPACE_LISTING,
				sortByMtime: true,
				recursive: true,
				signal: requestSignal(signal, TOOL_TIMEOUT_MS),
				timeoutMs: TOOL_TIMEOUT_MS,
			}),
		]);
		const dirs = dirsResult.matches
			.map(m => m.path)
			.filter((p): p is string => Boolean(p))
			.slice(0, 30);
		const files = filesResult.matches
			.map(m => m.path)
			.filter((p): p is string => Boolean(p))
			.slice(0, 40);
		const parts = ["Directories:", dirs.join("\n"), "", "Recent files:", files.join("\n")];
		if (dirsResult.matches.length + filesResult.matches.length >= MAX_WORKSPACE_LISTING) parts.push("...");
		const listing = parts.join("\n");
		workspaceListingCache = { cwd, listing, ts: Date.now() };
		return listing;
	} catch (err) {
		if (signal?.aborted) throw err;
		return "(workspace listing unavailable)";
	}
}

/**
 * Convert FastContext `ChatMessage[]` to omp `Context` fields for the registry
 * backend. `system` messages are collected into `Context.systemPrompt` (Devin
 * consumes it as the request `prompt` field); `assistant` messages with
 * `tool_calls` become ToolCall content blocks (arguments parsed from JSON
 * string to object); `tool` messages become `ToolResultMessage` with `toolName`
 * resolved from the matching assistant tool call. Timestamps are synthesized —
 * history-replay paths only read role + content.
 */
function fcMessagesToContext(messages: ChatMessage[]): { systemPrompt?: string[]; messages: Message[] } {
	const systemSegments: string[] = [];
	const toolNameById = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role === "assistant" && msg.tool_calls) {
			for (const call of msg.tool_calls) {
				if (call.id && call.function?.name) toolNameById.set(call.id, call.function.name);
			}
		}
	}
	const now = Date.now();
	const out: Message[] = [];
	for (const msg of messages) {
		if (msg.role === "system") {
			if (msg.content) systemSegments.push(msg.content);
			continue;
		}
		if (msg.role === "user") {
			out.push({ role: "user", content: msg.content ?? "", timestamp: now });
			continue;
		}
		if (msg.role === "assistant") {
			const content: (TextContent | ToolCall)[] = [];
			if (msg.content) content.push({ type: "text", text: msg.content });
			for (const call of msg.tool_calls ?? []) {
				let args: Record<string, unknown> = {};
				try {
					args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
				} catch {
					args = {};
				}
				content.push({ type: "toolCall", id: call.id, name: call.function.name, arguments: args });
				toolNameById.set(call.id, call.function.name);
			}
			out.push({
				role: "assistant",
				content,
				api: "openai-completions" as Api,
				provider: "fastcontext",
				model: "",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: now,
			});
			continue;
		}
		// role === "tool" — tool result; FastContext carries only tool_call_id + content.
		const toolCallId = msg.tool_call_id ?? "";
		out.push({
			role: "toolResult",
			toolCallId,
			toolName: toolNameById.get(toolCallId) ?? toolCallId,
			content: [{ type: "text", text: msg.content ?? "" }],
			isError: false,
			timestamp: now,
		});
	}
	return { ...(systemSegments.length > 0 ? { systemPrompt: systemSegments } : {}), messages: out };
}

/** Map FastContext's OpenAI-shape tool definitions to omp `Tool[]` (parameters pass through as JSON Schema). */
function fcToolsToOmpTools(tools: readonly (typeof FAST_CONTEXT_TOOLS)[number][]): Tool[] {
	return tools.map(def => ({
		name: def.function.name,
		description: def.function.description,
		parameters: def.function.parameters as Tool["parameters"],
	}));
}

/** Convert an omp `AssistantMessage` (from `completeSimple`) into FastContext's `{ message, toolCalls }` shape. */
function assistantToFcResponse(msg: AssistantMessage): { message: ChatMessage; toolCalls: FastContextToolCall[] } {
	const textParts: string[] = [];
	const toolCalls: FastContextToolCall[] = [];
	for (const block of msg.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		} else if (block.type === "toolCall") {
			toolCalls.push({
				id: block.id,
				type: "function",
				function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
			});
		}
	}
	const content = textParts.length > 0 ? textParts.join("") : null;
	return {
		message: { role: "assistant", content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
		toolCalls,
	};
}
/** Derive `baseUrl`/`model` display fields for `FastContextToolDetails` from the resolved backend. */
function backendDisplay(backend: FastContextBackend): { baseUrl: string; model: string } {
	return backend.kind === "registry"
		? { baseUrl: "registry", model: backend.modelId }
		: { baseUrl: backend.url, model: backend.model };
}
export class FastContextTool implements AgentTool<typeof fastContextSchema, FastContextToolDetails> {
	readonly name = "fast_context";
	readonly approval = "read" as const;
	readonly label = "FastContext";
	readonly summary = "Run local FastContext repository exploration";
	readonly description = prompt.render(fastContextDescription);
	readonly parameters = fastContextSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	#session: ToolSession;
	#fetch: FetchFunction;
	#completeFn: typeof completeSimple;
	#resolvedBackend: { kind: "local"; url: string; model: string } | null = null;

	constructor(session: ToolSession, options?: FastContextOptions) {
		this.#session = session;
		this.#fetch = options?.fetch ?? fetch;
		this.#completeFn = options?.completeFn ?? completeSimple;
	}

	static createIf(session: ToolSession): FastContextTool | null {
		return session.settings.get("fastContext.enabled") ? new FastContextTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: FastContextToolInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<FastContextToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<FastContextToolDetails>> {
		return untilAborted(signal, async () => {
			const apiBaseUrl = normalizeFastContextBaseUrl(this.#session.settings.get("fastContext.baseUrl"));
			const backend = await this.#resolveBackend(apiBaseUrl, signal);
			// Fast Tools forces agent mode (SWE-grep-style parallel retrieval).
			// Otherwise honor an explicit non-default mode; a reflexive `mode: "hint"`
			// yields to the user's configured fastContext.mode so the setting wins.
			const mode =
				this.#session.settings.get("fastContext.fastTools") === true
					? "agent"
					: params.mode && params.mode !== "hint"
						? params.mode
						: (this.#session.settings.get("fastContext.mode") ?? "hint");
			return mode === "hint"
				? this.#executeHint(backend, params, signal)
				: this.#executeAgent(backend, params, signal);
		});
	}

	async #executeAgent(
		backend: FastContextBackend,
		params: FastContextToolInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<FastContextToolDetails>> {
		const { baseUrl, model } = backendDisplay(backend);
		const maxTurns = clampedTurns(params.max_turns);
		const messages: ChatMessage[] = [
			{
				role: "system",
				content: prompt.render(fastContextSystemPrompt, {
					osKind: `${os.type()} ${os.release()}`,
					shellName: process.env.SHELL ?? process.env.ComSpec ?? "unknown",
					workDir: this.#session.cwd,
					workDirListing: await buildWorkspaceListing(this.#session.cwd, signal),
				}),
			},
			{ role: "user", content: `<query>\n${params.query.trim()}\n</query>` },
		];

		let toolCalls = 0;
		let finalText = "";
		// Stable cascade id shared across all turns of this invocation so the
		// provider (Devin) can thread the conversation and reuse cross-turn
		// prompt-cache state instead of treating every turn as a fresh context.
		const fcCascadeId = crypto.randomUUID();
		for (let turn = 1; turn <= maxTurns + 1; turn++) {
			const isFinalTurn = turn === maxTurns + 1;
			if (isFinalTurn) {
				messages.push({ role: "user", content: prompt.render(finalTurnPrompt) });
			}
			const response = await this.#chat(
				backend,
				messages,
				signal,
				isFinalTurn ? AGENT_FINAL_TURN_MAX_TOKENS : AGENT_TOOL_TURN_MAX_TOKENS,
				FAST_CONTEXT_TOOLS,
				REQUEST_TIMEOUT_MS,
				fcCascadeId,
			);
			const boundedCalls = response.toolCalls.slice(0, MAX_PARALLEL_TOOL_CALLS);
			// Truncate tool_calls in saved message to match bounded calls (PR review: P2)
			const savedMessage: ChatMessage = {
				role: response.message.role,
				content: response.message.content,
				...(boundedCalls.length > 0 ? { tool_calls: boundedCalls } : {}),
			};
			messages.push(savedMessage);
			// Early termination: if the model produces a <final_answer> block
			// alongside tool calls, parse citations and exit immediately instead
			// of waiting for a no-tool-call turn. Saves 1+ LLM round-trips.
			// Check the raw content for the tag — extractFinalAnswer() strips it,
			// so checking the extracted text would never match (dead code before fix).
			if (response.toolCalls.length > 0 && response.message.content?.includes("<final_answer>")) {
				const earlyAnswer = extractFinalAnswer(response.message.content);
				const { citations: earlyCites, lowConfidenceCitations: earlyLow } = await parseCitations(
					earlyAnswer,
					this.#session.cwd,
					params.query,
				);
				const allEarly = [...earlyCites, ...earlyLow];
				if (allEarly.length > 0) {
					const confidence = earlyCites.length > 0 ? "HIGH" : "LOW";
					const diagnosticPrefix = `[FastContext agent: ${turn} turns, ${toolCalls + response.toolCalls.length} tool calls, ${allEarly.length} citations, confidence ${confidence}]`;
					const details: FastContextToolDetails = {
						baseUrl,
						model,
						mode: "agent",
						turns: turn,
						toolCalls: toolCalls + response.toolCalls.length,
						citations: allEarly,
						keywords: queryKeywords(params.query),
					};
					return toolResult<FastContextToolDetails>(details).text(`${diagnosticPrefix}\n${earlyAnswer}`).done();
				}
			}
			if (response.toolCalls.length === 0) {
				// Strip <final_answer> wrapper so both the TUI-facing result text
				// and parseCitations receive clean content (the early-termination
				// path at ~L878 already uses extractFinalAnswer). The LLM consumes
				// this via the tool-result text too, so tag-free is correct for both.
				finalText = extractFinalAnswer(response.message.content ?? "");
				const { citations, lowConfidenceCitations } = await parseCitations(
					finalText,
					this.#session.cwd,
					params.query,
				);
				const allCitations = [...citations, ...lowConfidenceCitations];
				const keywords = queryKeywords(params.query);
				if (allCitations.length === 0 && turn <= maxTurns) {
					messages.push({ role: "user", content: prompt.render(citationRetryPrompt) });
					continue;
				}
				// Hint-mode fallback when agent returns no citations
				if (allCitations.length === 0) {
					const hintResult = await this.#executeHint(backend, params, signal);
					if ((hintResult.details?.citations ?? []).length > 0) return hintResult;
					const details: FastContextToolDetails = {
						baseUrl,
						model,
						mode: "agent",
						turns: turn,
						toolCalls,
						citations: [],
						keywords,
						error: "FastContext returned no file-line citations; hint fallback also found no files.",
					};
					return toolResult<FastContextToolDetails>(details)
						.text(`${details.error} Suggested grep keywords: [${keywords.join(", ")}].`)
						.error()
						.useless()
						.done();
				}
				const confidence = citations.length > 0 ? "HIGH" : lowConfidenceCitations.length > 0 ? "LOW" : "NONE";
				const diagnosticPrefix = `[FastContext agent: ${turn} turns, ${toolCalls} tool calls, ${allCitations.length} citations, confidence ${confidence}]`;
				const details: FastContextToolDetails = {
					baseUrl,
					model,
					mode: "agent",
					turns: turn,
					toolCalls,
					citations: allCitations,
					keywords,
				};
				return toolResult<FastContextToolDetails>(details)
					.text(`${diagnosticPrefix}\n${finalText || "FastContext returned an empty final response."}`)
					.done();
			}
			toolCalls += response.toolCalls.length;
			const toolMessages = await Promise.all(
				boundedCalls.map(async call => ({
					role: "tool" as const,
					tool_call_id: call.id,
					content: await this.#executeFastContextTool(call, signal),
				})),
			);
			messages.push(...toolMessages);
		}

		// Hint-mode fallback: when agent loop exhausts without converging
		const hintResult = await this.#executeHint(backend, params, signal);
		if ((hintResult.details?.citations ?? []).length > 0) return hintResult;

		finalText = `No final answer after ${maxTurns} turns; hint fallback also found no files.`;
		return toolResult<FastContextToolDetails>({
			baseUrl,
			model,
			mode: "agent",
			turns: maxTurns,
			toolCalls,
			citations: [],
			keywords: queryKeywords(params.query),
			error: finalText,
		})
			.text(finalText)
			.error()
			.done();
	}

	#hintError(
		backend: FastContextBackend,
		params: FastContextToolInput,
		errorMsg: string,
	): AgentToolResult<FastContextToolDetails> {
		const { baseUrl, model } = backendDisplay(backend);
		return toolResult<FastContextToolDetails>({
			baseUrl,
			model,
			mode: "hint",
			turns: 1,
			toolCalls: 0,
			citations: [],
			keywords: queryKeywords(params.query),
			error: errorMsg,
		})
			.text(errorMsg)
			.error()
			.done();
	}

	async #executeHint(
		backend: FastContextBackend,
		params: FastContextToolInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<FastContextToolDetails>> {
		const { baseUrl, model } = backendDisplay(backend);
		const workDirListing = await buildWorkspaceListing(this.#session.cwd, signal);
		const systemContent = prompt.render(hintSystemPrompt, {
			workDir: this.#session.cwd,
			workDirListing,
		});
		const hintMessages: ChatMessage[] = [
			{ role: "system", content: systemContent },
			{ role: "user", content: params.query.trim() },
		];
		let rawText: string;
		try {
			// Cloud/reasoning models (registry backend) need a longer budget than the
			// 30s hint timeout tuned for a fast local model — otherwise the single
			// query-expansion turn times out before the model emits a plan.
			const hintTimeout = backend.kind === "registry" ? REQUEST_TIMEOUT_MS : HINT_REQUEST_TIMEOUT_MS;
			// Hint plans are ~100-200 tokens of JSON. 512 gives 2.7x headroom
			// over the worst case (maxed arrays). The llama.cpp server allocates
			// compute proportional to max_completion_tokens even when the model
			// stops early, so capping this cuts hint latency ~75%.
			const response = await this.#chat(backend, hintMessages, signal, 512, null, hintTimeout, undefined, 0);
			rawText = response.message.content ?? "";
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			return this.#hintError(backend, params, `FastContext hint failed: ${errorMsg}`);
		}
		const plan = parseHintPlan(rawText);
		// When the model returns unparseable output, fall through to the
		// query-derived fallback path instead of returning an error — the
		// fallback grep/glob + ranking pipeline works without a model plan.
		const effectivePlan: HintPlan = plan ?? {
			keywords: [],
			globs: [],
			grep_patterns: [],
			grep_paths: [],
			description: "",
		};
		const queryKws = queryKeywords(params.query);
		// Identifier keywords (UPPER_SNAKE_CASE + CamelCase from the query) are
		// far more distinctive than generic words — prioritize them in
		// supplementary grep/glob so definition files enter the candidate pool.
		// Without this, "tempdir" loses to "directories"/"temporary" by length,
		// and temp.ts (which defines `class TempDir` but doesn't mention
		// "temporary" or "directories") never gets grep'd.
		const queryIdentifierSet = identifierKeywords(params.query);
		const byIdentifierThenLength = (a: string, b: string) => {
			const aId = queryIdentifierSet.has(a) ? 1 : 0;
			const bId = queryIdentifierSet.has(b) ? 1 : 0;
			return bId - aId || b.length - a.length;
		};
		// Build supplementary search patterns (query-derived, independent of plan)
		const supplementaryGlobs = queryKws
			.filter(kw => kw.length >= 4)
			.sort(byIdentifierThenLength)
			.slice(0, HINT_MAX_GLOBS)
			.map(kw => `**/*${kw}*`);
		// Identifier-segment globs: split CamelCase identifiers into word
		// segments and glob for each ≥4-char segment. This catches definition
		// files whose basename is a stem of the queried identifier (e.g.
		// "TempDir" → segment "temp" → glob `**/*temp*` → matches temp.ts).
		// Without this, temp.ts never enters the candidate pool because the
		// grep for "tempdir" returns 200+ files that import TempDir, and the
		// 200-result cap excludes temp.ts itself.
		// Extract from the ORIGINAL query (pre-lowercase) so CamelCase
		// boundaries are preserved: "TempDir" → ["Temp", "Dir"].
		const identifierSegments = new Set<string>();
		const rawIdentifiers = [
			...(params.query.match(/\b[A-Z][A-Z0-9_]{4,}\b/g) ?? []),
			...(params.query.match(/\b[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+\b/g) ?? []),
			...(params.query.match(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g) ?? []).filter(id => id.length >= 6),
		];
		for (const id of rawIdentifiers) {
			const segments = id
				.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|[_\s]+/g)
				.filter(s => s.length >= 4)
				.map(s => s.toLowerCase());
			for (const seg of segments) identifierSegments.add(seg);
		}
		const segmentGlobs = [...identifierSegments]
			.sort((a, b) => b.length - a.length)
			.slice(0, 3)
			.map(seg => `**/*${seg}*`);
		// Prefix globs for longer segments (≥6 chars): "aborted" → prefix
		// "abort" → glob `**/*abort*` → matches abortable.ts. Generated
		// separately from main segment globs so they're independent of the
		// slice(0, 3) limit. This catches definition files where the filename
		// contains a prefix of the identifier segment but not the full segment.
		const prefixGlobs = [...identifierSegments]
			.filter(seg => seg.length >= 6)
			.map(seg => seg.slice(0, 5))
			.filter((seg, i, arr) => arr.indexOf(seg) === i)
			.map(seg => `**/*${seg}*`);
		// Directory-path globs for segments ≥5 chars: `**/agent/**/*`
		// matches files in directories named "agent". This catches files
		// with generic basenames (types.ts) that define a CamelCase
		// identifier whose segments match a directory name, not the
		// filename. Without this, AgentTool defined in types.ts never
		// enters the candidate pool — `**/*agent*` matches basenames
		// containing "agent", not files inside an "agent/" directory.
		// Segments <5 chars (e.g. "tool") are excluded to avoid flooding
		// (every file in tools/ would match).
		const idDirGlobs = [...identifierSegments].filter(seg => seg.length >= 5).map(seg => `**/${seg}/**/*`);
		// Keyword-derived directory globs: query keywords like "identity",
		// "session", "streaming" frequently match directory names containing
		// the GT file (identity/classify.ts, session/session-context.ts). These
		// are only generated from keywords ≥6 chars to avoid flooding from
		// short generic names (e.g. "model" → every file in model/ dirs).
		// Identifier-segment directory globs (above) already handle CamelCase
		// query terms; this catches natural-language keywords that aren't
		// CamelCase identifiers but still correspond to directory names.
		const kwDirGlobs = queryKws
			.filter(kw => kw.length >= 6 && !identifierSegments.has(kw))
			.filter((kw, i, arr) => arr.indexOf(kw) === i)
			.slice(0, 4)
			.map(kw => `**/${kw}/**/*`);
		const dirGlobs = [...idDirGlobs, ...kwDirGlobs];
		// Directory globs come first (most targeted — files in a named
		// directory), then segment globs (filename matches), then prefix
		// globs, then generic keyword globs. All must survive the 200-file
		// dedup cap — directory globs first prevent generic segment globs
		// (e.g. `**/*agent*` = 109 files) from flooding the cap before the
		// more targeted directory globs (`**/agent/**/*` = 72 files) run.
		const allSupplementaryGlobs = [...dirGlobs, ...segmentGlobs, ...prefixGlobs, ...supplementaryGlobs];
		const allGrepCandidates = [...effectivePlan.keywords, ...queryKws]
			.filter(kw => kw.length >= 5)
			.sort(byIdentifierThenLength);
		const supplementaryGrepKws = allGrepCandidates.slice(0, 1);

		// Execute plan + supplementary searches in ONE batch (saves ~150-200ms
		// by eliminating a sequential round-trip — supplementary patterns are
		// query-derived, not plan-dependent)
		const [globResults, grepResults, suppGlobResults, suppGrepResults] = await Promise.all([
			effectivePlan.globs.length > 0
				? Promise.all(effectivePlan.globs.map(g => this.#nativeGlob(g, this.#session.cwd, signal)))
				: Promise.resolve([[]] as string[][]),
			effectivePlan.grep_patterns.length > 0
				? Promise.all(effectivePlan.grep_patterns.map(p => this.#nativeGrep(p, effectivePlan.grep_paths, signal)))
				: Promise.resolve([[]] as string[][]),
			allSupplementaryGlobs.length > 0
				? Promise.all(allSupplementaryGlobs.map(g => this.#nativeGlob(g, this.#session.cwd, signal)))
				: Promise.resolve([[]] as string[][]),
			supplementaryGrepKws.length > 0
				? Promise.all(supplementaryGrepKws.map(p => this.#nativeGrep(p, ["."], signal)))
				: Promise.resolve([[]] as string[][]),
		]);

		const planGrepFileSet = new Set(grepResults.flat());
		let grepFileSet = new Set(planGrepFileSet);
		const globMatchedSet = new Set<string>();
		const planGlobMatchedSet = new Set<string>();
		const suppGlobMatchedSet = new Set<string>();
		// Sort plan glob result arrays by specificity (fewer matches = more
		// targeted) before flattening. Without this, a broad glob like
		// `**/utils/**` (100 matches, fills the cap with unrelated files) can
		// displace a specific glob like `**/*temp*` (15 matches, contains the
		// target definition file) when the combined results are sliced to
		// MAX_TOOL_LINES. Specific globs first ensures targeted matches survive.
		const globResultsBySpec = [...globResults].sort((a, b) => a.length - b.length);
		const globFlat = globResultsBySpec.flat();
		for (const f of globFlat) {
			globMatchedSet.add(f);
			planGlobMatchedSet.add(f);
		}
		let allFiles = [...new Set([...globFlat, ...grepResults.flat()])].slice(0, MAX_TOOL_LINES);
		let effectiveKeywords = effectivePlan.keywords;
		let fallbackUsed = false;

		// Merge supplementary results into the candidate pool
		const suppGrepFiles = suppGrepResults.flat();
		const suppGlobFiles = suppGlobResults.flat();
		if (suppGrepFiles.length > 0 || suppGlobFiles.length > 0) {
			effectiveKeywords = [...new Set([...effectivePlan.keywords, ...queryKws])];
			// Glob-matched files (filename matches) are more likely to be definition
			// sites than grep-matched files (content mentions). Put glob results
			// first so they survive the 200-file cap — without this, a grep for
			// "tempdir" returns 200+ importing files and pushes temp.ts (matched
			// only by the segment glob `**/*temp*`) past the cap.
			const planGlobFiles = new Set(globFlat);
			allFiles = [...new Set([...suppGlobFiles, ...suppGrepFiles, ...allFiles])].slice(0, 200);
			// Re-inject displaced plan-glob-matched files after the cap. Plan
			// globs are the model's deliberate filename matches — they should
			// always get content-scored. Without this, broad supplementary
			// globs (e.g. `**/*file*` = 100+ matches) flood the 200-cap and
			// displace targeted plan-glob matches like `**/*temp*` → temp.ts.
			// Only plan GLOB files are re-injected (not grep — grep matches are
			// content mentions that could be importers, not definition sites).
			// The ranking pipeline re-sorts by content/path score, so adding
			// files to the pool doesn't displace existing rankings — it only
			// gives plan-glob files a fair shot at being scored.
			for (const f of planGlobFiles) {
				if (!allFiles.includes(f)) allFiles.push(f);
			}
			for (const f of suppGrepFiles) grepFileSet.add(f);
			for (const f of suppGlobFiles) {
				globMatchedSet.add(f);
				suppGlobMatchedSet.add(f);
			}
		}

		// Query-derived fallback when everything above yields nothing
		if (allFiles.length === 0) {
			fallbackUsed = true;
			effectiveKeywords = queryKws;
			const fallbackGreps = queryKws
				.filter(kw => kw.length >= 4)
				.sort(byIdentifierThenLength)
				.slice(0, HINT_MAX_GREPS);
			const fallbackResults = await Promise.all(fallbackGreps.map(p => this.#nativeGrep(p, ["."], signal)));
			const fallbackGlobPatterns = [
				...queryKws
					.filter(kw => kw.length >= 3)
					.sort(byIdentifierThenLength)
					.slice(0, HINT_MAX_GLOBS)
					.map(kw => `**/*${kw}*`),
				...segmentGlobs,
			];
			const fallbackGlobResults = await Promise.all(
				fallbackGlobPatterns.map(g => this.#nativeGlob(g, this.#session.cwd, signal)),
			);
			grepFileSet = new Set(fallbackResults.flat());
			allFiles = [...new Set([...fallbackResults.flat(), ...fallbackGlobResults.flat()])].slice(0, 200);
		}

		// Content-based ranking (callsive deterministic keyword scoring):
		// Score each file by how many query keywords appear in its content
		// (first 1000 chars for real-world file sizes), then by path-keyword
		// matches as a tiebreaker. Deprioritize test files, docs, and config.
		// Skip when a single file already has a unique path-keyword match.
		if (effectiveKeywords.length > 0 && allFiles.length > 1) {
			const lowerKeywords = effectiveKeywords.map(k => k.toLowerCase());
			// Identifier-derived keywords (UPPER_SNAKE_CASE from the query) are
			// far more distinctive than generic words — weight them 3x in content
			// scoring so files containing the actual identifier outrank files that
			// merely mention generic words like "read" or "tool".
			const identifierSet = identifierKeywords(params.query);
			const filesWithPathMatches = allFiles.filter(f => {
				const normPath = f.replace(/\\/g, "/").toLowerCase();
				return lowerKeywords.some(kw => normPath.includes(kw));
			});
			// If only one file has a path-keyword match and it's already first, skip I/O
			if (filesWithPathMatches.length !== 1 || !filesWithPathMatches.includes(allFiles[0])) {
				// Pre-sort by path score + type penalty (no I/O), then only read
				// content for the top 20 to avoid excessive I/O on large repos
				const pathScored = allFiles.map(f => {
					const normalizedPath = f.replace(/\\/g, "/").toLowerCase();
					const pathMatches = lowerKeywords.filter(kw => normalizedPath.includes(kw)).length;
					const isTest = /\/(test|tests|__tests__)\/|\.test\.|\.spec\./.test(normalizedPath);
					const isDoc =
						/\/docs\//.test(normalizedPath) ||
						(/\.md$/.test(normalizedPath) && !/\/(prompts|agents)\//.test(normalizedPath));
					const isInfra = /\/(\.github|infra)\//.test(normalizedPath);
					const isScript = /\/(scripts|examples|bench|prompts)\//.test(normalizedPath);
					// Config/data files (JSON, YAML, TOML, theme defaults) are not
					// code definitions — they match keyword globs/greps but contain
					// no logic. Penalize at the script tier (0.7x) so they don't
					// outrank source files via convergence boost.
					const isConfig = /\.(json|ya?ml|toml|csv|svg)$/.test(normalizedPath);
					const isTypeDef = /\.d\.ts$/.test(normalizedPath);
					const isCompat = /\/(compat|_compat|legacy)\//.test(normalizedPath);
					// Pre-sort uses the strong additive penalty (-100) so test/doc
					// files stay out of the top-30 content-scoring pool. The graduated
					// multiplier (semble_rs-inspired) is applied to the FINAL score
					// after content scoring — test files that enter via the
					// grep/glob-matched path aren't completely zeroed out.
					// - STRONG 0.3x: test, docs, .github/infra
					// - MODERATE 0.5x: type-def stubs (.d.ts), compat/legacy dirs
					// - MILD 0.7x: scripts, config/data files (.json/.yaml/.toml)
					let typeMultiplier = 1;
					if (isTest || isDoc || isInfra) typeMultiplier = 0.3;
					else if (isTypeDef || isCompat) typeMultiplier = 0.5;
					else if (isScript || isConfig) typeMultiplier = 0.7;
					const typePenalty = isTest || isDoc || isInfra ? -100 : isScript || isConfig ? -1 : 0;
					return { file: f, pathScore: pathMatches + typePenalty, typeMultiplier, rawPathScore: pathMatches };
				});
				pathScored.sort((a, b) => b.pathScore - a.pathScore);
				// Top 30 by path score, PLUS any grep/glob-matched files not in
				// top 30 — these matched content keywords or query-keyword filenames,
				// so they should be content-scored even with low path scores
				const topByPath = pathScored.slice(0, 30).map(e => e.file);
				const matchedNotInTop = allFiles.filter(f => {
					const norm = f.replace(/\\/g, "/");
					const isMatched =
						grepFileSet.has(f) || grepFileSet.has(norm) || globMatchedSet.has(f) || globMatchedSet.has(norm);
					return isMatched && !topByPath.includes(f);
				});
				const topCandidateFiles = [...topByPath, ...matchedNotInTop];
				const topCandidates = topCandidateFiles.map(f => pathScored.find(e => e.file === f)!).filter(Boolean);
				const contentScored = await Promise.all(
					topCandidates.map(async entry => {
						let contentScore = 0;
						try {
							// Size guard: large files get a 4k byte-range read
							const file = Bun.file(entry.file);
							const blob = file.size > 100_000 ? file.slice(0, 4000) : file;
							const rawText = await blob.text();
							const lower = rawText.toLowerCase();
							// Weight identifier matches 3x — a file containing
							// READ_ONLY_TOOL_NAMES is the definition site; a file
							// containing generic "read" and "tool" is just noise.
							contentScore = lowerKeywords.reduce((score, kw) => {
								return score + (lower.includes(kw) ? (identifierSet.has(kw) ? 3 : 1) : 0);
							}, 0);
							// Basename boost: if a query keyword appears in the
							// filename itself (e.g. "grep" in grep.rs, "explore"
							// in explore.md), that's a strong signal. +2 per
							// basename-keyword match. Also match identifier stems:
							// "tempdir" → basename "temp" (semble_rs stem_matches).
							const lowerBasename = path.basename(entry.file).toLowerCase();
							const basenameNoExt = lowerBasename.replace(/\.[^.]+$/, "");
							contentScore += lowerKeywords.reduce((bonus, kw) => {
								if (lowerBasename.includes(kw)) return bonus + 2;
								// Identifier stem match: if the identifier (stripped
								// of underscores) starts with the basename, or vice
								// versa, treat as a match. "tempdir" → "temp".
								if (identifierSet.has(kw)) {
									const kwNorm = kw.replace(/_/g, "");
									if (
										kwNorm.length >= 4 &&
										basenameNoExt.length >= 3 &&
										(kwNorm.startsWith(basenameNoExt) || basenameNoExt.startsWith(kwNorm))
									) {
										return bonus + 2;
									}
								}
								return bonus;
							}, 0);
							const defKeywords =
								"(?:export\\s+(?:async\\s+)?(?:function|class|enum|interface|const|struct)|pub\\s+(?:fn|struct|enum))";
							// Definition-site boost (semble_rs-inspired): files that
							// DEFINE the queried identifier outrank files that merely
							// reference it. Uses the full identifierSet (which includes
							// filtered lowerCamelCase — untilAborted passes dot and verb
							// filters, so its definition `function untilAborted` gets
							// boosted). The three filters on identifierKeywords ensure
							// property accessors and call-site references don't
							// trigger false boosts.
							// Same line-start anchor + case-sensitive + export-required
							// semantics as the plan-symbol boost below — see comments there.
							if (identifierSet.size > 0) {
								for (const id of identifierSet) {
									const defPattern = new RegExp(
										`^\\s*${defKeywords}\\s+[a-z_]*${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
										"m",
									);
									if (defPattern.test(rawText)) {
										contentScore += 8;
										break;
									}
								}
							}
							// Plan-symbol definition boost: the model plan's
							// grep_patterns carry exact symbol names (toolResult,
							// declareWorkerHostEntry) absent from natural-language
							// queries. Boost files that DECLARE them with the symbol
							// at the START of the name (function toolResult, class
							// ToolResultBuilder). The start anchor is precise — it
							// avoids the substring over-match of [a-z_]*id (which
							// The line-start anchor (^ with multiline) prevents false
							// boosts from comments that mention the symbol name — e.g.
							// fast-context.ts line 1044 says `class TempDir` in a comment,
							// which would wrongly boost it above the real definition file.
							// Case-SENSITIVE matching against original-case text (no `i`
							// flag) prevents matching different-cased variables: `Message`
							// must not match `const messages`, `TempDir` must not match
							// `TempDirGuard`. Plan grep_patterns carry exact symbol names
							// from the model, so case-sensitive is correct semantics.
							// Requiring `export` (TS/JS) or `pub` (Rust) before the def
							// keyword prevents false boosts from LOCAL variables — e.g.
							// `const gitStatus` inside a method in component.ts matched
							// and outranked the actual definition file git.ts. Only
							// exported definitions are public API worth boosting.
							for (const sym of effectivePlan.grep_patterns) {
								if (!/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(sym) || /^[a-z]+$/.test(sym)) continue;
								const escSym = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
								if (new RegExp(`^\\s*${defKeywords}\\s+${escSym}[a-z0-9_]*\\b`, "m").test(rawText)) {
									contentScore += 8;
									break;
								}
							}
							// Path-aligned class-name boost: when a query keyword (≥6 chars)
							// both appears in the file's path AND names a class defined in
							// the file (`class Settings`, `class Changelog`), boost it. This
							// catches definition files for natural-language queries whose
							// keywords aren't CamelCase (so the identifier/plan-symbol boosts
							// miss them). The path-alignment requirement is the discriminator
							// — without it, every file defining `class Context` or `class
							// Version` would be boosted for a generic keyword.
							const lowerPath = entry.file.replace(/\\/g, "/").toLowerCase();
							for (const kw of lowerKeywords) {
								if (kw.length < 8 || CITATION_STOP_WORDS.has(kw)) continue;
								if (!lowerPath.includes(kw)) continue;
								if (new RegExp(`(?:export\\s+)?class\\s+${kw}\\b`, "i").test(lower)) {
									contentScore += 8;
									break;
								}
							}
							// Barrel boost: index.ts/index.js files whose parent
							// directory name contains a query keyword get +3. Barrel
							// files have almost no content (just `export * from`),
							// so they lose on content scoring. The parent-dir match
							// mirrors how a human finds barrels — "the provider-models
							// barrel" → look for index.ts inside the provider-models dir.
							const lowerBasename2 = path.basename(entry.file).toLowerCase();
							if (
								(lowerBasename2 === "index.ts" || lowerBasename2 === "index.js") &&
								lowerKeywords.some(kw => path.basename(path.dirname(entry.file)).toLowerCase().includes(kw))
							) {
								contentScore += 3;
							}
							// Directory-segment boost: if any path component matches
							// an identifier segment (e.g. "agent" matches the "agent/"
							// in packages/agent/src/types.ts), add +2. This catches
							// files with generic basenames (types.ts) that define a
							// CamelCase identifier whose segments match a directory name,
							// not the filename. Only applies when the file also has a
							// definition-site match (checked above) to prevent generic
							// segments like "tool" from boosting every file in tools/.
							if (identifierSegments.size > 0) {
								const pathParts = entry.file.replace(/\\/g, "/").toLowerCase().split("/");
								let dirSegMatch = false;
								for (const seg of identifierSegments) {
									if (pathParts.includes(seg)) {
										dirSegMatch = true;
										break;
									}
								}
								// Only boost if a definition-site match already fired
								// (contentScore includes the +8 from defPattern). This
								// prevents false boosts on files that merely live in a
								// matching directory but don't define the identifier.
								if (dirSegMatch && contentScore >= 8) {
									contentScore += 2;
								}
							}
							// Multi-signal convergence boost: a file matched by multiple
							// independent signals (plan glob + plan grep + supplementary
							// glob) is far more likely to be the GT. Added to contentScore
							// BEFORE the type multiplier so test/doc files (0.3x) get a
							// dampened convergence bonus too — without this, a test file
							// matching all 3 signals would get the same +6 as a source file.
							const norm = entry.file.replace(/\\/g, "/");
							let sigCount = 0;
							if (planGlobMatchedSet.has(entry.file) || planGlobMatchedSet.has(norm)) sigCount++;
							if (planGrepFileSet.has(entry.file) || planGrepFileSet.has(norm)) sigCount++;
							if (suppGlobMatchedSet.has(entry.file) || suppGlobMatchedSet.has(norm)) sigCount++;
							contentScore += Math.max(0, sigCount - 1) * 3;
						} catch {}
						return {
							file: entry.file,
							// Apply graduated penalty multiplier to the final score
							// (semble_rs-inspired): uses rawPathScore (without the -100
							// pre-sort penalty) so test/doc files that enter via the
							// grep/glob-matched path get 0.3x instead of being nuked.
							// A test file with rawPathScore=2 and contentScore=5 gets
							// (2+5)*0.3 = 2.1, vs a source file with (1+3)*1 = 4.
							score: (entry.rawPathScore + contentScore) * entry.typeMultiplier,
							contentScore,
						};
					}),
				);
				const rankedTop = contentScored.sort((a, b) => b.score - a.score).map(e => e.file);
				const topSet = new Set(topCandidateFiles);
				const remaining = pathScored.filter(e => !topSet.has(e.file)).map(e => e.file);
				// Boost files found by supplementary grep or glob — grep matched
				// content keywords; glob matched a query keyword in the filename.
				// Within the boosted set, sort by the final multiplied score
				// (content + path, WITH the graduated test/doc/script type
				// penalty), then path score as tiebreaker. Using raw
				// contentScore here would bypass the 0.3x penalty — a test file
				// mentioning the identifier many times would outrank the source
				// definition file. When many files grep-match the same
				// identifier, the file that defines it (source, 1.0x) must rank
				// above files that merely reference it (test/doc, 0.3x).
				const isMatched = (f: string) => {
					const norm = f.replace(/\\/g, "/");
					return grepFileSet.has(f) || grepFileSet.has(norm) || globMatchedSet.has(f) || globMatchedSet.has(norm);
				};
				const boosted = rankedTop.filter(isMatched);
				const contentByFile = new Map(contentScored.map(e => [e.file, e]));
				const boostedSorted = pathScored
					.filter(e => boosted.includes(e.file))
					.sort((a, b) => {
						const sa = contentByFile.get(a.file)?.score ?? 0;
						const sb = contentByFile.get(b.file)?.score ?? 0;
						if (sb !== sa) return sb - sa;
						if (b.pathScore !== a.pathScore) return b.pathScore - a.pathScore;
						// Third tiebreaker: prefer plan-glob-matched files (the model's
						// deliberate filename matches) over supplementary-matched files
						// (query-derived patterns). When scores are tied, the file the
						// model specifically globbed for is more likely the target.
						const aPlan =
							planGlobMatchedSet.has(a.file) || planGlobMatchedSet.has(a.file.replace(/\\/g, "/")) ? 1 : 0;
						const bPlan =
							planGlobMatchedSet.has(b.file) || planGlobMatchedSet.has(b.file.replace(/\\/g, "/")) ? 1 : 0;
						return bPlan - aPlan;
					})
					.map(e => e.file);
				const nonBoosted = rankedTop.filter(f => !boosted.includes(f));
				allFiles = [...boostedSorted, ...nonBoosted, ...remaining];
			}
		}

		const includeSnippets = this.#session.settings.get("fastContext.snippets") ?? params.include_snippets ?? true;
		const snippetLines = Math.min(
			Math.max(
				this.#session.settings.get("fastContext.snippetLines") ??
					params.snippet_lines ??
					HINT_DEFAULT_SNIPPET_LINES,
				3,
			),
			30,
		);
		const maxResultTokens = Math.max(
			100,
			Math.min(params.max_result_tokens ?? HINT_DEFAULT_MAX_RESULT_TOKENS, 16000),
		);

		// Token-budget enforcement (callsive compact packet):
		// Cap the number of files to fit within the token budget. Each file
		// path averages ~60 chars (~15 tokens), plus overhead. We estimate
		// the overhead at ~100 tokens for the header/keywords, then allocate
		// the rest to file paths and snippets.
		const overheadTokens = 100;
		const availableTokens = maxResultTokens - overheadTokens;
		const perFileTokenEstimate = 20;
		const maxFilesByBudget = Math.max(3, Math.floor(availableTokens / perFileTokenEstimate));
		const maxFiles = Math.min(allFiles.length, maxFilesByBudget, HINT_MAX_RESULT_FILES);
		allFiles = allFiles.slice(0, maxFiles);

		const snippetFiles = includeSnippets ? allFiles.slice(0, HINT_MAX_SNIPPET_FILES) : [];
		const snippets = await this.#readSnippets(snippetFiles, grepFileSet, effectiveKeywords, snippetLines, signal);

		// If snippets push us over budget, trim from the end (lowest-ranked)
		const snippetTokens = Math.ceil(snippets.reduce((sum, s) => sum + s.text.length, 0) / 4);
		const fileTokens = Math.ceil(allFiles.reduce((sum, f) => sum + f.length + 1, 0) / 4);
		let trimmedSnippets = snippets;
		if (fileTokens + snippetTokens > availableTokens && snippets.length > 0) {
			const tokenBudgetForSnippets = availableTokens - fileTokens;
			let keptSnippetBytes = 0;
			trimmedSnippets = [];
			for (const snippet of snippets) {
				if (keptSnippetBytes + snippet.text.length > tokenBudgetForSnippets * 4) break;
				trimmedSnippets.push(snippet);
				keptSnippetBytes += snippet.text.length;
			}
		}

		// Use relative paths in result text to save tokens (callsive compact encoding)
		const relFiles = allFiles.map(f => {
			const rel = path.relative(this.#session.cwd, f).replace(/\\/g, "/");
			return rel || f;
		});
		const fallbackNote = fallbackUsed ? " (fallback)" : "";

		// Build result text, then enforce token budget on the final output
		// by iteratively dropping the last (lowest-ranked) file and snippet
		const buildResultText = (files: string[], snippets: Array<{ text: string }>) => {
			const snip = snippets.length > 0 ? `\n\n--- Snippets ---\n${snippets.map(s => s.text).join("\n\n")}` : "";
			return `[FC hint: ${files.length} files${fallbackNote}]\n\nFiles:\n${files.join("\n")}${snip}\n\n[${effectiveKeywords.join(" ")}]`;
		};
		let budgetFiles = relFiles;
		let budgetSnippets = trimmedSnippets;
		let resultText = buildResultText(budgetFiles, budgetSnippets);
		while (Math.ceil(resultText.length / 4) > maxResultTokens && budgetFiles.length > 3) {
			budgetFiles = budgetFiles.slice(0, -1);
			if (budgetSnippets.length >= budgetFiles.length) {
				budgetSnippets = budgetSnippets.slice(0, Math.max(0, budgetFiles.length - 1));
			}
			resultText = buildResultText(budgetFiles, budgetSnippets);
		}
		// Update allFiles and citations to match the budget-trimmed set
		allFiles = allFiles.slice(0, budgetFiles.length);
		const citations = allFiles.map(f => `${f}:1-1`);

		const details: FastContextToolDetails = {
			baseUrl,
			model,
			mode: "hint",
			turns: 1,
			toolCalls: effectivePlan.globs.length + effectivePlan.grep_patterns.length,
			citations,
			keywords: effectiveKeywords,
			globs: effectivePlan.globs,
			grepPatterns: effectivePlan.grep_patterns,
			grepPaths: effectivePlan.grep_paths,
			description: effectivePlan.description,
			...(citations.length === 0
				? { error: "FastContext hint returned no files; fall back to normal search/find/read." }
				: {}),
		};
		const builder = toolResult<FastContextToolDetails>(details).text(resultText);
		return (citations.length === 0 ? builder.error().useless() : builder).done();
	}

	async #readSnippets(
		files: string[],
		grepMatchedFiles: Set<string>,
		keywords: string[],
		linesPerSnippet: number,
		signal?: AbortSignal,
	): Promise<Array<{ path: string; text: string }>> {
		// Read all files in parallel, then select snippets sequentially.
		// This separates I/O (parallelizable) from budget-bound selection.
		const fileTexts = await Promise.all(
			files.map(async file => {
				try {
					return { file, text: await Bun.file(file).text() };
				} catch {
					return { file, text: null };
				}
			}),
		);
		let totalBytes = 0;
		const snippets: Array<{ path: string; text: string }> = [];
		for (const { file, text: rawText } of fileTexts) {
			if (totalBytes >= HINT_MAX_SNIPPET_BYTES) break;
			if (signal?.aborted) break;
			if (rawText === null) continue;
			const fileLines = splitFileLines(rawText);
			if (fileLines.length === 0) continue;
			let startLine = 1;
			const normalizedFile = file.replace(/\\/g, "/");
			if (grepMatchedFiles.has(file) || grepMatchedFiles.has(normalizedFile)) {
				const lowerKeywords = keywords.map(k => k.toLowerCase());
				const lowerLines = fileLines.map(l => l.toLowerCase());
				// Symbol-aware snippet selection (callsive symbol indexing):
				// Prefer snippets near symbol declarations (class, function, enum,
				// export, pub) that also contain a query keyword — these show the
				// actual definition, not just where a keyword appears.
				const symbolPattern =
					/^\s*(export\s+)?(async\s+)?(function|class|enum|interface|const|pub\s+(fn|struct|enum))\s+/i;
				let matchIdx = fileLines.findIndex(
					(line, i) => symbolPattern.test(line) && lowerKeywords.some(kw => lowerLines[i].includes(kw)),
				);
				// Fallback: any symbol declaration
				if (matchIdx < 0) matchIdx = fileLines.findIndex(line => symbolPattern.test(line));
				// Fallback: first keyword match
				if (matchIdx < 0)
					matchIdx = fileLines.findIndex(line => lowerKeywords.some(kw => line.toLowerCase().includes(kw)));
				if (matchIdx >= 0) {
					startLine = Math.max(1, matchIdx - Math.floor(linesPerSnippet / 3));
				}
			}
			const endLine = Math.min(fileLines.length, startLine + linesPerSnippet - 1);
			const snippetLines = fileLines.slice(startLine - 1, endLine);
			const body = snippetLines.map((line, i) => `${startLine + i}|${truncateLine(line)}`).join("\n");
			const relPath = path.relative(this.#session.cwd, file).replace(/\\/g, "/");
			const snippetStr = `\`\`\`${relPath}:${startLine}-${endLine}\n${body}\n\`\`\``;
			if (totalBytes + snippetStr.length > HINT_MAX_SNIPPET_BYTES) break;
			totalBytes += snippetStr.length;
			snippets.push({ path: file, text: snippetStr });
		}
		return snippets;
	}

	async #nativeGlob(pattern: string, cwd: string, signal?: AbortSignal): Promise<string[]> {
		if (!/[*?[\]{}]/.test(pattern)) {
			const direct = path.resolve(cwd, pattern);
			if (!isWithinCwd(direct, cwd)) return [];
			const stat = await fs.stat(direct).catch(() => null);
			if (stat?.isFile()) return [direct];
			if (stat?.isDirectory()) {
				try {
					const result = await glob({
						pattern: "**/*",
						path: direct,
						hidden: false,
						gitignore: true,
						maxResults: MAX_TOOL_LINES,
						sortByMtime: false,
						recursive: true,
						signal: requestSignal(signal, TOOL_TIMEOUT_MS),
						timeoutMs: TOOL_TIMEOUT_MS,
					});
					return result.matches
						.map(m => m.path)
						.filter((p): p is string => Boolean(p))
						.map(p => (path.isAbsolute(p) ? p : path.resolve(direct, p)));
				} catch {
					return [];
				}
			}
			return [];
		}
		try {
			const result = await glob({
				pattern,
				path: cwd,
				hidden: pattern.startsWith("."),
				gitignore: true,
				maxResults: MAX_TOOL_LINES,
				sortByMtime: false,
				recursive: true,
				signal: requestSignal(signal, TOOL_TIMEOUT_MS),
				timeoutMs: TOOL_TIMEOUT_MS,
			});
			const rawPaths = result.matches
				.map(m => m.path)
				.filter((p): p is string => Boolean(p))
				.map(p => (path.isAbsolute(p) ? p : path.resolve(cwd, p)));
			// Expand directory matches to their immediate file children.
			// glob can return directory paths when the pattern matches a directory
			// name (e.g. `**/*provider*` matches `provider-models/` the directory,
			// not `index.ts` inside it). Without expansion, the directory path enters
			// the candidate pool but fails silently on content read, and the barrel
			// file inside (found only by filename) is excluded from the 200-file cap.
			// Optimization: only stat paths without a file extension — directories
			// never have extensions, so this avoids 100+ stat calls per glob.
			const dirPaths = rawPaths.filter(p => !path.extname(p));
			const expanded: string[] = rawPaths.filter(p => path.extname(p));
			for (const p of dirPaths) {
				try {
					const stat = await fs.stat(p);
					if (stat.isDirectory()) {
						// Use glob (not fs.readdir) to respect gitignore and
						// hidden-file filtering — same as the direct-path branch.
						const dirResult = await glob({
							pattern: "*",
							path: p,
							hidden: pattern.startsWith("."),
							gitignore: true,
							maxResults: MAX_TOOL_LINES,
							sortByMtime: false,
							recursive: false,
							signal: requestSignal(signal, TOOL_TIMEOUT_MS),
							timeoutMs: TOOL_TIMEOUT_MS,
						});
						for (const m of dirResult.matches) {
							if (m.path) {
								expanded.push(path.isAbsolute(m.path) ? m.path : path.resolve(p, m.path));
							}
						}
					} else {
						// Extensionless file (Makefile, Dockerfile, LICENSE, etc.)
						expanded.push(p);
					}
				} catch {
					// Not a directory or unreadable — skip
				}
			}
			return expanded;
		} catch {
			return [];
		}
	}

	async #nativeGrep(pattern: string, searchPaths: string[], signal?: AbortSignal): Promise<string[]> {
		const cwd = this.#session.cwd;
		const paths = searchPaths.length > 0 ? searchPaths : ["."];
		const results = await Promise.all(
			paths.map(async sp => {
				try {
					const result = await grep(
						{
							pattern,
							path: resolveWorkspacePath(sp, cwd),
							ignoreCase: true,
							hidden: true,
							gitignore: true,
							maxCount: MAX_TOOL_LINES,
							mode: GrepOutputMode.FilesWithMatches,
							signal: requestSignal(signal, SEARCH_TIMEOUT_MS),
							timeoutMs: SEARCH_TIMEOUT_MS,
						},
						undefined,
					);
					return result.matches
						.map(m => m.path)
						.filter((p): p is string => Boolean(p))
						.map(p => formatAbsolute(p, resolveWorkspacePath(sp, cwd)));
				} catch {
					return [];
				}
			}),
		);
		return results.flat();
	}
	async #resolveBackend(apiBaseUrl: string, signal?: AbortSignal): Promise<FastContextBackend> {
		const raw = this.#session.settings.get("fastContext.model")?.trim() || "";
		// "local" sentinel = explicit local server (auto-discovers the model via
		// /v1/models). Anything else containing "/" is a provider-prefixed id that
		// routes through the registry.
		const configured = raw === "local" ? undefined : raw || undefined;

		// Registry backend: an explicit provider-prefixed model id routes through
		// the model registry via completeSimple, removing the need for a local
		// OpenAI-compatible server.
		if (configured?.includes("/")) {
			const backend = await this.#resolveRegistryBackend(configured);
			if (!backend) {
				throw new Error(
					`FastContext model "${configured}" could not be resolved against available registered ` +
						`models. Check provider credentials and model id, or set fastContext.model to a bare ` +
						`id to use the local OpenAI-compatible endpoint.`,
				);
			}
			return backend;
		}

		// Auto-default: no explicit model is set. When Devin credentials are
		// present, prefer devin/swe-1-6-fast (fast, accurate, no local server
		// needed) and persist the resolved id so the model picker and the
		// baseUrl-visibility condition reflect the effective backend. Any explicit
		// choice (including the "local" sentinel) is preserved. Falls back to the
		// local endpoint if the default model can't resolve.
		if (configured === undefined && this.#session.modelRegistry?.authStorage?.hasAuth("devin")) {
			const backend = await this.#resolveRegistryBackend("devin/swe-1-6-fast");
			if (backend) {
				try {
					this.#session.settings.set("fastContext.model", backend.modelId);
				} catch {
					// Best-effort persist: the effective default still works for this call.
				}
				return backend;
			}
		}

		// Local backend: bare model id, "local" sentinel, or unset → /chat/completions.
		return this.#resolveLocalBackend(apiBaseUrl, configured, signal);
	}

	/**
	 * Resolve a provider-prefixed model id through the registry. Returns
	 * `undefined` (rather than throwing) when the model can't be resolved or has
	 * no API key, so callers can choose between surfacing an error (an explicit
	 * model choice) and falling back to the local endpoint (the auto-default).
	 */
	async #resolveRegistryBackend(
		modelId: string,
	): Promise<Extract<FastContextBackend, { kind: "registry" }> | undefined> {
		const modelRegistry = this.#session.modelRegistry;
		if (!modelRegistry) return undefined;
		const resolveModel = (): Model<Api> | undefined => {
			const available = modelRegistry.getAvailable();
			return resolveModelFromString(
				expandRoleAlias(modelId, this.#session.settings),
				available,
				getModelMatchPreferences(this.#session.settings),
				modelRegistry,
			);
		};
		let model = resolveModel();
		if (!model) {
			// Dynamic providers (e.g. Devin) populate getAvailable() via background
			// discovery that may not have completed yet — refresh then retry once.
			await modelRegistry.refreshProvider(modelId.split("/")[0]!, "online-if-uncached");
			model = resolveModel();
		}
		if (!model) return undefined;
		const apiKey = await modelRegistry.getApiKey(model);
		if (!apiKey) return undefined;
		return { kind: "registry", model, apiKey, modelId: `${model.provider}/${model.id}` };
	}

	async #resolveLocalBackend(
		apiBaseUrl: string,
		configured: string | undefined,
		signal?: AbortSignal,
	): Promise<FastContextBackend> {
		if (configured) {
			return { kind: "local", url: apiBaseUrl, model: configured };
		}
		// Cache resolved model keyed by endpoint URL — if the user changes
		// fastContext.baseUrl mid-session, the stale model id from the old
		// server won't be sent to the new one (different servers validate
		// the model field differently).
		if (this.#resolvedBackend?.kind === "local" && this.#resolvedBackend.url === apiBaseUrl) {
			return this.#resolvedBackend;
		}
		const response = await this.#fetch(`${apiBaseUrl}/models`, {
			signal: requestSignal(signal, REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			const detail = await readResponseErrorSnippet(response);
			throw new Error(
				`FastContext model discovery failed: HTTP ${response.status} from ${apiBaseUrl}/models${detail}`,
			);
		}
		const data = (await response.json()) as ModelsResponse;
		if (data.error?.message) throw new Error(`FastContext model discovery failed: ${data.error.message}`);
		const model = data.data?.find(entry => entry.id)?.id;
		if (!model) throw new Error(`FastContext model discovery returned no models from ${apiBaseUrl}/models`);
		this.#resolvedBackend = { kind: "local", url: apiBaseUrl, model };
		return this.#resolvedBackend;
	}

	async #chat(
		backend: FastContextBackend,
		messages: ChatMessage[],
		signal?: AbortSignal,
		maxCompletionTokens: number = AGENT_TOOL_TURN_MAX_TOKENS,
		tools: readonly unknown[] | null = FAST_CONTEXT_TOOLS,
		timeoutMs: number = REQUEST_TIMEOUT_MS,
		sessionId?: string,
		temperature: number = 0.3,
	): Promise<{ message: ChatMessage; toolCalls: FastContextToolCall[] }> {
		if (backend.kind === "registry") {
			// Registry backend: route through the registered provider (e.g. Devin)
			// via completeSimple. The provider handles the wire format; we convert
			// FastContext's OpenAI-style messages/tools to/from the omp model.
			const { systemPrompt, messages: ompMessages } = fcMessagesToContext(messages);
			const ompTools =
				tools && tools.length > 0
					? fcToolsToOmpTools(tools as readonly (typeof FAST_CONTEXT_TOOLS)[number][])
					: undefined;
			const context: Context = {
				...(systemPrompt ? { systemPrompt } : {}),
				messages: ompMessages,
				...(ompTools ? { tools: ompTools } : {}),
			};
			const result = await this.#completeFn(backend.model, context, {
				apiKey: backend.apiKey,
				...(sessionId ? { sessionId } : {}),
				signal: requestSignal(signal, timeoutMs),
				maxTokens: maxCompletionTokens,
				temperature,
				disableReasoning: true,
				...(ompTools ? { toolChoice: "auto" } : {}),
			});
			if (result.errorMessage) {
				throw new Error(
					`FastContext chat failed via ${backend.modelId}: ${result.errorMessage}` +
						(result.errorStatus ? ` (HTTP ${result.errorStatus})` : ""),
				);
			}
			return assistantToFcResponse(result);
		}
		// Local backend: raw OpenAI-compatible /chat/completions (llama.cpp).
		const response = await this.#fetch(`${backend.url}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: backend.model,
				messages,
				...(tools && tools.length > 0 ? { tools, parallel_tool_calls: true } : {}),
				max_completion_tokens: maxCompletionTokens,
				temperature,
				top_p: 0.9,
				top_k: 20,
				chat_template_kwargs: { enable_thinking: false },
			}),
			signal: requestSignal(signal, timeoutMs),
		});
		if (!response.ok) {
			const detail = await readResponseErrorSnippet(response);
			throw new Error(
				`FastContext chat failed: HTTP ${response.status} from ${backend.url}/chat/completions${detail}`,
			);
		}
		const data = (await response.json()) as ChatCompletionResponse;
		if (data.error?.message) throw new Error(`FastContext chat failed: ${data.error.message}`);
		const message = data.choices?.[0]?.message;
		if (!message) throw new Error("FastContext chat returned no choices");
		const toolCalls = (message.tool_calls ?? []).filter((call): call is FastContextToolCall => {
			return Boolean(call?.id && call.function?.name && typeof call.function.arguments === "string");
		});
		return {
			message: {
				role: message.role ?? "assistant",
				content: message.content ?? null,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			},
			toolCalls,
		};
	}

	async #executeFastContextTool(call: FastContextToolCall, signal?: AbortSignal): Promise<string> {
		try {
			const name = call.function.name as FastContextToolName;
			if (name === "Read") return await this.#readFile(call.function.arguments, signal);
			if (name === "Glob") return await this.#globFiles(call.function.arguments, signal);
			if (name === "Grep") return await this.#grepFiles(call.function.arguments, signal);
			return `Tool \`${call.function.name}\` not found.`;
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
	}

	async #readFile(rawArguments: string, signal?: AbortSignal): Promise<string> {
		const args = parseArguments<ReadArguments>(rawArguments);
		if (!args.path) return "Read Tool: file path is required.";
		const filePath = resolveWorkspacePath(args.path, this.#session.cwd);
		const stat = await fs.stat(filePath).catch(() => null);
		if (!stat) return `Read Tool: file ${args.path} does not exist.`;
		if (!stat.isFile()) return `Read Tool: ${args.path} is not a file.`;
		const rawLines = splitFileLines(await Bun.file(filePath).text());
		if (rawLines.length === 0) return "File is empty.";
		const maxReadLines = this.#session.settings.get("fastContext.maxReadLines") ?? MAX_READ_LINES;
		let offset = Number.isFinite(args.offset) && (args.offset ?? 0) > 0 ? Math.floor(args.offset ?? 1) : 1;
		if (offset > rawLines.length) offset = rawLines.length;
		let endLine = rawLines.length;
		if (Number.isFinite(args.limit) && (args.limit ?? 0) > 0) {
			endLine = Math.min(rawLines.length, offset + Math.floor(args.limit ?? maxReadLines) - 1);
		}
		endLine = Math.min(endLine, offset + maxReadLines - 1);
		const lines = rawLines.slice(offset - 1, endLine);
		if (signal?.aborted) throw new Error("Read Tool: aborted.");
		return formatReadOutput(filePath, offset, endLine, lines);
	}

	async #globFiles(rawArguments: string, signal?: AbortSignal): Promise<string> {
		const args = parseArguments<GlobArguments>(rawArguments);
		if (!args.pattern?.trim()) return "Glob Tool: pattern is required.";
		const directory = resolveWorkspacePath(args.directory, this.#session.cwd);
		const stat = await fs.stat(directory).catch(() => null);
		if (!stat?.isDirectory())
			return `The directory \`${args.directory ?? directory}\` does not exist or is not a directory.`;
		const result = await glob({
			pattern: args.pattern,
			path: directory,
			hidden: args.pattern.startsWith("."),
			gitignore: true,
			maxResults: MAX_TOOL_LINES + 1,
			sortByMtime: false,
			recursive: true,
			signal: requestSignal(signal, TOOL_TIMEOUT_MS),
		});
		const matches = result.matches
			.map(match => match.path)
			.filter((entry): entry is string => Boolean(entry))
			.map(entry => formatAbsolute(entry, directory))
			.slice(0, MAX_TOOL_LINES);
		if (matches.length === 0) return "No files found";
		if (result.matches.length > MAX_TOOL_LINES) {
			matches.push(
				`Results are truncated: showing first ${MAX_TOOL_LINES} results. Consider a more specific path or pattern.`,
			);
		}
		return matches.join("\n");
	}

	async #grepFiles(rawArguments: string, signal?: AbortSignal): Promise<string> {
		const args = parseArguments<GrepArguments>(rawArguments);
		if (!args.pattern?.trim()) return "Grep Tool: pattern is required.";
		const searchPath = resolveWorkspacePath(args.path, this.#session.cwd);
		const stat = await fs.stat(searchPath).catch(() => null);
		if (!stat) return `Grep Tool: path ${args.path ?? searchPath} does not exist.`;
		const outputMode = args.output_mode ?? "files_with_matches";
		const limit = Math.max(0, Math.min(Math.floor(args.head_limit ?? MAX_TOOL_LINES), MAX_TOOL_LINES));
		if (limit === 0) return "";
		const nativeMode =
			outputMode === "files_with_matches"
				? GrepOutputMode.FilesWithMatches
				: outputMode === "count"
					? GrepOutputMode.Count
					: GrepOutputMode.Content;
		const context = Number.isFinite(args["-C"]) ? Math.max(0, Math.floor(args["-C"] ?? 0)) : undefined;
		const contextBefore = Number.isFinite(args["-B"]) ? Math.max(0, Math.floor(args["-B"] ?? 0)) : (context ?? 3);
		const contextAfter = Number.isFinite(args["-A"]) ? Math.max(0, Math.floor(args["-A"] ?? 0)) : (context ?? 3);
		const result = await grep(
			{
				pattern: args.pattern,
				path: searchPath,
				glob: args.glob,
				type: args.type,
				ignoreCase: args["-i"] ?? false,
				multiline: args.multiline ?? false,
				hidden: true,
				gitignore: true,
				maxCount: limit,
				...(nativeMode === GrepOutputMode.Content ? { contextBefore, contextAfter } : {}),
				maxColumns: MAX_LINE_LENGTH,
				mode: nativeMode,
				maxCountPerFile: nativeMode === GrepOutputMode.Content ? MAX_TOOL_LINES : undefined,
				signal: requestSignal(signal, SEARCH_TIMEOUT_MS),
				timeoutMs: SEARCH_TIMEOUT_MS,
			},
			undefined,
		);
		if (result.matches.length === 0) return "No matches found";
		if (outputMode === "files_with_matches") {
			return result.matches.map(match => formatAbsolute(match.path, searchPath)).join("\n");
		}
		if (outputMode === "count") {
			return result.matches
				.map(match => `${formatAbsolute(match.path, searchPath)}:${match.matchCount ?? 0}`)
				.join("\n");
		}
		return formatContentMatches(result.matches, searchPath, args["-n"] ?? true, limit);
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

/** Render args for fast_context (subset of {@link FastContextToolInput}). */
interface FastContextRenderArgs {
	query?: string;
	mode?: "hint" | "agent";
}

/** Cap displayed citations in collapsed mode; expanded shows all. */
const FC_COLLAPSED_CITATIONS = PREVIEW_LIMITS.COLLAPSED_ITEMS;

/**
 * Parse a `path:line` / `path:line-line` citation into the file path and an
 * optional leading line number for OSC 8 hyperlinking. The path may be
 * relative (fileHyperlink resolves it against the process cwd) or absolute.
 */
function parseCitationTarget(citation: string): { filePath: string; line?: number } {
	const colon = citation.lastIndexOf(":");
	if (colon <= 0) return { filePath: citation };
	const pathPart = citation.slice(0, colon);
	const rangePart = citation.slice(colon + 1);
	const firstNum = Number.parseInt(rangePart.split("-")[0] ?? "", 10);
	return {
		filePath: pathPart,
		line: Number.isFinite(firstNum) && firstNum > 0 ? firstNum : undefined,
	};
}

/**
 * Inline renderer for the `fast_context` tool result.
 *
 * Mirrors `findToolRenderer` (not `readToolRenderer`): fast_context returns a
 * file/citation shortlist, so the output shape is a list, not file content.
 * `inline: true` keeps the block inline (no collapsed ctrl+o window) and
 * `mergeCallAndResult: true` fuses the call + result into one card — the same
 * shape `find` uses. The citation list comes from structured
 * `FastContextToolDetails.citations`, NEVER from parsing `<final_answer>` text.
 */
export const fastContextToolRenderer = {
	inline: true,
	renderCall(args: FastContextRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const text = renderStatusLine(
			{
				icon: "pending",
				title: "FastContext",
				titleColor: "toolTitle",
				description: args.query || (args.mode ? `${args.mode} mode` : ""),
				meta: args.mode && args.mode !== "hint" ? [args.mode] : undefined,
			},
			uiTheme,
		);
		return new Text(text, 1, 0);
	},

	renderResult(
		result: {
			content: Array<{ type: string; text?: string }>;
			details?: FastContextToolDetails;
			isError?: boolean;
		},
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: FastContextRenderArgs,
	): Component {
		const details = result.details;

		// Error case: error-styled inline block.
		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 1, 0);
		}

		// Structured citations are the source of truth — do NOT parse result text.
		let citations = details?.citations ?? [];

		// Fallback only when citations are empty: pull file lines out of the
		// `[FC hint: N files]\n\nFiles:\n…` hint-mode packet, never from
		// <final_answer> text.
		if (citations.length === 0) {
			const rawText = result.content?.find(c => c.type === "text")?.text ?? "";
			citations = extractHintFileList(rawText);
		}

		const fileCount = citations.length;
		const model = details?.model ?? "fast-context";
		const mode = details?.mode ?? args?.mode ?? "hint";
		const header = renderStatusLine(
			{
				icon: fileCount > 0 ? undefined : "warning",
				iconOverride: fileCount > 0 ? uiTheme.styledSymbol("icon.fast", "accent") : undefined,
				title: "FastContext",
				titleColor: "toolTitle",
				description: `${model} · ${mode}`,
				meta: [fileCount === 1 ? "1 file" : `${fileCount} files`],
			},
			uiTheme,
		);

		if (fileCount === 0) {
			const lines = [header, uiTheme.fg("dim", "(no files found)")];
			return new Text(lines.join("\n"), 1, 0);
		}

		return createCachedComponent(
			() => options.expanded,
			width => {
				const listLines = renderTreeList(
					{
						items: citations,
						expanded: options.expanded,
						maxCollapsed: FC_COLLAPSED_CITATIONS,
						itemType: "file",
						renderItem: (citation: string) => {
							const safe = replaceTabs(citation);
							const target = parseCitationTarget(citation);
							return fileHyperlink(target.filePath, safe, target.line ? { line: target.line } : undefined);
						},
					},
					uiTheme,
				);
				return [header, ...listLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
			{ paddingX: 1 },
		);
	},
	mergeCallAndResult: true,
};

/**
 * Fallback parser for hint-mode result packets shaped
 * `[FC hint: N files]\n\nFiles:\n<path>\n<path>\n...`. Used only when
 * `details.citations` is empty (e.g. a result reconstructed without details).
 * Returns plain file paths (no line numbers); never inspects `<final_answer>`.
 */
function extractHintFileList(text: string): string[] {
	const filesMatch = text.match(/\nFiles:\n([\s\S]*?)(?:\n\n|\n---|\n\[|$)/);
	if (!filesMatch) return [];
	return filesMatch[1]
		.split("\n")
		.map(l => l.trim())
		.filter(l => l.length > 0 && !l.startsWith("["));
}
