import * as crypto from "node:crypto";
import type {
	ExperimentResult,
	ExperimentState,
	MetricDirection,
	PopulationCandidate,
	PopulationFamily,
	PopulationRecommendation,
	PopulationState,
} from "./types";

const MAX_FAMILY_CANDIDATES = 50;
const MAX_FAMILIES = 5;

export function createPopulationState(): PopulationState {
	return {
		families: [],
		candidates: [],
		activeFamilyId: null,
		generation: 0,
	};
}

export function generateFamilyId(): string {
	return `fam_${crypto.randomBytes(4).toString("hex")}`;
}

export function generateCandidateId(): string {
	return `cand_${crypto.randomBytes(4).toString("hex")}`;
}

export function createFamily(name: string, direction: MetricDirection): PopulationFamily {
	return {
		id: generateFamilyId(),
		name,
		bestMetric: null,
		bestCandidateId: null,
		direction,
		createdAt: Date.now(),
		candidates: [],
	};
}

export function createCandidate(
	familyId: string,
	result: ExperimentResult,
	mutations: string[],
	parentId: string | null = null,
): PopulationCandidate {
	return {
		id: generateCandidateId(),
		familyId,
		metric: result.metric,
		status: result.status,
		commit: result.commit,
		runNumber: result.runNumber ?? 0,
		createdAt: result.timestamp,
		parentId,
		generation: 0,
		mutations,
		asi: result.asi,
	};
}

export function addCandidateToPopulation(population: PopulationState, candidate: PopulationCandidate): void {
	population.candidates.push(candidate);
	const family = population.families.find(f => f.id === candidate.familyId);
	if (family) {
		family.candidates.push(candidate.id);
		if (candidate.status === "keep") {
			if (family.bestMetric === null || isBetter(candidate.metric, family.bestMetric, family.direction)) {
				family.bestMetric = candidate.metric;
				family.bestCandidateId = candidate.id;
			}
		}
	}
	// Prune old candidates if family exceeds max
	if (family && family.candidates.length > MAX_FAMILY_CANDIDATES) {
		const toRemove = family.candidates.slice(0, family.candidates.length - MAX_FAMILY_CANDIDATES);
		family.candidates = family.candidates.slice(-MAX_FAMILY_CANDIDATES);
		population.candidates = population.candidates.filter(c => !toRemove.includes(c.id));
	}
	population.generation = Math.max(population.generation, candidate.generation);
}

export function ensureActiveFamily(population: PopulationState, state: ExperimentState): PopulationFamily {
	let family = population.activeFamilyId ? population.families.find(f => f.id === population.activeFamilyId) : null;
	if (!family) {
		family = createFamily(state.name ?? "default", state.bestDirection);
		population.families.push(family);
		population.activeFamilyId = family.id;
	}
	// Prune families if too many
	if (population.families.length > MAX_FAMILIES) {
		const activeId = population.activeFamilyId;
		population.families = population.families.slice(-MAX_FAMILIES);
		if (!population.families.some(f => f.id === activeId)) {
			population.families.push(family);
		}
	}
	return family;
}

export function getRecommendation(population: PopulationState, state: ExperimentState): PopulationRecommendation {
	const family = ensureActiveFamily(population, state);
	const current = state.results.filter(r => r.segment === state.currentSegment);
	const recent = current.slice(-5);
	const recentKept = recent.filter(r => r.status === "keep" && !r.flagged);
	const recentDiscarded = recent.filter(r => r.status === "discard");
	const recentCrashed = recent.filter(r => r.status === "crash" || r.status === "checks_failed");

	// If too many crashes, suggest backtracking
	if (recentCrashed.length >= 3) {
		const bestCandidate = family.bestCandidateId
			? population.candidates.find(c => c.id === family.bestCandidateId)
			: null;
		return {
			type: "backtrack",
			familyId: family.id,
			candidateId: bestCandidate?.id ?? null,
			reason: "Multiple recent crashes — backtrack to last known good candidate.",
			suggestedMutations: bestCandidate?.mutations ?? [],
		};
	}

	// If many consecutive discards, explore
	if (recentDiscarded.length >= 4) {
		return {
			type: "explore",
			familyId: family.id,
			candidateId: null,
			reason: "Many consecutive discards — try a different approach.",
			suggestedMutations: collectDiverseMutations(population, family),
		};
	}

	// If recent kept runs show improvement, continue
	if (recentKept.length >= 2) {
		const lastKept = recentKept[recentKept.length - 1];
		const prevKept = recentKept[recentKept.length - 2];
		if (lastKept && prevKept && isBetter(lastKept.metric, prevKept.metric, state.bestDirection)) {
			return {
				type: "continue",
				familyId: family.id,
				candidateId: null,
				reason: "Recent kept runs show improvement — continue current direction.",
				suggestedMutations: extractMutationHints(lastKept),
			};
		}
	}

	// If we have a best candidate, refine
	if (family.bestCandidateId) {
		const best = population.candidates.find(c => c.id === family.bestCandidateId);
		if (best) {
			return {
				type: "refine",
				familyId: family.id,
				candidateId: best.id,
				reason: `Refine best candidate (${best.metric}) with smaller mutations.`,
				suggestedMutations: best.mutations.map(m => `tweak ${m}`),
			};
		}
	}

	// Default: explore
	return {
		type: "explore",
		familyId: family.id,
		candidateId: null,
		reason: "No clear pattern yet — explore broadly.",
		suggestedMutations: collectDiverseMutations(population, family),
	};
}

function isBetter(current: number, best: number, direction: MetricDirection): boolean {
	return direction === "lower" ? current < best : current > best;
}

function extractMutationHints(result: ExperimentResult): string[] {
	const hints: string[] = [];
	if (typeof result.asi?.hypothesis === "string") {
		hints.push(`follow ${result.asi.hypothesis}`);
	}
	if (typeof result.asi?.next_action_hint === "string") {
		hints.push(result.asi.next_action_hint);
	}
	if (hints.length === 0) {
		hints.push("iterate on last change");
	}
	return hints;
}

function collectDiverseMutations(population: PopulationState, family: PopulationFamily): string[] {
	const seen = new Set<string>();
	const mutations: string[] = [];
	for (const candidate of population.candidates.filter(c => c.familyId === family.id)) {
		for (const m of candidate.mutations) {
			if (!seen.has(m)) {
				seen.add(m);
				mutations.push(m);
			}
		}
	}
	return mutations.slice(0, 10);
}

export function populationStateToJson(population: PopulationState): string {
	return JSON.stringify(population, null, 2);
}

export function populationStateFromJson(json: string): PopulationState | null {
	try {
		const parsed = JSON.parse(json) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		const candidate = parsed as PopulationState;
		if (!Array.isArray(candidate.families) || !Array.isArray(candidate.candidates)) return null;
		return candidate;
	} catch {
		return null;
	}
}
