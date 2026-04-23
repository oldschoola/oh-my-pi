/**
 * `/mission-plan` command helper — preview the execution plan for a target
 * (preflight checks, discovery results, dependency graph, wave plan).
 *
 * Complements `/mission-deps` (dependency graph only) by running the full
 * discovery + wave computation pipeline without starting a batch. The output
 * mirrors what a supervisor/operator sees in the first seconds of
 * `/mission-batch all`, minus the actual lane spawn.
 *
 * Pure except for config + filesystem reads (via `runDiscovery` /
 * `runPreflight`). Returns a structured `{ message, level }` so the
 * extension layer owns UI glue.
 */

import type { MissionState } from "../types";
import { loadOrchestratorConfig, loadTaskRunnerConfig } from "./config";
import { runDiscovery } from "./discovery";
import { formatDependencyGraph, formatDiscoveryResults, formatWavePlan } from "./formatting";
import { FATAL_DISCOVERY_CODES } from "./types";
import { buildDependencyGraph, computeWaveAssignments, validateGraph } from "./waves";
import { formatPreflightResults, runPreflight } from "./worktree";

export interface MissionPlanReport {
	message: string;
	level: "info" | "warning" | "error";
}

const USAGE =
	"Usage: /mission-plan <areas|all> [--refresh]\n\n" +
	"Preview the execution plan for the selected target without starting a batch.\n" +
	"Shows preflight checks, discovered tasks, dependency graph, and wave plan.\n\n" +
	"Options:\n" +
	"  --refresh   Force-refresh dependency cache during discovery\n\n" +
	"Examples:\n" +
	"  /mission-plan all\n" +
	"  /mission-plan api frontend\n" +
	"  /mission-plan all --refresh";

interface ParsedPlanArgs {
	refresh: boolean;
	targets: string[];
	help: boolean;
}

export function parseMissionPlanArgs(raw: string): ParsedPlanArgs {
	const result: ParsedPlanArgs = { refresh: false, targets: [], help: false };
	const trimmed = raw?.trim() ?? "";
	if (!trimmed) return result;

	for (const token of trimmed.split(/\s+/).filter(Boolean)) {
		if (token === "--help" || token === "-h") {
			result.help = true;
		} else if (token === "--refresh") {
			result.refresh = true;
		} else if (token.startsWith("--")) {
			// Unknown flag → treat as target so the downstream discovery
			// argument resolver can surface the issue with context.
			result.targets.push(token);
		} else {
			result.targets.push(token);
		}
	}
	return result;
}

export function buildMissionPlanReport(cwd: string, rawArgs: string, mission: MissionState | null): MissionPlanReport {
	const parsed = parseMissionPlanArgs(rawArgs ?? "");
	if (parsed.help) return { message: USAGE, level: "info" };
	if (parsed.targets.length === 0) return { message: USAGE, level: "info" };

	const runner = loadTaskRunnerConfig(cwd);
	const taskAreas = runner.task_areas ?? {};
	const orchestrator = loadOrchestratorConfig(cwd);

	const sections: string[] = [];

	// 1. Preflight
	const preflight = runPreflight(orchestrator, cwd);
	sections.push(formatPreflightResults(preflight));
	if (!preflight.passed) {
		return { message: sections.join("\n\n"), level: "error" };
	}

	// 2. Discovery
	const discovery = runDiscovery(parsed.targets.join(" "), taskAreas, cwd, {
		refreshDependencies: parsed.refresh,
		dependencySource: orchestrator.dependencies?.source ?? "prompt",
		useDependencyCache: orchestrator.dependencies?.cache ?? false,
	});

	// Merge completed tasks from the active batch so they render as ✅
	// in the dependency graph even when they are no longer on disk.
	if (mission?.batch) {
		for (const outcome of mission.batch.tasks) {
			if (outcome.status === "succeeded") {
				discovery.completed.add(outcome.taskId);
			}
		}
	}

	sections.push(formatDiscoveryResults(discovery));

	const fatalCodes = new Set<string>(FATAL_DISCOVERY_CODES);
	const hasFatal = discovery.errors.some(e => fatalCodes.has(e.code));
	if (hasFatal) {
		return { message: sections.join("\n\n"), level: "error" };
	}
	if (discovery.pending.size === 0) {
		return { message: sections.join("\n\n"), level: "warning" };
	}

	// 3. Dependency graph
	sections.push(formatDependencyGraph(discovery.pending, discovery.completed));

	// 4. Wave plan (pre-validate so errors surface as readable text rather than
	//    empty wave output — computeWaveAssignments returns { waves: [] } on
	//    validation failure).
	const graph = buildDependencyGraph(discovery.pending, discovery.completed);
	const validation = validateGraph(graph, discovery.pending, discovery.completed);
	if (!validation.valid) {
		const errs = validation.errors.map(e => `  [${e.code}] ${e.message}`).join("\n");
		sections.push(`❌ Dependency graph invalid:\n${errs}`);
		return { message: sections.join("\n\n"), level: "error" };
	}

	const waveResult = computeWaveAssignments(discovery.pending, discovery.completed, orchestrator);
	const sizeWeights = orchestrator.assignment?.size_weights ?? { S: 1, M: 2, L: 4 };
	sections.push(formatWavePlan(waveResult, sizeWeights));

	const level: "info" | "warning" = discovery.errors.length > 0 ? "warning" : "info";
	return { message: sections.join("\n\n"), level };
}
