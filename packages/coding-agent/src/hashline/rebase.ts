/**
 * In-file delta rebase for stale hashline anchors.
 *
 * When a model authors edits whose anchors point at the right *content* but
 * the wrong *line number* (because some other party inserted or deleted lines
 * above the edit region between read and edit), the strict per-anchor hash
 * check rejects the edit. This module attempts a safe, content-driven rebase
 * before surfacing the mismatch:
 *
 *  1. Group edits by source diff line (`HashlineEdit.lineNum`). Every group
 *     produced by the parser shares a source line — multi-line ranges expand
 *     to many edits all carrying the same `lineNum`. Anchors in one group
 *     MUST shift by the same delta or the range corrupts.
 *
 *  2. For each group with at least one mismatched boundary anchor, find a
 *     single uniform delta `D` such that every boundary anchor in the group
 *     hash-matches when shifted by `D`. Interior anchors (filler hash) shift
 *     by the same `D` for consistency.
 *
 *  3. The delta MUST be unique within the candidate set — if two different
 *     `D` values both produce a valid rebase, the target is ambiguous and we
 *     fall back to the mismatch error. This preserves the safety invariant
 *     that duplicated content cannot be silently relocated.
 *
 * Groups whose boundary anchors all currently validate are left alone (delta
 * `0`). A mixed group with both matched and mismatched boundary anchors has
 * no valid uniform delta and forces fallback.
 */

import { RANGE_INTERIOR_HASH } from "./constants";
import { computeLineHash } from "./hash";
import type { Anchor, HashlineEdit } from "./types";

const REBASE_WARNING_PREFIX = "Recovered from stale anchors by shifting line numbers to match current file content";

export interface HashlineRebaseResult {
	edits: HashlineEdit[];
	warning: string;
}

interface RebaseGroup {
	sourceLineNum: number;
	edits: HashlineEdit[];
	boundaryAnchors: Anchor[];
}

function getEditAnchor(edit: HashlineEdit): Anchor | undefined {
	if (edit.kind === "delete") return edit.anchor;
	if (edit.cursor.kind === "before_anchor") return edit.cursor.anchor;
	if (edit.cursor.kind === "after_anchor") return edit.cursor.anchor;
	return undefined;
}

function anchorMatchesAt(anchor: Anchor, fileLines: string[], delta: number): boolean {
	const targetLine = anchor.line + delta;
	if (targetLine < 1 || targetLine > fileLines.length) return false;
	if (anchor.hash === RANGE_INTERIOR_HASH) return true;
	return computeLineHash(targetLine, fileLines[targetLine - 1] ?? "") === anchor.hash;
}

function shiftAnchor(anchor: Anchor, delta: number): Anchor {
	return delta === 0 ? anchor : { ...anchor, line: anchor.line + delta };
}

function shiftEdit(edit: HashlineEdit, delta: number): HashlineEdit {
	if (delta === 0) return edit;
	if (edit.kind === "delete") {
		return { ...edit, anchor: shiftAnchor(edit.anchor, delta) };
	}
	if (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor") {
		return {
			...edit,
			cursor: { ...edit.cursor, anchor: shiftAnchor(edit.cursor.anchor, delta) },
		};
	}
	return edit;
}

function groupEditsBySourceLine(edits: HashlineEdit[]): RebaseGroup[] {
	const groups = new Map<number, RebaseGroup>();
	for (const edit of edits) {
		let group = groups.get(edit.lineNum);
		if (!group) {
			group = { sourceLineNum: edit.lineNum, edits: [], boundaryAnchors: [] };
			groups.set(edit.lineNum, group);
		}
		group.edits.push(edit);
		const anchor = getEditAnchor(edit);
		if (anchor && anchor.hash !== RANGE_INTERIOR_HASH) {
			group.boundaryAnchors.push(anchor);
		}
	}
	return [...groups.values()];
}

/**
 * Find every delta `D` such that every boundary anchor in `anchors`
 * hash-matches when its line is shifted by `D`. Returns the candidate set
 * sorted by absolute distance; an empty array means no delta works.
 *
 * The search seeds candidates from the first anchor: any line in the file
 * whose hash matches anchor[0].hash defines a candidate `D = L - anchor[0].line`.
 * Each candidate is then verified against the remaining anchors. This is
 * O(N) in file length per group (vs. O(N*M) brute force).
 */
function findCandidateDeltas(anchors: Anchor[], fileLines: string[]): number[] {
	if (anchors.length === 0) return [];
	const [seedAnchor, ...rest] = anchors;
	const candidates: number[] = [];
	for (let lineIdx = 0; lineIdx < fileLines.length; lineIdx++) {
		const targetLine = lineIdx + 1;
		const actualHash = computeLineHash(targetLine, fileLines[lineIdx] ?? "");
		if (actualHash !== seedAnchor.hash) continue;
		const delta = targetLine - seedAnchor.line;
		if (rest.every(a => anchorMatchesAt(a, fileLines, delta))) {
			candidates.push(delta);
		}
	}
	return candidates;
}

function groupBoundaryHasMismatch(anchors: Anchor[], fileLines: string[]): boolean {
	return anchors.some(a => !anchorMatchesAt(a, fileLines, 0));
}

/**
 * Try to rebase every mismatched edit-group by a uniform delta. Returns the
 * rebased edit list and a warning when every group resolves to a single
 * unambiguous delta; returns `null` when any group is unresolvable or
 * ambiguous, signalling the caller to surface the original mismatch error.
 */
export function tryRebaseHashlineEdits(edits: HashlineEdit[], fileLines: string[]): HashlineRebaseResult | null {
	const groups = groupEditsBySourceLine(edits);
	const deltaByGroup = new Map<number, number>();
	let totalShifted = 0;

	for (const group of groups) {
		if (!groupBoundaryHasMismatch(group.boundaryAnchors, fileLines)) {
			deltaByGroup.set(group.sourceLineNum, 0);
			continue;
		}
		if (group.boundaryAnchors.length === 0) return null;
		const candidates = findCandidateDeltas(group.boundaryAnchors, fileLines);
		if (candidates.length !== 1) return null;
		const delta = candidates[0];
		if (delta === 0) return null; // mismatch but only zero-shift "works": impossible by construction
		deltaByGroup.set(group.sourceLineNum, delta);
		totalShifted++;
	}

	if (totalShifted === 0) return null;

	const rebased = edits.map(edit => {
		const delta = deltaByGroup.get(edit.lineNum) ?? 0;
		return shiftEdit(edit, delta);
	});

	const sample = [...deltaByGroup.entries()]
		.filter(([, d]) => d !== 0)
		.map(([src, d]) => `op@${src}: ${d > 0 ? "+" : ""}${d}`)
		.join(", ");
	const warning = `${REBASE_WARNING_PREFIX} (${sample}).`;

	return { edits: rebased, warning };
}
