/**
 * FastContext retrieval-quality benchmark.
 *
 * Runs the REAL FastContext hint pipeline (FastContextTool.execute, hint mode)
 * against the omp-dev repo with the local LLM mocked to return a FIXED plan per
 * query. The ranking / glob / grep / snippet pipeline is fully deterministic
 * given a fixed repo state, so the metrics are reproducible with no network.
 *
 * Primary metric: mean_reciprocal_rank (MRR) of the ground-truth definition
 * file. Higher = the right file floats to the top = the agent trusts FC and
 * skips manual read/search/find. Scope-mixing (test/doc/changelog files leaking
 * above the definition) is the dominant failure mode this exercises.
 *
 * Secondary: hit_at_5, snippet_eligible (GT in top-15 → gets a snippet),
 * noise_ratio_top10, avg_packet_tokens, hint_pipeline_ms.
 *
 * Run from repo root: bun packages/coding-agent/scripts/bench-fast-context.ts
 */
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { FastContextTool } from "@oh-my-pi/pi-coding-agent/tools";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const REPO = path.resolve(import.meta.dir, "../../..");

interface Plan {
	keywords: string[];
	globs: string[];
	grep_patterns: string[];
	grep_paths: string[];
	description: string;
}

interface Case {
	query: string;
	/** Mocked LLM hint plan — a realistic query expansion. */
	plan: Plan;
	/** Repo-relative ground-truth definition file(s) the agent needs. */
	gt: string[];
}

// Realistic cross-package retrieval queries. Plans mimic a competent FC model;
// the ranking challenge comes from grep/glob noise (tests, docs, CHANGELOG,
// unrelated same-keyword files across packages), not from a bad plan.
const SUITE: Case[] = [
	{
		query: "where is the fast context hint ranking and snippet selection logic",
		gt: ["packages/coding-agent/src/tools/fast-context.ts"],
		plan: {
			keywords: ["fastcontext", "snippet", "ranking", "hint"],
			globs: ["**/*fast-context*"],
			grep_patterns: ["readSnippets", "executeHint"],
			grep_paths: ["packages/coding-agent"],
			description: "FastContext ranking + snippets",
		},
	},
	{
		query: "how does the coding agent declare the worker host entry and dispatch workers",
		gt: ["packages/coding-agent/src/cli.ts", "packages/utils/src/worker-host.ts"],
		plan: {
			keywords: ["worker", "declareWorkerHostEntry", "dispatch"],
			globs: ["**/cli.ts", "**/*worker-host*"],
			grep_patterns: ["declareWorkerHostEntry", "__omp_worker"],
			grep_paths: ["packages"],
			description: "Worker host entry + dispatch",
		},
	},
	{
		query: "find the model identity family and version classification",
		gt: ["packages/catalog/src/identity/classify.ts"],
		plan: {
			keywords: ["classify", "identity", "family", "version"],
			globs: ["**/identity/**", "**/*classify*"],
			grep_patterns: ["classify", "family"],
			grep_paths: ["packages/catalog"],
			description: "Model identity classification",
		},
	},
	{
		query: "where is the agent main loop that calls tools and manages state",
		gt: ["packages/agent/src/agent-loop.ts"],
		plan: {
			keywords: ["agent", "loop", "tool", "state"],
			globs: ["**/agent-loop*", "**/*agent*"],
			grep_patterns: ["agentLoop", "tool"],
			grep_paths: ["packages/agent"],
			description: "Agent loop + tool calls",
		},
	},
	{
		query: "how are settings isolated and overridden per session",
		gt: ["packages/coding-agent/src/config/settings.ts"],
		plan: {
			keywords: ["settings", "isolated", "override"],
			globs: ["**/config/settings.ts"],
			grep_patterns: ["isolated", "override"],
			grep_paths: ["packages/coding-agent"],
			description: "Settings isolation + override",
		},
	},
	{
		query: "where is the commit changelog finalization and version bump",
		gt: ["packages/coding-agent/src/commit/changelog/index.ts"],
		plan: {
			keywords: ["changelog", "commit", "version", "release"],
			globs: ["**/changelog/**", "**/*changelog*"],
			grep_patterns: ["changelog", "finalize"],
			grep_paths: ["packages/coding-agent"],
			description: "Changelog finalization",
		},
	},
	{
		query: "how is tool output sanitized and truncated for terminal rendering",
		gt: ["packages/coding-agent/src/tools/render-utils.ts"],
		plan: {
			keywords: ["sanitize", "truncate", "render", "tabs"],
			globs: ["**/*render-utils*"],
			grep_patterns: ["replaceTabs", "truncateToWidth"],
			grep_paths: ["packages/coding-agent"],
			description: "Tool render sanitization",
		},
	},
	{
		query: "find the subprocess worker client that spawns and communicates with workers",
		gt: ["packages/coding-agent/src/subprocess/worker-client.ts"],
		plan: {
			keywords: ["worker", "client", "subprocess", "spawn"],
			globs: ["**/subprocess/**", "**/*worker-client*"],
			grep_patterns: ["WorkerClient", "subprocess"],
			grep_paths: ["packages/coding-agent"],
			description: "Subprocess worker client",
		},
	},
	{
		query: "where is the generated model thinking metadata and policy application",
		gt: ["packages/catalog/src/model-thinking.ts", "packages/catalog/scripts/generated-policies.ts"],
		plan: {
			keywords: ["thinking", "model", "policy", "generated"],
			globs: ["**/*model-thinking*"],
			grep_patterns: ["applyGeneratedModelPolicies", "thinking"],
			grep_paths: ["packages/catalog"],
			description: "Model thinking metadata",
		},
	},
	{
		query: "find the catalog provider descriptors and discovery factory",
		gt: ["packages/catalog/src/provider-models/descriptors.ts"],
		plan: {
			keywords: ["provider", "descriptor", "catalog", "discovery"],
			globs: ["**/provider-models/**", "**/*descriptor*"],
			grep_patterns: ["CATALOG_PROVIDERS", "descriptor"],
			grep_paths: ["packages/catalog"],
			description: "Provider descriptors",
		},
	},
	{
		query: "where is the MCP server transport and tool registration",
		gt: ["packages/coding-agent/src/mcp/manager.ts", "packages/coding-agent/src/mcp/tool-bridge.ts"],
		plan: {
			keywords: ["mcp", "transport", "tool", "register"],
			globs: ["**/mcp/**"],
			grep_patterns: ["mcp", "transport"],
			grep_paths: ["packages/coding-agent"],
			description: "MCP transport + tools",
		},
	},
	{
		query: "how is the LSP client manager initialized and requests handled",
		gt: ["packages/coding-agent/src/lsp/index.ts"],
		plan: {
			keywords: ["lsp", "client", "request", "symbol"],
			globs: ["**/lsp/**"],
			grep_patterns: ["lsp", "codeActions"],
			grep_paths: ["packages/coding-agent"],
			description: "LSP client manager",
		},
	},
	{
		query: "where is the task subagent spawn and parallel dispatch",
		gt: ["packages/coding-agent/src/task/index.ts"],
		plan: {
			keywords: ["task", "subagent", "spawn", "parallel"],
			globs: ["**/task/**"],
			grep_patterns: ["spawn", "subagent"],
			grep_paths: ["packages/coding-agent"],
			description: "Task subagent dispatch",
		},
	},
	{
		query: "find the tool result builder that constructs read approval results",
		gt: ["packages/coding-agent/src/tools/tool-result.ts"],
		plan: {
			keywords: ["tool", "result", "builder", "approval"],
			globs: ["**/*tool-result*"],
			grep_patterns: ["toolResult", "approval"],
			grep_paths: ["packages/coding-agent"],
			description: "Tool result builder",
		},
	},
	{
		query: "where is the fast context tool renderer that displays citations inline",
		gt: ["packages/coding-agent/src/tools/fast-context.ts"],
		plan: {
			keywords: ["fastcontext", "renderer", "citation", "inline"],
			globs: ["**/*fast-context*"],
			grep_patterns: ["fastContextToolRenderer", "parseCitationTarget"],
			grep_paths: ["packages/coding-agent"],
			description: "FastContext TUI renderer",
		},
	},
	{
		query: "how is streaming output truncated and buffered for display",
		gt: ["packages/coding-agent/src/session/streaming-output.ts"],
		plan: {
			keywords: ["streaming", "output", "truncated", "buffered"],
			globs: ["**/*streaming-output*"],
			grep_patterns: ["truncateTail", "TailBuffer"],
			grep_paths: ["packages/coding-agent"],
			description: "Streaming output truncation",
		},
	},
	{
		query: "find the temporary file and directory utility helpers",
		gt: ["packages/utils/src/temp.ts"],
		plan: {
			keywords: ["temporary", "file", "directory", "utility"],
			globs: ["**/utils/**", "**/*temp*"],
			grep_patterns: ["TempDir", "temp"],
			grep_paths: ["packages/utils"],
			description: "Temp file utilities",
		},
	},
	{
		query: "where is the git status parsing and porcelain diff handling",
		gt: ["packages/coding-agent/src/utils/git.ts"],
		plan: {
			keywords: ["git", "status", "parsing", "porcelain"],
			globs: ["**/utils/git.ts"],
			grep_patterns: ["porcelain", "gitStatus"],
			grep_paths: ["packages/coding-agent"],
			description: "Git status parsing",
		},
	},
	{
		query: "where is the conversation message type and context structure definition",
		gt: ["packages/agent/src/types.ts", "packages/ai/src/types.ts"],
		plan: {
			keywords: ["message", "type", "context", "structure"],
			globs: ["**/agent/types.ts"],
			grep_patterns: ["Message", "Context"],
			grep_paths: ["packages/agent"],
			description: "Message types",
		},
	},
	{
		query: "where is the logger setup and log file rotation",
		gt: ["packages/utils/src/logger.ts"],
		plan: {
			keywords: ["logger", "setup", "log", "rotation"],
			globs: ["**/utils/logger.ts"],
			grep_patterns: ["logger", "rotation"],
			grep_paths: ["packages/utils"],
			description: "Logger setup",
		},
	},
	{
		query: "how is the conversation context assembled and message history tracked",
		gt: ["packages/coding-agent/src/session/session-context.ts"],
		plan: {
			keywords: ["context", "assembled", "message", "history"],
			globs: ["**/*session-context*"],
			grep_patterns: ["sessionContext", "context"],
			grep_paths: ["packages/coding-agent"],
			description: "Session context",
		},
	},
	{
		query: "where is the tool output metadata and content type structure",
		gt: ["packages/coding-agent/src/tools/output-meta.ts"],
		plan: {
			keywords: ["tool", "output", "metadata", "content"],
			globs: ["**/*output-meta*"],
			grep_patterns: ["outputMeta", "ToolContent"],
			grep_paths: ["packages/coding-agent"],
			description: "Output metadata",
		},
	},
];
// Messy query variants — test robustness to typos, fragments, pronouns, multi-intent.
// These reuse existing GTs but with degraded query quality.
const MESSY: Case[] = [
	{
		query: "fastcontext snipet rankng",
		gt: ["packages/coding-agent/src/tools/fast-context.ts"],
		plan: {
			keywords: ["fastcontext", "snippet", "ranking", "hint"],
			globs: ["**/*fast-context*"],
			grep_patterns: ["readSnippets", "executeHint"],
			grep_paths: ["packages/coding-agent"],
			description: "FC ranking + snippets (typo query)",
		},
	},
	{
		query: "the thing that handles temp files and dirs",
		gt: ["packages/utils/src/temp.ts"],
		plan: {
			keywords: ["temporary", "file", "directory", "utility", "helpers"],
			globs: ["**/utils/**", "**/*temp*"],
			grep_patterns: ["TempDir", "temp"],
			grep_paths: ["packages/utils"],
			description: "Temp file utilities (pronoun query)",
		},
	},
	{
		query: "how does settings work and where do i change the commit log",
		gt: ["packages/coding-agent/src/config/settings.ts", "packages/coding-agent/src/commit/changelog/index.ts"],
		plan: {
			keywords: ["settings", "commit", "changelog", "config"],
			globs: ["**/config/settings.ts", "**/changelog/**"],
			grep_patterns: ["settings", "changelog"],
			grep_paths: ["packages/coding-agent"],
			description: "Settings + changelog (multi-intent query)",
		},
	},
	{
		query: "logger",
		gt: ["packages/utils/src/logger.ts"],
		plan: {
			keywords: ["logger", "log", "rotation", "setup"],
			globs: ["**/utils/logger.ts"],
			grep_patterns: ["logger", "rotation"],
			grep_paths: ["packages/utils"],
			description: "Logger setup (fragment query)",
		},
	},
	{
		query: "fix the mcp transport its broken",
		gt: ["packages/coding-agent/src/mcp/manager.ts", "packages/coding-agent/src/mcp/tool-bridge.ts"],
		plan: {
			keywords: ["mcp", "transport", "tool", "register"],
			globs: ["**/mcp/**"],
			grep_patterns: ["mcp", "transport"],
			grep_paths: ["packages/coding-agent"],
			description: "MCP transport + tools (bug-report query)",
		},
	},
];
const ALL_SUITE = [...SUITE, ...MESSY];

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "fastContext.enabled": true, "fastContext.baseUrl": "http://127.0.0.1:8080" }),
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

function mockFetch(plan: Plan) {
	return async (url: string): Promise<Response> => {
		if (url === "http://127.0.0.1:8080/v1/models")
			return Response.json({ data: [{ id: "FastContext-1.0-4B-RL-Q4_K_M" }] });
		if (url === "http://127.0.0.1:8080/v1/chat/completions")
			return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] });
		return new Response("not found", { status: 404 });
	};
}

const NOISE_RE = /(^|\/)(test|tests|__tests__|docs?|scripts|\.github|infra|CHANGELOG|README|DEVELOPMENT|AGENTS)\b|\.test\.|\.spec\.|\.md$/i;

function rel(absPath: string): string {
	return path.relative(REPO, absPath).replace(/\\/g, "/");
}

function normalize(p: string): string {
	return p.replace(/\\/g, "/");
}

const session = makeSession(REPO);
let rrSum = 0;
let hit5 = 0;
let snippetEligible = 0;
let noiseCount = 0;
let noiseDenom = 0;
let tokenSum = 0;
let msSum = 0;
// Microsoft-style file-level F1 metrics (from run_score.py / utils.py)
let filePrecisionSum = 0;
let fileRecallSum = 0;
let fileF1Sum = 0;
// Plan quality: do plan globs/greps/keywords match GT files?
let planGlobHitSum = 0; // % of GT files found by plan globs
let planGrepHitSum = 0; // % of GT files found by plan greps
// Snippet quality: do snippets contain GT file content?
let snippetGtHitSum = 0;
// Citation format: are output citations well-formed (file:line-range)?
let citationFormatValidSum = 0;
const perCase: string[] = [];

const CITE_RE = /^[^\s]+:\d+-\d+/;

for (const c of ALL_SUITE) {
	const tool = new FastContextTool(session, { fetch: mockFetch(c.plan) });
	const start = performance.now();
	const result = await tool.execute("bench", {
		query: c.query,
		include_snippets: true,
		snippet_lines: 10,
	});
	const ms = performance.now() - start;
	msSum += ms;
	const cites = (result.details?.citations ?? []).map(x => rel(x.replace(/:\d+-\d+.*$/, "")));
	const gtNorm = c.gt.map(normalize);
	// rank of first GT file in citations (1-indexed)
	let rank = 0;
	for (let i = 0; i < cites.length; i++) {
		if (gtNorm.some(g => cites[i] === g || cites[i].endsWith("/" + g) || g.endsWith("/" + cites[i]))) {
			rank = i + 1;
			break;
		}
	}
	const rr = rank > 0 ? 1 / rank : 0;
	rrSum += rr;
	if (rank > 0 && rank <= 5) hit5++;
	if (rank > 0 && rank <= 15) snippetEligible++;
	const top10 = cites.slice(0, 10);
	noiseCount += top10.filter(f => NOISE_RE.test(f)).length;
	noiseDenom += top10.length;
	const text = result.content.find(cc => cc.type === "text");
	const textStr = text?.type === "text" ? text.text : "";
	tokenSum += Math.ceil(textStr.length / 4);

	// --- Microsoft-style file-level F1 (from calculate_score_file) ---
	const predFiles = new Set(cites.map(normalize));
	const trueFiles = new Set(gtNorm);
	const overlap = [...trueFiles].filter(f => predFiles.has(f) || [...predFiles].some(p => p.endsWith("/" + f) || f.endsWith("/" + p)));
	const precision = predFiles.size > 0 ? overlap.length / predFiles.size : 0;
	const recall = trueFiles.size > 0 ? overlap.length / trueFiles.size : 0;
	const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
	filePrecisionSum += precision;
	fileRecallSum += recall;
	fileF1Sum += f1;

	// --- Plan quality: do plan globs/greps find GT files? ---
	// Simulate glob matching: check if GT file path matches any plan glob pattern
	const globHits = c.gt.filter(gt => {
		const gtRel = normalize(gt);
		return c.plan.globs.some(g => {
			// Simple glob-to-path check: **/*foo* matches any path containing foo
			const pattern = g.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".");
			return new RegExp(pattern).test(gtRel);
		});
	});
	planGlobHitSum += c.gt.length > 0 ? globHits.length / c.gt.length : 0;
	// Check if plan grep_patterns appear in GT file content (simulated)
	// We can't read files here, so we check if the pattern matches the GT filename
	const grepHits = c.gt.filter(gt => {
		const gtLower = normalize(gt).toLowerCase();
		return c.plan.grep_patterns.some(p => p.toLowerCase().includes(gtLower.split("/").pop()!.split(".")[0]) || gtLower.includes(p.toLowerCase()));
	});
	planGrepHitSum += c.gt.length > 0 ? grepHits.length / c.gt.length : 0;

	// --- Snippet quality: do snippets contain GT file paths? ---
	const snippetText = textStr.includes("--- Snippets ---") ? textStr.split("--- Snippets ---")[1] : "";
	const snippetHasGt = c.gt.some(gt => {
		const gtRel = normalize(gt);
		return snippetText.includes(gtRel) || snippetText.includes(path.basename(gt));
	});
	snippetGtHitSum += snippetHasGt ? 1 : 0;

	// --- Citation format validation ---
	const rawCites = result.details?.citations ?? [];
	const allValid = rawCites.length > 0 && rawCites.every(c => CITE_RE.test(c));
	citationFormatValidSum += allValid ? 1 : 0;

	perCase.push(
		`  ${rank > 0 ? "#" + rank : "MISS"} (rr=${rr.toFixed(2)}) (F1=${f1.toFixed(2)}) ${c.query.slice(0, 42)}  →  ${cites.slice(0, 3).join(", ")}`,
	);
}

const n = ALL_SUITE.length;
const mrr = rrSum / n;
const hitAt5 = hit5 / n;
const snippetElig = snippetEligible / n;
const noiseRatio = noiseDenom > 0 ? noiseCount / noiseDenom : 0;
const avgTokens = tokenSum / n;
const avgMs = msSum / n;
const filePrecision = filePrecisionSum / n;
const fileRecall = fileRecallSum / n;
const fileF1 = fileF1Sum / n;
const planGlobHit = planGlobHitSum / n;
const planGrepHit = planGrepHitSum / n;
const snippetGtHit = snippetGtHitSum / n;
const citationFormatValid = citationFormatValidSum / n;

if (process.env.FC_BENCH_VERBOSE) {
	console.log(perCase.join("\n"));
	console.log("");
}
console.log(`METRIC mean_reciprocal_rank=${mrr.toFixed(4)}`);
console.log(`METRIC hit_at_5=${hitAt5.toFixed(4)}`);
console.log(`METRIC snippet_eligible=${snippetElig.toFixed(4)}`);
console.log(`METRIC noise_ratio_top10=${noiseRatio.toFixed(4)}`);
console.log(`METRIC avg_packet_tokens=${avgTokens.toFixed(0)}`);
console.log(`METRIC hint_pipeline_ms=${avgMs.toFixed(0)}`);
// Microsoft-style metrics (from arxiv 2606.14066, run_score.py)
console.log(`METRIC file_precision=${filePrecision.toFixed(4)}`);
console.log(`METRIC file_recall=${fileRecall.toFixed(4)}`);
console.log(`METRIC file_f1=${fileF1.toFixed(4)}`);
// Plan quality metrics
console.log(`METRIC plan_glob_hit_rate=${planGlobHit.toFixed(4)}`);
console.log(`METRIC plan_grep_hit_rate=${planGrepHit.toFixed(4)}`);
// Snippet quality
console.log(`METRIC snippet_gt_coverage=${snippetGtHit.toFixed(4)}`);
// Citation format validation
console.log(`METRIC citation_format_valid=${citationFormatValid.toFixed(4)}`);
