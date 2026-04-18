// src/detector.ts — Detect phase/feature/milestone transitions from LLM output

import type { MissionPhase } from "./types";

// ---------------------------------------------------------------------------
// Phase Detection
// ---------------------------------------------------------------------------

interface PhaseTransitionResult {
	type: "complete" | "transition";
	phaseIndex: number;
}

/**
 * Detect phase completion or transition signals in LLM output.
 *
 * Builds regex patterns dynamically from the phase list — nothing is hardcoded.
 * Completion only matches phases with status `"active"`.
 * Transition only matches phases with status `"pending"`.
 *
 * @param text - Already-lowercased LLM output
 */
export function detectPhaseTransition(
	text: string,
	phases: MissionPhase[],
	_currentPhase?: number,
): PhaseTransitionResult | null {
	// Escape special regex characters in a name
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	// --- Completion patterns (active phases only) ---
	for (let i = 0; i < phases.length; i++) {
		if (phases[i].status !== "active") continue;

		const num = i + 1; // 1-based index shown to users
		const name = esc(phases[i].name.toLowerCase());

		const completionPatterns = [
			// Explicit phase number patterns
			new RegExp(`phase\\s+${num}\\s+complete`),
			new RegExp(`phase\\s+${num}\\s+done`),
			new RegExp(`phase\\s+${num}\\s+\\(${name}\\)\\s+complete`),
			new RegExp(`${name}\\s+complete`),
			new RegExp(`${name}\\s+phase\\s+complete`),
			new RegExp(`completed\\s+phase\\s+${num}`),
			new RegExp(`completed\\s+the\\s+${name}\\s+phase`),
			// Natural language completion patterns
			new RegExp(`i'?ve?\\s+completed\\s+(?:the\\s+)?${name}`),
			new RegExp(`i'?m\\s+done\\s+(?:with\\s+)?(?:the\\s+)?${name}`),
			new RegExp(`finished\\s+(?:the\\s+)?${name}\\s+phase`),
			new RegExp(`done\\s+with\\s+(?:the\\s+)?${name}`),
			new RegExp(`wrapped\\s+up\\s+(?:the\\s+)?${name}`),
			new RegExp(`${name}\\s+is\\s+done`),
			new RegExp(`${name}\\s+is\\s+complete`),
			new RegExp(`that\\s+concludes\\s+(?:the\\s+)?${name}`),
			new RegExp(`that\\s+wraps\\s+up\\s+(?:the\\s+)?${name}`),
			// Generic "phase complete" without number/name
			new RegExp(`phase\\s+${num}\\s+is\\s+complete`),
			new RegExp(`${name}\\s+phase\\s+is\\s+done`),
		];

		for (const pattern of completionPatterns) {
			if (pattern.test(text)) {
				return { type: "complete", phaseIndex: i };
			}
		}
	}

	// --- Transition patterns (pending phases only) ---
	for (let i = 0; i < phases.length; i++) {
		if (phases[i].status !== "pending") continue;

		const num = i + 1;
		const name = esc(phases[i].name.toLowerCase());

		const transitionPatterns = [
			// Explicit phase number patterns
			new RegExp(`moving\\s+to\\s+phase\\s+${num}`),
			new RegExp(`starting\\s+phase\\s+${num}`),
			new RegExp(`proceeding\\s+to\\s+phase\\s+${num}`),
			new RegExp(`beginning\\s+${name}`),
			new RegExp(`starting\\s+${name}`),
			new RegExp(`now\\s+entering\\s+phase\\s+${num}`),
			// Natural language transition patterns
			new RegExp(`moving\\s+on\\s+to\\s+(?:the\\s+)?${name}`),
			new RegExp(`let'?s\\s+(?:now\\s+)?(?:start|begin|move\\s+to)\\s+${name}`),
			new RegExp(`now\\s+(?:let'?s\\s+)?(?:moving\\s+)?(?:on\\s+)?(?:to\\s+)?(?:the\\s+)?${name}`),
			new RegExp(`proceeding\\s+with\\s+(?:the\\s+)?${name}`),
			new RegExp(`next\\s+up\\s*(?:is\\s*)?(?:the\\s+)?${name}`),
			new RegExp(`transitioning\\s+to\\s+(?:the\\s+)?${name}`),
			new RegExp(`now\\s+(?:moving\\s+)?(?:to|into)\\s+(?:the\\s+)?${name}\\s+phase`),
		];

		for (const pattern of transitionPatterns) {
			if (pattern.test(text)) {
				return { type: "transition", phaseIndex: i };
			}
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Adaptive — proposed phase list
// ---------------------------------------------------------------------------

/** A phase proposed by the planning agent during adaptive-mode planning. */
export interface ProposedPhase {
	emoji: string;
	name: string;
	description: string;
}

/** Matches the `## Proposed Phases` header, tolerating extra whitespace. */
const PROPOSED_HEADER = /^\s*##+\s+proposed\s+phases\b/i;

/**
 * Matches a numbered phase line:
 *   `1. 🔨 Implement Parser — add parser in src/parse.ts`
 *
 * Captures: [_, emoji, name+separator+desc] — we split the tail manually so
 * we can accept any of em-dash / en-dash / colon / hyphen / double-colon as a
 * separator without regex ambiguity.
 */
const PHASE_LINE = /^\s*(?:\d+\.|[-*])\s+(\S+)\s+(.+)$/;

/** Separator characters accepted between the phase name and its description. */
const NAME_DESC_SEPARATORS = /(?:\s+[—–]\s+|:\s+|\s+-{1,2}\s+)/;

/**
 * Parse a `## Proposed Phases` block out of the agent's planning output.
 *
 * Returns the list of proposed phases, or `null` when the section is
 * absent, malformed, or contains no valid phase lines.
 *
 * Accepts the **raw** (case-preserving) message text — unlike
 * {@link detectPhaseTransition}, which wants the lowercased form for its
 * regex matching. Phase names and emojis must retain their original casing.
 */
export function detectProposedPhases(text: string): ProposedPhase[] | null {
	const lines = text.split(/\r?\n/);
	const headerIdx = lines.findIndex(l => PROPOSED_HEADER.test(l));
	if (headerIdx < 0) return null;

	const phases: ProposedPhase[] = [];
	for (let i = headerIdx + 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) {
			// Blank lines terminate the block once we've collected at least one phase.
			if (phases.length > 0) break;
			continue;
		}
		// Any subsequent heading ends the section.
		if (/^\s*#/.test(line)) break;

		const m = line.match(PHASE_LINE);
		if (!m) continue;

		const emoji = m[1];
		const tail = m[2].trim();

		const sep = tail.match(NAME_DESC_SEPARATORS);
		let name: string;
		let description: string;
		if (sep && sep.index !== undefined) {
			name = tail.slice(0, sep.index).trim();
			description = tail.slice(sep.index + sep[0].length).trim();
		} else {
			// No separator — entire tail is the name, description is empty.
			name = tail;
			description = "";
		}

		if (!name) continue;
		// Disallow a proposed "Plan" phase — the seed already contains it.
		if (/^plan\b/i.test(name)) continue;

		phases.push({ emoji, name, description });
	}

	return phases.length >= 1 ? phases : null;
}

// ---------------------------------------------------------------------------
// Adaptive — milestone fallback
// ---------------------------------------------------------------------------

/** Matches `### Milestone N: Name` lines in the plan's Output Format block. */
const MILESTONE_LINE = /^\s*###\s+Milestone\s+\d+\s*[:\-—–]\s*(.+?)\s*$/i;

/**
 * Fallback parser: derive phases from `### Milestone N: Name` headers when
 * the agent's plan follows the prescribed **Output Format** (`### Milestone`)
 * but forgets to append the explicit `## Proposed Phases` section.
 *
 * Each milestone header becomes a proposed phase with a default 📋 emoji
 * and the header text as the phase name. Milestone descriptions are not
 * carried over — they typically live in a separate `#### Feature` block.
 *
 * Returns `null` when no milestone headers are found.
 */
export function detectMilestonePhases(text: string): ProposedPhase[] | null {
	const phases: ProposedPhase[] = [];
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(MILESTONE_LINE);
		if (!m) continue;
		const name = m[1].trim();
		if (!name) continue;
		// Skip a milestone titled just “Plan” — the seed already contains it.
		if (/^plan\b/i.test(name)) continue;
		phases.push({ emoji: "📋", name, description: "" });
	}
	return phases.length >= 1 ? phases : null;
}
