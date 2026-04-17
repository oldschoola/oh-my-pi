/**
 * MVP lane runner — drains waves by spawning agents, awaiting exits, and
 * recording outcomes via engine reducers.
 *
 * This is a minimal viable implementation: one agent per lane, sequential
 * dispatch within a lane, no merge, no quality gates, no retries. Full
 * lane-runner (with worktrees, mailbox polling, supervisor coordination)
 * lands when the heavy taskplane modules are ported.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { MissionState, TaskOutcome } from "../types";
import { type SpawnAgentHandle, spawnAgent } from "./adapter";
import { advanceWave, recordTaskOutcome, setLaneStatus } from "./engine";
import type { MissionControlConfig } from "./types";

export interface LaneRunnerDeps {
	cwd: string;
	getMission: () => MissionState | null;
	setMission: (state: MissionState) => void;
	persist: (state: MissionState) => Promise<void>;
	config: MissionControlConfig;
}

export interface LaneRunnerHandle {
	stop(): Promise<void>;
	readonly running: boolean;
}

export function startLaneRunner(deps: LaneRunnerDeps): LaneRunnerHandle {
	let stopped = false;
	const activeAgents = new Set<SpawnAgentHandle>();

	const loop = (async () => {
		while (!stopped) {
			const state = deps.getMission();
			if (!state?.batch) break;
			if (state.batch.phase !== "running") break;

			const currentWave = state.batch.waves[state.batch.currentWave];
			const currentWaveTasks = currentWave?.taskIds ?? [];
			const pending = currentWaveTasks.filter(id => {
				const task = state.batch?.tasks.find(t => t.taskId === id);
				return task && task.status === "pending";
			});

			if (pending.length === 0) {
				const advanced = advanceWave(state);
				deps.setMission(advanced);
				await deps.persist(advanced);
				if (advanced.batch?.phase === "complete") break;
				continue;
			}

			const freeLanes = state.batch.laneStatuses.filter(l => l.status === "idle");
			if (freeLanes.length === 0) {
				await sleep(500);
				continue;
			}

			const batch: Array<{ laneNumber: number; taskId: string }> = [];
			for (let i = 0; i < Math.min(freeLanes.length, pending.length); i++) {
				const lane = freeLanes[i];
				const taskId = pending[i];
				if (!lane || !taskId) continue;
				batch.push({ laneNumber: lane.lane, taskId });
			}

			await Promise.all(batch.map(assignment => runTask(assignment, deps, activeAgents, () => stopped)));
		}
	})().catch(err => {
		logger.error("[missioncontrol] lane-runner loop failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	return {
		get running() {
			return !stopped;
		},
		async stop() {
			stopped = true;
			await Promise.all(Array.from(activeAgents).map(a => a.stop()));
			await loop;
		},
	};
}

async function runTask(
	assignment: { laneNumber: number; taskId: string },
	deps: LaneRunnerDeps,
	activeAgents: Set<SpawnAgentHandle>,
	isStopped: () => boolean,
): Promise<void> {
	const start = Date.now();
	const stateBefore = deps.getMission();
	if (!stateBefore?.batch) return;

	const afterLane = setLaneStatus(stateBefore, assignment.laneNumber, {
		status: "running",
		taskId: assignment.taskId,
		stepProgress: "starting",
		elapsed: 0,
	});
	const withTaskStart = withTaskStatus(afterLane, assignment.taskId, { status: "running", startTime: start });
	deps.setMission(withTaskStart);
	await deps.persist(withTaskStart);

	let outcome: TaskOutcome = {
		taskId: assignment.taskId,
		status: "succeeded",
		startTime: start,
		endTime: Date.now(),
		exitReason: "",
		sessionName: `lane-${assignment.laneNumber}`,
		doneFileFound: false,
	};

	try {
		const handle = await spawnAgent({
			cwd: deps.cwd,
			modelId: deps.config.model,
			prompt: buildTaskPrompt(assignment.taskId),
		});
		activeAgents.add(handle);
		try {
			await handle.done;
		} finally {
			activeAgents.delete(handle);
		}
		if (isStopped()) {
			outcome = { ...outcome, status: "failed", exitReason: "aborted", endTime: Date.now() };
		} else {
			outcome = { ...outcome, endTime: Date.now() };
		}
	} catch (err) {
		outcome = {
			...outcome,
			status: "failed",
			exitReason: err instanceof Error ? err.message : String(err),
			endTime: Date.now(),
		};
	}

	const current = deps.getMission();
	if (!current?.batch) return;
	const withOutcome = recordTaskOutcome(current, outcome);
	const withIdleLane = setLaneStatus(withOutcome, assignment.laneNumber, {
		status: "idle",
		taskId: null,
		stepProgress: "",
		elapsed: Date.now() - start,
	});
	deps.setMission(withIdleLane);
	await deps.persist(withIdleLane);
}

function withTaskStatus(state: MissionState, taskId: string, patch: Partial<TaskOutcome>): MissionState {
	if (!state.batch) return state;
	return {
		...state,
		batch: {
			...state.batch,
			tasks: state.batch.tasks.map(t => (t.taskId === taskId ? { ...t, ...patch } : t)),
		},
	};
}

function buildTaskPrompt(taskId: string): string {
	return (
		`Mission task: ${taskId}\n\n` +
		`Complete the task defined for id "${taskId}". Write a .DONE file at the task directory when finished. ` +
		`Exit cleanly when the work is complete.`
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
