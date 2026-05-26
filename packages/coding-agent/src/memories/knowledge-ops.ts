/**
 * Knowledge operations layer.
 *
 * Pure data layer exposing the seven knowledge operations
 * against the four-bucket memory taxonomy. The `tools/knowledge.ts`
 * wrappers turn these into AgentTool implementations; tests drive them
 * directly.
 *
 * All ops accept a `memoryRoot` (the absolute path returned by
 * `getMemoryRoot`) and a type-prefixed path of the form
 * `<type>/<rest>` where `<type>` is one of memory|skill|design|reference.
 *
 *   - Document paths end in `.md`.
 *   - Directory paths do not.
 *   - The type prefix is mandatory.
 *   - `..` segments are rejected.
 *
 * Writes flow through the `directory-config` permission gates and the
 * `document` body-marker contract:
 *
 *   - `readOnly: true` is the hard refusal (reference/ default).
 *   - `aiMaintained: false` is routing-only: the resolved config surfaces
 *     `requiresApproval: true` and mutating ops route through an optional
 *     `approvalSink` so the user can review the proposed change.
 *   - Body-markerless docs are always treated as user-authored; `edit` is
 *     refused regardless of approval.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import {
	checkDeletePermission,
	checkWritePermission,
	type EffectiveDirectoryConfig,
	isSidecarPath,
	renameDirectoryWithSidecar,
	resolveDirectoryConfig,
	resolveDocConfig,
	sidecarPathForDirectory,
	TYPE_DIRS,
} from "./directory-config";
import {
	buildMemoryDoc,
	defaultMaintenanceRulesForType,
	defaultSummaryEnabledForType,
	deriveDocId,
	type InjectMode,
	type MemoryDoc,
	type MemoryDocFrontmatter,
	type MemoryDocType,
	parseMemoryDoc,
	rewriteDocBody,
	validateMemoryDoc,
} from "./document";

const KNOWN_TYPES = Object.keys(TYPE_DIRS) as MemoryDocType[];

/** Resolved type-prefixed path. */
export interface ResolvedKnowledgePath {
	type: MemoryDocType;
	/** Absolute filesystem path under `memoryRoot/<typeRoot>/`. */
	absPath: string;
	/** Path relative to the type root (no `.md` stripped). */
	relFromTypeRoot: string;
	/** The original normalized type-prefixed path (e.g. `memory/foo.md`). */
	canonical: string;
}

export class KnowledgeOpsError extends Error {
	constructor(
		readonly code: KnowledgeOpsErrorCode,
		message: string,
	) {
		super(message);
		this.name = "KnowledgeOpsError";
	}
}

export type KnowledgeOpsErrorCode =
	| "invalid_path"
	| "not_found"
	| "already_exists"
	| "permission_denied"
	| "kind_mismatch"
	| "type_change"
	| "io_error";

// ────────────────────────────────────────────────────────────────────
// approval sink
// ────────────────────────────────────────────────────────────────────

/** Summary of a proposed knowledge mutation, surfaced to the user for approval. */
export interface KnowledgeApprovalPreview {
	kind: "create" | "edit" | "move" | "delete";
	/** Type-prefixed canonical source path. */
	path: string;
	/** Type-prefixed canonical destination path. Set only for `move`. */
	destPath?: string;
	type: MemoryDocType;
	entryKind: "document" | "directory";
	/** Doc title when known. */
	title?: string;
	/** New or current summary when relevant. */
	summary?: string;
	/** Excerpt of the new/proposed body when relevant. */
	bodyPreview?: string;
}

/**
 * Approval request handed to the sink. The sink decides when (and whether)
 * to call `apply()`. Returning without calling `apply()` is interpreted as
 * "deferred to user" — the caller reports `applied: false`.
 */
export interface KnowledgeApprovalRequest {
	preview: KnowledgeApprovalPreview;
	/** Performs the underlying write. Throws if the underlying op fails. */
	apply(): Promise<void>;
}

/**
 * User-approval callback. Tools that wire up `queueResolveHandler` pass a
 * sink that queues the preview and calls `apply()` on the user's `resolve`
 * invocation. Tests pass a synchronous auto-accept (`req => req.apply()`).
 */
export type KnowledgeApprovalSink = (request: KnowledgeApprovalRequest) => Promise<void>;

export interface KnowledgeOpOptions {
	approvalSink?: KnowledgeApprovalSink;
}

export interface KnowledgeOpOutcome {
	/** `true` when the write actually ran (synchronously inside this call). */
	applied: boolean;
	/** `true` when the op was routed through an approval sink. */
	requiredApproval: boolean;
}

/**
 * Validate and resolve a type-prefixed path against `memoryRoot`.
 *
 * `kind` controls whether `.md` is required ("document"), forbidden
 * ("directory"), or either ("any"). Returns the resolved location even
 * when the target does not exist.
 */
export function resolveKnowledgePath(
	memoryRoot: string,
	pathInput: string,
	kind: "document" | "directory" | "any",
): ResolvedKnowledgePath {
	if (typeof pathInput !== "string" || pathInput.length === 0) {
		throw new KnowledgeOpsError("invalid_path", "Knowledge path is required");
	}
	const normalized = pathInput
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (!normalized) {
		throw new KnowledgeOpsError("invalid_path", "Knowledge path is required");
	}
	if (normalized.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
		throw new KnowledgeOpsError("invalid_path", `Knowledge path may not contain '.' or '..' segments: ${pathInput}`);
	}
	const [rawType, ...rest] = normalized.split("/");
	const type = rawType as MemoryDocType;
	if (!KNOWN_TYPES.includes(type)) {
		throw new KnowledgeOpsError(
			"invalid_path",
			`Unknown knowledge type "${rawType}". Expected one of: ${KNOWN_TYPES.join(", ")}`,
		);
	}
	const relFromTypeRoot = rest.join("/");
	const hasMdSuffix = /\.md$/i.test(relFromTypeRoot);
	if (kind === "document" && !hasMdSuffix) {
		throw new KnowledgeOpsError("invalid_path", `Document paths must end with .md: ${pathInput}`);
	}
	if (kind === "directory" && hasMdSuffix) {
		throw new KnowledgeOpsError("invalid_path", `Directory paths must not end with .md: ${pathInput}`);
	}
	if (kind === "document" && relFromTypeRoot === "") {
		throw new KnowledgeOpsError("invalid_path", `Document path is missing a filename: ${pathInput}`);
	}
	if (relFromTypeRoot.split("/").some(seg => isSidecarPath(seg))) {
		throw new KnowledgeOpsError("invalid_path", `.omp-meta sidecars are not knowledge documents: ${pathInput}`);
	}
	const typeRoot = path.join(memoryRoot, TYPE_DIRS[type]);
	const absPath = relFromTypeRoot ? path.join(typeRoot, ...relFromTypeRoot.split("/")) : typeRoot;
	// Defense in depth: the assembled path must stay under the type root.
	const rel = path.relative(typeRoot, absPath);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new KnowledgeOpsError("invalid_path", `Knowledge path escapes type root: ${pathInput}`);
	}
	return { type, absPath, relFromTypeRoot, canonical: normalized };
}

// ────────────────────────────────────────────────────────────────────
// list
// ────────────────────────────────────────────────────────────────────

export interface KnowledgeListEntry {
	/** Type-prefixed canonical path. */
	path: string;
	kind: "document" | "directory";
	type: MemoryDocType;
}

/**
 * List documents and child directories beneath an optional type-prefixed
 * directory prefix. Omit `pathPrefix` to list across every type root.
 *
 * Output is sorted by canonical path. Sidecars are filtered; the `_drafts`
 * machinery under `design/` is surfaced as ordinary entries.
 */
export async function knowledgeList(memoryRoot: string, pathPrefix?: string): Promise<KnowledgeListEntry[]> {
	const targets: Array<{ type: MemoryDocType; root: string; rel: string }> = [];
	if (pathPrefix && pathPrefix.trim() !== "") {
		const resolved = resolveKnowledgePath(memoryRoot, pathPrefix, "directory");
		targets.push({
			type: resolved.type,
			root: path.join(memoryRoot, TYPE_DIRS[resolved.type]),
			rel: resolved.relFromTypeRoot,
		});
	} else {
		for (const type of KNOWN_TYPES) {
			targets.push({ type, root: path.join(memoryRoot, TYPE_DIRS[type]), rel: "" });
		}
	}
	const entries: KnowledgeListEntry[] = [];
	for (const target of targets) {
		const startDir = target.rel ? path.join(target.root, ...target.rel.split("/")) : target.root;
		await walkInto(startDir, target.root, target.type, entries);
	}
	entries.sort((a, b) => a.path.localeCompare(b.path));
	return entries;
}

async function walkInto(dir: string, typeRoot: string, type: MemoryDocType, out: KnowledgeListEntry[]): Promise<void> {
	const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(error => {
		if (isEnoent(error)) return [];
		throw error;
	});
	for (const entry of dirents) {
		if (entry.name.endsWith(".omp-meta")) continue;
		const full = path.join(dir, entry.name);
		const rel = path.relative(typeRoot, full).split(path.sep).join("/");
		const canonical = `${TYPE_DIRS[type]}/${rel}`;
		if (entry.isDirectory()) {
			out.push({ path: canonical, kind: "directory", type });
			await walkInto(full, typeRoot, type, out);
			continue;
		}
		if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
			out.push({ path: canonical, kind: "document", type });
		}
	}
}

// ────────────────────────────────────────────────────────────────────
// query + ranker
// ────────────────────────────────────────────────────────────────────

export interface KnowledgeQueryOptions {
	lexicalQuery?: string;
	/** Optional semantic query. Routed through `ranker.rank` when set. */
	semanticQuery?: string;
	pathPrefix?: string;
	/**
	 * Restrict the search to the given top-level buckets. When omitted or
	 * empty, every bucket is searched.
	 */
	types?: readonly MemoryDocType[];
	limit?: number;
	/** Optional ranker override. Defaults to `lexicalRanker`. */
	ranker?: KnowledgeRanker;
}

/**
 * Which section of the document a query term matched. Title and path are
 * bonus surfaces for matches that only land outside the body region.
 * Priority order when multiple sections match:
 * `summary` > `maintenanceRules` > `body` > `title` > `path`.
 */
export type KnowledgeMatchSection = "summary" | "maintenanceRules" | "body" | "title" | "path";

export interface KnowledgeQueryHit {
	path: string;
	type: MemoryDocType;
	title?: string;
	score: number;
	snippet: string;
	/** Which doc section the highest-priority match landed in. Omitted when
	 * the candidate scored zero (in which case it isn't returned at all). */
	matchedSection?: KnowledgeMatchSection;
	/** Whether the doc has a non-empty summary surface (frontmatter or `## Summary`). */
	hasSummary?: boolean;
	/** Frontmatter `injectMode` when present. */
	injectMode?: InjectMode;
	/** Frontmatter `aiMaintained` when present. */
	aiMaintained?: boolean;
	/** Frontmatter `updatedAt` (unix seconds) when present. */
	updatedAt?: number;
}

/** Document candidate handed to a ranker. */
export interface KnowledgeRankCandidate {
	entry: KnowledgeListEntry;
	frontmatter: MemoryDocFrontmatter;
	body: string;
	title?: string;
	/** Frontmatter `summary` or extracted `## Summary` section body. */
	summary?: string;
	/** Contents of the `<!-- omp:maintain-rules:* -->` block, newline-joined. */
	maintenanceRules?: string;
}

export interface KnowledgeRankInput {
	lexicalQuery: string;
	semanticQuery: string;
	candidates: KnowledgeRankCandidate[];
}

/**
 * Pluggable ranker. Default is `lexicalRanker`. A semantic ranker can be
 * registered without changing the surface; until one is, semantic-only
 * queries fall through to lexical via the default impl.
 */
export interface KnowledgeRanker {
	/** Score and rank candidates. Returns hits sorted best-first. */
	rank(input: KnowledgeRankInput): Promise<KnowledgeQueryHit[]>;
}

/**
 * Default lexical ranker. Scores per-section with these weights:
 *
 *   - title +1.5  · path +1.0  · summary +1.5  · maintenanceRules +1.2  · body +1.0
 *
 * Tracks the highest-priority matched section (`summary` > `maintenanceRules`
 * > `body` > `title` > `path`) so the result tells callers *where* the term
 * hit — agents can then decide whether to follow up with `knowledge_read
 * part=summary` or `part=body`. Snippet is pulled from the matched section's
 * text, not always from the body.
 */
export const lexicalRanker: KnowledgeRanker = {
	async rank({ lexicalQuery, semanticQuery, candidates }): Promise<KnowledgeQueryHit[]> {
		const query = (lexicalQuery || semanticQuery).trim();
		if (!query) return [];
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		const hits: KnowledgeQueryHit[] = [];
		for (const candidate of candidates) {
			const { entry, title, body, summary, maintenanceRules } = candidate;
			const titleLower = (title ?? "").toLowerCase();
			const pathLower = entry.path.toLowerCase();
			const summaryLower = (summary ?? "").toLowerCase();
			const rulesLower = (maintenanceRules ?? "").toLowerCase();
			const bodyLower = body.toLowerCase();

			let score = 0;
			let bodyHit = false;
			let summaryHit = false;
			let rulesHit = false;
			let titleHit = false;
			let pathHit = false;
			for (const term of terms) {
				if (titleLower.includes(term)) {
					score += 1.5;
					titleHit = true;
				}
				if (pathLower.includes(term)) {
					score += 1.0;
					pathHit = true;
				}
				if (summaryLower.includes(term)) {
					score += 1.5;
					summaryHit = true;
				}
				if (rulesLower.includes(term)) {
					score += 1.2;
					rulesHit = true;
				}
				if (bodyLower.includes(term)) {
					score += 1.0;
					bodyHit = true;
				}
			}
			if (score === 0) continue;

			// Priority: summary > maintenanceRules > body > title > path.
			const matchedSection: KnowledgeMatchSection | undefined = summaryHit
				? "summary"
				: rulesHit
					? "maintenanceRules"
					: bodyHit
						? "body"
						: titleHit
							? "title"
							: pathHit
								? "path"
								: undefined;

			const snippetSource =
				matchedSection === "summary"
					? (summary ?? "")
					: matchedSection === "maintenanceRules"
						? (maintenanceRules ?? "")
						: matchedSection === "title"
							? (title ?? "")
							: matchedSection === "path"
								? entry.path
								: body;

			const fm = candidate.frontmatter;
			hits.push({
				path: entry.path,
				type: entry.type,
				title,
				score,
				snippet: extractSnippet(snippetSource, terms),
				matchedSection,
				hasSummary: typeof summary === "string" && summary.trim().length > 0,
				injectMode: typeof fm.injectMode === "string" ? fm.injectMode : undefined,
				aiMaintained: typeof fm.aiMaintained === "boolean" ? fm.aiMaintained : undefined,
				updatedAt: typeof fm.updatedAt === "number" ? fm.updatedAt : undefined,
			});
		}
		hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
		return hits;
	},
};

/**
 * Search across the knowledge tree. `lexicalQuery` and `semanticQuery`
 * are both accepted; both flow through the active ranker. A semantic
 * backend can register a custom ranker via the `ranker` option; until
 * one is registered, semantic queries fall through to lexical scoring.
 */
export async function knowledgeQuery(memoryRoot: string, options: KnowledgeQueryOptions): Promise<KnowledgeQueryHit[]> {
	const lexical = (options.lexicalQuery ?? "").trim();
	const semantic = (options.semanticQuery ?? "").trim();
	if (!lexical && !semantic) return [];
	const limit = clampLimit(options.limit ?? 5);

	const docs = await knowledgeList(memoryRoot, options.pathPrefix);
	const typeFilter = options.types && options.types.length > 0 ? new Set(options.types) : undefined;
	const candidates: KnowledgeRankCandidate[] = [];
	for (const entry of docs) {
		if (entry.kind !== "document") continue;
		if (typeFilter && !typeFilter.has(entry.type)) continue;
		const absPath = resolveKnowledgePath(memoryRoot, entry.path, "document").absPath;
		let raw: string;
		try {
			raw = await Bun.file(absPath).text();
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		const doc = parseMemoryDoc(raw);
		const title = typeof doc.frontmatter.title === "string" ? doc.frontmatter.title : undefined;
		const body = doc.hasBodyMarkers ? doc.body : raw;
		const fmSummaryRaw = typeof doc.frontmatter.summary === "string" ? doc.frontmatter.summary.trim() : "";
		const summary = fmSummaryRaw || extractSummarySection(raw) || undefined;
		const rulesArr = extractMaintenanceRulesFromDoc(raw);
		const maintenanceRules = rulesArr.length > 0 ? rulesArr.join("\n") : undefined;
		candidates.push({ entry, frontmatter: doc.frontmatter, body, title, summary, maintenanceRules });
	}
	const ranker = options.ranker ?? lexicalRanker;
	const ranked = await ranker.rank({ lexicalQuery: lexical, semanticQuery: semantic, candidates });
	return ranked.slice(0, limit);
}

function clampLimit(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 5;
	return Math.min(Math.floor(value), 20);
}

function extractSnippet(body: string, terms: string[], windowSize = 160): string {
	const lower = body.toLowerCase();
	let best = -1;
	for (const term of terms) {
		const idx = lower.indexOf(term);
		if (idx !== -1 && (best === -1 || idx < best)) best = idx;
	}
	const start = best === -1 ? 0 : Math.max(0, best - 40);
	const end = Math.min(body.length, start + windowSize);
	return body.slice(start, end).replace(/\s+/g, " ").trim();
}

// ────────────────────────────────────────────────────────────────────
// read
// ────────────────────────────────────────────────────────────────────

export type KnowledgeReadPart = "full" | "summary" | "body";

export interface KnowledgeReadResult {
	path: string;
	type: MemoryDocType;
	part: KnowledgeReadPart;
	content: string;
	hasBodyMarkers: boolean;
	frontmatter: MemoryDocFrontmatter;
}

/**
 * Read a knowledge document.
 *
 * - `part: "summary"` returns the parsed frontmatter `summary` (or the
 *   `## Summary` section body if frontmatter omits it).
 * - `part: "body"` returns only the body region between markers.
 * - `part: "full"` returns a reformatted markdown view (title, summary,
 *   maintenance rules, content) — frontmatter and `<!-- omp:* -->` comment
 *   markers are stripped so the LLM only sees the agent-facing surface.
 */
export async function knowledgeRead(
	memoryRoot: string,
	pathInput: string,
	part: KnowledgeReadPart = "full",
): Promise<KnowledgeReadResult> {
	const resolved = resolveKnowledgePath(memoryRoot, pathInput, "document");
	let raw: string;
	try {
		raw = await Bun.file(resolved.absPath).text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new KnowledgeOpsError("not_found", `Knowledge document not found: ${pathInput}`);
		}
		throw error;
	}
	const doc = parseMemoryDoc(raw);
	let content: string;
	if (part === "full") {
		content = renderReadableFull(raw, doc);
	} else if (part === "body") {
		content = doc.hasBodyMarkers ? doc.body.trim() : raw.trim();
	} else {
		const fmSummary = typeof doc.frontmatter.summary === "string" ? doc.frontmatter.summary.trim() : "";
		content = fmSummary || extractSummarySection(raw);
	}
	return {
		path: resolved.canonical,
		type: resolved.type,
		part,
		content,
		hasBodyMarkers: doc.hasBodyMarkers,
		frontmatter: doc.frontmatter,
	};
}

/**
 * Render a `part=full` knowledge read as agent-friendly markdown: the
 * `# title`, a `## Summary` block when present, a `## Maintenance Rules`
 * block when present, and a `## Content` block holding the body region.
 * Frontmatter and `<!-- omp:* -->` comment markers are stripped so the
 * LLM only sees the human-readable surface.
 */
function renderReadableFull(raw: string, doc: MemoryDoc): string {
	const title =
		typeof doc.frontmatter.title === "string" && doc.frontmatter.title.trim()
			? doc.frontmatter.title.trim()
			: undefined;
	const fmSummaryRaw = typeof doc.frontmatter.summary === "string" ? doc.frontmatter.summary.trim() : "";
	const summary = fmSummaryRaw || extractSummarySection(raw);
	const rules = extractMaintenanceRulesFromDoc(raw);
	const body = doc.hasBodyMarkers ? doc.body.trim() : raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

	const parts: string[] = [];
	if (title) parts.push(`# ${title}`, "");
	if (summary) parts.push("## Summary", summary, "");
	if (rules.length > 0) {
		parts.push("## Maintenance Rules");
		for (const rule of rules) parts.push(`- ${rule}`);
		parts.push("");
	}
	parts.push("## Content", body || "");
	return parts.join("\n").trimEnd();
}

export function extractSummarySection(raw: string): string {
	// The end-anchor uses `$(?![\s\S])` (true end-of-string) rather than
	// `\s*$`: with the `m` flag, `\s*$` matches at every line boundary, so a
	// lazy `[\s\S]*?` would terminate at the first newline and silently
	// truncate multi-paragraph summaries.
	const match = raw.match(/^##\s+Summary\s*\n([\s\S]*?)(?=\n##\s|\n<!--\s*omp:|$(?![\s\S]))/im);
	return match?.[1]?.trim() ?? "";
}

// ────────────────────────────────────────────────────────────────────
// approval routing
// ────────────────────────────────────────────────────────────────────

/**
 * Route a mutating write through the approval sink when required.
 *
 * - `requiresApproval` and `approvalSink` present  → call sink with `apply`.
 *   The sink decides when to invoke `apply()`; if it returns without doing
 *   so, the op is reported as `applied: false, requiredApproval: true`.
 * - `requiresApproval` and no `approvalSink`        → throw `permission_denied`.
 * - `requiresApproval: false`                       → run `apply` synchronously.
 */
async function routeApproval(
	requiresApproval: boolean,
	preview: KnowledgeApprovalPreview,
	apply: () => Promise<void>,
	approvalSink: KnowledgeApprovalSink | undefined,
): Promise<KnowledgeOpOutcome> {
	if (!requiresApproval) {
		await apply();
		return { applied: true, requiredApproval: false };
	}
	if (!approvalSink) {
		throw new KnowledgeOpsError("permission_denied", `user approval required: ${preview.path}`);
	}
	let applied = false;
	const wrapped = async (): Promise<void> => {
		await apply();
		applied = true;
	};
	await approvalSink({ preview, apply: wrapped });
	return { applied, requiredApproval: true };
}

// ────────────────────────────────────────────────────────────────────
// create
// ────────────────────────────────────────────────────────────────────

export interface KnowledgeCreateDocOptions {
	summary?: string | null;
	body?: string;
	maintenanceRules?: string | null;
	/**
	 * Opt-in slash-command surface. When `true`, the resulting frontmatter
	 * carries `commandEnabled: true` so `/knowledge:<type>/<path>` is
	 * registered on the next session start. Omitted (or `false`) keeps the
	 * doc out of the slash menu — the field is *not* written when falsy so
	 * frontmatter stays quiet for the common case.
	 */
	commandEnabled?: boolean;
}

/**
 * Create a knowledge document. Path must be type-prefixed and end with
 * `.md`. Refuses if the file already exists or the parent directory
 * sidecar denies new documents.
 *
 * The new doc inherits `aiMaintained` / `readOnly` from the parent
 * directory's effective config so directories like `design/` (which
 * default to `aiMaintained: false`) produce user-authored shape docs.
 * When `requiresApproval` is set on the parent, the create routes
 * through `options.approvalSink`.
 */
export async function knowledgeCreateDocument(
	memoryRoot: string,
	pathInput: string,
	content: KnowledgeCreateDocOptions = {},
	options: KnowledgeOpOptions = {},
): Promise<KnowledgeOpOutcome> {
	const resolved = resolveKnowledgePath(memoryRoot, pathInput, "document");
	const exists = await fileExists(resolved.absPath);
	if (exists) {
		throw new KnowledgeOpsError("already_exists", `Knowledge document already exists: ${pathInput}`);
	}
	const denied = await checkWritePermission(memoryRoot, resolved.absPath, "create");
	if (denied) {
		throw new KnowledgeOpsError("permission_denied", denied);
	}
	const parentDir = path.dirname(resolved.absPath);
	const parentExists = await fileExists(parentDir);
	const dirConfig = await resolveDirectoryConfig(memoryRoot, parentDir);
	if (!parentExists && dirConfig && !dirConfig.allowCreateDirectories) {
		// Creating an intermediate directory along the way requires the
		// type root / nearest sidecar to allow directory creation. Otherwise
		// `knowledge_create kind=document` would launder around the
		// `allowCreateDirectories: false` gate.
		throw new KnowledgeOpsError("permission_denied", `directory create not allowed: ${parentDir}`);
	}
	const summary = content.summary ?? undefined;
	const userRules = parseMaintenanceRules(content.maintenanceRules);
	const trimmedBody = content.body?.trim();
	const docTitle = deriveTitle(resolved.relFromTypeRoot, summary);

	// Auto-fill maintenance rules on AI-maintained docs when the caller
	// omits them, then validate the resulting frontmatter shape before
	// any filesystem mutation so a doomed write never reaches the user as a
	// pending approval preview.
	const effectiveAiMaintained = dirConfig?.aiMaintained ?? true;
	const effectiveReadOnly = dirConfig?.readOnly ?? false;
	const effectiveInjectMode: InjectMode = dirConfig?.injectMode ?? "none";
	const maintenanceRules =
		userRules.length > 0
			? userRules
			: effectiveAiMaintained
				? [...defaultMaintenanceRulesForType(resolved.type)]
				: [];
	const explicitMaintenanceRules = maintenanceRules.length > 0;
	const summaryEnabled = summary !== undefined ? true : defaultSummaryEnabledForType(resolved.type);

	const denial = validateMemoryDoc({
		type: resolved.type,
		injectMode: effectiveInjectMode,
		aiMaintained: effectiveAiMaintained,
		explicitMaintenanceRules,
		maintenanceRules,
	});
	if (denial) {
		throw new KnowledgeOpsError("invalid_path", denial);
	}

	const apply = async (): Promise<void> => {
		// Materialize the parent only at apply time so a rejected/withheld
		// approval leaves the tree untouched.
		await fs.mkdir(parentDir, { recursive: true });
		const now = unixNow();
		const docContent = buildMemoryDoc({
			frontmatter: {
				id: deriveDocId(resolved.relFromTypeRoot),
				type: resolved.type,
				path: resolved.relFromTypeRoot,
				title: docTitle,
				injectMode: effectiveInjectMode,
				inheritInjectMode: true,
				inheritAiConfig: true,
				aiMaintained: effectiveAiMaintained,
				readOnly: effectiveReadOnly,
				summaryEnabled,
				explicitMaintenanceRules,
				createdAt: now,
				updatedAt: now,
				// Only emit `commandEnabled` when the caller opted in; falsy values
				// stay out of frontmatter to keep the doc quiet.
				commandEnabled: content.commandEnabled === true ? true : undefined,
			},
			title: docTitle,
			summary: summary ?? undefined,
			maintenanceRules,
			body: trimmedBody ?? "<!-- Empty knowledge body. Replace with project content. -->",
		});
		await Bun.write(resolved.absPath, docContent);
	};
	const preview: KnowledgeApprovalPreview = {
		kind: "create",
		path: resolved.canonical,
		type: resolved.type,
		entryKind: "document",
		title: docTitle,
		summary: summary ?? undefined,
		bodyPreview: bodyExcerpt(trimmedBody),
	};
	return routeApproval(dirConfig?.requiresApproval ?? false, preview, apply, options.approvalSink);
}

/**
 * Create a knowledge directory. Idempotent for an already-existing
 * directory; throws if a file with the same name exists. Refuses bare
 * type roots (those are seeded, not user-created). Honours the parent
 * directory's `readOnly` / `allowCreateDirectories` gates and routes
 * through `options.approvalSink` when the parent requires approval.
 */
export async function knowledgeCreateDirectory(
	memoryRoot: string,
	pathInput: string,
	options: KnowledgeOpOptions = {},
): Promise<KnowledgeOpOutcome> {
	const resolved = resolveKnowledgePath(memoryRoot, pathInput, "directory");
	if (resolved.relFromTypeRoot === "") {
		throw new KnowledgeOpsError(
			"invalid_path",
			`Refusing to create taxonomy root directory: ${pathInput}. Type roots are reserved.`,
		);
	}
	const stat = await fs.stat(resolved.absPath).catch(() => undefined);
	if (stat) {
		if (stat.isDirectory()) return { applied: false, requiredApproval: false };
		throw new KnowledgeOpsError("kind_mismatch", `Knowledge path exists but is not a directory: ${pathInput}`);
	}
	const parentDir = path.dirname(resolved.absPath);
	// resolveDirectoryConfig classifies by path string, so missing
	// intermediate directories still resolve to the correct type-root
	// defaults + type-root sidecar (no need to walk fs.stat upwards).
	const ancestorConfig = await resolveDirectoryConfig(memoryRoot, parentDir);
	if (ancestorConfig?.readOnly) {
		throw new KnowledgeOpsError("permission_denied", `target is read-only: ${resolved.absPath}`);
	}
	if (ancestorConfig && !ancestorConfig.allowCreateDirectories) {
		throw new KnowledgeOpsError("permission_denied", `directory create not allowed: ${resolved.absPath}`);
	}
	const apply = async (): Promise<void> => {
		await fs.mkdir(resolved.absPath, { recursive: true });
	};
	const preview: KnowledgeApprovalPreview = {
		kind: "create",
		path: resolved.canonical,
		type: resolved.type,
		entryKind: "directory",
	};
	return routeApproval(ancestorConfig?.requiresApproval ?? false, preview, apply, options.approvalSink);
}

function deriveTitle(rel: string, summary: string | undefined): string {
	const stem = rel.replace(/\.md$/i, "").split("/").pop() ?? rel;
	if (summary) return stem;
	return stem || "Knowledge Document";
}

function parseMaintenanceRules(value: string | null | undefined): string[] {
	if (!value) return [];
	const trimmed = value.trim();
	if (!trimmed) return [];
	return trimmed
		.split(/\r?\n/)
		.map(line => line.replace(/^\s*[-*]\s+/, "").trim())
		.filter(Boolean);
}

function bodyExcerpt(body: string | undefined, limit = 280): string | undefined {
	if (!body) return undefined;
	const trimmed = body.trim();
	if (!trimmed) return undefined;
	return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

// ────────────────────────────────────────────────────────────────────
// edit
// ────────────────────────────────────────────────────────────────────

export interface KnowledgeEditPatch {
	summary?: string | null;
	body?: string;
	maintenanceRules?: string | null;
}

/**
 * Patch the content sections of an existing knowledge document. Only
 * provided sections change; omitted sections survive verbatim.
 *
 * Requires the doc to carry body markers — marker-less docs are treated
 * as user-authored and the edit is refused regardless of approval. When
 * the doc's effective config has `requiresApproval`, the write routes
 * through `options.approvalSink`.
 */
export async function knowledgeEditDocument(
	memoryRoot: string,
	pathInput: string,
	patch: KnowledgeEditPatch,
	options: KnowledgeOpOptions = {},
): Promise<KnowledgeOpOutcome> {
	if (patch.summary === undefined && patch.body === undefined && patch.maintenanceRules === undefined) {
		throw new KnowledgeOpsError(
			"invalid_path",
			`knowledge_edit requires at least one of summary, body, or maintenanceRules: ${pathInput}`,
		);
	}
	const resolved = resolveKnowledgePath(memoryRoot, pathInput, "document");
	let raw: string;
	try {
		raw = await Bun.file(resolved.absPath).text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new KnowledgeOpsError("not_found", `Knowledge document not found: ${pathInput}`);
		}
		throw error;
	}
	const doc = parseMemoryDoc(raw);
	if (!doc.hasBodyMarkers) {
		throw new KnowledgeOpsError(
			"permission_denied",
			`Knowledge document is user-authored (no body markers): ${pathInput}`,
		);
	}
	const denied = await checkWritePermission(memoryRoot, resolved.absPath, "update", doc.frontmatter);
	if (denied) {
		throw new KnowledgeOpsError("permission_denied", denied);
	}
	const docConfig = await resolveDocConfig(memoryRoot, resolved.absPath, doc.frontmatter);

	const nextBody = patch.body !== undefined ? patch.body : doc.body;
	const nextSummary =
		patch.summary === undefined ? doc.frontmatter.summary : patch.summary === null ? undefined : patch.summary;
	const nextRules = patch.maintenanceRules === undefined ? undefined : parseMaintenanceRules(patch.maintenanceRules);

	const onlyBodyChanged =
		patch.body !== undefined && patch.summary === undefined && patch.maintenanceRules === undefined;

	// Validate the resulting doc shape before writing. The effective rules
	// are either the patch (when provided), the existing in-doc rules, or
	// nothing — and we never let the edit transition a valid doc into an
	// aiMaintained-but-empty-rules state.
	const effectiveRules = nextRules !== undefined ? nextRules : extractMaintenanceRulesFromDoc(raw);
	const effectiveExplicitRules =
		nextRules !== undefined ? nextRules.length > 0 : doc.frontmatter.explicitMaintenanceRules === true;
	const editDenial = validateMemoryDoc({
		type: resolved.type,
		injectMode: docConfig?.injectMode,
		aiMaintained: docConfig?.aiMaintained === true,
		explicitMaintenanceRules: effectiveExplicitRules,
		maintenanceRules: effectiveRules,
	});
	if (editDenial) {
		throw new KnowledgeOpsError("invalid_path", editDenial);
	}

	const apply = async (): Promise<void> => {
		const now = unixNow();
		const nextFrontmatter: MemoryDocFrontmatter = {
			...doc.frontmatter,
			summary: nextSummary,
			summaryEnabled:
				nextSummary !== undefined && nextSummary !== ""
					? true
					: (doc.frontmatter.summaryEnabled ?? defaultSummaryEnabledForType(resolved.type)),
			explicitMaintenanceRules:
				nextRules !== undefined ? nextRules.length > 0 : doc.frontmatter.explicitMaintenanceRules,
			updatedAt: now,
		};
		if (!nextFrontmatter.createdAt) nextFrontmatter.createdAt = now;

		if (onlyBodyChanged) {
			const rewritten = rewriteDocBody(doc, nextBody.trim());
			if (rewritten === undefined) {
				throw new KnowledgeOpsError("io_error", "rewriteDocBody refused — body markers missing");
			}
			await Bun.write(resolved.absPath, rewritten);
			return;
		}

		const summaryString = typeof nextSummary === "string" ? nextSummary : undefined;
		const titleString =
			typeof nextFrontmatter.title === "string"
				? nextFrontmatter.title
				: deriveTitle(resolved.relFromTypeRoot, summaryString);
		const rebuilt = buildMemoryDoc({
			frontmatter: nextFrontmatter,
			title: titleString,
			summary: summaryString,
			maintenanceRules: nextRules ?? extractMaintenanceRulesFromDoc(raw),
			body: nextBody.trim(),
		});
		await Bun.write(resolved.absPath, rebuilt);
	};

	const preview: KnowledgeApprovalPreview = {
		kind: "edit",
		path: resolved.canonical,
		type: resolved.type,
		entryKind: "document",
		title: typeof doc.frontmatter.title === "string" ? doc.frontmatter.title : undefined,
		summary: typeof nextSummary === "string" ? nextSummary : undefined,
		bodyPreview: bodyExcerpt(patch.body),
	};
	return routeApproval(docConfig?.requiresApproval ?? false, preview, apply, options.approvalSink);
}

function extractMaintenanceRulesFromDoc(raw: string): string[] {
	const match = raw.match(/<!--\s*omp:maintain-rules:start\s*-->([\s\S]*?)<!--\s*omp:maintain-rules:end\s*-->/);
	if (!match) return [];
	return parseMaintenanceRules(match[1]);
}

// ────────────────────────────────────────────────────────────────────
// move
// ────────────────────────────────────────────────────────────────────

/**
 * Rename a knowledge document or directory. Source and destination must
 * be the same kind AND the same top-level type. Cross-type moves are
 * refused — a document never silently changes meaning. When the source
 * is under a `requiresApproval` directory, the move routes through
 * `options.approvalSink`.
 */
export async function knowledgeMove(
	memoryRoot: string,
	pathInput: string,
	newPathInput: string,
	kind: "document" | "directory",
	options: KnowledgeOpOptions = {},
): Promise<KnowledgeOpOutcome> {
	const source = resolveKnowledgePath(memoryRoot, pathInput, kind);
	const dest = resolveKnowledgePath(memoryRoot, newPathInput, kind);
	if (source.type !== dest.type) {
		throw new KnowledgeOpsError(
			"type_change",
			`Cross-type move refused: ${pathInput} (${source.type}) → ${newPathInput} (${dest.type})`,
		);
	}
	if (kind === "directory" && (source.relFromTypeRoot === "" || dest.relFromTypeRoot === "")) {
		// Renaming a bucket root (`memory`, `skill`, `design`, `reference`)
		// would relocate the entire taxonomy and break every subsequent
		// path lookup. Refuse symmetrically with `knowledgeDelete` and
		// `knowledgeCreateDirectory`, both of which reserve the type roots.
		throw new KnowledgeOpsError(
			"invalid_path",
			`Refusing to move taxonomy root directory: ${pathInput} → ${newPathInput}. Type roots are reserved.`,
		);
	}
	if (source.absPath === dest.absPath) {
		return { applied: false, requiredApproval: false };
	}

	const stat = await fs.stat(source.absPath).catch(() => undefined);
	if (!stat) {
		throw new KnowledgeOpsError("not_found", `Knowledge ${kind} not found: ${pathInput}`);
	}
	if (kind === "document" && !stat.isFile()) {
		throw new KnowledgeOpsError("kind_mismatch", `Expected a document, found a directory: ${pathInput}`);
	}
	if (kind === "directory" && !stat.isDirectory()) {
		throw new KnowledgeOpsError("kind_mismatch", `Expected a directory, found a file: ${pathInput}`);
	}

	const destStat = await fs.stat(dest.absPath).catch(() => undefined);
	if (destStat) {
		throw new KnowledgeOpsError("already_exists", `Knowledge ${kind} already exists at destination: ${newPathInput}`);
	}

	// Source-side: who is allowed to mutate the thing being moved?
	let requiresApproval = false;
	let sourceFrontmatter: MemoryDocFrontmatter = {};
	if (kind === "document") {
		try {
			sourceFrontmatter = parseMemoryDoc(await Bun.file(source.absPath).text()).frontmatter;
		} catch {
			// best-effort frontmatter read — fall through with empty fm
		}
		const denied = await checkWritePermission(memoryRoot, source.absPath, "update", sourceFrontmatter);
		if (denied) throw new KnowledgeOpsError("permission_denied", denied);
		const sourceParentConfig = await resolveDirectoryConfig(memoryRoot, path.dirname(source.absPath));
		if (sourceParentConfig && !sourceParentConfig.allowMoveDocuments) {
			throw new KnowledgeOpsError("permission_denied", `document move not allowed: ${pathInput}`);
		}
		const sourceConfig = await resolveDocConfig(memoryRoot, source.absPath, sourceFrontmatter);
		requiresApproval = sourceConfig?.requiresApproval ?? false;
	} else {
		const config = await resolveDirectoryConfig(memoryRoot, source.absPath);
		if (config && !config.allowMoveDirectories) {
			throw new KnowledgeOpsError("permission_denied", `directory move not allowed: ${pathInput}`);
		}
		if (config?.readOnly) {
			throw new KnowledgeOpsError("permission_denied", `target is read-only: ${pathInput}`);
		}
		// Refuse if any descendant doc carries `readOnly: true` — a moved
		// directory must not silently drag user-locked content along.
		const lockedDescendant = await findReadOnlyDescendant(source.absPath);
		if (lockedDescendant) {
			throw new KnowledgeOpsError(
				"permission_denied",
				`directory contains read-only document: ${lockedDescendant.rel}`,
			);
		}
		requiresApproval = config?.requiresApproval ?? false;
	}

	// Destination-side: does the target tree accept this thing?
	const destParentDir = path.dirname(dest.absPath);
	const destParentExists = await fileExists(destParentDir);
	const destAncestor = await resolveDirectoryConfig(memoryRoot, destParentDir);
	if (destAncestor?.readOnly) {
		throw new KnowledgeOpsError("permission_denied", `destination is read-only: ${newPathInput}`);
	}
	if (kind === "document" && destAncestor && !destAncestor.allowCreateDocuments) {
		throw new KnowledgeOpsError("permission_denied", `destination denies new docs: ${destParentDir}`);
	}
	// Directory moves materialize a new child entry under `destParentDir`,
	// even when the parent itself already exists. Honour
	// `allowCreateDirectories: false` symmetrically with the document branch
	// above so a `.omp-meta` lock on the destination tree cannot be
	// laundered around via a move into an existing parent.
	if ((kind === "directory" || !destParentExists) && destAncestor && !destAncestor.allowCreateDirectories) {
		throw new KnowledgeOpsError("permission_denied", `destination denies new directories: ${destParentDir}`);
	}
	// If the destination's effective config also requires approval, escalate.
	if (destAncestor?.requiresApproval) requiresApproval = true;

	const apply = async (): Promise<void> => {
		await fs.mkdir(destParentDir, { recursive: true });
		if (kind === "directory") {
			// Move the directory and its paired sidecar together so policy
			// follows the rename and stale sidecars never orphan.
			await renameDirectoryWithSidecar(source.absPath, dest.absPath);
		} else {
			await fs.rename(source.absPath, dest.absPath);
		}
	};
	const preview: KnowledgeApprovalPreview = {
		kind: "move",
		path: source.canonical,
		destPath: dest.canonical,
		type: source.type,
		entryKind: kind,
	};
	return routeApproval(requiresApproval, preview, apply, options.approvalSink);
}

// ────────────────────────────────────────────────────────────────────
// delete
// ────────────────────────────────────────────────────────────────────

/**
 * Delete a knowledge document or directory. `readOnly` is the hard
 * refusal; `aiMaintained: false` routes through `options.approvalSink`.
 */
export async function knowledgeDelete(
	memoryRoot: string,
	pathInput: string,
	kind: "document" | "directory",
	options: KnowledgeOpOptions = {},
): Promise<KnowledgeOpOutcome> {
	const resolved = resolveKnowledgePath(memoryRoot, pathInput, kind);
	if (kind === "directory" && resolved.relFromTypeRoot === "") {
		throw new KnowledgeOpsError(
			"permission_denied",
			`Refusing to delete taxonomy root directory: ${pathInput}. Type roots are reserved.`,
		);
	}
	const stat = await fs.stat(resolved.absPath).catch(() => undefined);
	if (!stat) {
		throw new KnowledgeOpsError("not_found", `Knowledge ${kind} not found: ${pathInput}`);
	}
	if (kind === "document" && !stat.isFile()) {
		throw new KnowledgeOpsError("kind_mismatch", `Expected a document, found a directory: ${pathInput}`);
	}
	if (kind === "directory" && !stat.isDirectory()) {
		throw new KnowledgeOpsError("kind_mismatch", `Expected a directory, found a file: ${pathInput}`);
	}
	let frontmatter: MemoryDocFrontmatter = {};
	if (kind === "document") {
		try {
			frontmatter = parseMemoryDoc(await Bun.file(resolved.absPath).text()).frontmatter;
		} catch {
			// missing or unparseable — fall through with empty frontmatter
		}
	}
	const denied = await checkDeletePermission(memoryRoot, resolved.absPath, frontmatter);
	if (denied) {
		throw new KnowledgeOpsError("permission_denied", denied);
	}
	let config: EffectiveDirectoryConfig | undefined;
	if (kind === "document") {
		config = await resolveDocConfig(memoryRoot, resolved.absPath, frontmatter);
	} else {
		config = await resolveDirectoryConfig(memoryRoot, resolved.absPath);
	}
	if (kind === "directory") {
		// Refuse if any descendant doc carries `readOnly: true` — a recursive
		// delete must not silently remove user-locked content.
		const lockedDescendant = await findReadOnlyDescendant(resolved.absPath);
		if (lockedDescendant) {
			throw new KnowledgeOpsError(
				"permission_denied",
				`directory contains read-only document: ${lockedDescendant.rel}`,
			);
		}
	}
	const apply = async (): Promise<void> => {
		if (kind === "document") {
			await fs.rm(resolved.absPath, { force: true });
			return;
		}
		await fs.rm(resolved.absPath, { recursive: true, force: true });
		// Remove the paired sidecar too so a future same-named directory
		// does not silently inherit stale policy.
		await fs.rm(sidecarPathForDirectory(resolved.absPath), { force: true });
	};
	const preview: KnowledgeApprovalPreview = {
		kind: "delete",
		path: resolved.canonical,
		type: resolved.type,
		entryKind: kind,
		title: typeof frontmatter.title === "string" ? frontmatter.title : undefined,
	};
	return routeApproval(config?.requiresApproval ?? false, preview, apply, options.approvalSink);
}

// ────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────

async function fileExists(absPath: string): Promise<boolean> {
	const stat = await fs.stat(absPath).catch(() => undefined);
	return stat !== undefined;
}

function unixNow(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * Enumerate every `.md` document under `dirAbsPath` and return the first
 * whose frontmatter has `readOnly: true`. Used by directory move/delete to
 * refuse mutations that would silently affect user-locked descendants.
 */
async function findReadOnlyDescendant(dirAbsPath: string): Promise<{ absPath: string; rel: string } | undefined> {
	const stack: string[] = [dirAbsPath];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		const entries = await fs.readdir(current, { withFileTypes: true }).catch(error => {
			if (isEnoent(error)) return [];
			throw error;
		});
		for (const entry of entries) {
			if (entry.name.endsWith(".omp-meta")) continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (!(entry.isFile() && entry.name.toLowerCase().endsWith(".md"))) continue;
			let raw: string;
			try {
				raw = await Bun.file(full).text();
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
			const fm = parseMemoryDoc(raw).frontmatter;
			if (fm.readOnly === true) {
				return { absPath: full, rel: path.relative(dirAbsPath, full).split(path.sep).join("/") };
			}
		}
	}
	return undefined;
}
// ────────────────────────────────────────────────────────────────────
// commandEnabled slash-command surface
// ────────────────────────────────────────────────────────────────────

/**
 * A knowledge doc that opted in to the `/knowledge:<slug>` slash-command
 * surface via frontmatter `commandEnabled: true`. Mirrors the shape the
 * skill-command flow consumes so both surfaces can share renderers.
 */
export interface KnowledgeCommandEntry {
	/** Type-prefixed path without the `.md` suffix (e.g. `memory/api-style`). */
	slug: string;
	/** Absolute path to the on-disk doc. */
	absPath: string;
	/** Top-level type bucket. */
	type: MemoryDocType;
	/** Relative path from the type root (e.g. `api-style.md`). */
	path: string;
	/** Frontmatter `title`, falling back to the slug. */
	title: string;
	/** Short label used as the slash-command description. */
	description: string;
}

/**
 * Slash-command name for a knowledge entry (`knowledge:<slug>`). Pair with
 * a leading `/` at the dispatch site to compose the command string.
 */
export function getKnowledgeSlashCommandName(entry: Pick<KnowledgeCommandEntry, "slug">): string {
	return `knowledge:${entry.slug}`;
}

/**
 * Walk the four type roots and collect every doc whose frontmatter sets
 * `commandEnabled: true`. Sorted by slug for deterministic ordering.
 *
 * Files that fail to read/parse are skipped silently — a malformed doc
 * MUST NOT take down the whole slash-command surface.
 */
export async function listCommandEnabledDocs(memoryRoot: string): Promise<KnowledgeCommandEntry[]> {
	const listEntries: KnowledgeListEntry[] = [];
	for (const type of KNOWN_TYPES) {
		const typeRoot = path.join(memoryRoot, TYPE_DIRS[type]);
		await walkInto(typeRoot, typeRoot, type, listEntries);
	}
	const out: KnowledgeCommandEntry[] = [];
	for (const entry of listEntries) {
		if (entry.kind !== "document") continue;
		const typePrefix = TYPE_DIRS[entry.type];
		// `entry.path` is canonical (`<type>/<relFromTypeRoot>`). Strip the
		// prefix to recover the type-root-relative path, then strip `.md` to
		// produce the slug.
		const relFromTypeRoot = entry.path.startsWith(`${typePrefix}/`)
			? entry.path.slice(typePrefix.length + 1)
			: entry.path;
		const absPath = path.join(memoryRoot, typePrefix, ...relFromTypeRoot.split("/"));
		let raw: string;
		try {
			raw = await fs.readFile(absPath, "utf8");
		} catch {
			continue;
		}
		const parsed = parseMemoryDoc(raw);
		if (parsed.frontmatter.commandEnabled !== true) continue;
		const slug = `${typePrefix}/${relFromTypeRoot.replace(/\.md$/i, "")}`;
		const title =
			typeof parsed.frontmatter.title === "string" && parsed.frontmatter.title.trim()
				? parsed.frontmatter.title.trim()
				: slug;
		out.push({
			slug,
			absPath,
			type: entry.type,
			path: relFromTypeRoot,
			title,
			description: title,
		});
	}
	out.sort((a, b) => a.slug.localeCompare(b.slug));
	return out;
}

/** Result of {@link buildKnowledgePromptMessage}. */
export interface BuiltKnowledgePromptMessage {
	message: string;
	details: {
		name: string;
		path: string;
		slug: string;
		args?: string;
		lineCount: number;
	};
}

/**
 * Build the prompt message that `/knowledge:<slug>` dispatches as a
 * CustomMessage. Mirrors `buildSkillPromptMessage`: the body region is
 * extracted via `parseMemoryDoc` when body markers are present, otherwise
 * we fall back to frontmatter-stripped content (same regex the skill flow
 * uses). Trailing meta lines disambiguate Knowledge from Skill in the
 * agent's view.
 */
export async function buildKnowledgePromptMessage(
	entry: KnowledgeCommandEntry,
	args: string,
): Promise<BuiltKnowledgePromptMessage> {
	const content = await Bun.file(entry.absPath).text();
	const parsed = parseMemoryDoc(content);
	const body = parsed.hasBodyMarkers ? parsed.body.trim() : content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
	const metaLines = [`Knowledge: ${entry.type}/${entry.path}`];
	const trimmedArgs = args.trim();
	if (trimmedArgs) {
		metaLines.push(`User: ${trimmedArgs}`);
	}
	const message = `${body}\n\n---\n\n${metaLines.join("\n")}`;
	return {
		message,
		details: {
			name: entry.title,
			path: entry.absPath,
			slug: entry.slug,
			args: trimmedArgs || undefined,
			lineCount: body ? body.split("\n").length : 0,
		},
	};
}
