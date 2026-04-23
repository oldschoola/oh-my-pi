/**
 * Shared formatters for dashboard components.
 *
 * Every component renders durations, token counts, percentages, and relative
 * timestamps the same way — duplicating these helpers per file caused visible
 * UI inconsistency (one variant dropped seconds at >=1h, others didn't).
 */

import { formatDistanceToNow } from "date-fns";

/**
 * Format a millisecond duration as `"Xs"`, `"Xm Ys"`, or `"Xh Ym Zs"`.
 * Negative or zero input returns `"0s"`.
 */
export function formatDuration(ms: number): string {
	if (ms <= 0) return "0s";
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	if (m < 60) return `${m}m ${s}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m ${s}s`;
}

/**
 * Like {@link formatDuration} but returns `null` for `undefined`/`null` input
 * or negative durations. Used in history cards where the duration column
 * should be left blank rather than rendered as `"0s"`.
 */
export function formatDurationOrNull(ms?: number | null): string | null {
	if (ms === undefined || ms === null) return null;
	if (ms < 0) return null;
	return formatDuration(ms);
}

/** Format a token count compactly: `"0"`, `"123"`, `"1.2k"`, `"3.4M"`. */
export function formatTokens(n: number): string {
	if (n === 0) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/** Map a 0-100 percentage onto the dashboard's progress-bar fill class. */
export function pctClass(pct: number): string {
	if (pct >= 100) return "pct-hi";
	if (pct >= 50) return "pct-mid";
	if (pct > 0) return "pct-low";
	return "pct-0";
}

/**
 * Render a timestamp as `"about 2 hours ago"`. Empty string for `undefined`,
 * raw stringified input for unparseable values.
 */
export function formatRelative(iso?: string | number | null): string {
	if (iso === undefined || iso === null) return "";
	try {
		return formatDistanceToNow(new Date(iso), { addSuffix: true });
	} catch {
		return String(iso);
	}
}

/** Format a USD cost into `$0.00` / `$0.0042` depending on magnitude. */
export function formatCost(n: number): string {
	if (n <= 0) return "$0";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

/**
 * Parse a `<taskId>::<repoId>[::<N>]` segment id into its parts.
 * Returns null on malformed inputs.
 */
export function parseSegmentId(segmentId: string): { taskId: string; repoId: string } | null {
	if (!segmentId || typeof segmentId !== "string") return null;
	const sep = segmentId.indexOf("::");
	if (sep <= 0 || sep >= segmentId.length - 2) return null;
	const taskId = segmentId.slice(0, sep);
	const rest = segmentId.slice(sep + 2);
	const nextSep = rest.indexOf("::");
	const repoId = nextSep >= 0 ? rest.slice(0, nextSep) : rest;
	return { taskId, repoId };
}

export interface SegmentProgressInfo {
	index: number;
	total: number;
	repoId?: string;
	segmentId?: string;
}

/**
 * Compute `Segment N/M: <repoId>` info for a task. Returns null when the task
 * has <= 1 segment (single-repo path) or no segment metadata.
 */
export function taskSegmentProgress(task: {
	segmentIds?: string[];
	activeSegmentId?: string | null;
	repoId?: string;
	resolvedRepoId?: string;
	status?: string;
}): SegmentProgressInfo | null {
	const segmentIds = Array.isArray(task.segmentIds) ? task.segmentIds.filter(id => typeof id === "string") : [];
	if (segmentIds.length <= 1) return null;
	const activeId = task.activeSegmentId && segmentIds.includes(task.activeSegmentId) ? task.activeSegmentId : null;
	const currentId = activeId ?? segmentIds[segmentIds.length - 1];
	const idx = Math.max(0, segmentIds.indexOf(currentId));
	const parsed = parseSegmentId(currentId);
	return {
		index: idx + 1,
		total: segmentIds.length,
		repoId: parsed?.repoId ?? task.resolvedRepoId ?? task.repoId,
		segmentId: currentId,
	};
}

export function segmentProgressText(info: SegmentProgressInfo): string {
	const repo = info.repoId ?? "unknown";
	if (info.index && info.total) return `Segment ${info.index}/${info.total}: ${repo}`;
	return `Segment: ${repo}`;
}

/**
 * Filter STATUS.md to keep only `#### Segment: <activeRepoId>` blocks within
 * each `### Step N:` section. Non-step content stays untouched.
 *
 * Mirrors taskplane `filterStatusMdForSegment`. Used by the TerminalViewer's
 * STATUS.md column when a multi-segment task is selected.
 */
export function filterStatusMdForSegment(markdown: string, activeRepoId: string): string {
	if (!activeRepoId) return markdown;
	const lines = markdown.split("\n");
	const result: string[] = [];
	let inStep = false;
	let inSegmentBlock = false;
	let segmentMatch = false;
	let foundAnySegmentHeader = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (/^###\s+Step\s+\d+/.test(line)) {
			inStep = true;
			inSegmentBlock = false;
			segmentMatch = false;
			result.push(line);
			continue;
		}
		if (/^###\s+/.test(line) && !/^###\s+Step\s+\d+/.test(line)) {
			inStep = false;
			inSegmentBlock = false;
			segmentMatch = false;
			result.push(line);
			continue;
		}
		if (inStep && /^####\s+Segment:\s*/.test(line)) {
			foundAnySegmentHeader = true;
			const segRepo = line.replace(/^####\s+Segment:\s*/, "").trim();
			inSegmentBlock = true;
			segmentMatch = segRepo === activeRepoId;
			if (segmentMatch) result.push(line);
			continue;
		}
		if (/^####\s+/.test(line)) {
			inSegmentBlock = false;
			segmentMatch = false;
			result.push(line);
			continue;
		}
		if (inSegmentBlock) {
			if (segmentMatch) result.push(line);
			continue;
		}
		result.push(line);
	}

	if (!foundAnySegmentHeader) return markdown;
	return result.join("\n");
}

// ---------------------------------------------------------------------------
// STATUS.md renderer — sanitized HTML for the Terminal viewer's status column.
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * Render a limited subset of inline Markdown as HTML: **bold**, *italic*,
 * `code`, and autolinks. All other text is HTML-escaped. Inputs are never
 * trusted — we escape first, then apply the small set of replacements on the
 * escaped string using placeholders so that escaped `<` / `>` from literal
 * text can't be confused with generated tags.
 */
export function renderInlineMd(text: string): string {
	let escaped = escapeHtml(text);
	// Code spans are highest priority so their contents are verbatim.
	escaped = escaped.replace(/`([^`]+)`/g, (_m, p1) => `<code class="status-md-code">${p1}</code>`);
	escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	escaped = escaped.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
	return escaped;
}

export interface RenderedStatusMd {
	html: string;
	/** True when at least one checked (`[x]`) line was rendered. */
	hasLastChecked: boolean;
}

/**
 * Render a STATUS.md-style document into sanitized HTML with structural
 * styling hooks the dashboard can target from CSS. Supports:
 *   - `#`, `##`, `###`, `####` headings (h1..h4)
 *   - `- [ ]` / `- [x]` checkbox lines (distinct classes)
 *   - `- ` bullet lines (plain list items)
 *   - Plain text lines (wrapped in `.status-md-text`)
 *   - Blank lines (spacer)
 *
 * The *last* checked line gets `id="last-checked"` so the viewer can
 * scroll-to-cursor when tracking mode is on. All user-supplied text is
 * HTML-escaped via `renderInlineMd`.
 */
export function renderStatusMd(markdown: string): RenderedStatusMd {
	const lines = markdown.split("\n");
	const html: string[] = [];
	let lastCheckedIdx = -1;
	const checkedLineIndices: number[] = [];

	// First pass: find the last checked-box line index so we can tag it.
	for (let i = 0; i < lines.length; i++) {
		if (/^-\s*\[x\]\s+/i.test(lines[i])) {
			lastCheckedIdx = i;
			checkedLineIndices.push(i);
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "") {
			html.push('<div class="status-md-spacer"></div>');
			continue;
		}
		const hMatch = line.match(/^(#{1,4})\s+(.*)$/);
		if (hMatch) {
			const level = hMatch[1].length;
			const content = renderInlineMd(hMatch[2]);
			html.push(`<div class="status-md-h${level}">${content}</div>`);
			continue;
		}
		const checkedMatch = line.match(/^(\s*)-\s*\[(x|X| )\]\s+(.*)$/);
		if (checkedMatch) {
			const checked = checkedMatch[2].toLowerCase() === "x";
			const indent = Math.min(checkedMatch[1].length, 12);
			const content = renderInlineMd(checkedMatch[3]);
			const classes = `status-md-check ${checked ? "checked" : "unchecked"}`;
			const idAttr = i === lastCheckedIdx ? ' id="last-checked"' : "";
			const marker = checked ? "■" : "□";
			html.push(
				`<div class="${classes}" style="padding-left:${indent * 6}px"${idAttr}><span class="status-md-marker">${marker}</span>${content}</div>`,
			);
			continue;
		}
		const bulletMatch = line.match(/^(\s*)-\s+(.*)$/);
		if (bulletMatch) {
			const indent = Math.min(bulletMatch[1].length, 12);
			const content = renderInlineMd(bulletMatch[2]);
			html.push(`<div class="status-md-li" style="padding-left:${indent * 6}px">• ${content}</div>`);
			continue;
		}
		html.push(`<div class="status-md-text">${renderInlineMd(line)}</div>`);
	}

	return { html: html.join("\n"), hasLastChecked: lastCheckedIdx >= 0 };
}
