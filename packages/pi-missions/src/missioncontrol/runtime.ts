/**
 * Engine factory — stateless `createEngine` returns handlers/hooks/status.
 *
 * The factory is inert until `/mission-batch` promotes a mission. Phase-based
 * missions stay on the simple detector path and never touch the engine.
 *
 * Minimum viable surface for extension wire-up:
 *   handlers.batch   — promote current mission to batch mode
 *   handlers.pause   — pause active batch
 *   handlers.resume  — resume active batch
 *   handlers.abort   — abort active batch
 *   status           — snapshot for dashboard API
 *   hooks.*          — lifecycle listeners (no-op until batch active)
 *
 * Whenever a batch is running the factory also activates a supervisor
 * lockfile + heartbeat so the dashboard's SupervisorPanel reflects "active"
 * instead of "No active supervisor". The lockfile is removed on pause,
 * abort, or `onSessionEnd` — the same points that stop the lane-runner.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { MissionState } from "../types";
import { missionBatchPath } from "./adapter";
import { abortBatch, beginBatch, pauseBatch, promoteToBatch, resumeBatch } from "./engine";
import { startLaneRunner as defaultStartLaneRunner, type LaneRunnerHandle } from "./lane-runner";
import { reconcileMilestoneValidators } from "./milestone-resume";
import { loadActiveBatch, loadBatchState, saveActiveBatch } from "./persistence";
import { activateSupervisor, deactivateSupervisor, type SupervisorHandle } from "./supervisor";
import type {
	EngineStatus,
	MilestoneValidatorReconciliation,
	MissionControlConfig,
	PromoteBatchOptions,
} from "./types";
import { DEFAULT_MISSIONCONTROL_CONFIG } from "./types";

export interface EngineDeps {
	cwd: string;
	getMission: () => MissionState | null;
	setMission: (state: MissionState | null) => void;
	/**
	 * Test seam — override the lane-runner factory so suites can verify
	 * what reconciliations are handed to it without module mocking.
	 * Production callers leave this unset to use the real factory.
	 */
	startLaneRunner?: typeof defaultStartLaneRunner;
}

export interface Engine {
	handlers: {
		batch: (opts?: PromoteBatchOptions) => Promise<MissionState | null>;
		pause: () => Promise<MissionState | null>;
		resume: (opts?: { force?: boolean }) => Promise<MissionState | null>;
		abort: (reason?: string) => Promise<MissionState | null>;
	};
	status: () => EngineStatus;
	hooks: {
		onSessionStart: () => Promise<void>;
		onMessageEnd: () => Promise<void>;
		onSessionEnd: () => Promise<void>;
	};
	config: MissionControlConfig;
}

export function createEngine(deps: EngineDeps, cfg: MissionControlConfig = DEFAULT_MISSIONCONTROL_CONFIG): Engine {
	let runner: LaneRunnerHandle | null = null;
	let supervisor: SupervisorHandle | null = null;

	async function persist(state: MissionState): Promise<void> {
		try {
			await saveActiveBatch(deps.cwd, state);
		} catch (err) {
			logger.error("[missioncontrol] persist failed", {
				path: missionBatchPath(deps.cwd),
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async function mutate(fn: (state: MissionState) => MissionState): Promise<MissionState | null> {
		const current = deps.getMission();
		if (!current) return null;
		const next = fn(current);
		deps.setMission(next);
		await persist(next);
		return next;
	}

	const start = deps.startLaneRunner ?? defaultStartLaneRunner;

	function ensureRunner(initialReconciliations?: readonly MilestoneValidatorReconciliation[]): void {
		if (runner?.running) return;
		runner = start({
			cwd: deps.cwd,
			getMission: deps.getMission,
			setMission: state => deps.setMission(state),
			persist,
			config: cfg,
			...(initialReconciliations && initialReconciliations.length > 0
				? { initialMilestoneReconciliations: initialReconciliations }
				: {}),
		});
	}

	async function stopRunner(): Promise<void> {
		if (!runner) return;
		await runner.stop();
		runner = null;
	}

	function ensureSupervisor(batchId: string): void {
		// `writeLockfile` is atomic — calling this when a stale or foreign
		// lockfile exists overwrites it. We still short-circuit when the
		// live handle already covers this batchId to avoid churning the
		// heartbeat interval.
		if (supervisor && supervisor.batchId === batchId) return;
		if (supervisor) supervisor.stop();
		supervisor = activateSupervisor(deps.cwd, batchId);
	}

	function releaseSupervisor(): void {
		if (!supervisor) return;
		deactivateSupervisor(supervisor, deps.cwd);
		supervisor = null;
	}

	async function computeResumeReconciliations(): Promise<MilestoneValidatorReconciliation[]> {
		try {
			const persisted = await loadBatchState(deps.cwd);
			if (!persisted) return [];
			return await reconcileMilestoneValidators(persisted, deps.cwd);
		} catch (err) {
			logger.warn("[missioncontrol] milestone reconciliation failed on resume", {
				error: err instanceof Error ? err.message : String(err),
			});
			return [];
		}
	}

	return {
		config: cfg,
		handlers: {
			batch: async opts => {
				const next = await mutate(state => beginBatch(promoteToBatch(state, opts ?? {}, cfg)));
				if (next?.batch && next.batch.phase === "running") {
					ensureRunner();
					ensureSupervisor(next.batch.batchId);
				}
				return next;
			},
			pause: async () => {
				const next = await mutate(pauseBatch);
				await stopRunner();
				releaseSupervisor();
				return next;
			},
			resume: async opts => {
				// Compute reconciliations BEFORE mutating: the persist step
				// overwrites `.omp/mission-batch.json` with the live MissionState
				// shape, which `loadBatchState` cannot validate as a v5
				// PersistedBatchState. Reading first preserves the on-disk
				// snapshot that reflects the pre-crash state.
				const reconciliations = await computeResumeReconciliations();
				const next = await mutate(state => resumeBatch(state, opts));
				if (next?.batch && next.batch.phase === "running") {
					ensureRunner(reconciliations);
					ensureSupervisor(next.batch.batchId);
				}
				return next;
			},
			abort: async reason => {
				const next = await mutate(state => abortBatch(state, reason));
				await stopRunner();
				releaseSupervisor();
				return next;
			},
		},
		status: () => {
			const state = deps.getMission();
			if (!state?.batch) return { active: false };
			const { batch } = state;
			return {
				active: true,
				batchId: batch.batchId,
				phase: batch.phase,
				laneCount: batch.laneCount,
				tasksTotal: batch.tasksTotal,
				tasksComplete: batch.tasksComplete,
				tasksFailed: batch.tasksFailed,
			};
		},
		hooks: {
			onSessionStart: async () => {
				// Same ordering rule as `resume`: read the on-disk v5
				// snapshot before `setMission` triggers any downstream persist.
				const reconciliations = await computeResumeReconciliations();
				const persisted = await loadActiveBatch(deps.cwd);
				if (persisted) {
					deps.setMission(persisted);
					if (persisted.batch?.phase === "running") {
						ensureRunner(reconciliations);
						ensureSupervisor(persisted.batch.batchId);
					}
				}
			},
			onMessageEnd: async () => {
				// Simple missions stay on the phase detector path. Batch missions
				// are driven by the lane-runner, which mutates state directly.
			},
			onSessionEnd: async () => {
				const state = deps.getMission();
				if (state?.batch && state.batch.phase === "running") {
					await mutate(pauseBatch);
				}
				await stopRunner();
				releaseSupervisor();
			},
		},
	};
}
