/**
 * Config loading — thin wrappers over the unified loader.
 *
 * Preserves the snake_case return shapes (`OrchestratorConfig`,
 * `TaskRunnerConfig`, `SupervisorConfig`) so downstream engine consumers can
 * stay unchanged while the JSON migration lands.
 *
 * Reads `.omp/mission.json` first; falls back to legacy YAML files + defaults.
 * Pointer-resolution (workspace redirection) is honored via `pointerConfigRoot`.
 */

import { loadProjectConfig, toOrchestratorConfig, toTaskRunnerConfig } from "./config-loader";
import type { OrchestratorConfig, SupervisorConfig, TaskRunnerConfig } from "./types";
import { DEFAULT_SUPERVISOR_CONFIG } from "./types";

export { hasConfigFiles, resolveConfigRoot } from "./config-loader";

/**
 * Load orchestrator config.
 *
 * In workspace mode, `pointerConfigRoot` is inserted into the config
 * resolution chain between cwd-local and `OMP_WORKSPACE_ROOT`.
 */
export function loadOrchestratorConfig(cwd: string, pointerConfigRoot?: string): OrchestratorConfig {
	const unified = loadProjectConfig(cwd, pointerConfigRoot);
	return toOrchestratorConfig(unified);
}

/** Load task-runner config (orchestrator subset). */
export function loadTaskRunnerConfig(cwd: string, pointerConfigRoot?: string): TaskRunnerConfig {
	const unified = loadProjectConfig(cwd, pointerConfigRoot);
	return toTaskRunnerConfig(unified);
}

/**
 * Load supervisor config from unified project config.
 *
 * Extracts `orchestrator.supervisor`; falls back to defaults if the section
 * is missing (backward compat with configs created before supervisor landed).
 */
export function loadSupervisorConfig(cwd: string, pointerConfigRoot?: string): SupervisorConfig {
	const unified = loadProjectConfig(cwd, pointerConfigRoot);
	const section = unified.orchestrator.supervisor;
	if (!section) return { ...DEFAULT_SUPERVISOR_CONFIG };
	return {
		model: section.model ?? DEFAULT_SUPERVISOR_CONFIG.model,
		autonomy: section.autonomy ?? DEFAULT_SUPERVISOR_CONFIG.autonomy,
	};
}
