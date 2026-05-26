/**
 * Knowledge tools.
 *
 * Seven operations over the four-bucket memory taxonomy:
 * `knowledge_list`, `_query`, `_read`, `_create`, `_edit`, `_move`,
 * `_delete`. Each tool is a thin wrapper around the operations in
 * `memories/knowledge-ops.ts` — the heavy lifting (path validation,
 * body-marker rewrite, `.omp-meta` permission gating) lives there.
 *
 * Path conventions:
 *   - Type-prefixed: `memory/foo.md`, `skill/bar/`, `design/baz.md`.
 *   - Documents end in `.md`; directories do not.
 *   - The type prefix is mandatory; cross-type moves are refused.
 */

import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import { getMemoryRoot } from "../memories";
import {
	type KnowledgeApprovalPreview,
	type KnowledgeApprovalRequest,
	type KnowledgeApprovalSink,
	type KnowledgeOpOutcome,
	KnowledgeOpsError,
	knowledgeCreateDirectory,
	knowledgeCreateDocument,
	knowledgeDelete,
	knowledgeEditDocument,
	knowledgeList,
	knowledgeMove,
	knowledgeQuery,
	knowledgeRead,
} from "../memories/knowledge-ops";
import type { ToolSession } from ".";
import { queueResolveHandler } from "./resolve";
import { ToolError } from "./tool-errors";

// ────────────────────────────────────────────────────────────────────
// shared helpers
// ────────────────────────────────────────────────────────────────────

function getMemoryRootFor(session: ToolSession): string {
	return getMemoryRoot(session.settings.getAgentDir(), session.cwd);
}

function toToolError(error: unknown): never {
	if (error instanceof KnowledgeOpsError) {
		throw new ToolError(error.message);
	}
	throw error;
}

function plainText(text: string): AgentToolResult {
	return { content: [{ type: "text", text }] };
}

/**
 * Build an approval sink that stages knowledge writes through the
 * resolve protocol. The sink queues a `resolve` directive describing the
 * preview; on user `apply`, the underlying op runs and the tool emits a
 * normal "done" result. On `discard`, the op is dropped.
 */
function buildKnowledgeApprovalSink(session: ToolSession, sourceToolName: string): KnowledgeApprovalSink {
	return async (request: KnowledgeApprovalRequest) => {
		const label = formatApprovalLabel(request.preview);
		// Mirror skill_create: hard-fail if no resolve channel exists in
		// this session so callers see a clear error instead of a silent
		// "pending user approval" that can never be applied.
		const queue = session.getToolChoiceQueue?.();
		const forced = session.buildToolChoice?.("resolve");
		if (!queue || !forced || typeof forced === "string") {
			throw new ToolError(
				`${sourceToolName} requires user approval but no resolve channel is available in this session. Use the equivalent file edit tools manually if necessary.`,
			);
		}
		queueResolveHandler(session, {
			label,
			sourceToolName,
			apply: async (_reason: string) => {
				await request.apply();
				return plainText(`Applied: ${label}`);
			},
		});
	};
}

function formatApprovalLabel(preview: KnowledgeApprovalPreview): string {
	const target = preview.destPath ? `${preview.path} -> ${preview.destPath}` : preview.path;
	const verb =
		preview.kind === "create"
			? "Create"
			: preview.kind === "edit"
				? "Edit"
				: preview.kind === "move"
					? "Move"
					: "Delete";
	return `${verb} ${preview.entryKind}: ${target}`;
}

function pendingResult(outcome: KnowledgeOpOutcome, label: string): AgentToolResult {
	if (outcome.applied) {
		return plainText(label);
	}
	// `applied: false && requiredApproval: false` is a legitimate no-op
	// (e.g. `knowledge_create kind=directory` on an existing dir,
	// or `knowledge_move` with source == destination). No resolve handler
	// was queued, so reporting "pending user approval" would dead-end the
	// caller. Only the approval path queues a resolve.
	if (!outcome.requiredApproval) {
		return plainText(`${label} (no-op).`);
	}
	return plainText(`${label} pending user approval. The user must call \`resolve\` to apply or discard.`);
}

// ────────────────────────────────────────────────────────────────────
// schemas
// ────────────────────────────────────────────────────────────────────

const listSchema = z
	.object({
		pathPrefix: z
			.string()
			.optional()
			.describe(
				"Optional type-prefixed directory prefix (e.g. `memory/`, `skill/sbox/`). Omit to list across every type root.",
			),
	})
	.strict();

const querySchema = z
	.object({
		lexicalQuery: z
			.string()
			.optional()
			.describe("Lexical query for exact terms, titles, paths, identifiers, or short keyword combinations."),
		semanticQuery: z
			.string()
			.optional()
			.describe(
				"Semantic query for intent- or meaning-based retrieval. Currently treated as a lexical query — OMP ships lexical scan only.",
			),
		limit: z
			.number()
			.int()
			.min(1)
			.max(20)
			.default(5)
			.optional()
			.describe("Maximum number of results to return (default 5, max 20)."),
		pathPrefix: z.string().optional().describe("Optional type-prefixed directory prefix to constrain the search."),
		types: z
			.array(z.enum(["memory", "skill", "design", "reference"]))
			.optional()
			.describe(
				"Restrict the search to the listed top-level buckets. Omit (or pass an empty array) to search every bucket.",
			),
	})
	.strict();

const readSchema = z
	.object({
		path: z.string().describe("Type-prefixed document path ending in `.md` (e.g. `memory/preferences.md`)."),
		part: z.enum(["full", "summary", "body"]).default("full").optional().describe("Which content section to read."),
	})
	.strict();

const createSchema = z
	.object({
		kind: z
			.enum(["document", "directory"])
			.describe("Whether to create a knowledge document or a knowledge directory."),
		path: z
			.string()
			.describe(
				"Type-prefixed path. Use `.md` suffix for `kind=document`; omit `.md` for `kind=directory`. Type prefix is mandatory.",
			),
		document: z
			.object({
				summary: z.string().nullable().optional(),
				body: z.string().optional(),
				maintenanceRules: z
					.string()
					.nullable()
					.optional()
					.describe(
						"Optional document-level maintenance rules. Provide one rule per line; omit to inherit from the parent directory.",
					),
				commandEnabled: z
					.boolean()
					.optional()
					.describe(
						"Opt-in: when true, the doc is registered as `/knowledge:<type>/<path>` at session start. Omit (or false) to keep it out of the slash menu.",
					),
			})
			.strict()
			.optional()
			.describe("Document-only initial content. Ignored for `kind=directory`."),
	})
	.strict();

const editSchema = z
	.object({
		path: z.string().describe("Type-prefixed document path ending in `.md`."),
		document: z
			.object({
				summary: z.string().nullable().optional(),
				body: z.string().optional(),
				maintenanceRules: z.string().nullable().optional(),
			})
			.strict()
			.describe("Document content patch. Provide one or more sections to update."),
	})
	.strict();

const moveSchema = z
	.object({
		kind: z
			.enum(["document", "directory"])
			.describe("Whether the target is a knowledge document or a knowledge directory."),
		path: z.string().describe("Current type-prefixed path."),
		newPath: z.string().describe("Target type-prefixed path. Keep it inside the same top-level type tree."),
	})
	.strict();

const deleteSchema = z
	.object({
		kind: z
			.enum(["document", "directory"])
			.describe("Whether the target is a knowledge document or a knowledge directory."),
		path: z.string().describe("Current type-prefixed path. Use `.md` for documents; omit for directories."),
	})
	.strict();

// ────────────────────────────────────────────────────────────────────
// tool factories
// ────────────────────────────────────────────────────────────────────

export class KnowledgeListTool implements AgentTool<typeof listSchema> {
	readonly name = "knowledge_list";
	readonly label = "KnowledgeList";
	readonly summary = "List knowledge documents and directories";
	readonly loadMode = "discoverable";
	readonly description =
		"List knowledge documents in the unified knowledge store. Use this to browse the four top-level types: memory, skill, design, and reference. Returns plain text with one canonical type-prefixed path per line — directories end in `/`, documents in `.md`.";
	readonly parameters = listSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof listSchema>,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const memoryRoot = getMemoryRootFor(this.session);
			try {
				const entries = await knowledgeList(memoryRoot, params.pathPrefix);
				if (entries.length === 0) {
					return plainText("(empty knowledge tree)");
				}
				const text = entries.map(entry => (entry.kind === "directory" ? `${entry.path}/` : entry.path)).join("\n");
				return plainText(text);
			} catch (error) {
				toToolError(error);
			}
		});
	}
}

export class KnowledgeQueryTool implements AgentTool<typeof querySchema> {
	readonly name = "knowledge_query";
	readonly label = "KnowledgeQuery";
	readonly summary = "Search the unified knowledge store";
	readonly loadMode = "discoverable";
	readonly description =
		"Search the unified knowledge store by lexical scan over canonical paths, titles, and document bodies. Provide `lexicalQuery` and/or `semanticQuery` — in this build both flow through the same lexical scorer; a semantic backend may land later as a parallel scorer. Returns ranked hits with canonical path, title, score, and a short snippet.";
	readonly parameters = querySchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof querySchema>,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const lexical = (params.lexicalQuery ?? "").trim();
			const semantic = (params.semanticQuery ?? "").trim();
			if (!lexical && !semantic) {
				throw new ToolError("knowledge_query requires `lexicalQuery` or `semanticQuery`");
			}
			const memoryRoot = getMemoryRootFor(this.session);
			try {
				const hits = await knowledgeQuery(memoryRoot, {
					lexicalQuery: lexical || undefined,
					semanticQuery: semantic || undefined,
					pathPrefix: params.pathPrefix,
					types: params.types,
					limit: params.limit,
				});
				if (hits.length === 0) {
					return plainText(`(no matches for ${JSON.stringify(lexical || semantic)})`);
				}
				const lines: string[] = [];
				for (const hit of hits) {
					const title = hit.title ? ` · ${hit.title}` : "";
					const section = hit.matchedSection ? ` section=${hit.matchedSection}` : "";
					const meta: string[] = [];
					if (hit.injectMode) meta.push(`inject=${hit.injectMode}`);
					if (hit.aiMaintained !== undefined) meta.push(`ai=${hit.aiMaintained}`);
					if (hit.hasSummary) meta.push("summary");
					if (typeof hit.updatedAt === "number") meta.push(`updated=${hit.updatedAt}`);
					const metaPart = meta.length > 0 ? ` ${meta.join(" ")}` : "";
					lines.push(`${hit.path}${title}  score=${hit.score.toFixed(1)}${section}${metaPart}`);
					if (hit.snippet) lines.push(`    ${hit.snippet}`);
				}
				return plainText(lines.join("\n"));
			} catch (error) {
				toToolError(error);
			}
		});
	}
}

export class KnowledgeReadTool implements AgentTool<typeof readSchema> {
	readonly name = "knowledge_read";
	readonly label = "KnowledgeRead";
	readonly summary = "Read a knowledge document";
	readonly loadMode = "discoverable";
	readonly description =
		"Read a unified knowledge document by type-prefixed `.md` path. Returns plain-text markdown content. `part=full` returns the on-disk document; `part=body` returns only the body region between `<!-- omp:body:start --> ... <!-- omp:body:end -->` markers; `part=summary` returns the frontmatter `summary` value or the `## Summary` section.";
	readonly parameters = readSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof readSchema>,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const memoryRoot = getMemoryRootFor(this.session);
			try {
				const result = await knowledgeRead(memoryRoot, params.path, params.part ?? "full");
				return plainText(result.content);
			} catch (error) {
				toToolError(error);
			}
		});
	}
}

export class KnowledgeCreateTool implements AgentTool<typeof createSchema> {
	readonly name = "knowledge_create";
	readonly label = "KnowledgeCreate";
	readonly summary = "Create a knowledge document or directory";
	readonly loadMode = "discoverable";
	readonly description =
		"Create a unified knowledge document or directory. Document paths must end with `.md` and carry a type prefix (`memory/`, `skill/`, `design/`, `reference/`). New documents inherit inject mode and AI edit config from the parent directory by default. `skill/<name>.md` creates a *skill knowledge document* (a reusable process reference doc), NOT a runtime-loadable skill — use `skill_create` for skill packages under `.omp/skills/<name>/`. Writes under `design/` route through user approval via the `resolve` protocol. Directory creation only creates the folder structure; metadata uses dedicated knowledge tools. Returns a plain-text status line.";
	readonly parameters = createSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof createSchema>,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const memoryRoot = getMemoryRootFor(this.session);
			try {
				if (params.kind === "directory") {
					const outcome = await knowledgeCreateDirectory(memoryRoot, params.path, {
						approvalSink: buildKnowledgeApprovalSink(this.session, this.name),
					});
					return pendingResult(outcome, `Created directory ${params.path}`);
				}
				const outcome = await knowledgeCreateDocument(
					memoryRoot,
					params.path,
					{
						summary: params.document?.summary ?? undefined,
						body: params.document?.body ?? undefined,
						maintenanceRules: params.document?.maintenanceRules ?? undefined,
						commandEnabled: params.document?.commandEnabled,
					},
					{ approvalSink: buildKnowledgeApprovalSink(this.session, this.name) },
				);
				return pendingResult(outcome, `Created document ${params.path}`);
			} catch (error) {
				toToolError(error);
			}
		});
	}
}

export class KnowledgeEditTool implements AgentTool<typeof editSchema> {
	readonly name = "knowledge_edit";
	readonly label = "KnowledgeEdit";
	readonly summary = "Edit a knowledge document";
	readonly loadMode = "discoverable";
	readonly description =
		"Edit an existing unified knowledge document by type-prefixed `.md` path. Only updates content sections — frontmatter, identity, and on-disk layout survive. Body-only patches preserve the rest of the file byte-for-byte; summary/maintenance patches rebuild the doc with the new sections. User-authored documents lacking body markers are refused. Edits to docs whose effective config has `aiMaintained: false` (e.g. `design/`) route through user approval via the `resolve` protocol. Returns a plain-text status line.";
	readonly parameters = editSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof editSchema>,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const memoryRoot = getMemoryRootFor(this.session);
			try {
				const outcome = await knowledgeEditDocument(
					memoryRoot,
					params.path,
					{
						summary: params.document.summary,
						body: params.document.body,
						maintenanceRules: params.document.maintenanceRules,
					},
					{ approvalSink: buildKnowledgeApprovalSink(this.session, this.name) },
				);
				return pendingResult(outcome, `Edited document ${params.path}`);
			} catch (error) {
				toToolError(error);
			}
		});
	}
}

export class KnowledgeMoveTool implements AgentTool<typeof moveSchema> {
	readonly name = "knowledge_move";
	readonly label = "KnowledgeMove";
	readonly summary = "Move a knowledge document or directory";
	readonly loadMode = "discoverable";
	readonly description =
		"Move a unified knowledge document or directory within its knowledge type tree. Cross-type moves are refused — a document does not silently change meaning. Moves under `aiMaintained: false` paths (e.g. `design/`) route through user approval via the `resolve` protocol. Document paths must end with `.md`; directory paths do not. Returns a plain-text status line.";
	readonly parameters = moveSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof moveSchema>,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const memoryRoot = getMemoryRootFor(this.session);
			try {
				const outcome = await knowledgeMove(memoryRoot, params.path, params.newPath, params.kind, {
					approvalSink: buildKnowledgeApprovalSink(this.session, this.name),
				});
				return pendingResult(outcome, `Moved ${params.kind} ${params.path} -> ${params.newPath}`);
			} catch (error) {
				toToolError(error);
			}
		});
	}
}

export class KnowledgeDeleteTool implements AgentTool<typeof deleteSchema> {
	readonly name = "knowledge_delete";
	readonly label = "KnowledgeDelete";
	readonly summary = "Delete a knowledge document or directory";
	readonly loadMode = "discoverable";
	readonly description =
		"Delete a unified knowledge document or directory by type-prefixed path. `readOnly` targets (e.g. under `reference/`) are refused. Deletes under `aiMaintained: false` paths route through user approval via the `resolve` protocol. Returns a plain-text status line.";
	readonly parameters = deleteSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof deleteSchema>,
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const memoryRoot = getMemoryRootFor(this.session);
			try {
				const outcome = await knowledgeDelete(memoryRoot, params.path, params.kind, {
					approvalSink: buildKnowledgeApprovalSink(this.session, this.name),
				});
				return pendingResult(outcome, `Deleted ${params.kind} ${params.path}`);
			} catch (error) {
				toToolError(error);
			}
		});
	}
}

export const KNOWLEDGE_TOOL_NAMES = [
	"knowledge_list",
	"knowledge_query",
	"knowledge_read",
	"knowledge_create",
	"knowledge_edit",
	"knowledge_move",
	"knowledge_delete",
] as const;
