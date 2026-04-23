/**
 * Milestone validator loop driver (Track #2 integration).
 *
 * Composes the Track B/C validator spawners, the Track F knowledge
 * ingestor, the Track A4 fix-feature generator, and the Track A3
 * milestone lifecycle reducers into a single end-to-end round.
 *
 * Inputs: the runtime `MissionState`, the milestone whose validators
 * need to run, and a dependency bag that stubs spawn + persistence in
 * tests. Output: a structured {@link ValidationRoundResult} describing
 * the new state plus what the caller should do next.
 *
 * Responsibilities:
 *   1. Bump the milestone's validation round counter.
 *   2. Spawn scrutiny + user-testing validators in parallel, each
 *      wrapped in a stall timeout. Parse their JSON output files.
 *   3. Merge the two validator results into a single round and ingest
 *      lessons into the per-project knowledge library.
 *   4. Branch on the combined verdict:
 *        - `"pass"` → mark milestone passed.
 *        - `"fail"` → mark milestone failed (fatal).
 *        - `"needs-fix"` → generate fix features when we can still
 *          attempt another round, otherwise mark the milestone failed.
 *   5. When fix features are generated, insert them into the runtime
 *      batch state as pending tasks in a freshly-appended wave and
 *      reset the milestone status to `"in_progress"` so the lane-runner
 *      picks them up before calling the validators again.
 *
 * The module is pure orchestration — no direct filesystem or process
 * access outside of the injected deps. Persistence is the caller's
 * responsibility (via `deps.persist`).
 */

import type { BatchMilestone, BatchState, MissionState, TaskOutcome, WaveAssignment } from "../types";
import { missionBatchPath } from "./adapter";
import {
	currentMilestone,
	markMilestoneFailed,
	markMilestonePassed,
	updateMilestoneInArray,
} from "./engine-milestones";
import type { GeneratedFixFeature, ValidatorFinding } from "./fix-features";
import { generateFixFeatures as defaultGenerateFixFeatures } from "./fix-features";
import { ingestValidatorLessons as defaultIngestValidatorLessons } from "./knowledge";
import type { MilestoneValidatorReconciliation } from "./types";
import { validationContractPath } from "./validation-contract";
import { DEFAULT_VALIDATOR_STALL_TIMEOUT_MS, withStallTimeout } from "./validator-stall";
import type { MilestoneValidationRound } from "./validators";
import {
	parseScrutinyValidatorResult as defaultParseScrutiny,
	parseUserTestingValidatorResult as defaultParseUserTesting,
	spawnScrutinyValidator as defaultSpawnScrutiny,
	spawnUserTestingValidator as defaultSpawnUserTesting,
	mergeValidatorRound,
	validationOutputPath,
} from "./validators";

/** Thin alias so callers can refer to the milestone lifecycle shape. */
export type MilestoneRuntime = BatchMilestone;

/**
 * Dependency bag for {@link runValidationRound}.
 *
 * Every IO + spawn seam is injectable so tests can stub the RPC agent
 * host and the validator output parsing without touching the real
 * filesystem's `validation/<batchId>/...json` files.
 */
export interface ValidationRoundDeps {
	cwd: string;
	/** Persists the mutated `MissionState` after every mutating branch. */
	persist: (state: MissionState) => Promise<void>;
	/** Stall threshold per validator spawn (ms). Defaults to `DEFAULT_VALIDATOR_STALL_TIMEOUT_MS`. */
	stallTimeoutMs?: number;
	/** Absolute path to the validation contract. Defaults to `validationContractPath(cwd)`. */
	contractPath?: string;
	/** Absolute path to the persisted batch state. Defaults to `missionBatchPath(cwd)`. */
	batchStatePath?: string;
	/** Model override for the scrutiny validator. */
	scrutinyModel?: string;
	/** Model override for the user-testing validator. */
	userTestingModel?: string;
	/** Inject spawn fakes for tests. */
	spawnScrutiny?: typeof defaultSpawnScrutiny;
	spawnUserTesting?: typeof defaultSpawnUserTesting;
	/** Inject parsers for tests so validator output files don't need to exist. */
	parseScrutiny?: typeof defaultParseScrutiny;
	parseUserTesting?: typeof defaultParseUserTesting;
	/** Inject fix-feature generator for tests. */
	generateFixFeatures?: typeof defaultGenerateFixFeatures;
	/** Inject knowledge ingestor for tests. */
	ingestLessons?: typeof defaultIngestValidatorLessons;
	/** Deterministic clock hook for tests. */
	now?: () => number;
	/**
	 * Resume reconciliation for this milestone (Track H3 integration).
	 * When set, `runValidationRound` reuses the current round number
	 * instead of bumping, loads existing outputs from slots with
	 * `needsRespawn === false`, and spawns only slots that need a
	 * re-run. Passed on the first tick after supervisor restart; absent
	 * on fresh rounds.
	 */
	reconciliation?: MilestoneValidatorReconciliation;
}

/**
 * Discriminated outcome of one validation round. Every variant carries
 * the new `MissionState` so the caller can swap it into the runtime
 * without re-reading disk.
 */
export type ValidationRoundResult =
	| { kind: "passed"; round: MilestoneValidationRound; state: MissionState }
	| {
			kind: "fix-features-generated";
			round: MilestoneValidationRound;
			fixFeatures: GeneratedFixFeature[];
			state: MissionState;
	  }
	| { kind: "failed-max-rounds"; round: MilestoneValidationRound; state: MissionState }
	| { kind: "failed-fatal"; round: MilestoneValidationRound; state: MissionState }
	| {
			kind: "stalled";
			validator: "scrutiny" | "user-testing";
			timeoutMs: number;
			state: MissionState;
	  };

/**
 * Count the fix features already produced for `milestoneId` by looking
 * at existing task IDs matching the canonical `FIX-<milestoneNum>-###`
 * prefix. Pure helper; exported for callers that need the same
 * calculation outside the runner (resume, dashboards).
 */
export function countFixFeaturesForMilestone(batch: BatchState, milestoneId: string): number {
	const milestoneNumMatch = /-(\d+)$/.exec(milestoneId);
	const milestoneNum = milestoneNumMatch ? (milestoneNumMatch[1]?.padStart(3, "0") ?? "000") : "000";
	const prefix = `FIX-${milestoneNum}-`;
	return batch.tasks.filter(t => t.taskId.startsWith(prefix)).length;
}

/**
 * Insert generated fix-feature tasks into the runtime batch:
 *   - Push a `TaskOutcome` per fix feature onto `batch.tasks`.
 *   - Append a new `WaveAssignment` carrying their ids at
 *     `wavePlan.length` (schedules them for the next scheduling tick).
 *   - Bump `tasksTotal`.
 *
 * Returns a new `MissionState`; never mutates the input.
 */
export function insertFixFeaturesIntoBatch(
	state: MissionState,
	fixFeatures: readonly GeneratedFixFeature[],
): MissionState {
	if (!state.batch || fixFeatures.length === 0) return state;
	const batch = state.batch;
	const newTasks: TaskOutcome[] = fixFeatures.map(f => ({
		taskId: f.taskId,
		status: "pending",
		startTime: null,
		endTime: null,
		exitReason: "",
		sessionName: "",
		doneFileFound: false,
	}));
	const newWave: WaveAssignment = {
		wave: batch.waves.length,
		taskIds: fixFeatures.map(f => f.taskId),
	};
	const nextBatch: BatchState = {
		...batch,
		tasks: [...batch.tasks, ...newTasks],
		waves: [...batch.waves, newWave],
		tasksTotal: batch.tasksTotal + fixFeatures.length,
	};
	return { ...state, batch: nextBatch };
}

/**
 * Apply a milestone update in place on a `MissionState`, returning a
 * new state. Mirrors `updateMilestoneInArray` but threads through the
 * whole runtime state so callers don't have to rebuild `BatchState`.
 */
function withUpdatedMilestone(
	state: MissionState,
	milestoneId: string,
	update: (m: BatchMilestone) => BatchMilestone,
): MissionState {
	if (!state.batch) return state;
	const next = updateMilestoneInArray(state.batch.milestones, milestoneId, update);
	if (!next) return state;
	return { ...state, batch: { ...state.batch, milestones: next } };
}

/**
 * Drive a single validation round end-to-end.
 *
 * This function is the glue between the lane-runner (which knows when
 * features are complete) and the validator spawners (which know how to
 * run an agent against the contract). See module header for the full
 * lifecycle description.
 */
export async function runValidationRound(
	input: MissionState,
	milestone: BatchMilestone,
	deps: ValidationRoundDeps,
): Promise<ValidationRoundResult> {
	if (!input.batch) {
		throw new Error("runValidationRound requires a batch mission state");
	}
	const spawnScrutiny = deps.spawnScrutiny ?? defaultSpawnScrutiny;
	const spawnUserTesting = deps.spawnUserTesting ?? defaultSpawnUserTesting;
	const parseScrutiny = deps.parseScrutiny ?? defaultParseScrutiny;
	const parseUserTesting = deps.parseUserTesting ?? defaultParseUserTesting;
	const generateFixFeatures = deps.generateFixFeatures ?? defaultGenerateFixFeatures;
	const ingestLessons = deps.ingestLessons ?? defaultIngestValidatorLessons;
	const now = deps.now ?? (() => Date.now());
	const stallTimeoutMs = deps.stallTimeoutMs ?? DEFAULT_VALIDATOR_STALL_TIMEOUT_MS;
	const contractPath = deps.contractPath ?? validationContractPath(deps.cwd);
	const batchStatePath = deps.batchStatePath ?? missionBatchPath(deps.cwd);
	const batchId = input.batch.batchId;

	// 1. Determine the round number. When the caller provides resume
	//    reconciliation, the round was already bumped before the prior
	//    crash; reuse it. Otherwise, bump + persist as usual.
	const reconciliation = deps.reconciliation;
	const slotFor = (kind: "scrutiny" | "user-testing") => reconciliation?.slots.find(s => s.kind === kind);
	const roundNumber = reconciliation ? reconciliation.round : milestone.validationRounds + 1;
	let state = withUpdatedMilestone(input, milestone.id, m => ({
		...m,
		validationRounds: roundNumber,
	}));
	if (!reconciliation) {
		// Bump path persists the new round number so a crash between here
		// and the validator spawn leaves a correctable on-disk snapshot.
		// Reuse path assumes the round was already persisted pre-crash.
		await deps.persist(state);
	}

	// 2. Compute canonical output paths for this round.
	const scrutinyOutputPath = validationOutputPath(deps.cwd, batchId, milestone.id, roundNumber, "scrutiny");
	const userTestingOutputPath = validationOutputPath(deps.cwd, batchId, milestone.id, roundNumber, "user-testing");

	// 3. Spawn each validator unless its reconciliation slot marks the
	//    output reusable from disk. Each spawn is guarded by the stall
	//    timeout. `withStallTimeout` returns a `completed` outcome when
	//    the promise settles (even on rejection), so error surfacing
	//    happens after the race.
	const scrutinySlot = slotFor("scrutiny");
	const userTestingSlot = slotFor("user-testing");
	const shouldSpawnScrutiny = !scrutinySlot || scrutinySlot.needsRespawn;
	const shouldSpawnUserTesting = !userTestingSlot || userTestingSlot.needsRespawn;

	const scrutinyTask = shouldSpawnScrutiny
		? withStallTimeout({
				promise: spawnScrutiny({
					cwd: deps.cwd,
					batchId,
					milestoneId: milestone.id,
					round: roundNumber,
					outputPath: scrutinyOutputPath,
					contractPath,
					batchStatePath,
					...(deps.scrutinyModel ? { model: deps.scrutinyModel } : {}),
					now,
				}),
				timeoutMs: stallTimeoutMs,
			})
		: Promise.resolve({ kind: "completed", value: null } as const);
	const userTestingTask = shouldSpawnUserTesting
		? withStallTimeout({
				promise: spawnUserTesting({
					cwd: deps.cwd,
					batchId,
					milestoneId: milestone.id,
					round: roundNumber,
					outputPath: userTestingOutputPath,
					contractPath,
					batchStatePath,
					...(deps.userTestingModel ? { model: deps.userTestingModel } : {}),
					now,
				}),
				timeoutMs: stallTimeoutMs,
			})
		: Promise.resolve({ kind: "completed", value: null } as const);

	const [scrutinyOutcome, userTestingOutcome] = await Promise.all([scrutinyTask, userTestingTask]);

	if (scrutinyOutcome.kind === "stalled") {
		return { kind: "stalled", validator: "scrutiny", timeoutMs: scrutinyOutcome.timeoutMs, state };
	}
	if (userTestingOutcome.kind === "stalled") {
		return {
			kind: "stalled",
			validator: "user-testing",
			timeoutMs: userTestingOutcome.timeoutMs,
			state,
		};
	}
	if (scrutinyOutcome.kind === "aborted" || userTestingOutcome.kind === "aborted") {
		// Abort is a cooperative cancel from the caller. We surface it as
		// stalled so the operator handles it, while keeping the type
		// surface narrow — aborted runs are operationally equivalent.
		const which = scrutinyOutcome.kind === "aborted" ? "scrutiny" : "user-testing";
		return { kind: "stalled", validator: which, timeoutMs: stallTimeoutMs, state };
	}

	// 4. Parse the output files. A parse failure is fatal for the round
	//    (the validator either didn't write its file or produced garbage)
	//    — mark the milestone failed so the operator intervenes.
	let scrutiny: Awaited<ReturnType<typeof parseScrutiny>>;
	let userTesting: Awaited<ReturnType<typeof parseUserTesting>>;
	try {
		[scrutiny, userTesting] = await Promise.all([
			parseScrutiny(scrutinyOutputPath),
			parseUserTesting(userTestingOutputPath),
		]);
	} catch {
		state = withUpdatedMilestone(state, milestone.id, m => markMilestoneFailed(m, now()));
		await deps.persist(state);
		// Synthesize a minimal round record so callers can still render the
		// failure in the dashboard.
		const syntheticRound: MilestoneValidationRound = {
			milestoneId: milestone.id,
			round: roundNumber,
			startedAt: now(),
			completedAt: now(),
			scrutiny: syntheticValidatorOutput(milestone.id, roundNumber, "scrutiny"),
			userTesting: syntheticValidatorOutput(milestone.id, roundNumber, "user-testing"),
			findings: [],
			verdict: "fail",
			lessons: [],
		};
		return { kind: "failed-fatal", round: syntheticRound, state };
	}

	// 5. Merge into a single round record + ingest lessons into the
	//    knowledge library.
	const round = mergeValidatorRound(scrutiny, userTesting);
	await ingestLessons(deps.cwd, milestone.id, "scrutiny-validator", scrutiny.lessons, now());
	await ingestLessons(deps.cwd, milestone.id, "user-testing-validator", userTesting.lessons, now());

	// 6. Branch on verdict.
	if (round.verdict === "pass") {
		state = withUpdatedMilestone(state, milestone.id, m => markMilestonePassed(m, now()));
		await deps.persist(state);
		return { kind: "passed", round, state };
	}

	if (round.verdict === "fail") {
		state = withUpdatedMilestone(state, milestone.id, m => markMilestoneFailed(m, now()));
		await deps.persist(state);
		return { kind: "failed-fatal", round, state };
	}

	// `"needs-fix"` path — blockers present. Check the round budget first
	// so we don't spawn more workers when the milestone is already
	// exhausted.
	if (roundNumber >= milestone.maxValidationRounds) {
		state = withUpdatedMilestone(state, milestone.id, m => markMilestoneFailed(m, now()));
		await deps.persist(state);
		return { kind: "failed-max-rounds", round, state };
	}

	// Generate fix features from the blocker findings and inject them
	// into the runtime batch.
	const existingFixFeatureCount = countFixFeaturesForMilestone(state.batch ?? input.batch, milestone.id);
	const enrichedFindings: ValidatorFinding[] = round.findings.map(f => ({
		...f,
		validatorOutputPath: f.validatorOutputPath ?? outputPathForFinding(f, scrutinyOutputPath, userTestingOutputPath),
	}));
	const fixFeatures = await generateFixFeatures({
		cwd: deps.cwd,
		milestoneId: milestone.id,
		findings: enrichedFindings,
		existingFixFeatureCount,
		now: now(),
	});

	// If every finding was non-blocker, the generator returns `[]`. In
	// that case the round merely stashed warnings; mark passed so the
	// loop doesn't spin.
	if (fixFeatures.length === 0) {
		state = withUpdatedMilestone(state, milestone.id, m => markMilestonePassed(m, now()));
		await deps.persist(state);
		return { kind: "passed", round, state };
	}

	state = insertFixFeaturesIntoBatch(state, fixFeatures);
	// Reset the milestone to `in_progress` so the lane-runner advances to
	// the newly appended wave instead of re-invoking the validators on
	// the next tick. The next `advanceMilestonePhase` call will re-flip
	// to `validating` once the fix features complete.
	state = withUpdatedMilestone(state, milestone.id, m => ({ ...m, status: "in_progress" }));
	await deps.persist(state);
	return { kind: "fix-features-generated", round, fixFeatures, state };
}

/**
 * Thin re-export so the lane-runner can query which milestone to drive
 * without importing from both this module and engine-milestones.
 */
export { currentMilestone };

function outputPathForFinding(f: ValidatorFinding, scrutinyOutputPath: string, userTestingOutputPath: string): string {
	return f.validator === "scrutiny" ? scrutinyOutputPath : userTestingOutputPath;
}

/** Build a placeholder validator output used only on parse-failure paths. */
function syntheticValidatorOutput(
	milestoneId: string,
	round: number,
	validator: "scrutiny" | "user-testing",
): MilestoneValidationRound["scrutiny"] {
	return {
		schemaVersion: 1,
		validator,
		milestoneId,
		round,
		startedAt: 0,
		completedAt: 0,
		verdict: "fail",
		summary: `${validator} validator did not produce a parseable output file`,
		findings: [],
		lessons: [],
	};
}
