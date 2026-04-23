/**
 * Milestone validator resume reconciliation (Track #3 / H3).
 *
 * When a supervisor process dies mid-validator-run, the milestone is
 * still marked `"validating"` on disk and may have one or both of its
 * expected output files present. On resume the engine needs to decide,
 * per validator spawn:
 *
 *   - the output file exists + parses cleanly → load it and reuse the
 *     prior result in the current round (no re-spawn).
 *   - the output file is missing OR fails to parse → schedule a
 *     re-spawn at the same round.
 *
 * This module is pure-ish — it performs filesystem reads via the
 * shared `parseMilestoneValidatorResult` but never spawns agents or
 * mutates batch state. Callers (resume flow + lane-runner) consume
 * {@link MilestoneValidatorReconciliation} to drive the actual spawn
 * + parse decisions.
 */

import type { ValidatorKind } from "./fix-features";
import type { MilestoneValidatorReconciliation, MilestoneValidatorSlot, PersistedBatchState } from "./types";
import { parseMilestoneValidatorResult as defaultParseMilestoneResult, validationOutputPath } from "./validators";

/** The two validator kinds the milestone loop spawns. */
const VALIDATOR_KINDS: readonly ValidatorKind[] = ["scrutiny", "user-testing"] as const;

export interface ReconcileMilestoneValidatorsOptions {
	/**
	 * Override the parser for tests. Default uses the real
	 * {@link parseMilestoneValidatorResult} on the filesystem.
	 */
	parseResult?: typeof defaultParseMilestoneResult;
}

/**
 * Inspect every milestone in `"validating"` status against its expected
 * validator output files for the current round. Returns one
 * {@link MilestoneValidatorReconciliation} per inspected milestone.
 *
 * When `batchState.milestones` is unset or empty, returns `[]`.
 * Milestones in terminal / pre-validation states (`pending`,
 * `in_progress`, `passed`, `failed`) are skipped — resume only cares
 * about the `"validating"` snapshot.
 *
 * The helper swallows file-not-found into `needsRespawn: true`; every
 * other failure is surfaced via `parseError` so callers can log
 * diagnostics without losing the re-spawn intent.
 */
export async function reconcileMilestoneValidators(
	batchState: PersistedBatchState,
	cwd: string,
	options: ReconcileMilestoneValidatorsOptions = {},
): Promise<MilestoneValidatorReconciliation[]> {
	const parseResult = options.parseResult ?? defaultParseMilestoneResult;
	const milestones = batchState.milestones ?? [];
	if (milestones.length === 0) return [];

	const out: MilestoneValidatorReconciliation[] = [];
	for (const milestone of milestones) {
		if (milestone.status !== "validating") continue;
		const round = milestone.validationRounds;
		if (round < 1) {
			// A milestone in `"validating"` with round=0 is corrupted —
			// surface it as "both slots need re-spawn" so resume triggers a
			// fresh round.
			out.push({
				milestoneId: milestone.id,
				round: 1,
				slots: VALIDATOR_KINDS.map(kind => ({
					kind,
					outputPath: validationOutputPath(cwd, batchState.batchId, milestone.id, 1, kind),
					needsRespawn: true,
				})),
			});
			continue;
		}

		const slots: MilestoneValidatorSlot[] = [];
		for (const kind of VALIDATOR_KINDS) {
			const outputPath = validationOutputPath(cwd, batchState.batchId, milestone.id, round, kind);
			try {
				const output = await parseResult(outputPath);
				if (output.validator !== kind) {
					slots.push({
						kind,
						outputPath,
						parseError: `expected ${kind} output, got ${output.validator}`,
						needsRespawn: true,
					});
					continue;
				}
				slots.push({ kind, outputPath, needsRespawn: false });
			} catch (err) {
				const parseError = err instanceof Error ? err.message : String(err);
				// Missing files are the expected "crashed before write" case;
				// any other error still schedules a re-spawn but we preserve
				// the message for diagnostics.
				slots.push({ kind, outputPath, parseError, needsRespawn: true });
			}
		}
		out.push({ milestoneId: milestone.id, round, slots });
	}
	return out;
}
