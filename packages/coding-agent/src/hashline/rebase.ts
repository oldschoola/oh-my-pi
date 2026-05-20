/**
 * In-file delta rebase for stale hashline anchors.
 *
 * When a model authors edits whose anchors point at the right *content* but
 * the wrong *line number* (because some other party inserted or deleted lines
 * above the edit region between read and edit), the strict per-anchor hash
 * check rejects the edit. This module attempts a content-verified rebase
 * before surfacing the mismatch.
 *
 * SAFETY: hashline hashes are 2 characters over 647 buckets, so collisions
 * across unrelated lines are common. Hash equality alone is NOT sufficient
 * evidence to relocate an edit — a colliding line elsewhere in the file
 * would silently corrupt unrelated code. The rebase therefore requires
 * each rebased group to carry at least one **content-verified** anchor:
 * the caller supplies an `expectedContent` map (typically the per-session
 * `FileReadSnapshot` the model last observed) and the candidate target's
 * line text MUST exactly equal what the model expected at the stored
 * line number. Groups whose anchors are entirely outside the snapshot
 * fall through to the original mismatch error rather than risk a
 * hash-collision-driven misplacement.
 *
 * Algorithm:
 *  1. Group edits by source diff line (`HashlineEdit.lineNum`). Every group
 *     produced by the parser shares a source line — multi-line ranges expand
 *     to many edits all carrying the same `lineNum`. Anchors in one group
 *     MUST shift by the same delta or the range corrupts.
 *  2. For each group with at least one mismatched boundary anchor, find a
 *     single uniform delta `D` such that every boundary anchor in the group
 *     matches (by content if known, else by hash) when shifted by `D`. At
 *     least one anchor in the group must be content-verified at that delta.
 *  3. Accept only when exactly one such `D` exists. Multiple candidates,
 *     no candidates, or candidates with zero verified anchors all fall
 *     through to the original mismatch error.
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

interface AnchorMatch {
	/** Whether the candidate line satisfies the anchor (content or hash check). */
	ok: boolean;
	/** Whether the match was verified against caller-supplied expected content. */
	verified: boolean;
}

function getEditAnchor(edit: HashlineEdit): Anchor | undefined {
	if (edit.kind === "delete") return edit.anchor;
	if (edit.cursor.kind === "before_anchor") return edit.cursor.anchor;
	if (edit.cursor.kind === "after_anchor") return edit.cursor.anchor;
	return undefined;
}

function anchorMatchesAt(
	anchor: Anchor,
	fileLines: string[],
	delta: number,
	expectedContent: ReadonlyMap<number, string> | undefined,
): AnchorMatch {
	const targetLine = anchor.line + delta;
	if (targetLine < 1 || targetLine > fileLines.length) return { ok: false, verified: false };
	if (anchor.hash === RANGE_INTERIOR_HASH) return { ok: true, verified: false };

	const actualText = fileLines[targetLine - 1] ?? "";
	const expectedText = expectedContent?.get(anchor.line);
	if (expectedText !== undefined) {
		return { ok: expectedText === actualText, verified: true };
	}
	return { ok: computeLineHash(targetLine, actualText) === anchor.hash, verified: false };
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

interface DeltaCandidate {
	delta: number;
	verifiedAnchorCount: number;
}

/**
 * Find every delta `D` such that every boundary anchor in `anchors`
 * satisfies the match check when its line is shifted by `D`. For each
 * candidate we also tally how many anchors were content-verified by the
 * caller's snapshot, so the safety gate can require at least one.
 *
 * The search seeds candidates from the first anchor and verifies each
 * candidate against the rest. The seed iteration recomputes hashes per
 * line, which is O(N) in file length per group.
 */
function findCandidateDeltas(
	anchors: Anchor[],
	fileLines: string[],
	expectedContent: ReadonlyMap<number, string> | undefined,
): DeltaCandidate[] {
	if (anchors.length === 0) return [];
	const [seedAnchor, ...rest] = anchors;
	const seedExpected = expectedContent?.get(seedAnchor.line);
	const candidates: DeltaCandidate[] = [];
	for (let lineIdx = 0; lineIdx < fileLines.length; lineIdx++) {
		const targetLine = lineIdx + 1;
		const text = fileLines[lineIdx] ?? "";
		// Seed acceptance: content if we know it, else hash.
		if (seedExpected !== undefined) {
			if (text !== seedExpected) continue;
		} else if (computeLineHash(targetLine, text) !== seedAnchor.hash) {
			continue;
		}
		const delta = targetLine - seedAnchor.line;
		let verifiedCount = seedExpected !== undefined ? 1 : 0;
		let allMatch = true;
		for (const other of rest) {
			const m = anchorMatchesAt(other, fileLines, delta, expectedContent);
			if (!m.ok) {
				allMatch = false;
				break;
			}
			if (m.verified) verifiedCount++;
		}
		if (allMatch) {
			candidates.push({ delta, verifiedAnchorCount: verifiedCount });
		}
	}
	return candidates;
}

function anchorHashMatchesAtZero(anchor: Anchor, fileLines: string[]): boolean {
	const targetLine = anchor.line;
	if (targetLine < 1 || targetLine > fileLines.length) return false;
	if (anchor.hash === RANGE_INTERIOR_HASH) return true;
	const actualText = fileLines[targetLine - 1] ?? "";
	return computeLineHash(targetLine, actualText) === anchor.hash;
}

// At delta 0 the rebase must defer to hash, not content. The strict validator
// upstream already uses hash equality; if content happens to match the
// snapshot while the hash does not, we'd silently accept a mistyped-hash
// edit when another group in the batch rebases (the apply path does not
// re-validate hashes after a successful rebase). Hash gating here keeps
// `tryRebaseHashlineEdits` from regressing the strict-validator's hash
// guarantee for in-place groups.
function groupBoundaryHasMismatch(anchors: Anchor[], fileLines: string[]): boolean {
	return anchors.some(a => !anchorHashMatchesAtZero(a, fileLines));
}

/**
 * Try to rebase every mismatched edit-group by a uniform delta. Returns the
 * rebased edit list and a warning when every group resolves to a single
 * unambiguous delta backed by sufficient evidence (see file header).
 * Returns `null` when any group is unresolvable, ambiguous, or rests on
 * hash-only evidence too weak to be safe.
 */
export function tryRebaseHashlineEdits(
	edits: HashlineEdit[],
	fileLines: string[],
	expectedContent?: ReadonlyMap<number, string>,
): HashlineRebaseResult | null {
	const groups = groupEditsBySourceLine(edits);
	const deltaByGroup = new Map<number, number>();
	let totalShifted = 0;

	for (const group of groups) {
		if (!groupBoundaryHasMismatch(group.boundaryAnchors, fileLines)) {
			deltaByGroup.set(group.sourceLineNum, 0);
			continue;
		}
		if (group.boundaryAnchors.length === 0) return null;

		const candidates = findCandidateDeltas(group.boundaryAnchors, fileLines, expectedContent);
		if (candidates.length !== 1) return null;
		const candidate = candidates[0];
		if (candidate.delta === 0) return null;

		// Safety gate: require at least one content-verified anchor in the
		// group. Pure hash matches are too weak (2-char hash, 647 buckets)
		// to relocate an edit safely on their own — see file header.
		if (candidate.verifiedAnchorCount === 0) return null;

		deltaByGroup.set(group.sourceLineNum, candidate.delta);
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
