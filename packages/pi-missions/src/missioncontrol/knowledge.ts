/**
 * Shared knowledge library (Track F).
 *
 * Append-only per-project markdown file at `<projectDir>/knowledge.md`
 * that workers + validators + orchestrators read/write through.
 * Persistence spans missions \u2014 the knowledge accrued during one mission
 * is available when the next planner runs on the same project.
 *
 * File structure:
 *
 *     # Mission Knowledge Library
 *
 *     ## M-001 \u2014 Refactor reporting pipeline
 *     - 2026-04-22T10:15:00.000Z \u2014 scrutiny: workers consistently skip STATUS.md updates after ad-hoc commits.
 *     - 2026-04-22T10:17:00.000Z \u2014 user-testing: the CLI's `--json` flag must honor UTC timestamps.
 *
 *     ## (project) \u2014 General observations
 *     - 2026-04-22T12:00:00.000Z \u2014 planner: prefer `Bun.spawn` over `$` for long-running processes.
 *
 * Each entry is one bullet:
 *     `- <ISO timestamp> \u2014 <author>: <body>`
 *
 * Sections are grouped by `scope` (usually a milestoneId or the literal
 * string `"project"` for cross-milestone observations). New entries
 * append to the matching section, or create it if absent.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { projectDir } from "./adapter";

/** Filename of the per-project knowledge library. */
export const KNOWLEDGE_FILENAME = "knowledge.md";

/** Markdown heading for the top of the file. */
const FILE_HEADER = "# Mission Knowledge Library";

/** Scope token used for observations that aren't milestone-bound. */
export const KNOWLEDGE_GLOBAL_SCOPE = "(project)" as const;

/** One rendered knowledge entry. */
export interface KnowledgeEntry {
	/** Scope (milestoneId or `"(project)"`). */
	scope: string;
	/** ISO-8601 timestamp. */
	timestamp: string;
	/** Free-form author label (e.g. `"scrutiny-validator"`, `"user-testing-validator"`, `"planner"`, `"worker:F-001"`). */
	author: string;
	/** Entry body text (single line after trimming). */
	body: string;
	/** Optional section title shown in the `## scope \u2014 title` heading. */
	title?: string;
}

/** Resolve the absolute path for the knowledge file. */
export function knowledgePath(cwd: string): string {
	return path.join(projectDir(cwd), KNOWLEDGE_FILENAME);
}

/**
 * Escape characters that would corrupt a Markdown heading.
 *
 * We do NOT allow newlines in the scope/title to keep parsing trivial.
 */
function sanitizeHeadingFragment(s: string): string {
	return s.replace(/[\r\n]+/g, " ").trim();
}

/** One-line sanitiser for entry bodies. Collapses line breaks to spaces. */
function sanitizeEntryBody(body: string): string {
	return body.replace(/\r?\n/g, " ").trim();
}

/**
 * Build the heading line for a scope. When `title` is omitted, the scope
 * alone becomes the heading (`## M-001`).
 */
function buildHeading(scope: string, title?: string): string {
	const safeScope = sanitizeHeadingFragment(scope);
	const safeTitle = title ? sanitizeHeadingFragment(title) : "";
	return safeTitle ? `## ${safeScope} \u2014 ${safeTitle}` : `## ${safeScope}`;
}

/** Build the single-line bullet for an entry. */
function renderBullet(entry: KnowledgeEntry): string {
	return `- ${entry.timestamp} \u2014 ${sanitizeHeadingFragment(entry.author)}: ${sanitizeEntryBody(entry.body)}`;
}

/**
 * Append an entry to the knowledge library, creating the file and/or
 * section as needed.
 *
 * Appending preserves the existing file verbatim; we do not rewrite the
 * whole document. New sections are added at the end; existing sections
 * grow bullets inline.
 */
export async function appendKnowledgeEntry(cwd: string, entry: KnowledgeEntry): Promise<void> {
	const filePath = knowledgePath(cwd);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const heading = buildHeading(entry.scope, entry.title);
	const bullet = renderBullet(entry);

	let existing: string;
	try {
		existing = await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err)) throw err;
		// File absent \u2014 build the initial document.
		const contents = `${FILE_HEADER}\n\n${heading}\n${bullet}\n`;
		await Bun.write(filePath, contents);
		return;
	}

	// Ensure the file ends with a single trailing newline before we append.
	const base = existing.endsWith("\n") ? existing : `${existing}\n`;

	// Section already present?
	const sectionStart = findSectionStart(base, heading);
	if (sectionStart === -1) {
		const separator = base.endsWith("\n\n") ? "" : "\n";
		await Bun.write(filePath, `${base}${separator}${heading}\n${bullet}\n`);
		return;
	}

	// Append bullet at the END of this section (before the next `## ` heading
	// or end of file). New bullet goes right after the last existing bullet
	// so chronological order matches file order.
	const sectionBodyStart = base.indexOf("\n", sectionStart) + 1;
	const nextHeadingRel = base.slice(sectionBodyStart).search(/^##\s/m);
	const insertAt = nextHeadingRel === -1 ? base.length : sectionBodyStart + nextHeadingRel;

	// Insert bullet right before `insertAt`. Trim trailing blank lines before
	// the next section so we don't accumulate gaps.
	const before = base.slice(0, insertAt).replace(/\n+$/, "\n");
	const after = base.slice(insertAt);
	await Bun.write(filePath, `${before}${bullet}\n${after.startsWith("\n") ? "" : "\n"}${after}`);
}

/**
 * Locate a section heading in the file. Returns the character offset of
 * the heading's first character, or `-1` when absent. Exact match on the
 * heading line (up to a trailing newline).
 */
function findSectionStart(text: string, heading: string): number {
	const re = new RegExp(`^${escapeRegex(heading)}\\s*$`, "m");
	const match = re.exec(text);
	return match ? match.index : -1;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read every entry in the knowledge file. Returns `[]` when the file is
 * missing. Entries are returned in file order (matches append order when
 * every writer used `appendKnowledgeEntry`).
 *
 * `scope` is extracted from the nearest `##` heading above each bullet;
 * bullets without a preceding heading are skipped (they'd be an operator
 * edit mistake). Author + timestamp come from the bullet's lead.
 */
export async function readKnowledgeEntries(cwd: string): Promise<KnowledgeEntry[]> {
	const filePath = knowledgePath(cwd);
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	return parseKnowledgeText(text);
}

/**
 * Parse a knowledge file's text into structured entries.
 *
 * Exported for testability; production callers should use
 * {@link readKnowledgeEntries} which handles the I/O + missing file.
 */
export function parseKnowledgeText(text: string): KnowledgeEntry[] {
	const lines = text.split(/\r?\n/);
	const entries: KnowledgeEntry[] = [];
	let currentScope: string | null = null;
	let currentTitle: string | undefined;
	const headingRe = /^##\s+(.+?)(?:\s+\u2014\s+(.+))?$/;
	const bulletRe = /^-\s+(\S+)\s+\u2014\s+([^:]+):\s*(.+)$/;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const headingMatch = headingRe.exec(trimmed);
		if (headingMatch) {
			currentScope = sanitizeHeadingFragment(headingMatch[1] ?? "");
			currentTitle = headingMatch[2] ? sanitizeHeadingFragment(headingMatch[2]) : undefined;
			continue;
		}
		const bulletMatch = bulletRe.exec(trimmed);
		if (!bulletMatch || !currentScope) continue;
		const [, timestamp, author, body] = bulletMatch;
		if (!timestamp || !author || body === undefined) continue;
		const entry: KnowledgeEntry = {
			scope: currentScope,
			timestamp,
			author: author.trim(),
			body: body.trim(),
		};
		if (currentTitle) entry.title = currentTitle;
		entries.push(entry);
	}

	return entries;
}

/**
 * Produce a human-readable summary of the knowledge library.
 *
 * @param scope optional filter \u2014 when set, only entries for that scope
 *   are included (plus any `"(project)"` entries).
 * @param limit max entries to include (default 20, newest first).
 */
export async function summariseKnowledge(cwd: string, scope?: string, limit: number = 20): Promise<string> {
	const entries = await readKnowledgeEntries(cwd);
	const filtered = scope ? entries.filter(e => e.scope === scope || e.scope === KNOWLEDGE_GLOBAL_SCOPE) : entries;
	if (filtered.length === 0) {
		return scope ? `No knowledge entries for scope "${scope}".` : "No knowledge entries recorded.";
	}
	// Newest first by timestamp.
	const sorted = [...filtered].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	const limited = sorted.slice(0, Math.max(1, limit));
	const lines: string[] = [
		`Knowledge library \u2014 ${filtered.length} entr${filtered.length === 1 ? "y" : "ies"}${scope ? ` in scope ${scope}` : ""} (showing latest ${limited.length}):`,
	];
	for (const e of limited) {
		const header = e.title ? `${e.scope} / ${e.title}` : e.scope;
		lines.push(`  [${e.timestamp}] ${header} \u2014 ${e.author}: ${e.body}`);
	}
	return lines.join("\n");
}

/**
 * Convenience: ingest a validator's `lessons` array into the knowledge
 * library as individual entries scoped to the milestone.
 *
 * Returns the number of entries actually appended (empty + whitespace-only
 * lessons are skipped).
 */
export async function ingestValidatorLessons(
	cwd: string,
	milestoneId: string,
	author: string,
	lessons: readonly string[],
	now: number = Date.now(),
): Promise<number> {
	let count = 0;
	for (const lesson of lessons) {
		const body = lesson.trim();
		if (!body) continue;
		await appendKnowledgeEntry(cwd, {
			scope: milestoneId,
			timestamp: new Date(now).toISOString(),
			author,
			body,
		});
		count += 1;
	}
	return count;
}
