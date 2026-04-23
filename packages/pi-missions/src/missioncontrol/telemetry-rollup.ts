/**
 * Telemetry rollup (Track K).
 *
 * Aggregates per-task / per-validator telemetry into role-scoped sums so
 * Factory-style presentations ("duration distribution", "tokens per role",
 * "cost per role") can render without re-computing on every request.
 *
 * Pure data transformation. No I/O, no engine dependency \u2014 accepts a list
 * of telemetry samples and emits a rollup snapshot.
 *
 * Factory roles tracked:
 *   - `orchestrator`        \u2014 supervisor / planner
 *   - `worker`              \u2014 regular feature implementation
 *   - `fix_worker`          \u2014 fix features (blocker resolution round)
 *   - `scrutiny_validator`  \u2014 milestone-scope code review
 *   - `user_testing_validator` \u2014 milestone-scope UX verification
 *
 * A dedicated `fix_worker` role (not part of `MissionRole`) distinguishes
 * fix features from initial feature work so Factory's "fix-round overhead"
 * view lights up without re-parsing task metadata.
 */

import type { PersistedBatchState, PersistedTaskRecord } from "./types";

/** Role a telemetry sample is attributed to. */
export type TelemetryRole = "orchestrator" | "worker" | "fix_worker" | "scrutiny_validator" | "user_testing_validator";

/** All telemetry roles in canonical order. */
export const TELEMETRY_ROLES: readonly TelemetryRole[] = [
	"orchestrator",
	"worker",
	"fix_worker",
	"scrutiny_validator",
	"user_testing_validator",
] as const;

/** One sample of telemetry attributed to a role. */
export interface TelemetrySample {
	role: TelemetryRole;
	/** Task id / agent id the sample came from. Purely for traceability. */
	sourceId?: string;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	toolCalls: number;
}

/** Aggregate totals for one role. */
export interface RoleRollup {
	role: TelemetryRole;
	count: number;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd: number;
	toolCalls: number;
}

/** Overall rollup \u2014 per-role entries + mission totals. */
export interface MissionRollup {
	perRole: RoleRollup[];
	totals: Omit<RoleRollup, "role">;
}

function emptyRollup(role: TelemetryRole): RoleRollup {
	return {
		role,
		count: 0,
		durationMs: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		toolCalls: 0,
	};
}

/** Combine two rollups for the same role. */
function mergeRollup(a: RoleRollup, b: RoleRollup | Omit<RoleRollup, "role">): RoleRollup {
	return {
		role: a.role,
		count: a.count + b.count,
		durationMs: a.durationMs + b.durationMs,
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
		cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
		totalTokens: a.totalTokens + b.totalTokens,
		costUsd: a.costUsd + b.costUsd,
		toolCalls: a.toolCalls + b.toolCalls,
	};
}

/**
 * Aggregate a list of telemetry samples into per-role sums + overall totals.
 * Roles with zero samples still appear in `perRole` (count = 0) so consumers
 * can render stable tables without branching on presence.
 */
export function rollupTelemetry(samples: readonly TelemetrySample[]): MissionRollup {
	const perRole = new Map<TelemetryRole, RoleRollup>();
	for (const role of TELEMETRY_ROLES) perRole.set(role, emptyRollup(role));

	for (const s of samples) {
		const existing = perRole.get(s.role);
		if (!existing) continue; // unknown role \u2014 intentionally dropped
		const totalTokens = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens;
		perRole.set(
			s.role,
			mergeRollup(existing, {
				count: 1,
				durationMs: s.durationMs,
				inputTokens: s.inputTokens,
				outputTokens: s.outputTokens,
				cacheReadTokens: s.cacheReadTokens,
				cacheWriteTokens: s.cacheWriteTokens,
				totalTokens,
				costUsd: s.costUsd,
				toolCalls: s.toolCalls,
			}),
		);
	}

	const totals = [...perRole.values()].reduce(
		(acc, r) => ({
			count: acc.count + r.count,
			durationMs: acc.durationMs + r.durationMs,
			inputTokens: acc.inputTokens + r.inputTokens,
			outputTokens: acc.outputTokens + r.outputTokens,
			cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
			cacheWriteTokens: acc.cacheWriteTokens + r.cacheWriteTokens,
			totalTokens: acc.totalTokens + r.totalTokens,
			costUsd: acc.costUsd + r.costUsd,
			toolCalls: acc.toolCalls + r.toolCalls,
		}),
		{
			count: 0,
			durationMs: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
			costUsd: 0,
			toolCalls: 0,
		} as Omit<RoleRollup, "role">,
	);

	return {
		perRole: TELEMETRY_ROLES.map(role => perRole.get(role)!),
		totals,
	};
}

/**
 * Project a {@link PersistedTaskRecord} into a telemetry sample. Fix
 * features are classified as `fix_worker`; everything else is `worker`.
 *
 * `PersistedTaskRecord` does not carry a telemetry struct; callers that
 * want per-task telemetry should plumb the `diagnostics.taskExits` map
 * or the `LaneTaskOutcome.telemetry` object instead. This helper exists
 * to build a duration-only projection when richer data is unavailable.
 */
export function taskRecordToSample(task: PersistedTaskRecord): TelemetrySample {
	const role: TelemetryRole = task.isFixFeature ? "fix_worker" : "worker";
	const durationMs =
		typeof task.endedAt === "number" && typeof task.startedAt === "number"
			? Math.max(0, task.endedAt - task.startedAt)
			: 0;
	return {
		role,
		sourceId: task.taskId,
		durationMs,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		toolCalls: 0,
	};
}

/**
 * Roll up a persisted batch state into a mission-level rollup. Uses
 * `diagnostics.taskExits` when present (richer token + cost data);
 * otherwise falls back to duration-only samples derived from task
 * startedAt/endedAt.
 *
 * Returns a {@link MissionRollup}. The rollup includes only worker +
 * fix_worker roles \u2014 validator + orchestrator samples must be contributed
 * separately (via `samples` in {@link rollupBatchState}).
 */
export function rollupBatchState(
	state: PersistedBatchState,
	extraSamples: readonly TelemetrySample[] = [],
): MissionRollup {
	const samples: TelemetrySample[] = [];
	const taskExits = state.diagnostics?.taskExits ?? {};
	for (const task of state.tasks) {
		const role: TelemetryRole = task.isFixFeature ? "fix_worker" : "worker";
		const exit = taskExits[task.taskId];
		if (exit) {
			const tokens = exit.tokens;
			samples.push({
				role,
				sourceId: task.taskId,
				durationMs: (exit.durationSec ?? 0) * 1000,
				inputTokens: tokens?.input ?? 0,
				outputTokens: tokens?.output ?? 0,
				cacheReadTokens: tokens?.cacheRead ?? 0,
				cacheWriteTokens: tokens?.cacheWrite ?? 0,
				costUsd: exit.cost ?? 0,
				toolCalls: exit.toolCalls ?? 0,
			});
		} else {
			samples.push(taskRecordToSample(task));
		}
	}
	return rollupTelemetry([...samples, ...extraSamples]);
}

/**
 * Duration histogram bucketing helper.
 *
 * Produces count-per-bucket arrays for a "duration distribution" chart.
 * Buckets are half-open intervals `[lower, upper)` sorted ascending.
 * Samples with `durationMs < buckets[0].lower` are dropped; samples at
 * or above `buckets[last].upper` land in the last bucket (open upper).
 */
export interface DurationBucket {
	/** Inclusive lower edge in ms. */
	lower: number;
	/** Exclusive upper edge in ms (Infinity for the overflow bucket). */
	upper: number;
	label: string;
	count: number;
}

/**
 * Default bucketing covering Factory's observed mission tempo: sub-second
 * through multi-hour. Callers can provide their own via {@link bucketDurations}.
 */
export const DEFAULT_DURATION_BUCKETS: readonly { lower: number; upper: number; label: string }[] = [
	{ lower: 0, upper: 10_000, label: "<10s" },
	{ lower: 10_000, upper: 60_000, label: "10s\u201360s" },
	{ lower: 60_000, upper: 5 * 60_000, label: "1\u20135m" },
	{ lower: 5 * 60_000, upper: 30 * 60_000, label: "5\u201330m" },
	{ lower: 30 * 60_000, upper: 120 * 60_000, label: "30m\u20132h" },
	{ lower: 120 * 60_000, upper: Number.POSITIVE_INFINITY, label: "2h+" },
];

/**
 * Bucket a list of durations (ms) using `buckets`. Returns an array the
 * same length + order as `buckets` with `count` populated.
 */
export function bucketDurations(
	durationsMs: readonly number[],
	buckets: readonly { lower: number; upper: number; label: string }[] = DEFAULT_DURATION_BUCKETS,
): DurationBucket[] {
	const result: DurationBucket[] = buckets.map(b => ({ ...b, count: 0 }));
	for (const d of durationsMs) {
		if (!Number.isFinite(d) || d < 0) continue;
		for (let i = 0; i < result.length; i++) {
			const bucket = result[i];
			if (!bucket) continue;
			const isLast = i === result.length - 1;
			if (d >= bucket.lower && (isLast || d < bucket.upper)) {
				bucket.count += 1;
				break;
			}
		}
	}
	return result;
}

/** Extract every non-zero duration from a rollup for histogramming. */
export function extractDurations(samples: readonly TelemetrySample[]): number[] {
	const out: number[] = [];
	for (const s of samples) if (s.durationMs > 0) out.push(s.durationMs);
	return out;
}
