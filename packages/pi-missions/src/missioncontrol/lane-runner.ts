/**
 * MVP lane runner — drains waves by spawning agents, awaiting exits, and
 * recording outcomes via engine reducers.
 *
 * This is a minimal viable implementation: one agent per lane, sequential
 * dispatch within a lane, no merge, no quality gates, no retries. Full
 * lane-runner (with worktrees, mailbox polling, supervisor coordination)
 * lands when the heavy taskplane modules are ported.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { MissionState, TaskOutcome } from "../types";
import { type SpawnAgentHandle, spawnAgent } from "./adapter";
import type { AgentHostOptions, AgentHostResult } from "./agent-host";
import { spawnHostedAgent } from "./agent-host";
import { advanceWave, recordTaskOutcome, setLaneStatus } from "./engine";
import {
	ackMessage,
	ackOutboxMessage,
	appendMailboxAuditEvent,
	readInbox,
	readOutbox,
	sessionInboxDir,
	sessionOutboxDir,
} from "./mailbox";
import { appendAgentEvent, writeLaneSnapshot } from "./process-registry";
import {
	generateStatusMd,
	isStepComplete,
	logExecution,
	parsePromptMd,
	parseStatusMd,
	updateStatusField,
	updateStepStatus,
} from "./task-executor-core";
import {
	buildRuntimeAgentId,
	type ExecutionUnit,
	type LaneTaskOutcome,
	type LaneTaskStatus,
	type MissionControlConfig,
	type RuntimeAgentStatus,
	type RuntimeAgentTelemetrySnapshot,
	type RuntimeLaneSnapshot,
	type RuntimeTaskProgress,
	runtimeAgentEventsPath,
	type StepSegmentMapping,
	type SupervisorAlertCallback,
} from "./types";

// ── Segment-scoped STATUS.md helpers (ported from taskplane/lane-runner.ts) ──

export interface SegmentCheckboxCounts {
	checked: number;
	unchecked: number;
	total: number;
	uncheckedTexts: string[];
}

/**
 * Set of step numbers that contain at least one segment for the given repoId.
 * Used to filter a worker's remaining-steps view.
 */
export function getStepsForRepoId(stepSegmentMap: StepSegmentMapping[], repoId: string): Set<number> {
	const stepNumbers = new Set<number>();
	for (const step of stepSegmentMap) {
		if (step.segments.some(seg => seg.repoId === repoId)) {
			stepNumbers.add(step.stepNumber);
		}
	}
	return stepNumbers;
}

/**
 * Extract checkbox counts for a `#### Segment: <repoId>` block under `### Step N:`.
 * Returns null when the step or segment header is not found.
 */
export function getSegmentCheckboxes(
	statusContent: string,
	stepNumber: number,
	repoId: string,
): SegmentCheckboxCounts | null {
	const text = statusContent.replace(/\r\n/g, "\n");

	const stepHeaderPattern = new RegExp(`^###\\s+Step\\s+${stepNumber}:`, "m");
	const stepMatch = text.match(stepHeaderPattern);
	if (!stepMatch || stepMatch.index === undefined) return null;

	const afterStep = text.slice(stepMatch.index + stepMatch[0].length);
	const nextStepMatch = afterStep.search(/^###\s+Step\s+\d+:/m);
	const stepContent = nextStepMatch !== -1 ? afterStep.slice(0, nextStepMatch) : afterStep;

	const escapedRepo = repoId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const segHeaderPattern = new RegExp(`^####\\s+Segment:\\s*${escapedRepo}\\s*$`, "m");
	const segMatch = stepContent.match(segHeaderPattern);
	if (!segMatch || segMatch.index === undefined) return null;

	const afterSeg = stepContent.slice(segMatch.index + segMatch[0].length);
	const nextSectionMatch = afterSeg.search(/^(?:####\s|###\s|---)/m);
	const segContent = nextSectionMatch !== -1 ? afterSeg.slice(0, nextSectionMatch) : afterSeg;

	let checked = 0;
	let unchecked = 0;
	const uncheckedTexts: string[] = [];
	const cbRegex = /^\s*-\s*\[([ xX])\]\s*(.*)/gm;
	let m: RegExpExecArray | null = cbRegex.exec(segContent);
	while (m !== null) {
		if ((m[1] ?? "").toLowerCase() === "x") {
			checked++;
		} else {
			unchecked++;
			uncheckedTexts.push((m[2] ?? "").trim());
		}
		m = cbRegex.exec(segContent);
	}

	return { checked, unchecked, total: checked + unchecked, uncheckedTexts };
}

/** All checkboxes in the segment block are checked (and at least one exists). */
export function isSegmentComplete(statusContent: string, stepNumber: number, repoId: string): boolean {
	const result = getSegmentCheckboxes(statusContent, stepNumber, repoId);
	if (!result) return false;
	if (result.total === 0) return false;
	return result.unchecked === 0;
}

// ── Pending-expansion scan (outbox filesystem check) ────────────────────────

/**
 * Return `true` when at least one pending segment-expansion request exists
 * for the given agent in the current batch's mailbox.
 *
 * Pending files match `segment-expansion-*.json` inside
 * `.omp/mailbox/{batchId}/{agentId}/outbox/`. The engine scans for these at
 * segment boundaries — finding one means the task may gain more segments.
 *
 * Best-effort: filesystem errors return `false` so the caller never blocks.
 */
export function hasPendingExpansionRequestFiles(stateRoot: string, batchId: string, agentId: string): boolean {
	const outboxDir = sessionOutboxDir(stateRoot, batchId, agentId);
	if (!existsSync(outboxDir)) return false;
	try {
		const entries = readdirSync(outboxDir);
		return entries.some(entry => /^segment-expansion-.+\.json$/.test(entry));
	} catch {
		return false;
	}
}

// ── Reviewer telemetry snapshot reader ──────────────────────────────────────

/** Minimal context required to derive a reviewer agent ID from a lane. */
export interface ReviewerTelemetryContext {
	agentIdPrefix: string;
	laneNumber: number;
}

/** Max age for a reviewer state file before it's treated as stale. */
export const REVIEWER_STATE_STALE_MS = 120_000;

/**
 * Read a running-reviewer telemetry snapshot from `.reviewer-state.json`.
 *
 * Accepts either the reviewer state path directly, or a `status.md` path —
 * in the latter case the reader looks in the sibling `.reviewer-state.json`.
 * Returns `null` when the file is missing, the status is not `"running"`,
 * the file is older than `REVIEWER_STATE_STALE_MS`, or parsing fails.
 *
 * Fields unknown or non-finite fall back to safe zero values so consumers
 * never have to re-validate.
 */
export function readReviewerTelemetrySnapshot(
	context: ReviewerTelemetryContext,
	reviewerStatePathOrStatusPath: string,
): (RuntimeAgentTelemetrySnapshot & { reviewType?: string; reviewStep?: number }) | null {
	const reviewerPath =
		basename(reviewerStatePathOrStatusPath).toLowerCase() === "status.md"
			? join(dirname(reviewerStatePathOrStatusPath), ".reviewer-state.json")
			: reviewerStatePathOrStatusPath;
	if (!existsSync(reviewerPath)) return null;

	try {
		const raw = readFileSync(reviewerPath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<{
			status: string;
			elapsedMs: number;
			toolCalls: number;
			contextPct: number;
			costUsd: number;
			lastTool: string;
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
			updatedAt: number;
			reviewType: string;
			reviewStep: number;
		}>;

		if (parsed.status !== "running") return null;

		if (parsed.updatedAt && Date.now() - parsed.updatedAt > REVIEWER_STATE_STALE_MS) return null;

		return {
			agentId: buildRuntimeAgentId(context.agentIdPrefix, context.laneNumber, "reviewer"),
			status: "running",
			elapsedMs: Number.isFinite(parsed.elapsedMs) ? Number(parsed.elapsedMs) : 0,
			toolCalls: Number.isFinite(parsed.toolCalls) ? Number(parsed.toolCalls) : 0,
			contextPct: Number.isFinite(parsed.contextPct) ? Number(parsed.contextPct) : 0,
			costUsd: Number.isFinite(parsed.costUsd) ? Number(parsed.costUsd) : 0,
			lastTool: typeof parsed.lastTool === "string" ? parsed.lastTool : "",
			inputTokens: Number.isFinite(parsed.inputTokens) ? Number(parsed.inputTokens) : 0,
			outputTokens: Number.isFinite(parsed.outputTokens) ? Number(parsed.outputTokens) : 0,
			cacheReadTokens: Number.isFinite(parsed.cacheReadTokens) ? Number(parsed.cacheReadTokens) : 0,
			cacheWriteTokens: Number.isFinite(parsed.cacheWriteTokens) ? Number(parsed.cacheWriteTokens) : 0,
			reviewType: typeof parsed.reviewType === "string" ? parsed.reviewType : undefined,
			reviewStep: Number.isFinite(parsed.reviewStep) ? Number(parsed.reviewStep) : undefined,
		};
	} catch {
		return null;
	}
}

export function mapLaneTaskStatusToTerminalSnapshotStatus(status: LaneTaskStatus): "idle" | "complete" | "failed" {
	if (status === "succeeded") return "complete";
	if (status === "skipped") return "idle";
	return "failed";
}

export function mapLaneSnapshotStatusToWorkerStatus(
	status: "running" | "idle" | "complete" | "failed",
): RuntimeAgentStatus {
	if (status === "running") return "running";
	if (status === "complete") return "exited";
	if (status === "idle") return "wrapping_up";
	return "crashed";
}

// ── Runtime V2 lane-runner configuration ───────────────────────────────────

/**
 * Configuration for a single Runtime V2 lane execution.
 *
 * All fields are required except `supervisorAutonomy`, `projectName`, and
 * `onSupervisorAlert`. Empty strings on model/tools/thinking fields mean
 * "inherit from the session default".
 */
export interface LaneRunnerConfig {
	/** Batch ID. */
	batchId: string;
	/** Operator prefix for agent IDs (e.g., `"mission-henry"`). */
	agentIdPrefix: string;
	/** Lane number (1-indexed). */
	laneNumber: number;
	/** Absolute path to the lane worktree. */
	worktreePath: string;
	/** Git branch checked out in the worktree. */
	branch: string;
	/** Repo ID this lane targets. */
	repoId: string;
	/** State root for runtime artifacts (workspace root or repo root). */
	stateRoot: string;
	/** Worker model (empty string = inherit from session). */
	workerModel: string;
	/** Worker tool allow-list (comma-separated). */
	workerTools: string;
	/** Worker thinking mode (empty string = inherit). */
	workerThinking: string;
	/** Worker system prompt for full-task mode. */
	workerSystemPrompt: string;
	/** Worker system prompt overlay for segment-scoped mode. */
	workerSegmentPrompt: string;
	/** Reviewer model (empty string = inherit). */
	reviewerModel: string;
	/** Reviewer thinking mode (empty string = inherit). */
	reviewerThinking: string;
	/** Reviewer tool allow-list (empty string = default). */
	reviewerTools: string;
	/** Supervisor autonomy level for bridge-tool guards. */
	supervisorAutonomy?: "interactive" | "supervised" | "autonomous";
	/** Project name (for review request context). */
	projectName?: string;
	/** Max worker iterations before giving up. */
	maxIterations: number;
	/** No-progress stall limit. */
	noProgressLimit: number;
	/** Max worker wall-clock time per iteration (minutes). */
	maxWorkerMinutes: number;
	/** Context pressure warn threshold (0-100). */
	warnPercent: number;
	/** Context pressure kill threshold (0-100). */
	killPercent: number;
	/** Optional supervisor-alert callback for mailbox replies / escalations. */
	onSupervisorAlert?: SupervisorAlertCallback;
}

/** Result from executing one task through the Runtime V2 lane-runner. */
export interface LaneRunnerTaskResult {
	/** Standard lane task outcome compatible with the engine. */
	outcome: LaneTaskOutcome;
	/** Total worker iterations consumed. */
	iterations: number;
	/** Cumulative worker cost in USD. */
	costUsd: number;
	/** Total tokens used (input + output + cache read + cache write). */
	totalTokens: number;
}

// ── Private helpers: makeResult + emitSnapshot ─────────────────────────────

function makeResult(
	taskId: string,
	segmentId: string | null,
	sessionName: string,
	status: LaneTaskStatus,
	startTime: number,
	exitReason: string,
	doneFileFound: boolean,
	iterations: number,
	costUsd: number,
	totalTokens: number,
	config?: LaneRunnerConfig,
	statusPath?: string,
	reviewerStatePath?: string,
	finalTelemetry?: Partial<AgentHostResult>,
	segmentCtx?: { stepSegmentMap: StepSegmentMapping[]; repoId: string } | null,
): LaneRunnerTaskResult {
	const telemetry =
		status === "skipped"
			? undefined
			: {
					inputTokens: finalTelemetry?.inputTokens ?? 0,
					outputTokens: finalTelemetry?.outputTokens ?? 0,
					cacheReadTokens: finalTelemetry?.cacheReadTokens ?? 0,
					cacheWriteTokens: finalTelemetry?.cacheWriteTokens ?? 0,
					costUsd: finalTelemetry?.costUsd ?? 0,
					toolCalls: finalTelemetry?.toolCalls ?? 0,
					durationMs: finalTelemetry?.durationMs ?? 0,
				};

	const result: LaneRunnerTaskResult = {
		outcome: {
			taskId,
			status,
			segmentId,
			startTime,
			endTime: Date.now(),
			exitReason,
			sessionName,
			doneFileFound,
			laneNumber: config?.laneNumber,
			telemetry,
		},
		iterations,
		costUsd,
		totalTokens,
	};

	if (config && statusPath && reviewerStatePath) {
		const terminalStatus = mapLaneTaskStatusToTerminalSnapshotStatus(status);
		emitSnapshot(
			config,
			taskId,
			segmentId,
			terminalStatus,
			finalTelemetry ?? {},
			statusPath,
			reviewerStatePath,
			segmentCtx,
		);
	}

	return result;
}

/**
 * Write a lane snapshot to disk. NON-THROWING by contract — all errors are
 * caught and swallowed. This function is called from `setInterval` and
 * `onTelemetry` callbacks where an unhandled throw would trigger
 * `uncaughtException` and crash the engine-worker process.
 *
 * @returns true when the snapshot write succeeds, false otherwise.
 */
function emitSnapshot(
	config: LaneRunnerConfig,
	taskId: string,
	segmentId: string | null,
	status: "running" | "idle" | "complete" | "failed",
	telemetry: Partial<AgentHostResult>,
	statusPath: string,
	reviewerStatePath: string,
	segmentContext?: { stepSegmentMap: StepSegmentMapping[]; repoId: string } | null,
): boolean {
	try {
		let progress: RuntimeTaskProgress | null = null;
		try {
			const content = readFileSync(statusPath, "utf-8");
			const parsed = parseStatusMd(content);
			const currentStepMatch = content.match(/\*\*Current Step:\*\*\s*(.+)/);

			let checked: number;
			let total: number;
			if (segmentContext) {
				const { stepSegmentMap, repoId } = segmentContext;
				const repoSteps = getStepsForRepoId(stepSegmentMap, repoId);
				let segChecked = 0;
				let segTotal = 0;
				for (const stepNum of repoSteps) {
					const segCbs = getSegmentCheckboxes(content, stepNum, repoId);
					if (segCbs) {
						segChecked += segCbs.checked;
						segTotal += segCbs.total;
					}
				}
				checked = segChecked;
				total = segTotal;
			} else {
				checked = parsed.steps.reduce((sum, s) => sum + s.totalChecked, 0);
				total = parsed.steps.reduce((sum, s) => sum + s.totalItems, 0);
			}

			progress = {
				currentStep: currentStepMatch?.[1]?.trim() || "Unknown",
				checked,
				total,
				iteration: parsed.iteration,
				reviews: parsed.reviewCounter,
			};
		} catch {
			/* best effort */
		}

		const reviewerSnapshot = readReviewerTelemetrySnapshot(config, reviewerStatePath);

		const snapshot: RuntimeLaneSnapshot = {
			batchId: config.batchId,
			laneNumber: config.laneNumber,
			laneId: `lane-${config.laneNumber}`,
			repoId: config.repoId,
			taskId,
			segmentId,
			status,
			worker: {
				agentId: buildRuntimeAgentId(config.agentIdPrefix, config.laneNumber, "worker"),
				status: mapLaneSnapshotStatusToWorkerStatus(status),
				elapsedMs: telemetry.durationMs ?? 0,
				toolCalls: telemetry.toolCalls ?? 0,
				contextPct: telemetry.contextUsage?.percent ?? 0,
				costUsd: telemetry.costUsd ?? 0,
				lastTool: telemetry.lastTool ?? "",
				inputTokens: telemetry.inputTokens ?? 0,
				outputTokens: telemetry.outputTokens ?? 0,
				cacheReadTokens: telemetry.cacheReadTokens ?? 0,
				cacheWriteTokens: telemetry.cacheWriteTokens ?? 0,
			},
			reviewer: reviewerSnapshot,
			progress,
			updatedAt: Date.now(),
		};

		writeLaneSnapshot(
			config.stateRoot,
			config.batchId,
			config.laneNumber,
			snapshot as unknown as Record<string, unknown>,
		);
		return true;
	} catch {
		return false;
	}
}

// ── Runtime V2 main entry: executeTaskV2 ───────────────────────────────────

/**
 * Execute a single task in a lane using the Runtime V2 headless backend.
 *
 * Replaces the legacy TMUX-backed `executeLane()` path with direct
 * child-process hosting through {@link spawnHostedAgent}.
 *
 * Execution loop:
 *   1. Ensure STATUS.md exists
 *   2. For each iteration:
 *      a. Determine remaining steps
 *      b. Spawn worker agent via agent-host
 *      c. Wait for worker to exit
 *      d. Check progress (checkboxes)
 *      e. If all steps complete → break
 *      f. If no progress → increment stall counter
 *      g. If stall limit or iteration limit hit → fail
 *   3. If all steps complete, write .DONE (unless non-final segment)
 *   4. Return LaneRunnerTaskResult
 */
export async function executeTaskV2(
	unit: ExecutionUnit,
	config: LaneRunnerConfig,
	pauseSignal: { paused: boolean },
): Promise<LaneRunnerTaskResult> {
	const startTime = Date.now();
	const statusPath = unit.packet.statusPath;
	const donePath = unit.packet.donePath;
	const promptPath = unit.packet.promptPath;
	const taskFolder = unit.packet.taskFolder;
	const reviewerStatePath = join(taskFolder, ".reviewer-state.json");
	const taskId = unit.taskId;
	const segmentId = unit.segmentId;
	const workerAgentId = buildRuntimeAgentId(config.agentIdPrefix, config.laneNumber, "worker");

	// ── 1. Ensure STATUS.md exists ──────────────────────────────────
	if (!existsSync(statusPath)) {
		const content = readFileSync(promptPath, "utf-8");
		const parsed = parsePromptMd(content, promptPath);
		writeFileSync(statusPath, generateStatusMd(parsed));
	}

	updateStatusField(statusPath, "Status", "🟡 In Progress");
	updateStatusField(statusPath, "Last Updated", new Date().toISOString().slice(0, 10));
	logExecution(statusPath, "Task started", "Runtime V2 lane-runner execution");

	// Pre-segment guard: remove stale .DONE from prior segment or prior run.
	const isNonFinalAtStart =
		segmentId != null &&
		Array.isArray(unit.task.segmentIds) &&
		unit.task.segmentIds.length > 1 &&
		unit.task.segmentIds[unit.task.segmentIds.length - 1] !== segmentId;
	if (isNonFinalAtStart && existsSync(donePath)) {
		try {
			unlinkSync(donePath);
		} catch {
			/* best effort */
		}
		logExecution(statusPath, "Segment start", `Removed stale .DONE before non-final segment ${segmentId}`);
	}

	// ── 2. Iteration loop ───────────────────────────────────────────
	let noProgressCount = 0;
	let totalIterations = 0;
	let cumulativeCostUsd = 0;
	let cumulativeTokens = 0;
	let lastTelemetry: Partial<AgentHostResult> = {};

	const snapshotSegmentCtx: { stepSegmentMap: StepSegmentMapping[]; repoId: string } | null =
		segmentId && unit.task.stepSegmentMap && config.repoId
			? (() => {
					const ssm = unit.task.stepSegmentMap;
					if (!ssm) return null;
					const repoSteps = getStepsForRepoId(ssm, config.repoId);
					return repoSteps.size > 0 ? { stepSegmentMap: ssm, repoId: config.repoId } : null;
				})()
			: null;

	for (let iter = 0; iter < config.maxIterations; iter++) {
		if (pauseSignal.paused) {
			logExecution(statusPath, "Paused", `User paused at iteration ${totalIterations}`);
			return makeResult(
				taskId,
				segmentId,
				workerAgentId,
				"skipped",
				startTime,
				"Paused by user",
				false,
				totalIterations,
				cumulativeCostUsd,
				cumulativeTokens,
				config,
				statusPath,
				reviewerStatePath,
				undefined,
				snapshotSegmentCtx,
			);
		}

		const currentStatus = parseStatusMd(readFileSync(statusPath, "utf-8"));
		const parsed = parsePromptMd(readFileSync(promptPath, "utf-8"), promptPath);

		const stepSegmentMap = unit.task.stepSegmentMap;
		const currentRepoId = segmentId ? config.repoId : null;
		const rawRepoStepNumbers =
			stepSegmentMap && currentRepoId ? getStepsForRepoId(stepSegmentMap, currentRepoId) : null;
		const repoStepNumbers = rawRepoStepNumbers && rawRepoStepNumbers.size > 0 ? rawRepoStepNumbers : null;

		const iterStatusContent = readFileSync(statusPath, "utf-8");

		const remainingSteps = parsed.steps.filter(step => {
			if (repoStepNumbers && !repoStepNumbers.has(step.number)) return false;
			if (repoStepNumbers && currentRepoId) {
				return !isSegmentComplete(iterStatusContent, step.number, currentRepoId);
			}
			const ss = currentStatus.steps.find(s => s.number === step.number);
			return !isStepComplete(ss);
		});

		if (remainingSteps.length === 0) break;

		totalIterations++;
		const firstStep = remainingSteps[0];
		if (!firstStep) break;
		updateStatusField(statusPath, "Current Step", `Step ${firstStep.number}: ${firstStep.name}`);
		updateStatusField(statusPath, "Iteration", `${totalIterations}`);

		const firstStepStatus = currentStatus.steps.find(s => s.number === firstStep.number);
		if (firstStepStatus?.status !== "in-progress") {
			updateStepStatus(statusPath, firstStep.number, "in-progress");
			logExecution(statusPath, `Step ${firstStep.number} started`, firstStep.name);
		}

		let prevTotalChecked: number;
		if (repoStepNumbers && currentRepoId) {
			const preStatusContent = readFileSync(statusPath, "utf-8");
			const segCbs = getSegmentCheckboxes(preStatusContent, firstStep.number, currentRepoId);
			prevTotalChecked = segCbs ? segCbs.checked : 0;
		} else {
			prevTotalChecked = currentStatus.steps.reduce((sum, s) => sum + s.totalChecked, 0);
		}

		const wrapUpFile = join(taskFolder, ".task-wrap-up");
		if (existsSync(wrapUpFile)) {
			try {
				unlinkSync(wrapUpFile);
			} catch {
				/* ignore */
			}
		}

		const isSegmentScoped = !!(
			stepSegmentMap &&
			currentRepoId &&
			repoStepNumbers &&
			stepSegmentMap.find(s => s.stepNumber === firstStep.number)?.segments.find(seg => seg.repoId === currentRepoId)
		);

		const promptLines = [
			`Read your task instructions at: ${promptPath}`,
			`Read your execution state at: ${statusPath}`,
			``,
			`Task: ${taskId}`,
			`Task folder: ${taskFolder}/`,
			`Iteration: ${totalIterations}`,
			`Wrap-up signal file: ${wrapUpFile}`,
			``,
			`Execution repo context:`,
			`- Execution repo ID: ${unit.executionRepoId}`,
			`- Execution worktree (worker cwd): ${unit.worktreePath}`,
			`- Lane repo ID: ${config.repoId}`,
			...(isSegmentScoped ? [`- Active segment ID: ${segmentId}`] : []),
			``,
			`Packet home context:`,
			`- Packet home repo ID: ${unit.packetHomeRepoId}`,
			`- Packet task folder: ${taskFolder}`,
			`- Packet PROMPT path: ${promptPath}`,
			`- Packet STATUS path: ${statusPath}`,
			`- Packet .DONE path: ${donePath}`,
			`- Packet .reviews path: ${unit.packet.reviewsDir}`,
			``,
			`⚠️ ORCHESTRATED RUN: Do NOT archive or move the task folder. The orchestrator handles post-merge archival.`,
			``,
			`⚠️ CHECKPOINT RULE: After completing EACH checkbox item, immediately edit STATUS.md to check it off (- [ ] → - [x]) BEFORE starting the next item. Do NOT batch checkbox updates at the end of a step.`,
		];

		const segmentDag = isSegmentScoped ? unit.task.explicitSegmentDag : null;
		if (segmentDag && segmentDag.repoIds.length > 0) {
			const edgeSummary =
				segmentDag.edges.length > 0
					? segmentDag.edges.map(edge => `${edge.fromRepoId}->${edge.toRepoId}`).join(", ")
					: "(no explicit edges)";
			promptLines.push(
				``,
				`Segment DAG context (from PROMPT metadata):`,
				`- Repos: ${segmentDag.repoIds.join(", ")}`,
				`- Edges: ${edgeSummary}`,
			);
		}

		if (stepSegmentMap && currentRepoId && repoStepNumbers) {
			const currentStepNum = firstStep.number;
			const currentStepMapping = stepSegmentMap.find(s => s.stepNumber === currentStepNum);
			const mySegment = currentStepMapping?.segments.find(seg => seg.repoId === currentRepoId);

			if (currentStepMapping && mySegment) {
				const otherSegments = currentStepMapping.segments.filter(seg => seg.repoId !== currentRepoId);
				const segmentIndexInStep = currentStepMapping.segments.findIndex(seg => seg.repoId === currentRepoId) + 1;
				const totalSegmentsInStep = currentStepMapping.segments.length;

				promptLines.push(
					``,
					`Segment-scoped context (Phase A):`,
					`Active segment: ${segmentId} (Step ${currentStepNum}, segment ${segmentIndexInStep} of ${totalSegmentsInStep})`,
					`Your repo: ${currentRepoId}`,
					``,
				);

				if (mySegment.checkboxes.length > 0) {
					promptLines.push(`Your checkboxes for this step:`);
					for (const cb of mySegment.checkboxes) {
						promptLines.push(`  ${cb}`);
					}
				}

				if (otherSegments.length > 0) {
					promptLines.push(``, `Other segments in this step (NOT yours — do not attempt):`);
					for (const seg of otherSegments) {
						promptLines.push(
							`  - ${seg.repoId}: ${seg.checkboxes.length} checkbox(es) (will run in a separate segment)`,
						);
					}
				}

				const completedForRepo = parsed.steps.filter(step => {
					if (!repoStepNumbers.has(step.number)) return false;
					const ss = currentStatus.steps.find(s => s.number === step.number);
					return isStepComplete(ss);
				});
				if (completedForRepo.length > 0) {
					promptLines.push(``);
					promptLines.push(
						`Prior steps completed: ${completedForRepo.map(s => `Step ${s.number} (${s.name})`).join(", ")}`,
					);
				}

				promptLines.push(
					``,
					`When all YOUR checkboxes are checked, your segment is done — exit successfully.`,
					`Do NOT attempt work in other repos.`,
				);
			}
		}

		if (totalIterations > 1) {
			const remainingSet = new Set(remainingSteps.map(s => s.number));
			const completedSteps = parsed.steps.filter(s => !remainingSet.has(s.number));
			promptLines.push(
				``,
				`IMPORTANT: You exited previously without completing all steps.`,
				`Completed (do not redo): ${completedSteps.map(s => `Step ${s.number}: ${s.name}`).join(", ") || "(none)"}`,
				`Remaining (focus here): ${remainingSteps.map(s => `Step ${s.number}: ${s.name}`).join(", ")}`,
			);

			if (noProgressCount > 0) {
				promptLines.push(
					``,
					`🚨 CRITICAL: You have exited ${noProgressCount} time(s) without completing work.`,
					`Your previous exit was premature. You said something like "Now let me fix this"`,
					`and then STOPPED instead of actually making the edit.`,
					``,
					`DO NOT DO THIS AGAIN. When you know what to edit, call the edit tool IMMEDIATELY.`,
					`Do not produce a text message describing what you plan to do. Just do it.`,
					`Work continuously through ALL remaining checkboxes until the task is DONE.`,
					`Do not exit between checkboxes or steps.`,
				);
			}
		}

		// ── Spawn worker ────────────────────────────────────────────
		const eventsPath = runtimeAgentEventsPath(config.stateRoot, config.batchId, workerAgentId);
		const inboxDirForWorker = sessionInboxDir(config.stateRoot, config.batchId, workerAgentId);
		const mailboxDir = dirname(inboxDirForWorker);
		mkdirSync(inboxDirForWorker, { recursive: true });

		const steeringPendingPath = join(taskFolder, ".steering-pending");
		const outboxDir = sessionOutboxDir(config.stateRoot, config.batchId, workerAgentId);

		const hostOpts: AgentHostOptions = {
			agentId: workerAgentId,
			role: "worker",
			batchId: config.batchId,
			laneNumber: config.laneNumber,
			taskId,
			repoId: config.repoId,
			cwd: unit.worktreePath,
			prompt: promptLines.join("\n"),
			systemPrompt:
				isSegmentScoped && config.workerSegmentPrompt
					? `${config.workerSystemPrompt}\n\n---\n\n${config.workerSegmentPrompt}`
					: config.workerSystemPrompt || undefined,
			model: config.workerModel || undefined,
			tools: config.workerTools || "read,write,edit,bash,grep,find,ls",
			thinking: config.workerThinking || undefined,
			mailboxDir,
			steeringPendingPath,
			eventsPath,
			exitSummaryPath: eventsPath.replace(/\.jsonl$/, "-exit.json"),
			timeoutMs: config.maxWorkerMinutes * 60_000,
			stateRoot: config.stateRoot,
			packet: unit.packet,
			env: {
				MISSION_OUTBOX_DIR: outboxDir,
				MISSION_AGENT_ID: workerAgentId,
				MISSION_TASK_FOLDER: taskFolder,
				MISSION_STATUS_PATH: statusPath,
				MISSION_PROMPT_PATH: promptPath,
				MISSION_REVIEWS_DIR: unit.packet.reviewsDir,
				MISSION_REVIEWER_STATE_PATH: reviewerStatePath,
				MISSION_PROJECT_NAME: config.projectName || "project",
				MISSION_TASK_ID: taskId,
				MISSION_ACTIVE_SEGMENT_ID: isSegmentScoped ? (segmentId ?? "") : "",
				MISSION_SEGMENT_ID: isSegmentScoped ? (segmentId ?? "") : "",
				MISSION_SUPERVISOR_AUTONOMY: config.supervisorAutonomy || "autonomous",
				ORCH_BATCH_ID: config.batchId,
				...(config.reviewerModel ? { MISSION_REVIEWER_MODEL: config.reviewerModel } : {}),
				...(config.reviewerThinking ? { MISSION_REVIEWER_THINKING: config.reviewerThinking } : {}),
				...(config.reviewerTools ? { MISSION_REVIEWER_TOOLS: config.reviewerTools } : {}),
			},
			onPrematureExit: config.onSupervisorAlert
				? async (assistantMessage: string): Promise<string | null> => {
						try {
							const statusContent = readFileSync(statusPath, "utf-8");
							let midTotalChecked: number;
							if (repoStepNumbers && currentRepoId) {
								const segCbs = getSegmentCheckboxes(statusContent, firstStep.number, currentRepoId);
								midTotalChecked = segCbs ? segCbs.checked : 0;
							} else {
								const midStatus = parseStatusMd(statusContent);
								midTotalChecked = midStatus.steps.reduce((sum, s) => sum + s.totalChecked, 0);
							}
							if (midTotalChecked > prevTotalChecked) return null;

							const blockerMatch = statusContent.match(/## Blockers\s*\n([\s\S]*?)(?:\n---|-$)/i);
							if (blockerMatch?.[1]) {
								const blockerContent = blockerMatch[1].trim();
								if (blockerContent && blockerContent !== "*None*") return null;
							}
						} catch {
							/* fall through */
						}

						const truncatedMsg = assistantMessage.slice(0, 500);
						const uncheckedItems: string[] = [];
						try {
							const statusContent = readFileSync(statusPath, "utf-8");
							if (repoStepNumbers && currentRepoId) {
								const segCbs = getSegmentCheckboxes(statusContent, firstStep.number, currentRepoId);
								if (segCbs) {
									for (const text of segCbs.uncheckedTexts.slice(0, 5)) uncheckedItems.push(text);
								}
							} else {
								const uncheckedMatches = statusContent.match(/^- \[ \] .+$/gm);
								if (uncheckedMatches) {
									for (const item of uncheckedMatches.slice(0, 5)) {
										uncheckedItems.push(item.replace(/^- \[ \] /, "").trim());
									}
								}
							}
						} catch {
							/* best effort */
						}

						const currentStepInfo = `Step ${firstStep.number}: ${firstStep.name}`;

						try {
							config.onSupervisorAlert?.({
								category: "worker-exit-intercept",
								summary:
									`🔄 Worker on lane ${config.laneNumber} wants to exit with no progress.\n` +
									`  Task: ${taskId}\n` +
									`  Current step: ${currentStepInfo}\n` +
									`  Iteration: ${totalIterations}, No-progress count: ${noProgressCount + 1}\n` +
									`  Unchecked items: ${uncheckedItems.length > 0 ? uncheckedItems.join("; ") : "(none found)"}\n` +
									`  Worker said: "${truncatedMsg}"\n` +
									`\nSend a steering message to ${workerAgentId} with targeted instructions,` +
									` or reply "skip" / "let it fail" to close the session.`,
								context: {
									taskId,
									laneId: `lane-${config.laneNumber}`,
									laneNumber: config.laneNumber,
									agentId: workerAgentId,
									exitReason: `worker_exit_no_progress: ${truncatedMsg.slice(0, 200)}`,
								},
							});
						} catch {
							/* best effort */
						}

						const SUPERVISOR_REPLY_TIMEOUT_MS = 60_000;
						const POLL_INTERVAL_MS = 2_000;
						const escalationTimestamp = Date.now();
						const inboxDir = sessionInboxDir(config.stateRoot, config.batchId, workerAgentId);

						const supervisorReply = await new Promise<string | null>(resolveReply => {
							const deadline = Date.now() + SUPERVISOR_REPLY_TIMEOUT_MS;
							const poll = () => {
								if (Date.now() >= deadline) {
									resolveReply(null);
									return;
								}
								try {
									const messages = readInbox(inboxDir, config.batchId);
									for (const { filename, message } of messages) {
										if (message.timestamp >= escalationTimestamp && message.from === "supervisor") {
											try {
												ackMessage(inboxDir, filename);
											} catch {
												/* best effort */
											}
											resolveReply(message.content);
											return;
										}
									}
								} catch {
									/* inbox not ready yet */
								}
								setTimeout(poll, POLL_INTERVAL_MS);
							};
							poll();
						});

						if (!supervisorReply) {
							logExecution(
								statusPath,
								"Exit intercept timeout",
								`Supervisor did not respond within ${SUPERVISOR_REPLY_TIMEOUT_MS / 1000}s — closing session`,
							);
							return null;
						}

						const normalizedReply = supervisorReply.trim().toLowerCase();
						const CLOSE_DIRECTIVES = ["skip", "let it fail", "close", "abort", "stop"];
						const isShortEnoughForDirective = normalizedReply.length < 30;
						if (
							isShortEnoughForDirective &&
							CLOSE_DIRECTIVES.some(
								d =>
									normalizedReply === d ||
									normalizedReply.startsWith(`${d}:`) ||
									normalizedReply.startsWith(`${d} `) ||
									normalizedReply.startsWith(`${d}.`) ||
									normalizedReply.startsWith(`${d} -`),
							)
						) {
							logExecution(
								statusPath,
								"Exit intercept close",
								`Supervisor directed session close: "${supervisorReply.slice(0, 100)}"`,
							);
							return null;
						}

						logExecution(
							statusPath,
							"Exit intercept reprompt",
							`Supervisor provided instructions (${supervisorReply.length} chars) — reprompting worker`,
						);
						return supervisorReply;
					}
				: undefined,
		};

		let workerKillReason: "context" | "timer" | null = null;
		let iterationTelemetry: Partial<AgentHostResult> = {};

		const spawned = spawnHostedAgent(hostOpts, undefined, telemetry => {
			try {
				if (telemetry.contextUsage) {
					const pct = telemetry.contextUsage.percent;
					if (pct >= config.warnPercent) {
						const msg = `Wrap up (context ${Math.round(pct)}%)`;
						if (!existsSync(wrapUpFile)) writeFileSync(wrapUpFile, msg);
					}
					if (pct >= config.killPercent) {
						workerKillReason = "context";
						spawned.kill();
					}
				}

				iterationTelemetry = telemetry;
				lastTelemetry = telemetry;
				emitSnapshot(
					config,
					taskId,
					segmentId,
					"running",
					telemetry,
					statusPath,
					reviewerStatePath,
					snapshotSegmentCtx,
				);
			} catch {
				/* telemetry must not crash engine */
			}
		});

		let reviewerSnapshotFailures = 0;
		const reviewerRefreshFailureThreshold = 5;
		const reviewerRefresh = setInterval(() => {
			const ok = emitSnapshot(
				config,
				taskId,
				segmentId,
				"running",
				iterationTelemetry,
				statusPath,
				reviewerStatePath,
				snapshotSegmentCtx,
			);
			if (ok) {
				reviewerSnapshotFailures = 0;
				return;
			}
			reviewerSnapshotFailures += 1;
			if (reviewerSnapshotFailures >= reviewerRefreshFailureThreshold) {
				clearInterval(reviewerRefresh);
				logExecution(
					statusPath,
					"Snapshot refresh disabled",
					`Lane ${config.laneNumber}, task ${taskId}: ${reviewerSnapshotFailures} consecutive emitSnapshot failures`,
				);
			}
		}, 1000);

		let workerResult: AgentHostResult;
		try {
			workerResult = await spawned.promise;
		} finally {
			clearInterval(reviewerRefresh);
		}

		lastTelemetry = workerResult;

		if (existsSync(wrapUpFile)) {
			try {
				unlinkSync(wrapUpFile);
			} catch {
				/* ignore */
			}
		}

		cumulativeCostUsd += workerResult.costUsd;
		cumulativeTokens +=
			workerResult.inputTokens +
			workerResult.outputTokens +
			workerResult.cacheReadTokens +
			workerResult.cacheWriteTokens;

		// ── Poll worker outbox for replies/escalations ─────────────
		try {
			const outboxMessages = readOutbox(config.stateRoot, config.batchId, workerAgentId);
			for (const msg of outboxMessages) {
				const sanitized = msg.content.replace(/\r?\n/g, " / ").slice(0, 200);
				logExecution(statusPath, `Agent ${msg.type}`, sanitized);

				if (msg.type === "reply" || msg.type === "escalate") {
					appendAgentEvent(config.stateRoot, config.batchId, workerAgentId, {
						batchId: config.batchId,
						agentId: workerAgentId,
						role: "worker",
						laneNumber: config.laneNumber,
						taskId,
						repoId: config.repoId,
						ts: Date.now(),
						type: msg.type === "reply" ? "reply_sent" : "escalation_sent",
						payload: {
							messageId: msg.id,
							replyTo: msg.replyTo ?? null,
							content: sanitized,
						},
					});

					appendMailboxAuditEvent(config.stateRoot, config.batchId, {
						type: msg.type === "reply" ? "message_replied" : "message_escalated",
						from: workerAgentId,
						to: "supervisor",
						messageId: msg.id,
						messageType: msg.type,
						contentPreview: sanitized,
					});

					if (config.onSupervisorAlert) {
						const isEscalation = msg.type === "escalate";
						try {
							config.onSupervisorAlert({
								category: "agent-message",
								summary:
									`${isEscalation ? "🚨" : "📨"} Agent ${isEscalation ? "escalation" : "reply"} from ${workerAgentId}\n` +
									`  Task: ${taskId}\n` +
									`  Lane: lane-${config.laneNumber}\n` +
									`  Message: ${sanitized}`,
								context: {
									taskId,
									laneId: `lane-${config.laneNumber}`,
									laneNumber: config.laneNumber,
									agentId: workerAgentId,
									messageId: msg.id,
									exitReason: `${isEscalation ? "agent_escalation" : "agent_reply"}: ${sanitized}`,
								},
							});
						} catch {
							/* best effort */
						}
					}
				}

				ackOutboxMessage(config.stateRoot, config.batchId, workerAgentId, msg.id);
			}
		} catch {
			/* best effort */
		}

		// ── Steering annotation ────────────────────────────────────
		try {
			if (existsSync(steeringPendingPath)) {
				const raw = readFileSync(steeringPendingPath, "utf-8");
				for (const line of raw.split("\n").filter(l => l.trim())) {
					try {
						const entry = JSON.parse(line) as { ts: number; content: string; id: string };
						const sanitized = entry.content.replace(/\r?\n/g, " / ").replace(/\|/g, "\\|").slice(0, 200);
						logExecution(statusPath, "⚠️ Steering", sanitized);
					} catch {
						/* skip malformed */
					}
				}
				unlinkSync(steeringPendingPath);
			}
		} catch {
			/* non-fatal */
		}

		const statusMsg = workerResult.killed
			? `killed (${workerKillReason === "context" ? "context limit" : "wall-clock timeout"})`
			: workerResult.exitCode === 0
				? "done"
				: `error (code ${workerResult.exitCode})`;
		logExecution(
			statusPath,
			`Worker iter ${totalIterations}`,
			`${statusMsg} in ${Math.round(workerResult.durationMs / 1000)}s, tools: ${workerResult.toolCalls}`,
		);

		// ── Check progress ─────────────────────────────────────────
		const afterStatusContent = readFileSync(statusPath, "utf-8");
		const afterStatus = parseStatusMd(afterStatusContent);
		let afterTotalChecked: number;
		if (repoStepNumbers && currentRepoId) {
			const segCbs = getSegmentCheckboxes(afterStatusContent, firstStep.number, currentRepoId);
			afterTotalChecked = segCbs ? segCbs.checked : 0;
		} else {
			afterTotalChecked = afterStatus.steps.reduce((sum, s) => sum + s.totalChecked, 0);
		}
		const progressDelta = afterTotalChecked - prevTotalChecked;

		if (progressDelta <= 0) {
			let hasSoftProgress = false;
			try {
				const diffOutput = execSync("git diff --stat HEAD", {
					cwd: unit.worktreePath,
					timeout: 5000,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				}).trim();
				const changedFiles = diffOutput.split("\n").filter(l => l.includes("|"));
				const sourceChanges = changedFiles.filter(l => !l.includes("STATUS.md") && !l.includes(".steering"));
				hasSoftProgress = sourceChanges.length > 0;
			} catch {
				/* no git / timeout */
			}

			if (hasSoftProgress) {
				logExecution(
					statusPath,
					"Soft progress",
					`Iteration ${totalIterations}: 0 new checkboxes but uncommitted source changes detected — not counting as stall`,
				);
				noProgressCount = 0;
			} else {
				noProgressCount++;
				logExecution(
					statusPath,
					"No progress",
					`Iteration ${totalIterations}: 0 new checkboxes (${noProgressCount}/${config.noProgressLimit} stall limit)`,
				);
				if (noProgressCount >= config.noProgressLimit) {
					logExecution(statusPath, "Task blocked", `No progress after ${noProgressCount} iterations`);
					return makeResult(
						taskId,
						segmentId,
						workerAgentId,
						"failed",
						startTime,
						`No progress after ${noProgressCount} iterations`,
						false,
						totalIterations,
						cumulativeCostUsd,
						cumulativeTokens,
						config,
						statusPath,
						reviewerStatePath,
						lastTelemetry,
						snapshotSegmentCtx,
					);
				}
			}
		} else {
			noProgressCount = 0;
		}

		if (repoStepNumbers && currentRepoId) {
			for (const stepNum of repoStepNumbers) {
				if (isSegmentComplete(afterStatusContent, stepNum, currentRepoId)) {
					const ss = afterStatus.steps.find(s => s.number === stepNum);
					if (isStepComplete(ss)) updateStepStatus(statusPath, stepNum, "complete");
				}
			}
		} else {
			for (const step of parsed.steps) {
				const ss = afterStatus.steps.find(s => s.number === step.number);
				if (isStepComplete(ss)) updateStepStatus(statusPath, step.number, "complete");
			}
		}

		let allComplete: boolean;
		if (repoStepNumbers && currentRepoId) {
			allComplete = [...repoStepNumbers].every(stepNum =>
				isSegmentComplete(afterStatusContent, stepNum, currentRepoId),
			);
		} else {
			allComplete = parsed.steps.every(step => {
				const ss = afterStatus.steps.find(s => s.number === step.number);
				return isStepComplete(ss);
			});
		}
		if (allComplete) break;
	}

	// ── 3. Post-loop completion check ───────────────────────────────
	const finalStatusContent = readFileSync(statusPath, "utf-8");
	const finalStatus = parseStatusMd(finalStatusContent);
	const parsed = parsePromptMd(readFileSync(promptPath, "utf-8"), promptPath);

	const postLoopRepoId = segmentId ? config.repoId : null;
	const postLoopStepSegMap = unit.task.stepSegmentMap;
	const postLoopRepoSteps =
		postLoopStepSegMap && postLoopRepoId ? getStepsForRepoId(postLoopStepSegMap, postLoopRepoId) : null;
	const effectivePostLoopRepoSteps = postLoopRepoSteps && postLoopRepoSteps.size > 0 ? postLoopRepoSteps : null;

	let allStepsComplete: boolean;
	if (effectivePostLoopRepoSteps && postLoopRepoId) {
		allStepsComplete = [...effectivePostLoopRepoSteps].every(stepNum =>
			isSegmentComplete(finalStatusContent, stepNum, postLoopRepoId),
		);
	} else {
		allStepsComplete = parsed.steps.every(step => {
			const ss = finalStatus.steps.find(s => s.number === step.number);
			return isStepComplete(ss);
		});
	}

	if (!allStepsComplete) {
		let incomplete: string;
		if (effectivePostLoopRepoSteps && postLoopRepoId) {
			incomplete = [...effectivePostLoopRepoSteps]
				.filter(stepNum => !isSegmentComplete(finalStatusContent, stepNum, postLoopRepoId))
				.map(n => `Step ${n}`)
				.join(", ");
		} else {
			incomplete = parsed.steps
				.filter(step => {
					const ss = finalStatus.steps.find(s => s.number === step.number);
					return !isStepComplete(ss);
				})
				.map(s => `Step ${s.number}`)
				.join(", ");
		}
		logExecution(statusPath, "Task incomplete", `Max iterations reached. Incomplete: ${incomplete}`);
		return makeResult(
			taskId,
			segmentId,
			workerAgentId,
			"failed",
			startTime,
			`Max iterations (${config.maxIterations}) reached with incomplete steps: ${incomplete}`,
			false,
			totalIterations,
			cumulativeCostUsd,
			cumulativeTokens,
			config,
			statusPath,
			reviewerStatePath,
			lastTelemetry,
			snapshotSegmentCtx,
		);
	}

	const isNonFinalSegment =
		segmentId != null &&
		Array.isArray(unit.task.segmentIds) &&
		unit.task.segmentIds.length > 1 &&
		unit.task.segmentIds[unit.task.segmentIds.length - 1] !== segmentId;

	const hasPendingExpansionRequests =
		segmentId != null && hasPendingExpansionRequestFiles(config.stateRoot, config.batchId, workerAgentId);

	if (isNonFinalSegment || hasPendingExpansionRequests) {
		if (existsSync(donePath)) {
			let deleted = false;
			try {
				unlinkSync(donePath);
				deleted = true;
			} catch {
				/* best effort */
			}
			if (deleted) {
				logExecution(
					statusPath,
					"Segment complete",
					`Segment ${segmentId} succeeded (non-final — removed premature worker-created .DONE)`,
				);
			} else {
				logExecution(
					statusPath,
					"Segment complete",
					`⚠️ Segment ${segmentId} succeeded but FAILED to remove premature .DONE — downstream segments may be skipped`,
				);
			}
		} else {
			logExecution(statusPath, "Segment complete", `Segment ${segmentId} succeeded (not final — .DONE suppressed)`);
		}
		const suppressionReason = isNonFinalSegment ? "non-final" : "pending expansion requests";
		return makeResult(
			taskId,
			segmentId,
			workerAgentId,
			"succeeded",
			startTime,
			`Segment completed (${suppressionReason} — .DONE suppressed)`,
			false,
			totalIterations,
			cumulativeCostUsd,
			cumulativeTokens,
			config,
			statusPath,
			reviewerStatePath,
			lastTelemetry,
			snapshotSegmentCtx,
		);
	}

	if (!existsSync(donePath)) {
		writeFileSync(donePath, `Completed: ${new Date().toISOString()}\nTask: ${taskId}\n`);
	}
	updateStatusField(statusPath, "Status", "✅ Complete");
	logExecution(statusPath, "Task complete", ".DONE created");

	return makeResult(
		taskId,
		segmentId,
		workerAgentId,
		"succeeded",
		startTime,
		".DONE file created by lane-runner",
		true,
		totalIterations,
		cumulativeCostUsd,
		cumulativeTokens,
		config,
		statusPath,
		reviewerStatePath,
		lastTelemetry,
		snapshotSegmentCtx,
	);
}

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
