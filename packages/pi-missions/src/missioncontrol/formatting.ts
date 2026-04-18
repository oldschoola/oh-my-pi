/**
 * Output formatting — dependency graph, wave plan, dashboard view-model,
 * and the `createMissionWidget` renderer.
 *
 * Ported from taskplane `extensions/taskplane/formatting.ts` with:
 *  - pi-tui import switched from `@mariozechner/pi-tui` to `@oh-my-pi/pi-tui`
 *  - `OrchBatchRuntimeState` → `MissionBatchRuntimeState`
 *  - `OrchDashboardViewModel` → `MissionDashboardViewModel`
 *  - `OrchLaneCardData` → `MissionLaneCardData`
 *  - `OrchSummaryCounts` → `MissionSummaryCounts`
 *  - `computeOrchSummaryCounts` → `computeMissionSummaryCounts`
 *  - `createOrchWidget` → `createMissionWidget`
 *  - `/orch-sessions` attach hint text → `/mission-sessions`
 *
 * Pure — no side effects.
 */

import { truncateToWidth } from "@oh-my-pi/pi-tui";

import { type ParsedTask, parseDependencyReference } from "./discovery";
import {
	type DiscoveryResult,
	FATAL_DISCOVERY_CODES,
	getTaskDurationMinutes,
	type LaneAssignment,
	type MissionBatchRuntimeState,
	type MissionDashboardViewModel,
	type MissionLaneCardData,
	type MissionSummaryCounts,
	type MonitorState,
	SIZE_DURATION_MINUTES,
	type WaveComputationResult,
} from "./types";

/** Narrow shape of the pi-tui theme passed to widget renderers. */
export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

// ── Dependency Graph Formatting ──────────────────────────────────────

/**
 * Format a dependency graph for display.
 *
 * Shows both upstream (what each task depends on) and downstream
 * (what depends on each task) views. Output is deterministic:
 * tasks sorted by ID, edges sorted by target ID.
 *
 * If `filterTaskId` is provided, only shows edges involving that task.
 */
export function formatDependencyGraph(
	pending: Map<string, ParsedTask>,
	completed: Set<string>,
	filterTaskId?: string,
): string {
	const lines: string[] = [];

	const sortedTasks = [...pending.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));

	const downstream = new Map<string, string[]>();
	for (const task of sortedTasks) {
		for (const depRaw of task.dependencies) {
			const depId = parseDependencyReference(depRaw).taskId;
			const existing = downstream.get(depId) || [];
			existing.push(task.taskId);
			downstream.set(depId, existing);
		}
	}

	if (filterTaskId) {
		const task = pending.get(filterTaskId);
		if (!task) {
			lines.push(`❌ Task "${filterTaskId}" not found in pending tasks.`);
			return lines.join("\n");
		}

		lines.push(`🔗 Dependencies for ${filterTaskId} (${task.taskName}):`);
		lines.push("");

		lines.push("  ⬆ Upstream (depends on):");
		if (task.dependencies.length === 0) {
			lines.push("    (none — no dependencies)");
		} else {
			const sortedDeps = [...task.dependencies].sort();
			for (const depRaw of sortedDeps) {
				const depId = parseDependencyReference(depRaw).taskId;
				const status = completed.has(depId) ? "✅ complete" : pending.has(depId) ? "⏳ pending" : "❓ unknown";
				lines.push(`    ${filterTaskId} → ${depRaw} (${status})`);
			}
		}

		lines.push("");
		lines.push("  ⬇ Downstream (depended on by):");
		const downstreamTasks = (downstream.get(filterTaskId) || []).sort();
		if (downstreamTasks.length === 0) {
			lines.push("    (none — no tasks depend on this)");
		} else {
			for (const dep of downstreamTasks) {
				lines.push(`    ${dep} → ${filterTaskId}`);
			}
		}

		return lines.join("\n");
	}

	lines.push("🔗 Dependency Graph:");
	lines.push("");

	let hasDeps = false;

	lines.push("  ⬆ Upstream (task → depends on):");
	for (const task of sortedTasks) {
		if (task.dependencies.length > 0) {
			hasDeps = true;
			const sortedDeps = [...task.dependencies].sort();
			for (const depRaw of sortedDeps) {
				const depId = parseDependencyReference(depRaw).taskId;
				const status = completed.has(depId) ? "✅ complete" : pending.has(depId) ? "⏳ pending" : "❓ unknown";
				lines.push(`    ${task.taskId} → ${depRaw} (${status})`);
			}
		}
	}
	if (!hasDeps) {
		lines.push("    (none — all tasks are independent)");
	}

	lines.push("");
	lines.push("  ⬇ Downstream (task ← depended on by):");
	let hasDownstream = false;
	const allTargets = new Set<string>();
	for (const task of sortedTasks) {
		for (const depRaw of task.dependencies) {
			allTargets.add(parseDependencyReference(depRaw).taskId);
		}
	}
	const sortedTargets = [...allTargets].sort();
	for (const target of sortedTargets) {
		const dependents = (downstream.get(target) || []).sort();
		if (dependents.length > 0) {
			hasDownstream = true;
			const status = completed.has(target) ? "✅" : pending.has(target) ? "⏳" : "❓";
			lines.push(`    ${target} ${status} ← ${dependents.join(", ")}`);
		}
	}
	if (!hasDownstream) {
		lines.push("    (none — no downstream dependencies)");
	}

	const independentTasks = sortedTasks.filter(t => t.dependencies.length === 0 && !downstream.get(t.taskId)?.length);
	if (independentTasks.length > 0) {
		lines.push("");
		lines.push("  ○ Independent (no dependencies, nothing depends on them):");
		for (const task of independentTasks) {
			lines.push(`    ${task.taskId} [${task.size}] ${task.taskName}`);
		}
	}

	return lines.join("\n");
}

/**
 * Format a DiscoveryResult for terminal display.
 *
 * Ported from taskplane `discovery.ts:1749`. Groups pending tasks by area
 * (deterministic: areas + tasks sorted alphabetically/by id), shows dependency
 * + repo suffixes when present, and splits errors into fatal (via
 * FATAL_DISCOVERY_CODES) + warnings.
 */
export function formatDiscoveryResults(result: DiscoveryResult): string {
	const lines: string[] = [];

	lines.push("📋 Discovery Results");
	lines.push(`   Pending tasks:   ${result.pending.size}`);
	lines.push(`   Completed tasks: ${result.completed.size}`);
	lines.push("");

	if (result.pending.size > 0) {
		const byArea = new Map<string, ParsedTask[]>();
		for (const task of result.pending.values()) {
			const area = task.areaName ?? "";
			const existing = byArea.get(area) ?? [];
			existing.push(task);
			byArea.set(area, existing);
		}

		lines.push("Pending Tasks:");
		const sortedAreas = [...byArea.entries()].sort((a, b) => a[0].localeCompare(b[0]));
		for (const [area, tasks] of sortedAreas) {
			lines.push(`  ${area}:`);
			const sortedTasks = [...tasks].sort((a, b) => a.taskId.localeCompare(b.taskId));
			for (const task of sortedTasks) {
				const deps = task.dependencies.length > 0 ? ` → depends on: ${task.dependencies.join(", ")}` : "";
				const repo = task.resolvedRepoId ? ` → repo: ${task.resolvedRepoId}` : "";
				lines.push(`    ${task.taskId} [${task.size}] ${task.taskName}${deps}${repo}`);
			}
		}
		lines.push("");
	}

	if (result.errors.length > 0) {
		const fatalCodes = new Set<string>(FATAL_DISCOVERY_CODES);
		const fatalErrors = result.errors.filter(e => fatalCodes.has(e.code));
		const warnings = result.errors.filter(e => !fatalCodes.has(e.code));

		if (fatalErrors.length > 0) {
			lines.push("❌ Errors:");
			for (const err of fatalErrors) lines.push(`  [${err.code}] ${err.message}`);
			lines.push("");
		}

		if (warnings.length > 0) {
			lines.push("⚠️  Warnings:");
			for (const err of warnings) lines.push(`  [${err.code}] ${err.message}`);
			lines.push("");
		}
	}

	return lines.join("\n");
}

/**
 * Format wave computation results as a readable execution plan.
 *
 * Output sections (fixed order):
 * 1. Wave overview header
 * 2. Per-wave: task count, lane count, parallel/serial indicator
 * 3. Per-lane within wave: tasks with sizes, serial notes, lane weight
 * 4. Per-wave: estimated duration (critical path = max lane duration)
 * 5. Summary: total estimated duration, size-to-duration table
 */
export function formatWavePlan(result: WaveComputationResult, sizeWeights: Record<string, number>): string {
	const lines: string[] = [];

	if (result.errors.length > 0) {
		lines.push("❌ Wave Computation Errors:");
		for (const err of result.errors) {
			lines.push(`  [${err.code}] ${err.message}`);
		}
		return lines.join("\n");
	}

	if (result.waves.length === 0) {
		lines.push("No waves to schedule.");
		return lines.join("\n");
	}

	const totalTasks = result.waves.reduce((sum, w) => sum + w.tasks.length, 0);
	const maxLanesUsed = Math.max(
		...result.waves.map(w => {
			const lanes = new Set(w.tasks.map(t => t.lane));
			return lanes.size;
		}),
	);

	lines.push(
		`🌊 Execution Plan: ${result.waves.length} wave(s), ${totalTasks} task(s), up to ${maxLanesUsed} lane(s)`,
	);
	lines.push("");

	let totalEstimate = 0;
	for (const wave of result.waves) {
		const laneGroups = new Map<number, LaneAssignment[]>();
		for (const assignment of wave.tasks) {
			const existing = laneGroups.get(assignment.lane) || [];
			existing.push(assignment);
			laneGroups.set(assignment.lane, existing);
		}

		const laneCount = laneGroups.size;
		const taskCount = wave.tasks.length;
		const parallel = laneCount > 1 ? "parallel" : "serial";

		lines.push(`  Wave ${wave.waveNumber}: ${taskCount} task(s) across ${laneCount} lane(s) [${parallel}]`);

		let maxLaneDuration = 0;
		const sortedLanes = [...laneGroups.entries()].sort((a, b) => a[0] - b[0]);

		for (const [lane, assignments] of sortedLanes) {
			const sortedAssignments = [...assignments].sort((a, b) => a.taskId.localeCompare(b.taskId));
			const taskList = sortedAssignments.map(a => `${a.taskId} [${a.task.size}]`).join(", ");
			const laneDuration = sortedAssignments.reduce(
				(sum, a) => sum + getTaskDurationMinutes(a.task.size, sizeWeights),
				0,
			);
			if (laneDuration > maxLaneDuration) maxLaneDuration = laneDuration;
			const serialNote = sortedAssignments.length > 1 ? " (serial)" : "";
			lines.push(`    Lane ${lane}: ${taskList}${serialNote}  [est. ${laneDuration} min]`);
		}

		totalEstimate += maxLaneDuration;
		lines.push(`    ⏱  Wave duration: ${maxLaneDuration} min (critical path: longest lane)`);
		lines.push("");
	}

	const totalHours = (totalEstimate / 60).toFixed(1);
	lines.push(`📊 Total estimated duration: ${totalEstimate} min (~${totalHours} hours)`);
	lines.push(
		`   Duration model: S=${SIZE_DURATION_MINUTES.S}m, M=${SIZE_DURATION_MINUTES.M}m, L=${SIZE_DURATION_MINUTES.L}m`,
	);
	lines.push("   Critical path: sum of per-wave bottleneck lanes (waves sequential, lanes parallel)");

	return lines.join("\n");
}

// ── Summary Helpers ──────────────────────────────────────────────────

/**
 * Compute summary counts from batch state + optional monitor state.
 *
 * Pure function — no side effects, deterministic output.
 */
export function computeMissionSummaryCounts(
	batchState: MissionBatchRuntimeState,
	monitorState?: MonitorState | null,
): MissionSummaryCounts {
	let running = 0;
	let stalled = 0;

	if (monitorState) {
		for (const lane of monitorState.lanes) {
			if (lane.currentTaskSnapshot) {
				if (lane.currentTaskSnapshot.status === "stalled") {
					stalled++;
				} else if (lane.currentTaskSnapshot.status === "running") {
					running++;
				}
			}
		}
	}

	const completed = batchState.succeededTasks;
	const failed = batchState.failedTasks;
	const blocked = batchState.blockedTasks;
	const total = batchState.totalTasks;
	const queued = Math.max(0, total - completed - failed - blocked - stalled - running - batchState.skippedTasks);

	return { completed, running, queued, failed, blocked, stalled, total };
}

/**
 * Format elapsed time from start/end timestamps.
 *
 * @param startMs - Start epoch ms
 * @param endMs   - End epoch ms (null = use current time)
 * @returns Human-readable string, e.g., "2m 14s" or "1h 5m 30s"
 */
export function formatElapsedTime(startMs: number, endMs?: number | null): string {
	if (startMs <= 0) return "0s";
	const elapsed = (endMs ?? Date.now()) - startMs;
	if (elapsed < 0) return "0s";

	const totalSec = Math.floor(elapsed / 1000);
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;

	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/**
 * Build the dashboard view-model from runtime state.
 *
 * Pure function — deterministic mapping from MissionBatchRuntimeState +
 * optional MonitorState to render-ready MissionDashboardViewModel.
 *
 * Fallback behavior:
 * - No batch → idle view with zeroed counts
 * - No monitor data → empty lane cards, counts from batch state only
 * - Missing STATUS.md → "no data" in lane card
 */
export function buildDashboardViewModel(
	batchState: MissionBatchRuntimeState,
	monitorState?: MonitorState | null,
): MissionDashboardViewModel {
	const summary = computeMissionSummaryCounts(batchState, monitorState);
	const elapsed = formatElapsedTime(batchState.startedAt, batchState.endedAt);

	const waveProgress =
		batchState.totalWaves > 0 ? `${Math.max(0, batchState.currentWaveIndex + 1)}/${batchState.totalWaves}` : "0/0";

	const laneCards: MissionLaneCardData[] = [];

	// TP-170: Detect stale monitor data from prior waves.
	const monitorIsFresh =
		monitorState &&
		monitorState.lanes.length > 0 &&
		(batchState.currentLanes.length === 0 ||
			monitorState.lanes.some(ml => batchState.currentLanes.some(cl => cl.laneNumber === ml.laneNumber)));

	// TP-170: Build a laneNumber → AllocatedLane index for identity reconciliation.
	const allocatedByLaneNumber = new Map<number, { laneSessionId: string; laneId: string }>();
	for (const cl of batchState.currentLanes) {
		allocatedByLaneNumber.set(cl.laneNumber, {
			laneSessionId: cl.laneSessionId,
			laneId: cl.laneId,
		});
	}

	if (monitorIsFresh && monitorState) {
		const sortedLanes = [...monitorState.lanes].sort((a, b) => a.laneNumber - b.laneNumber);

		for (const lane of sortedLanes) {
			const snap = lane.currentTaskSnapshot;
			const alloc = allocatedByLaneNumber.get(lane.laneNumber);

			let status: MissionLaneCardData["status"] = "idle";
			if (lane.failedTasks.length > 0) {
				status = "failed";
			} else if (snap?.status === "stalled") {
				status = "stalled";
			} else if (snap?.status === "running") {
				// TP-170: TOCTOU guard — dead session ⇒ failed, not "session dead".
				status = lane.sessionAlive ? "running" : "failed";
			} else if (lane.completedTasks.length > 0 && lane.remainingTasks.length === 0 && !lane.currentTaskId) {
				status = "succeeded";
			}

			laneCards.push({
				laneNumber: lane.laneNumber,
				laneId: alloc?.laneId || lane.laneId,
				sessionName: alloc?.laneSessionId || lane.sessionName,
				sessionAlive: lane.sessionAlive,
				currentTaskId: lane.currentTaskId,
				currentStepName: snap?.currentStepName || null,
				totalChecked: snap?.totalChecked || 0,
				totalItems: snap?.totalItems || 0,
				completedTasks: lane.completedTasks.length,
				totalLaneTasks:
					lane.completedTasks.length +
					lane.failedTasks.length +
					lane.remainingTasks.length +
					(lane.currentTaskId ? 1 : 0),
				status,
				stallReason: snap?.stallReason || null,
			});
		}
	} else if (batchState.currentLanes.length > 0) {
		const sortedLanes = [...batchState.currentLanes].sort((a, b) => a.laneNumber - b.laneNumber);
		for (const lane of sortedLanes) {
			laneCards.push({
				laneNumber: lane.laneNumber,
				laneId: lane.laneId,
				sessionName: lane.laneSessionId,
				sessionAlive: true,
				currentTaskId: lane.tasks.length > 0 ? (lane.tasks[0]?.taskId ?? null) : null,
				currentStepName: null,
				totalChecked: 0,
				totalItems: 0,
				completedTasks: 0,
				totalLaneTasks: lane.tasks.length,
				status: "running",
				stallReason: null,
			});
		}
	}

	let attachHint = "";
	const aliveLane = laneCards.find(l => l.sessionAlive && l.status === "running");
	if (aliveLane) {
		attachHint = `Use /mission-sessions to inspect active lane sessions (${aliveLane.sessionName})`;
	} else if (laneCards.length > 0) {
		attachHint = "Use /mission-sessions for active lane session list";
	}

	let failurePolicy: string | null = null;
	if (batchState.phase === "stopped" && batchState.waveResults.length > 0) {
		const lastWave = batchState.waveResults[batchState.waveResults.length - 1];
		if (lastWave?.stoppedEarly && lastWave.policyApplied) {
			failurePolicy = lastWave.policyApplied;
		}
	}

	return {
		phase: batchState.phase,
		batchId: batchState.batchId,
		orchBranch: batchState.orchBranch || batchState.baseBranch || "",
		waveProgress,
		elapsed,
		summary,
		laneCards,
		attachHint,
		errors: batchState.errors,
		failurePolicy,
	};
}

// ── Lane Card Rendering ──────────────────────────────────────────────

/**
 * Render a single lane card for the dashboard.
 *
 * Follows the task-runner `renderStepCard` pattern:
 * bordered box with lane info, status icon, task progress.
 *
 * @param card     - Lane card data from view-model
 * @param colWidth - Available width for the card (including borders)
 * @param theme    - Pi-tui theme helpers used for color styling
 * @returns Array of styled string lines (one per card row)
 */
export function renderLaneCard(card: MissionLaneCardData, colWidth: number, theme: ThemeLike): string[] {
	const w = colWidth - 2;
	const trunc = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

	const statusIcon =
		card.status === "succeeded"
			? "✓"
			: card.status === "running"
				? "●"
				: card.status === "failed"
					? "✗"
					: card.status === "stalled"
						? "⚠"
						: "○";
	const statusColor =
		card.status === "succeeded"
			? "success"
			: card.status === "running"
				? "accent"
				: card.status === "failed"
					? "error"
					: card.status === "stalled"
						? "warning"
						: "dim";

	const sessionLabel = `⎡${card.sessionName}⎤`;
	const sessionStr = theme.fg("accent", theme.bold(trunc(sessionLabel, w)));
	const sessionVis = Math.min(sessionLabel.length, w);

	const taskInfo = card.currentTaskId
		? `${statusIcon} ${card.currentTaskId}`
		: card.status === "succeeded"
			? `${statusIcon} done`
			: card.status === "failed"
				? `${statusIcon} failed`
				: `${statusIcon} idle`;
	const taskStr = theme.fg(statusColor, trunc(taskInfo, w));
	const taskVis = Math.min(taskInfo.length, w);

	let stepInfo = "";
	if (card.currentStepName) {
		stepInfo = trunc(card.currentStepName, w - 2);
	} else if (card.currentTaskId && card.totalItems === 0) {
		stepInfo = card.sessionAlive ? "starting..." : "no status data";
	} else if (!card.currentTaskId && card.status !== "idle") {
		stepInfo = `${card.completedTasks}/${card.totalLaneTasks} tasks`;
	}
	const stepStr = theme.fg("muted", trunc(stepInfo, w));
	const stepVis = Math.min(stepInfo.length, w);

	let extraInfo = "";
	let extraColor = "dim";
	if (card.stallReason) {
		extraInfo = `⚠ ${trunc(card.stallReason, w - 4)}`;
		extraColor = "warning";
	} else if (card.totalItems > 0) {
		extraInfo = `${card.totalChecked}/${card.totalItems} ✓`;
		extraColor = card.totalChecked === card.totalItems ? "success" : "muted";
	} else if (!card.sessionAlive && card.status === "running") {
		extraInfo = "session ended";
		extraColor = "warning";
	}
	const extraStr = theme.fg(extraColor, trunc(extraInfo, w));
	const extraVis = Math.min(extraInfo.length, w);

	const top = `┌${"─".repeat(w)}┐`;
	const bot = `└${"─".repeat(w)}┘`;
	const border = (content: string, vis: number) =>
		theme.fg("dim", "│") + content + " ".repeat(Math.max(0, w - vis)) + theme.fg("dim", "│");

	return [
		theme.fg("dim", top),
		border(` ${sessionStr}`, 1 + sessionVis),
		border(` ${taskStr}`, 1 + taskVis),
		border(` ${stepStr}`, 1 + stepVis),
		border(extraInfo ? ` ${extraStr}` : "", extraVis ? 1 + extraVis : 0),
		theme.fg("dim", bot),
	];
}

// ── Core Widget ──────────────────────────────────────────────────────

/** Rendered widget returned to the pi-tui host. */
export interface MissionWidget {
	render(width: number): string[];
	invalidate(): void;
}

/**
 * Create the widget registration callback for the mission dashboard.
 *
 * This is the main entry point for the dashboard widget. It captures
 * batchState and monitorState references and returns a widget that
 * re-renders on each paint cycle using the latest state.
 *
 * @param getBatchState   - Getter for current batch state
 * @param getMonitorState - Getter for current monitor state (may be null)
 * @param _sessionPrefix  - Session prefix for lane identification (unused today, kept for parity)
 */
export function createMissionWidget(
	getBatchState: () => MissionBatchRuntimeState,
	getMonitorState: () => MonitorState | null,
	_sessionPrefix: string,
): (tui: unknown, theme: ThemeLike) => MissionWidget {
	return (_tui: unknown, theme: ThemeLike) => {
		return {
			render(width: number): string[] {
				const batchState = getBatchState();
				const monitorState = getMonitorState();
				const vm = buildDashboardViewModel(batchState, monitorState);

				if (vm.phase === "idle") {
					return [];
				}

				const lines: string[] = [""];

				const phaseIcon =
					vm.phase === "launching"
						? "◌"
						: vm.phase === "planning"
							? "◌"
							: vm.phase === "executing"
								? "●"
								: vm.phase === "merging"
									? "🔀"
									: vm.phase === "paused"
										? "⏸"
										: vm.phase === "stopped"
											? "⛔"
											: vm.phase === "completed"
												? "✓"
												: vm.phase === "failed"
													? "✗"
													: "○";
				const phaseColor =
					vm.phase === "executing"
						? "accent"
						: vm.phase === "merging"
							? "accent"
							: vm.phase === "completed"
								? "success"
								: vm.phase === "failed" || vm.phase === "stopped"
									? "error"
									: vm.phase === "paused"
										? "warning"
										: "dim";

				const header =
					theme.fg(phaseColor, ` ${phaseIcon} `) +
					theme.fg("accent", theme.bold(vm.batchId || "—")) +
					theme.fg("dim", "  ") +
					theme.fg("warning", `W${vm.waveProgress}`) +
					theme.fg("dim", " · ") +
					theme.fg("muted", vm.elapsed);
				lines.push(truncateToWidth(header, width));

				if (vm.phase === "planning") {
					lines.push(truncateToWidth(theme.fg("dim", "  ◌ Planning batch..."), width));
					return lines;
				}

				const { completed, failed, total } = vm.summary;
				const done = completed + failed;
				const pct = total > 0 ? Math.round((done / total) * 100) : 0;
				const barWidth = Math.min(30, width - 20);
				const filled = Math.round((pct / 100) * barWidth);
				const progressBar =
					theme.fg("dim", "  ") +
					theme.fg("warning", "[") +
					theme.fg("success", "█".repeat(filled)) +
					theme.fg("dim", "░".repeat(Math.max(0, barWidth - filled))) +
					theme.fg("warning", "]") +
					theme.fg("dim", " ") +
					theme.fg("accent", `${done}/${total}`) +
					theme.fg("dim", ` (${pct}%)`);
				lines.push(truncateToWidth(progressBar, width));

				const countParts: string[] = [];
				if (vm.summary.completed > 0) countParts.push(theme.fg("success", `${vm.summary.completed} ✓`));
				if (vm.summary.running > 0) countParts.push(theme.fg("accent", `${vm.summary.running} running`));
				if (vm.summary.queued > 0) countParts.push(theme.fg("dim", `${vm.summary.queued} queued`));
				if (vm.summary.failed > 0) countParts.push(theme.fg("error", `${vm.summary.failed} ✗`));
				if (vm.summary.blocked > 0) countParts.push(theme.fg("warning", `${vm.summary.blocked} blocked`));
				if (vm.summary.stalled > 0) countParts.push(theme.fg("warning", `${vm.summary.stalled} stalled`));
				if (countParts.length > 0) {
					lines.push(truncateToWidth(`  ${countParts.join(theme.fg("dim", " · "))}`, width));
				}
				lines.push("");

				if (
					vm.laneCards.length > 0 &&
					(vm.phase === "executing" || vm.phase === "merging" || vm.phase === "paused")
				) {
					const arrowWidth = 3;
					const minCardWidth = 18;
					const maxCols = Math.max(1, Math.floor((width + arrowWidth) / (minCardWidth + arrowWidth)));
					const cols = Math.min(vm.laneCards.length, maxCols);
					const colWidth = Math.max(minCardWidth, Math.floor((width - arrowWidth * (cols - 1)) / cols));

					for (let rowStart = 0; rowStart < vm.laneCards.length; rowStart += cols) {
						const rowCards = vm.laneCards.slice(rowStart, rowStart + cols);
						const rendered = rowCards.map(c => renderLaneCard(c, colWidth, theme));

						if (rendered.length > 0) {
							const firstCard = rendered[0];
							if (!firstCard) continue;
							const cardHeight = firstCard.length;
							for (let line = 0; line < cardHeight; line++) {
								let row = firstCard[line] ?? "";
								for (let c = 1; c < rendered.length; c++) {
									row += "   ";
									row += rendered[c]?.[line] ?? "";
								}
								lines.push(truncateToWidth(row, width));
							}
						}
					}
				}

				if (vm.phase === "completed") {
					lines.push(truncateToWidth(theme.fg("success", "  ✅ Batch complete"), width));
				} else if (vm.phase === "failed") {
					lines.push(truncateToWidth(theme.fg("error", "  ❌ Batch failed"), width));
					for (const err of vm.errors.slice(0, 3)) {
						lines.push(truncateToWidth(theme.fg("error", `     ${err.slice(0, 80)}`), width));
					}
				} else if (vm.phase === "stopped") {
					lines.push(truncateToWidth(theme.fg("error", `  ⛔ Stopped by ${vm.failurePolicy || "policy"}`), width));
				} else if (vm.phase === "merging") {
					lines.push("");
					lines.push(
						truncateToWidth(
							theme.fg("accent", `  🔀 Merging lane branches into ${vm.orchBranch || "orch branch"}...`),
							width,
						),
					);
				} else if (vm.phase === "paused") {
					lines.push("");
					lines.push(
						truncateToWidth(theme.fg("warning", "  ⏸ Batch paused — lanes will stop after current tasks"), width),
					);
				}

				if (vm.attachHint && (vm.phase === "executing" || vm.phase === "merging" || vm.phase === "paused")) {
					lines.push("");
					lines.push(truncateToWidth(theme.fg("dim", `  💡 ${vm.attachHint}`), width));
				}

				return lines;
			},
			invalidate() {},
		};
	};
}

// ── Model validation rendering ───────────────────────────────────────

/**
 * Result row produced by `validateModelAvailability` — one per configured
 * role (Worker / Reviewer / Merger / Supervisor).
 *
 * - `inherit` — role left blank, inherits the session model.
 * - `found`   — explicit override resolved cleanly against the registry.
 * - `not-found` — override string does not map to any registered model.
 */
export interface ModelCheckResult {
	role: string;
	modelStr: string;
	status: "inherit" | "found" | "not-found";
	resolvedName?: string;
}

/**
 * Format `ModelCheckResult[]` for display by the `/mission-settings`
 * command and the bootup preflight.
 *
 * Ports `formatModelValidation` from
 * `taskplane/extensions/taskplane/extension.ts:901-923`:
 *   - product/config strings renamed (`.pi/taskplane-config.json` →
 *     `.omp/mission.json`, `/taskplane-settings` → `/mission-settings`)
 *   - behaviour otherwise byte-for-byte (role column padded to 12,
 *     `✅` / `❌` glyphs, fix hint appended only when any row failed).
 */
export function formatModelValidation(results: ModelCheckResult[]): string {
	const lines: string[] = ["Model Configuration:"];
	let hasFailure = false;

	for (const r of results) {
		if (r.status === "inherit") {
			lines.push(`  ✅ ${r.role.padEnd(12)} inherit → ${r.resolvedName}`);
		} else if (r.status === "found") {
			lines.push(`  ✅ ${r.role.padEnd(12)} ${r.modelStr} → ${r.resolvedName}`);
		} else {
			lines.push(`  ❌ ${r.role.padEnd(12)} ${r.modelStr} — NOT FOUND in model registry`);
			hasFailure = true;
		}
	}

	if (hasFailure) {
		lines.push("");
		lines.push("  Fix: update the model in .omp/mission.json or /mission-settings,");
		lines.push("  or remove the override to inherit the session model.");
	}

	return lines.join("\n");
}
