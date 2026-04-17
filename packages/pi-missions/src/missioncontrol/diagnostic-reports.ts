/**
 * Diagnostic report generation for mission batch completion/failure.
 *
 * Emits two artifacts at batch-terminal time:
 * 1. JSONL event log: `.omp/diagnostics/{opId}-{batchId}-events.jsonl`
 * 2. Human-readable summary: `.omp/diagnostics/{opId}-{batchId}-report.md`
 *
 * Write failures are non-fatal — errors are logged but never crash
 * the batch finalization flow.
 *
 * Ported from taskplane `extensions/taskplane/diagnostic-reports.ts` with
 * `.pi/` → `.omp/` path rebase and `OrchestratorConfig` → `MissionControlConfig`.
 * @module missioncontrol/diagnostic-reports
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { execLog } from "./log";
import { resolveOperatorId } from "./naming";
import type {
	AllocatedLane,
	AllocatedTask,
	BatchDiagnostics,
	LaneTaskOutcome,
	MissionBatchRuntimeState,
	MissionControlConfig,
	PersistedTaskExitSummary,
	PersistedTaskRecord,
} from "./types";
import { defaultBatchDiagnostics } from "./types";

// ── Types ────────────────────────────────────────────────────────────

/**
 * A single JSONL event representing one task's diagnostic record.
 * Deterministically ordered by taskId for reproducible output.
 */
export interface DiagnosticEvent {
	batchId: string;
	phase: string;
	mode: string;
	taskId: string;
	status: string;
	classification: string;
	cost: number;
	durationSec: number;
	retries: number;
	repoId: string | null;
	exitReason: string;
	startedAt: number | null;
	endedAt: number | null;
}

/**
 * Input data for diagnostic report generation.
 *
 * Assembled by the caller (engine / resume) from available runtime state
 * at the batch-terminal checkpoint.
 */
export interface DiagnosticReportInput {
	missionConfig: MissionControlConfig;
	/** Operator identifier override (from config / env). */
	operatorId?: string;
	batchId: string;
	phase: string;
	mode: string;
	startedAt: number;
	endedAt: number | null;
	tasks: PersistedTaskRecord[];
	diagnostics: BatchDiagnostics;
	succeededTasks: number;
	failedTasks: number;
	skippedTasks: number;
	blockedTasks: number;
	totalTasks: number;
	/** Root directory where `.omp/` lives. */
	stateRoot: string;
}

// ── Diagnostics Directory ────────────────────────────────────────────

/** Resolve the diagnostics directory path. */
export function diagnosticsDir(stateRoot: string): string {
	return join(stateRoot, ".omp", "diagnostics");
}

/** Ensure `.omp/diagnostics/` exists, creating it if needed. */
function ensureDiagnosticsDir(stateRoot: string): string {
	const dir = diagnosticsDir(stateRoot);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

// ── Event Generation ─────────────────────────────────────────────────

/**
 * Build diagnostic events from task records and diagnostics data.
 *
 * Data source precedence for each task:
 * 1. `diagnostics.taskExits[taskId]` — canonical v3 exit summary
 * 2. `task.exitDiagnostic.classification` — per-task exit diagnostic
 * 3. Fallback: classification="unknown", cost=0, durationSec from timestamps
 *
 * Tasks are sorted by taskId for deterministic output.
 */
export function buildDiagnosticEvents(input: DiagnosticReportInput): DiagnosticEvent[] {
	const { batchId, phase, mode, tasks, diagnostics } = input;
	const taskExits = diagnostics.taskExits ?? {};

	const sortedTasks = [...tasks].sort((a, b) => a.taskId.localeCompare(b.taskId));

	return sortedTasks.map((task): DiagnosticEvent => {
		const exitSummary: PersistedTaskExitSummary | undefined = taskExits[task.taskId];

		let classification = "unknown";
		if (exitSummary) {
			classification = exitSummary.classification;
		} else if (task.exitDiagnostic?.classification) {
			classification = task.exitDiagnostic.classification;
		}

		const cost = exitSummary?.cost ?? 0;

		let durationSec = 0;
		if (exitSummary) {
			durationSec = exitSummary.durationSec;
		} else if (task.startedAt !== null && task.endedAt !== null) {
			durationSec = Math.round((task.endedAt - task.startedAt) / 1000);
		}

		const retries = exitSummary?.retries ?? 0;
		const repoId = task.resolvedRepoId ?? task.repoId ?? null;

		return {
			batchId,
			phase,
			mode,
			taskId: task.taskId,
			status: task.status,
			classification,
			cost,
			durationSec,
			retries,
			repoId,
			exitReason: task.exitReason,
			startedAt: task.startedAt,
			endedAt: task.endedAt,
		};
	});
}

// ── JSONL Generation ─────────────────────────────────────────────────

/** Serialize diagnostic events to JSONL format (one JSON object per line). */
export function eventsToJsonl(events: DiagnosticEvent[]): string {
	if (events.length === 0) return "";
	return `${events.map(e => JSON.stringify(e)).join("\n")}\n`;
}

// ── Human-Readable Summary ───────────────────────────────────────────

function formatDuration(seconds: number): string {
	if (seconds <= 0) return "0s";
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	const parts: string[] = [];
	if (h > 0) parts.push(`${h}h`);
	if (m > 0) parts.push(`${m}m`);
	if (s > 0 || parts.length === 0) parts.push(`${s}s`);
	return parts.join(" ");
}

function formatCost(cost: number): string {
	if (cost === 0) return "$0.00";
	return `$${cost.toFixed(4)}`;
}

/** Generate a human-readable markdown summary report. */
export function buildMarkdownReport(input: DiagnosticReportInput, events: DiagnosticEvent[]): string {
	const { batchId, phase, mode, startedAt, endedAt, diagnostics } = input;
	const { succeededTasks, failedTasks, skippedTasks, blockedTasks, totalTasks } = input;

	const batchDurationSec = endedAt ? Math.round((endedAt - startedAt) / 1000) : 0;
	const batchCost = diagnostics.batchCost ?? 0;

	const lines: string[] = [];

	lines.push(`# Mission Batch Diagnostic Report`);
	lines.push(``);

	lines.push(`## Batch Overview`);
	lines.push(``);
	lines.push(`| Field | Value |`);
	lines.push(`|-------|-------|`);
	lines.push(`| Batch ID | \`${batchId}\` |`);
	lines.push(`| Final Phase | ${phase} |`);
	lines.push(`| Mode | ${mode} |`);
	lines.push(`| Duration | ${formatDuration(batchDurationSec)} |`);
	lines.push(`| Total Cost | ${formatCost(batchCost)} |`);
	lines.push(`| Total Tasks | ${totalTasks} |`);
	lines.push(`| Succeeded | ${succeededTasks} |`);
	lines.push(`| Failed | ${failedTasks} |`);
	lines.push(`| Skipped | ${skippedTasks} |`);
	lines.push(`| Blocked | ${blockedTasks} |`);
	lines.push(``);

	lines.push(`## Per-Task Results`);
	lines.push(``);

	if (events.length === 0) {
		lines.push(`_No task records available._`);
		lines.push(``);
	} else {
		lines.push(`| Task | Status | Classification | Cost | Duration | Retries |`);
		lines.push(`|------|--------|---------------|------|----------|---------|`);
		for (const evt of events) {
			lines.push(
				`| ${evt.taskId} | ${evt.status} | ${evt.classification} | ${formatCost(evt.cost)} | ${formatDuration(evt.durationSec)} | ${evt.retries} |`,
			);
		}
		lines.push(``);
	}

	if (mode === "workspace") {
		lines.push(`## Per-Repo Breakdown`);
		lines.push(``);

		const byRepo = new Map<string, DiagnosticEvent[]>();
		for (const evt of events) {
			const key = evt.repoId ?? "(unresolved)";
			const bucket = byRepo.get(key);
			if (bucket) {
				bucket.push(evt);
			} else {
				byRepo.set(key, [evt]);
			}
		}

		const repoKeys = [...byRepo.keys()].sort();

		if (repoKeys.length === 0) {
			lines.push(`_No per-repo data available._`);
			lines.push(``);
		} else {
			for (const repoKey of repoKeys) {
				const repoEvents = byRepo.get(repoKey);
				if (!repoEvents) continue;
				const repoSucceeded = repoEvents.filter(e => e.status === "succeeded").length;
				const repoFailed = repoEvents.filter(e => e.status === "failed").length;
				const repoCost = repoEvents.reduce((sum, e) => sum + e.cost, 0);

				lines.push(`### ${repoKey}`);
				lines.push(``);
				lines.push(`- Tasks: ${repoEvents.length} (${repoSucceeded} succeeded, ${repoFailed} failed)`);
				lines.push(`- Cost: ${formatCost(repoCost)}`);
				lines.push(``);

				lines.push(`| Task | Status | Classification | Cost | Duration |`);
				lines.push(`|------|--------|---------------|------|----------|`);
				for (const evt of repoEvents) {
					lines.push(
						`| ${evt.taskId} | ${evt.status} | ${evt.classification} | ${formatCost(evt.cost)} | ${formatDuration(evt.durationSec)} |`,
					);
				}
				lines.push(``);
			}
		}
	}

	lines.push(`---`);
	lines.push(`_Generated at ${new Date().toISOString()}_`);
	lines.push(``);

	return lines.join("\n");
}

// ── Report Emission ──────────────────────────────────────────────────

/**
 * Emit diagnostic reports (JSONL event log + markdown summary) at batch terminal.
 *
 * Called exactly once per batch run, immediately after the batch-terminal
 * persistence checkpoint in engine / resume.
 *
 * **Non-fatal:** All errors during report generation or writing are caught
 * and logged via `execLog()`. They never propagate to the caller or crash
 * the batch finalization flow.
 */
export function emitDiagnosticReports(input: DiagnosticReportInput): void {
	try {
		const opId = resolveOperatorId(input.operatorId);
		const dir = ensureDiagnosticsDir(input.stateRoot);

		const events = buildDiagnosticEvents(input);

		const jsonlPath = join(dir, `${opId}-${input.batchId}-events.jsonl`);
		const jsonlContent = eventsToJsonl(events);
		writeFileSync(jsonlPath, jsonlContent, "utf-8");

		const reportPath = join(dir, `${opId}-${input.batchId}-report.md`);
		const reportContent = buildMarkdownReport(input, events);
		writeFileSync(reportPath, reportContent, "utf-8");

		execLog("diagnostics", input.batchId, `emitted diagnostic reports`, {
			jsonl: jsonlPath,
			report: reportPath,
			taskCount: events.length,
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		execLog("diagnostics", input.batchId, `failed to emit diagnostic reports: ${msg}`);
	}
}

/**
 * Assemble diagnostic report input from batch runtime state.
 *
 * Convenience helper for engine / resume to call at the batch-terminal
 * checkpoint. Builds the full task registry from the wave plan + allocated
 * lanes + task outcomes — matching the canonical model used by the
 * persistence serializer. This ensures diagnostics cover all tasks
 * (including pending/blocked tasks that were never allocated) and preserve
 * repo attribution fields for workspace per-repo breakdown.
 */
export function assembleDiagnosticInput(
	missionConfig: MissionControlConfig,
	batchState: MissionBatchRuntimeState,
	wavePlan: string[][],
	lanes: AllocatedLane[],
	allTaskOutcomes: LaneTaskOutcome[],
	stateRoot: string,
	operatorId?: string,
): DiagnosticReportInput {
	const laneByTaskId = new Map<string, AllocatedLane>();
	const allocatedTaskByTaskId = new Map<string, { allocatedTask: AllocatedTask; lane: AllocatedLane }>();
	for (const lane of lanes) {
		for (const allocTask of lane.tasks) {
			laneByTaskId.set(allocTask.taskId, lane);
			allocatedTaskByTaskId.set(allocTask.taskId, { allocatedTask: allocTask, lane });
		}
	}

	// Latest outcome wins (allTaskOutcomes is append/replace ordered by time).
	const outcomeByTaskId = new Map<string, LaneTaskOutcome>();
	for (const outcome of allTaskOutcomes) {
		outcomeByTaskId.set(outcome.taskId, outcome);
	}

	// Build full task ID set from wave plan + outcomes (covers pending/blocked).
	const taskIdSet = new Set<string>();
	for (const wave of wavePlan) {
		for (const taskId of wave) taskIdSet.add(taskId);
	}
	for (const outcome of allTaskOutcomes) {
		taskIdSet.add(outcome.taskId);
	}

	const tasks: PersistedTaskRecord[] = [...taskIdSet].sort().map((taskId): PersistedTaskRecord => {
		const lane = laneByTaskId.get(taskId);
		const outcome = outcomeByTaskId.get(taskId);
		const allocated = allocatedTaskByTaskId.get(taskId);

		const record: PersistedTaskRecord = {
			taskId,
			laneNumber: lane?.laneNumber ?? 0,
			sessionName: outcome?.sessionName || lane?.laneSessionId || "",
			status: outcome?.status ?? "pending",
			taskFolder: "",
			startedAt: outcome?.startTime ?? null,
			endedAt: outcome?.endTime ?? null,
			doneFileFound: outcome?.doneFileFound ?? false,
			exitReason: outcome?.exitReason ?? "",
		};

		// Repo attribution from allocated task metadata (workspace mode).
		const allocTask = allocated?.allocatedTask.task as { promptRepoId?: string; resolvedRepoId?: string } | undefined;
		if (allocTask?.promptRepoId !== undefined) {
			record.repoId = allocTask.promptRepoId;
		}
		if (allocTask?.resolvedRepoId !== undefined) {
			record.resolvedRepoId = allocTask.resolvedRepoId;
		}

		if (outcome?.partialProgressCommits !== undefined) {
			record.partialProgressCommits = outcome.partialProgressCommits;
		}
		if (outcome?.partialProgressBranch !== undefined) {
			record.partialProgressBranch = outcome.partialProgressBranch;
		}

		// v3: Exit diagnostic from outcome.
		if (outcome?.exitDiagnostic !== undefined) {
			record.exitDiagnostic = outcome.exitDiagnostic;
		}

		return record;
	});

	return {
		missionConfig,
		operatorId,
		batchId: batchState.batchId,
		phase: batchState.phase,
		mode: batchState.mode ?? "repo",
		startedAt: batchState.startedAt,
		endedAt: batchState.endedAt,
		tasks,
		diagnostics: batchState.diagnostics ?? defaultBatchDiagnostics(),
		succeededTasks: batchState.succeededTasks,
		failedTasks: batchState.failedTasks,
		skippedTasks: batchState.skippedTasks,
		blockedTasks: batchState.blockedTasks,
		totalTasks: batchState.totalTasks,
		stateRoot,
	};
}
