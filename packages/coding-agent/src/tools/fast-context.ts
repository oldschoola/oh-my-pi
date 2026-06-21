import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { GrepMatch } from "@oh-my-pi/pi-natives";
import { GrepOutputMode, glob, grep } from "@oh-my-pi/pi-natives";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import fastContextDescription from "../prompts/tools/fast-context.md" with { type: "text" };
import citationRetryPrompt from "../prompts/tools/fast-context-citation-retry.md" with { type: "text" };
import finalTurnPrompt from "../prompts/tools/fast-context-final.md" with { type: "text" };
import hintSystemPrompt from "../prompts/tools/fast-context-hint-system.md" with { type: "text" };
import fastContextSystemPrompt from "../prompts/tools/fast-context-system.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
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

type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;
type ChatRole = "system" | "user" | "assistant" | "tool";
type FastContextToolName = "Read" | "Glob" | "Grep";

interface FastContextOptions {
	fetch?: FetchFunction;
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

interface FastContextToolDetails {
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
const MAX_READ_LINES = 200;
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
const MAX_WORKSPACE_LISTING = 60;
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
	const relative = path.relative(cwd, candidate);
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
	return new Set([...upperSnake, ...camelCase]);
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
	#resolvedModel: { url: string; model: string } | null = null;

	constructor(session: ToolSession, options?: FastContextOptions) {
		this.#session = session;
		this.#fetch = options?.fetch ?? fetch;
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
			const model = await this.#resolveModel(apiBaseUrl, signal);
			const mode = params.mode ?? "hint";
			return mode === "hint"
				? this.#executeHint(apiBaseUrl, model, params, signal)
				: this.#executeAgent(apiBaseUrl, model, params, signal);
		});
	}

	async #executeAgent(
		apiBaseUrl: string,
		model: string,
		params: FastContextToolInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<FastContextToolDetails>> {
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
		for (let turn = 1; turn <= maxTurns + 1; turn++) {
			const isFinalTurn = turn === maxTurns + 1;
			if (isFinalTurn) {
				messages.push({ role: "user", content: prompt.render(finalTurnPrompt) });
			}
			const response = await this.#chat(
				apiBaseUrl,
				model,
				messages,
				signal,
				isFinalTurn ? AGENT_FINAL_TURN_MAX_TOKENS : AGENT_TOOL_TURN_MAX_TOKENS,
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
						baseUrl: apiBaseUrl,
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
				finalText = response.message.content ?? "";
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
					const hintResult = await this.#executeHint(apiBaseUrl, model, params, signal);
					if ((hintResult.details?.citations ?? []).length > 0) return hintResult;
					const details: FastContextToolDetails = {
						baseUrl: apiBaseUrl,
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
					baseUrl: apiBaseUrl,
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
		const hintResult = await this.#executeHint(apiBaseUrl, model, params, signal);
		if ((hintResult.details?.citations ?? []).length > 0) return hintResult;

		finalText = `No final answer after ${maxTurns} turns; hint fallback also found no files.`;
		return toolResult<FastContextToolDetails>({
			baseUrl: apiBaseUrl,
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
		apiBaseUrl: string,
		model: string,
		params: FastContextToolInput,
		errorMsg: string,
	): AgentToolResult<FastContextToolDetails> {
		return toolResult<FastContextToolDetails>({
			baseUrl: apiBaseUrl,
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
		apiBaseUrl: string,
		model: string,
		params: FastContextToolInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<FastContextToolDetails>> {
		const workDirListing = await buildWorkspaceListing(this.#session.cwd, signal);
		const systemContent = prompt.render(hintSystemPrompt, {
			workDir: this.#session.cwd,
			workDirListing,
		});
		const response = await this.#fetch(`${apiBaseUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: systemContent },
					{ role: "user", content: params.query.trim() },
				],
				max_completion_tokens: 2048,
				temperature: 0.3,
				top_p: 0.9,
				top_k: 20,
				chat_template_kwargs: { enable_thinking: false },
			}),
			signal: requestSignal(signal, HINT_REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			const detail = await readResponseErrorSnippet(response);
			return this.#hintError(apiBaseUrl, model, params, `FastContext hint failed: HTTP ${response.status}${detail}`);
		}
		const data = (await response.json()) as ChatCompletionResponse;
		const rawText = data.choices?.[0]?.message?.content ?? "";
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
		const allSupplementaryGlobs = [...supplementaryGlobs, ...segmentGlobs];
		const allGrepCandidates = [...effectivePlan.keywords, ...queryKws]
			.filter(kw => kw.length >= 5)
			.sort(byIdentifierThenLength);
		const supplementaryGrepKws = allGrepCandidates.slice(0, 2);

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

		let grepFileSet = new Set(grepResults.flat());
		const globMatchedSet = new Set<string>();
		let allFiles = [...new Set([...globResults.flat(), ...grepResults.flat()])].slice(0, MAX_TOOL_LINES);
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
			allFiles = [...new Set([...suppGlobFiles, ...suppGrepFiles, ...allFiles])].slice(0, 200);
			for (const f of suppGrepFiles) grepFileSet.add(f);
			for (const f of suppGlobFiles) globMatchedSet.add(f);
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
					const isScript = /\/scripts\//.test(normalizedPath);
					// Scripts get a mild penalty (-1): utility/benchmark scripts are
					// often noise, but legitimate script targets (e.g. generate-models.ts
					// with 4 path keyword matches) still rank well.
					const typePenalty = isTest || isDoc || isInfra ? -100 : isScript ? -1 : 0;
					return { file: f, pathScore: pathMatches + typePenalty };
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
							const lower = (await blob.text()).toLowerCase();
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
							// Definition-site boost (semble_rs-inspired): files that
							// DEFINE the queried identifier outrank files that merely
							// reference it. When a query mentions "FastContext tool
							// class" or "GrepOutputMode enum", the file containing
							// `class FastContextTool` or `enum GrepOutputMode` is the
							// definition site. Boost is large (+8) because definition
							// files often have fewer keyword mentions than files that
							// merely reference the identifier many times.
							if (identifierSet.size > 0) {
								const defKeywords =
									"(?:export\\s+)?(?:async\\s+)?(?:function|class|enum|interface|const|struct|pub\\s+(?:fn|struct|enum))";
								for (const id of identifierSet) {
									const defPattern = new RegExp(
										`${defKeywords}\\s+[a-z_]*${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
										"i",
									);
									if (defPattern.test(lower)) {
										contentScore += 8;
										break;
									}
								}
							}
						} catch {}
						return {
							file: entry.file,
							score: entry.pathScore + contentScore,
							contentScore,
						};
					}),
				);
				const rankedTop = contentScored.sort((a, b) => b.score - a.score).map(e => e.file);
				const topSet = new Set(topCandidateFiles);
				const remaining = pathScored.filter(e => !topSet.has(e.file)).map(e => e.file);
				// Boost files found by supplementary grep or glob — grep matched
				// content keywords; glob matched a query keyword in the filename.
				// Within the boosted set, sort by content score (identifier-weighted)
				// then path score as tiebreaker. When 275 files all grep-match the
				// same identifier, the file that defines it should rank above files
				// that merely reference it.
				const isMatched = (f: string) => {
					const norm = f.replace(/\\/g, "/");
					return grepFileSet.has(f) || grepFileSet.has(norm) || globMatchedSet.has(f) || globMatchedSet.has(norm);
				};
				const boosted = rankedTop.filter(isMatched);
				const contentByFile = new Map(contentScored.map(e => [e.file, e]));
				const boostedSorted = pathScored
					.filter(e => boosted.includes(e.file))
					.sort((a, b) => {
						const ca = contentByFile.get(a.file)?.contentScore ?? 0;
						const cb = contentByFile.get(b.file)?.contentScore ?? 0;
						return cb - ca || b.pathScore - a.pathScore;
					})
					.map(e => e.file);
				const nonBoosted = rankedTop.filter(f => !boosted.includes(f));
				allFiles = [...boostedSorted, ...nonBoosted, ...remaining];
			}
		}

		const includeSnippets = params.include_snippets ?? true;
		const snippetLines = Math.min(Math.max(params.snippet_lines ?? HINT_DEFAULT_SNIPPET_LINES, 3), 30);
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
			baseUrl: apiBaseUrl,
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
			return result.matches
				.map(m => m.path)
				.filter((p): p is string => Boolean(p))
				.map(p => (path.isAbsolute(p) ? p : path.resolve(cwd, p)));
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
	async #resolveModel(apiBaseUrl: string, signal?: AbortSignal): Promise<string> {
		const configured = this.#session.settings.get("fastContext.model")?.trim();
		if (configured) return configured;
		// Cache resolved model keyed by endpoint URL — if the user changes
		// fastContext.baseUrl mid-session, the stale model id from the old
		// server won't be sent to the new one (different servers validate
		// the model field differently).
		if (this.#resolvedModel?.url === apiBaseUrl) return this.#resolvedModel.model;
		const response = await this.#fetch(`${apiBaseUrl}/models`, { signal: requestSignal(signal, REQUEST_TIMEOUT_MS) });
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
		this.#resolvedModel = { url: apiBaseUrl, model };
		return model;
	}

	async #chat(
		apiBaseUrl: string,
		model: string,
		messages: ChatMessage[],
		signal?: AbortSignal,
		maxCompletionTokens: number = AGENT_TOOL_TURN_MAX_TOKENS,
	): Promise<{ message: ChatMessage; toolCalls: FastContextToolCall[] }> {
		const response = await this.#fetch(`${apiBaseUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages,
				tools: FAST_CONTEXT_TOOLS,
				parallel_tool_calls: true,
				max_completion_tokens: maxCompletionTokens,
				temperature: 0.3,
				top_p: 0.9,
				top_k: 20,
				chat_template_kwargs: { enable_thinking: false },
			}),
			signal: requestSignal(signal, REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			const detail = await readResponseErrorSnippet(response);
			throw new Error(
				`FastContext chat failed: HTTP ${response.status} from ${apiBaseUrl}/chat/completions${detail}`,
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
		let offset = Number.isFinite(args.offset) && (args.offset ?? 0) > 0 ? Math.floor(args.offset ?? 1) : 1;
		if (offset > rawLines.length) offset = rawLines.length;
		let endLine = rawLines.length;
		if (Number.isFinite(args.limit) && (args.limit ?? 0) > 0) {
			endLine = Math.min(rawLines.length, offset + Math.floor(args.limit ?? MAX_READ_LINES) - 1);
		}
		endLine = Math.min(endLine, offset + MAX_READ_LINES - 1);
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
