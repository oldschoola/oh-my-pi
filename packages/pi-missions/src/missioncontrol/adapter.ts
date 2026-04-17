/**
 * Adapter shim — the one place MissionControl talks to oh-my-pi.
 *
 * Every other engine module imports from this module so the port stays
 * mechanical. Replaces taskplane's direct `pi --mode rpc` spawn, pi model
 * registry calls, and `.pi/` path resolution.
 *
 * NOTE: agent spawning is stubbed in the MVP — it resolves but does not
 * execute. Full RpcClient integration lands when the taskplane
 * agent-host/lane-runner/execution modules are ported.
 */

import * as path from "node:path";
import { getAgentDir, getProjectAgentDir, logger } from "@oh-my-pi/pi-utils";

export { logger };

export function projectDir(cwd: string): string {
	return getProjectAgentDir(cwd);
}

/**
 * User-level agent dir (e.g. `~/.omp/agent`). Thin wrapper so every
 * caller in missioncontrol goes through the adapter boundary instead
 * of importing from `@oh-my-pi/pi-utils` directly.
 */
export function userAgentDir(): string {
	return getAgentDir();
}

export function missionBatchPath(cwd: string): string {
	return path.join(projectDir(cwd), "mission-batch.json");
}

export function missionsDir(cwd: string): string {
	return path.join(projectDir(cwd), "missions");
}

export function missionTelemetryDir(cwd: string, missionId: string): string {
	return path.join(projectDir(cwd), "mission-telemetry", missionId);
}

export function legacyBatchPath(cwd: string): string {
	return path.join(cwd, ".pi", "batch-state.json");
}

export interface SpawnAgentOpts {
	cwd: string;
	modelId: string;
	prompt: string;
	sessionDir?: string;
	env?: Record<string, string>;
	onEvent?: (event: unknown) => void;
	/** Additional CLI args passed to the child agent. */
	extraArgs?: string[];
}

export interface SpawnAgentHandle {
	stop(): Promise<void>;
	readonly pid: number | null;
	/** Resolves when the agent process exits (any outcome). */
	readonly done: Promise<void>;
}

/**
 * Spawn an oh-my-pi RPC coding-agent subprocess via `RpcClient`.
 *
 * The pi-coding-agent package is an optional peer dependency, so the client
 * is loaded lazily. When unavailable (or when `OMP_MISSION_STUB_AGENT=1` is
 * set for tests) a no-op handle is returned and a warning is logged.
 *
 * CLI discovery order: `OMP_CLI_PATH` env → dynamic-import default.
 */
export async function spawnAgent(opts: SpawnAgentOpts): Promise<SpawnAgentHandle> {
	if (process.env.OMP_MISSION_STUB_AGENT === "1") {
		logger.debug("[missioncontrol] spawnAgent: stub mode");
		return noopHandle();
	}

	let RpcClient: typeof import("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client").RpcClient;
	try {
		({ RpcClient } = await import("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client"));
	} catch (err) {
		logger.warn("[missioncontrol] pi-coding-agent not installed — agent spawn disabled", {
			error: err instanceof Error ? err.message : String(err),
		});
		return noopHandle();
	}

	const client = new RpcClient({
		cliPath: process.env.OMP_CLI_PATH,
		cwd: opts.cwd,
		model: opts.modelId,
		sessionDir: opts.sessionDir,
		env: opts.env,
		args: opts.extraArgs,
	});

	if (opts.onEvent) client.onEvent(opts.onEvent);

	try {
		await client.start();
	} catch (err) {
		logger.error("[missioncontrol] RpcClient.start failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		client.stop();
		return noopHandle();
	}

	const done = client
		.promptAndWait(opts.prompt, undefined, 30 * 60 * 1000)
		.then(() => {})
		.catch(err => {
			logger.error("[missioncontrol] agent prompt failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		})
		.finally(() => client.stop());

	return {
		get pid() {
			return null;
		},
		async stop() {
			client.stop();
			await done;
		},
		done,
	};
}

function noopHandle(): SpawnAgentHandle {
	return {
		pid: null,
		async stop() {},
		done: Promise.resolve(),
	};
}
