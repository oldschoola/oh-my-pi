/**
 * `/mission-deps` command helper — pure function that builds a dependency-graph
 * report from a mission state + user args.
 *
 * Extracted from taskplane `/orch-deps` handler (extension.ts:3436-3511).
 * Trimmed to the fields available in oh-my-pi — no dependency cache or
 * refresh flag, no workspace routing. Task areas come from the loaded
 * TaskRunnerConfig; completed tasks come from `mission.batch.tasks`.
 *
 * Returns a structured result so the extension layer owns all UI glue.
 */

import { isAbsolute, join } from "node:path";

import type { MissionState } from "../types";
import { loadTaskRunnerConfig } from "./config";
import { discoverTasks, type ParsedTask } from "./discovery";
import { formatDependencyGraph } from "./formatting";

export interface MissionDepsReport {
	message: string;
	level: "info" | "warning" | "error";
}

const USAGE =
	"Usage: /mission-deps <areas|all> [--task <id>]\n\n" +
	"Shows the dependency graph for tasks in the specified areas.\n\n" +
	"Options:\n" +
	"  --task <id>    Show dependencies for a single task only\n\n" +
	"Examples:\n" +
	"  /mission-deps all\n" +
	"  /mission-deps all --task TO-014\n" +
	"  /mission-deps api frontend";

interface ParsedDepsArgs {
	filterTaskId?: string;
	targets: string[];
}

export function parseMissionDepsArgs(raw: string): ParsedDepsArgs {
	const result: ParsedDepsArgs = { targets: [] };
	const taskMatch = raw.match(/--task\s+([A-Z]+-\d+)/i);
	if (taskMatch) {
		result.filterTaskId = taskMatch[1].toUpperCase();
	}
	const clean = raw.replace(/--task\s+[A-Z]+-\d+/gi, "").trim();
	if (!clean) return result;
	result.targets = clean.split(/\s+/).filter(Boolean);
	return result;
}

export function buildMissionDepsReport(cwd: string, rawArgs: string, mission: MissionState | null): MissionDepsReport {
	const trimmed = rawArgs?.trim() ?? "";
	if (!trimmed) return { message: USAGE, level: "info" };

	const parsed = parseMissionDepsArgs(trimmed);
	if (parsed.targets.length === 0) {
		return {
			message: `${USAGE}\n\nError: target argument required (e.g., 'all' or an area name).`,
			level: "error",
		};
	}

	const runner = loadTaskRunnerConfig(cwd);
	const areas = runner.task_areas ?? {};
	const areaNames = Object.keys(areas);
	if (areaNames.length === 0) {
		return {
			message: "No task areas configured. Add `task_areas` to `.omp/mission.json` first.",
			level: "warning",
		};
	}

	const wantAll = parsed.targets.includes("all");
	const selected: { name: string; path: string }[] = [];
	const unknown: string[] = [];
	const targets = wantAll ? areaNames : parsed.targets;
	for (const name of targets) {
		const area = areas[name];
		if (!area) {
			unknown.push(name);
			continue;
		}
		const resolved = isAbsolute(area.path) ? area.path : join(cwd, area.path);
		selected.push({ name, path: resolved });
	}
	if (selected.length === 0) {
		return {
			message: `Unknown area(s): ${unknown.join(", ")}. Known: ${areaNames.join(", ")}.`,
			level: "error",
		};
	}

	const pending = new Map<string, ParsedTask>();
	for (const area of selected) {
		for (const task of discoverTasks(area.path)) {
			if (!pending.has(task.taskId)) pending.set(task.taskId, task);
		}
	}

	const completed = new Set<string>();
	if (mission?.batch) {
		for (const outcome of mission.batch.tasks) {
			if (outcome.status === "succeeded") completed.add(outcome.taskId);
		}
	}

	const lines: string[] = [];
	if (unknown.length > 0) {
		lines.push(`⚠ Skipped unknown area(s): ${unknown.join(", ")}`);
		lines.push("");
	}
	if (pending.size === 0) {
		lines.push(`No pending tasks found in: ${selected.map(s => s.name).join(", ")}`);
		return { message: lines.join("\n"), level: "warning" };
	}
	lines.push(formatDependencyGraph(pending, completed, parsed.filterTaskId));
	return { message: lines.join("\n"), level: unknown.length > 0 ? "warning" : "info" };
}
