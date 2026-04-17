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
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { MissionState } from "../types";
import { missionBatchPath } from "./adapter";
import { abortBatch, beginBatch, pauseBatch, promoteToBatch, resumeBatch } from "./engine";
import { type LaneRunnerHandle, startLaneRunner } from "./lane-runner";
import { loadActiveBatch, saveActiveBatch } from "./persistence";
import type { EngineStatus, MissionControlConfig, PromoteBatchOptions } from "./types";
import { DEFAULT_MISSIONCONTROL_CONFIG } from "./types";

export interface EngineDeps {
	cwd: string;
	getMission: () => MissionState | null;
	setMission: (state: MissionState | null) => void;
}

export interface Engine {
	handlers: {
		batch: (opts?: PromoteBatchOptions) => Promise<MissionState | null>;
		pause: () => Promise<MissionState | null>;
		resume: () => Promise<MissionState | null>;
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

	function ensureRunner(): void {
		if (runner?.running) return;
		runner = startLaneRunner({
			cwd: deps.cwd,
			getMission: deps.getMission,
			setMission: state => deps.setMission(state),
			persist,
			config: cfg,
		});
	}

	async function stopRunner(): Promise<void> {
		if (!runner) return;
		await runner.stop();
		runner = null;
	}

	return {
		config: cfg,
		handlers: {
			batch: async opts => {
				const next = await mutate(state => beginBatch(promoteToBatch(state, opts ?? {}, cfg)));
				if (next?.batch && next.batch.phase === "running") ensureRunner();
				return next;
			},
			pause: async () => {
				const next = await mutate(pauseBatch);
				await stopRunner();
				return next;
			},
			resume: async () => {
				const next = await mutate(resumeBatch);
				if (next?.batch && next.batch.phase === "running") ensureRunner();
				return next;
			},
			abort: async reason => {
				const next = await mutate(state => abortBatch(state, reason));
				await stopRunner();
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
				const persisted = await loadActiveBatch(deps.cwd);
				if (persisted) {
					deps.setMission(persisted);
					if (persisted.batch?.phase === "running") ensureRunner();
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
			},
		},
	};
}
