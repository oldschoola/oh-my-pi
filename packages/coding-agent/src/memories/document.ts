/**
 * Memory document anatomy.
 *
 * Every doc under `memory_root/{memory,skill,design,reference}/` has three
 * layered regions:
 *
 *   1. YAML frontmatter (between `---` fences).
 *   2. Free markdown — typically the title and a `## Summary` section, plus
 *      a `<!-- omp:maintain-rules:start -->` / `<!-- omp:maintain-rules:end -->`
 *      region containing bulleted rules the AI must preserve.
 *   3. `<!-- omp:body:start -->` / `<!-- omp:body:end -->` — the **only**
 *      region the consolidator is allowed to rewrite.
 *
 * Docs without body markers are treated as "user-authored, do not touch":
 * writes refuse to mutate them. New AI-emitted docs are wrapped in the body
 * markers automatically on first write.
 */

import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/**
 * Supported injection modes for memory docs.
 *
 *   - `none`    — doc exists; nothing about it is injected.
 *   - `path`    — only the canonical path + title are injected (a "I exist;
 *                 read me if relevant" breadcrumb). No body or summary bytes.
 *   - `summary` — frontmatter summary (or `## Summary` section) is injected.
 *   - `full`    — the full body bytes are injected.
 *   - `rule`    — the body is treated as imperative agent rules.
 */
export type InjectMode = "none" | "path" | "summary" | "full" | "rule";

/** Four typed top-level buckets. */
export type MemoryDocType = "memory" | "skill" | "design" | "reference";

/** Body-marker prefix. */
const BODY_MARKER_PREFIX = "omp";

const BODY_START = `<!-- ${BODY_MARKER_PREFIX}:body:start -->`;
const BODY_END = `<!-- ${BODY_MARKER_PREFIX}:body:end -->`;
const RULES_START = `<!-- ${BODY_MARKER_PREFIX}:maintain-rules:start -->`;
const RULES_END = `<!-- ${BODY_MARKER_PREFIX}:maintain-rules:end -->`;

export const BODY_MARKERS = {
	bodyStart: BODY_START,
	bodyEnd: BODY_END,
	rulesStart: RULES_START,
	rulesEnd: RULES_END,
} as const;

/**
 * Parsed frontmatter for a memory doc. Open-ended on purpose: unknown keys
 * round-trip verbatim through writes.
 */
export interface MemoryDocFrontmatter {
	id?: string;
	type?: MemoryDocType;
	path?: string;
	title?: string;
	injectMode?: InjectMode;
	inheritInjectMode?: boolean;
	summaryEnabled?: boolean;
	readOnly?: boolean;
	aiMaintained?: boolean;
	inheritAiConfig?: boolean;
	explicitMaintenanceRules?: boolean;
	seedVersion?: number;
	createdAt?: number;
	updatedAt?: number;
	/**
	 * Opt-in: when `true`, the doc becomes invocable as
	 * `/knowledge:<type>/<path>` in interactive / ACP frontends. Loading the
	 * body region into context is read-only, mirroring the `/skill:<name>`
	 * surface. Omit (or set to `false`) to keep the doc out of the slash menu.
	 */
	commandEnabled?: boolean;
	[key: string]: unknown;
}

/**
 * A parsed memory document. `raw` is the verbatim source we read off disk so
 * non-body regions can be reproduced byte-for-byte on write.
 */
export interface MemoryDoc {
	frontmatter: MemoryDocFrontmatter;
	raw: string;
	body: string;
	/** `[start, end)` byte offsets in `raw` for the body region (between markers). */
	bodyRange?: { start: number; end: number };
	/** `true` when the doc carries `<!-- omp:body:start -->` markers. */
	hasBodyMarkers: boolean;
}

/**
 * Parse a memory document, preserving the raw bytes for non-destructive rewrites.
 *
 * Unlike `parseFrontmatter`, this never strips HTML comments and never trims
 * the body — we need the markers intact and the offsets stable.
 */
export function parseMemoryDoc(raw: string): MemoryDoc {
	const normalized = raw.replace(/\r\n?/g, "\n");

	// Extract frontmatter via the shared parser (frontmatter values only; we
	// do not trust its body output because it strips comments).
	const { frontmatter } = parseFrontmatter(normalized, { normalize: false, level: "off" });

	// Locate body markers in the raw text (post line-ending normalization).
	const startIdx = normalized.indexOf(BODY_START);
	let bodyRange: { start: number; end: number } | undefined;
	if (startIdx !== -1) {
		const afterStart = startIdx + BODY_START.length;
		const endIdx = normalized.indexOf(BODY_END, afterStart);
		if (endIdx !== -1) {
			// Body region excludes the markers themselves. Newlines around the
			// markers are part of the body.
			bodyRange = { start: afterStart, end: endIdx };
		}
	}

	const body = bodyRange ? normalized.slice(bodyRange.start, bodyRange.end) : "";

	return {
		frontmatter: frontmatter as MemoryDocFrontmatter,
		raw: normalized,
		body,
		bodyRange,
		hasBodyMarkers: bodyRange !== undefined,
	};
}

/**
 * Rewrite the body region of an existing doc, preserving frontmatter,
 * heading, summary, and maintenance rules byte-for-byte.
 *
 * Returns the new file contents, or `undefined` if the doc has no body
 * markers (callers MUST treat that as "do not write — user owns this doc").
 */
export function rewriteDocBody(doc: MemoryDoc, newBody: string): string | undefined {
	if (!doc.bodyRange) return undefined;
	const body = `\n${newBody.trim()}\n`;
	return `${doc.raw.slice(0, doc.bodyRange.start)}${body}${doc.raw.slice(doc.bodyRange.end)}`;
}

/** Options for assembling a fresh memory doc with frontmatter + markers. */
export interface BuildDocOptions {
	frontmatter: MemoryDocFrontmatter;
	title: string;
	summary?: string;
	maintenanceRules?: readonly string[];
	body: string;
}

/**
 * Build a complete memory document with frontmatter, summary, maintenance
 * rules, and a body region enclosed in markers.
 *
 * Always emits markers, so future Phase-2 writes can mutate the body
 * without trampling other regions.
 */
export function buildMemoryDoc(options: BuildDocOptions): string {
	const fm = stringifyFrontmatter(options.frontmatter);
	const parts: string[] = [fm, `# ${options.title.trim()}`, ""];
	const summary = options.summary?.trim();
	if (summary) {
		parts.push("## Summary", summary, "");
	}
	const rules = options.maintenanceRules?.filter(rule => rule.trim().length > 0);
	if (rules && rules.length > 0) {
		parts.push(RULES_START);
		for (const rule of rules) {
			const trimmed = rule.trim().replace(/^[-*]\s*/, "");
			parts.push(`- ${trimmed}`);
		}
		parts.push(RULES_END, "");
	}
	parts.push(BODY_START, options.body.trim(), BODY_END, "");
	return parts.join("\n");
}

/**
 * Wrap a fresh body with the start/end markers without recreating
 * frontmatter or other regions. Used when we have a doc the model produced
 * as plain markdown and need to attach body markers before first write.
 */
export function wrapBodyWithMarkers(body: string): string {
	return `${BODY_START}\n${body.trim()}\n${BODY_END}\n`;
}

/**
 * Serialize a frontmatter object as a `---`-fenced YAML block. Keys are
 * emitted in insertion order; YAML strings are auto-quoted when needed.
 */
export function stringifyFrontmatter(frontmatter: MemoryDocFrontmatter): string {
	const body = YAML.stringify(frontmatter).trimEnd();
	return `---\n${body}\n---\n`;
}

/**
 * Derive a deterministic id slug from a relative path. Produces a stable
 * `kd_<slug>` shape so docs are addressable by id even when paths change.
 */
export function deriveDocId(relativePath: string): string {
	const slug = relativePath
		.replace(/\.md$/i, "")
		.replace(/[\\/]/g, "_")
		.replace(/[^A-Za-z0-9_-]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
	return `kd_${slug || "doc"}`;
}

/**
 * Monotonic seed version. Bump when the embedded built-in seed doc
 * contents change — older seeds with a lower `seedVersion` are refreshed
 * in-place (frontmatter + rules only; body is preserved).
 */
export const MEMORY_BUILTIN_SEED_VERSION = 2;

/**
 * Per-type default `summaryEnabled` value when a doc's frontmatter omits
 * the field. Skill and reference docs default to summary-on (they are
 * commonly injected by summary); memory and design default off.
 */
export function defaultSummaryEnabledForType(type: MemoryDocType): boolean {
	return type === "skill" || type === "reference";
}

/**
 * Per-type fallback maintenance-rules used when a caller creates an
 * `aiMaintained: true` doc without supplying rules. AI-maintained docs
 * always carry a non-empty rules section, so this fills the gap when the
 * caller omits them.
 */
export function defaultMaintenanceRulesForType(type: MemoryDocType): readonly string[] {
	switch (type) {
		case "memory":
			return [
				"Keep entries durable and reusable; consolidate duplicates into the latest conclusion.",
				"Drop transient context, one-off tasks, and unsupported guesses.",
			];
		case "skill":
			return [
				"Keep workflow steps, checks, and outputs stable across runs.",
				"Update key steps when the underlying tools or process change.",
				"Remove obsolete commands, duplicate notes, and expired limits.",
			];
		case "design":
			return [
				"Record confirmed design decisions and constraints.",
				"Keep open questions current; replace outdated approaches in place.",
				"Preserve the document structure while updating details.",
			];
		case "reference":
			return [
				"Capture verifiable facts, interfaces, and constraints.",
				"Prefer durable conclusions and version-specific differences.",
				"Drop outdated examples and unverified details.",
			];
	}
}

/**
 * Input shape for `validateMemoryDoc`. Only the fields the validator
 * inspects need to be supplied.
 */
export interface ValidateMemoryDocInput {
	type: MemoryDocType;
	injectMode?: InjectMode;
	aiMaintained?: boolean;
	explicitMaintenanceRules?: boolean;
	maintenanceRules?: readonly string[] | string | null;
}

/**
 * Structural invariants for a memory document. Returns a refusal string
 * when the document is malformed; `undefined` when valid.
 *
 * Enforced rules:
 *   - `aiMaintained: true` requires `explicitMaintenanceRules: true`.
 *   - `aiMaintained: true` requires non-empty maintenance rules.
 *   - `skill` / `reference` docs cannot use `injectMode=full` or `injectMode=rule`.
 */
export function validateMemoryDoc(input: ValidateMemoryDocInput): string | undefined {
	const aiMaintained = input.aiMaintained === true;
	const rules = input.maintenanceRules;
	const rulesArray = Array.isArray(rules)
		? rules
		: typeof rules === "string"
			? rules
					.split(/\r?\n/)
					.map(r => r.replace(/^\s*[-*]\s+/, "").trim())
					.filter(Boolean)
			: [];
	const rulesHaveContent = rulesArray.some(r => r.trim().length > 0);

	if (aiMaintained && input.explicitMaintenanceRules !== true) {
		return "aiMaintained=true requires explicitMaintenanceRules=true";
	}
	if (aiMaintained && !rulesHaveContent) {
		return "aiMaintained=true requires non-empty maintenance rules";
	}
	const mode = input.injectMode;
	if ((input.type === "skill" || input.type === "reference") && (mode === "full" || mode === "rule")) {
		return `${input.type} documents cannot use injectMode=full or injectMode=rule`;
	}
	return undefined;
}
