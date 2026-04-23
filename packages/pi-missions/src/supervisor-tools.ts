/**
 * Supervisor-side orchestrator tools — the `orch_*` + agent-mailbox
 * surface referenced by `templates/agents/supervisor.md`,
 * `templates/supervisor-primer.md`, and
 * `templates/agents/supervisor-routing.md`.
 *
 * NAMING: tool names keep the `orch_*` prefix intentionally, matching
 * the prompt templates verbatim. Renaming would require re-auditing
 * every prompt file. Do not rename without also updating all prompts.
 *
 * Port note: taskplane registered 16 tools in `extension.ts`
 * (3686-4707). This module is the pi-missions equivalent. Four
 * categories:
 *
 *   Observational:  orch_status, read_agent_status, list_active_agents,
 *                   read_lane_logs
 *   Control:        orch_pause, orch_resume, orch_abort
 *   Mailbox:        send_agent_message, read_agent_replies,
 *                   broadcast_message, trigger_wrap_up
 *   Integration:    orch_integrate, orch_retry_task, orch_skip_task,
 *                   orch_force_merge, orch_start
 *
 * `orch_retry_task`, `orch_skip_task`, and `orch_force_merge` perform
 * direct `PersistedBatchState` mutations with counter hygiene
 * (failedTasks / skippedTasks / blockedTaskIds) and phase transitions
 * that make the batch resumable via `orch_resume(force=true)`. They do
 * NOT re-run engine merge logic — `orch_force_merge` marks a partial
 * merge as `succeeded`; operators should follow up with a real
 * `/mission-resume` once V2 merge machinery is wired.
 *
 * Self-gate: runs only when `MISSION_AGENT_ID` is NOT set. That env
 * var is injected by the lane-runner when spawning workers; its
 * absence means we are in the operator's main session (or a
 * non-mission session), which is where these tools belong.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import type {
	BehavioralAssertion,
	Engine,
	KnowledgeEntry,
	MailboxMessageType,
	MissionRole,
	PersistedBatchState,
	RuntimeRegistry,
	SkillEntry,
} from "./missioncontrol";
import {
	appendKnowledgeEntry,
	buildIntegrationExecutor,
	buildMissionStatusReport,
	createSkillDraft,
	discardSkillDraft,
	discoverMailboxAgentIds,
	draftFeature,
	finalizePlan,
	getCurrentBranch,
	handleAddAssertion,
	handleCreateMilestone,
	isMissionRole,
	isProcessAlive,
	isTerminalStatus,
	KNOWLEDGE_GLOBAL_SCOPE,
	listAvailableSkills,
	listClarifications,
	loadBatchState,
	loadValidationContract,
	parseIntegrateArgs,
	persistRoleModelOverride,
	promoteSkillDraft,
	readKnowledgeEntries,
	readOutboxHistory,
	readRegistrySnapshot,
	recordClarification,
	resolveIntegrationContext,
	resolveOperatorId,
	runGit,
	saveBatchState,
	saveValidationContract,
	summariseKnowledge,
	validateAssertionId,
	writeBroadcastMessage,
	writeMailboxMessage,
	writeMissionCheckpoint,
} from "./missioncontrol";
import type { MissionState } from "./types";

type GetState = () => MissionState | null;
type SetState = (state: MissionState | null) => void;

interface TextResult {
	content: Array<{ type: "text"; text: string }>;
}

function textResult(text: string): TextResult {
	return { content: [{ type: "text" as const, text }] };
}

/**
 * Collect the set of agent IDs that can accept supervisor messages.
 *
 * Registry-first (Runtime V2 source of truth), with a mailbox
 * discovery fallback for batches whose registry file has not yet been
 * written. Filters out terminal-status or dead processes so callers
 * can rely on "in the set" meaning "alive and reachable".
 */
function collectKnownAgentIds(stateRoot: string, batchId: string): string[] {
	const ids = new Set<string>();
	const registry = readRegistrySnapshot(stateRoot, batchId);
	if (registry) {
		for (const manifest of Object.values(registry.agents)) {
			if (manifest.role !== "worker" && manifest.role !== "reviewer" && manifest.role !== "merger") continue;
			if (isTerminalStatus(manifest.status) || !isProcessAlive(manifest.pid)) continue;
			ids.add(manifest.agentId);
		}
	}
	if (ids.size === 0) {
		for (const id of discoverMailboxAgentIds(stateRoot, batchId)) ids.add(id);
	}
	return [...ids];
}

function formatRegistry(registry: RuntimeRegistry | null): string {
	if (!registry) return "No active registry.";
	const agents = Object.values(registry.agents);
	if (agents.length === 0) return "No agents in registry.";

	const lines: string[] = [`Active agents (${agents.length} registered):`];
	for (const m of agents) {
		const alive = !isTerminalStatus(m.status) && isProcessAlive(m.pid);
		const icon = alive ? "●" : "○";
		const parts: string[] = [m.agentId, `role: ${m.role}`, `status: ${m.status}`];
		if (m.laneNumber != null) parts.push(`lane: ${m.laneNumber}`);
		if (m.taskId) parts.push(`task: ${m.taskId}`);
		if (alive) {
			const elapsed = Math.round((Date.now() - m.startedAt) / 1000);
			parts.push(`elapsed: ${elapsed}s`);
		}
		lines.push(`  ${icon} ${parts.join(" · ")}`);
	}
	return lines.join("\n");
}

async function loadActiveBatchState(cwd: string): Promise<PersistedBatchState | null> {
	try {
		return await loadBatchState(cwd);
	} catch (err) {
		logger.warn("[pi-mission] supervisor-tools: loadBatchState failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Register the 16 `orch_*` + mailbox tools referenced by the
 * supervisor prompt templates.
 */
export default function registerSupervisorTools(
	pi: ExtensionAPI,
	getState: GetState,
	_setState: SetState,
	cwd: string,
	engine: Engine,
): void {
	// ── Observational ──────────────────────────────────────────────

	pi.registerTool({
		name: "orch_status",
		label: "Orchestrator Status",
		description:
			"Report the current batch status (phase, wave progress, task counts, elapsed time). " +
			"Works even when no batch is running.",
		parameters: Type.Object({}),
		async execute() {
			const state = getState();
			const report = await buildMissionStatusReport(state, { cwd });
			return textResult(report.message);
		},
	});

	pi.registerTool({
		name: "list_active_agents",
		label: "List Active Agents",
		description: "List all active Runtime V2 agents with role, lane, task, status, and elapsed time.",
		parameters: Type.Object({}),
		async execute() {
			const state = getState();
			if (!state?.batch) return textResult("No active batch.");
			const registry = readRegistrySnapshot(cwd, state.batch.batchId);
			return textResult(formatRegistry(registry));
		},
	});

	pi.registerTool({
		name: "read_agent_status",
		label: "Read Agent Status",
		description:
			"Summarize lane status for a running agent. With no `lane` arg, returns a snapshot across all lanes.",
		parameters: Type.Object({
			lane: Type.Optional(Type.Number({ description: "Lane number to check (omit for all lanes)" })),
		}),
		async execute(_id, params) {
			const state = getState();
			if (!state?.batch) return textResult("No active batch.");
			const lanes =
				typeof params.lane === "number"
					? state.batch.laneStatuses.filter(l => l.lane === params.lane)
					: state.batch.laneStatuses;
			if (lanes.length === 0) {
				return textResult(typeof params.lane === "number" ? `Lane ${params.lane} not found.` : "No lanes.");
			}
			const lines: string[] = [`Agent status — batch ${state.batch.batchId}`];
			for (const lane of lanes) {
				const task = lane.taskId ? `${lane.taskId} (${lane.status})` : "idle";
				const progress = lane.stepProgress ? ` · ${lane.stepProgress}` : "";
				lines.push(`  Lane ${lane.lane}: ${task}${progress}`);
			}
			return textResult(lines.join("\n"));
		},
	});

	pi.registerTool({
		name: "read_lane_logs",
		label: "Read Lane Logs",
		description: "Read stderr/crash logs for a specific lane from the telemetry directory.",
		parameters: Type.Object({
			lane: Type.Number({ description: "Lane number to read logs for" }),
		}),
		async execute(_id, params) {
			const state = getState();
			if (!state?.batch) return textResult("No active batch.");
			const batchId = state.batch.batchId;
			const telemetryDir = join(cwd, ".omp", "telemetry");
			if (!existsSync(telemetryDir)) {
				return textResult(`No telemetry directory found at ${telemetryDir}.`);
			}
			let entries: string[];
			try {
				entries = readdirSync(telemetryDir);
			} catch (err) {
				return textResult(`Failed to read telemetry dir: ${err instanceof Error ? err.message : String(err)}`);
			}
			const stderrCandidates = entries
				.filter(name => name.includes(`-lane-${params.lane}-worker`) && name.endsWith("-stderr.log"))
				.filter(name => name.includes(`-${batchId}-`) || !entries.some(e => e.includes(`-${batchId}-`)));
			if (stderrCandidates.length === 0) {
				return textResult(`No stderr log found for lane ${params.lane} in batch ${batchId}.`);
			}
			// Latest by mtime.
			const sorted = stderrCandidates
				.map(name => {
					let mtime = 0;
					try {
						mtime = statSync(join(telemetryDir, name)).mtimeMs;
					} catch {
						// best effort
					}
					return { name, mtime };
				})
				.sort((a, b) => b.mtime - a.mtime);
			const latest = sorted[0].name;
			try {
				const content = readFileSync(join(telemetryDir, latest), "utf-8");
				const truncated = content.length > 5000 ? `...\n${content.slice(-5000)}` : content;
				return textResult(`Lane ${params.lane} stderr (${latest}):\n\n${truncated.trim()}`);
			} catch (err) {
				return textResult(`Failed to read ${latest}: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// ── Control ────────────────────────────────────────────────────

	pi.registerTool({
		name: "orch_pause",
		label: "Pause Batch",
		description: "Pause the running batch gracefully. Current tasks finish; no new tasks start.",
		parameters: Type.Object({}),
		async execute() {
			const state = getState();
			if (!state?.batch) return textResult("No active batch to pause.");
			if (state.batch.phase === "paused") return textResult(`Batch ${state.batch.batchId} is already paused.`);
			const next = await engine.handlers.pause();
			const phase = next?.batch?.phase ?? "paused";
			return textResult(`Pause signalled — batch ${state.batch.batchId} is now ${phase}.`);
		},
	});

	pi.registerTool({
		name: "orch_resume",
		label: "Resume Batch",
		description: "Resume a paused batch. The batch continues from where it left off.",
		parameters: Type.Object({
			force: Type.Optional(Type.Boolean({ description: "Resume from stopped or failed state (default: false)" })),
		}),
		async execute(_id, _params) {
			const state = getState();
			if (!state?.batch) return textResult("No active batch to resume.");
			if (state.batch.phase !== "paused") {
				return textResult(`Batch ${state.batch.batchId} is not paused (phase: ${state.batch.phase}).`);
			}
			const next = await engine.handlers.resume();
			const phase = next?.batch?.phase ?? "running";
			return textResult(`Resumed — batch ${state.batch.batchId} is now ${phase}.`);
		},
	});

	pi.registerTool({
		name: "orch_abort",
		label: "Abort Batch",
		description: "Abort the running batch. Default is graceful (hard=false). hard=true for immediate termination.",
		parameters: Type.Object({
			hard: Type.Optional(
				Type.Boolean({ description: "Hard abort — immediate kill without grace period (default: false)" }),
			),
		}),
		async execute(_id, params) {
			const state = getState();
			if (!state?.batch) return textResult("No active batch to abort.");
			const reason = params.hard ? "hard abort by supervisor" : "aborted by supervisor";
			await engine.handlers.abort(reason);
			return textResult(`Batch ${state.batch.batchId} abort signalled (${params.hard ? "hard" : "graceful"}).`);
		},
	});

	// ── Mailbox ────────────────────────────────────────────────────

	pi.registerTool({
		name: "send_agent_message",
		label: "Send Agent Message",
		description:
			"Send a steering message to a running agent. Delivered into the agent's inbox; the worker picks it up at the next turn boundary.",
		parameters: Type.Object({
			to: Type.String({ description: "Target agent ID (from list_active_agents)" }),
			content: Type.String({ description: "Message content (max 4KB)" }),
			type: Type.Optional(
				Type.Union([Type.Literal("steer"), Type.Literal("query"), Type.Literal("abort"), Type.Literal("info")], {
					description: "Message type (default: steer)",
				}),
			),
		}),
		async execute(_id, params) {
			const state = getState();
			if (!state?.batch) return textResult("No active batch — cannot send messages.");
			const batchId = state.batch.batchId;
			const validSessions = new Set(collectKnownAgentIds(cwd, batchId));
			if (!validSessions.has(params.to)) {
				const preview = [...validSessions].slice(0, 5).join(", ");
				return textResult(
					`Unknown agent "${params.to}" in batch ${batchId}.\n` +
						`Valid targets: ${preview}${validSessions.size > 5 ? ` (${validSessions.size} total)` : ""}`,
				);
			}
			const messageType = (params.type ?? "steer") as MailboxMessageType;
			try {
				const msg = writeMailboxMessage(cwd, batchId, params.to, {
					from: "supervisor",
					type: messageType,
					content: params.content,
				});
				return textResult(
					`Message sent to ${params.to} (batch ${batchId})\n` +
						`  ID: ${msg.id}\n  Type: ${messageType}\n` +
						"Delivered at the agent's next turn boundary.",
				);
			} catch (err) {
				return textResult(`Failed to write message: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	pi.registerTool({
		name: "broadcast_message",
		label: "Broadcast Message",
		description:
			"Send a message to all active agents. Written to the broadcast inbox and delivered at each agent's next turn boundary.",
		parameters: Type.Object({
			content: Type.String({ description: "Message content (max 4KB)" }),
			type: Type.Optional(
				Type.Union([Type.Literal("steer"), Type.Literal("info"), Type.Literal("abort")], {
					description: "Message type (default: info)",
				}),
			),
		}),
		async execute(_id, params) {
			const state = getState();
			if (!state?.batch) return textResult("No active batch.");
			const batchId = state.batch.batchId;
			const messageType = (params.type ?? "info") as MailboxMessageType;
			const recipients = collectKnownAgentIds(cwd, batchId);
			if (recipients.length === 0) {
				return textResult(`No known agents in batch ${batchId} for broadcast delivery.`);
			}
			try {
				const msg = writeBroadcastMessage(cwd, batchId, {
					from: "supervisor",
					type: messageType,
					content: params.content,
				});
				return textResult(
					`Broadcast sent (batch ${batchId})\n  ID: ${msg.id}\n  Type: ${messageType}\n  Recipients: ${recipients.length}`,
				);
			} catch (err) {
				return textResult(`Failed to broadcast: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	pi.registerTool({
		name: "read_agent_replies",
		label: "Read Agent Replies",
		description:
			"Read reply + escalation messages from agents (non-consuming). Messages are never removed by reading — this is a durable history view.",
		parameters: Type.Object({
			from: Type.Optional(Type.String({ description: "Agent ID to read replies from (omit for all agents)" })),
		}),
		async execute(_id, params) {
			const state = getState();
			if (!state?.batch) return textResult("No active batch.");
			const batchId = state.batch.batchId;
			const agentIds = params.from
				? [params.from]
				: [...new Set([...collectKnownAgentIds(cwd, batchId), ...discoverMailboxAgentIds(cwd, batchId)])];

			const all: Array<{
				agentId: string;
				message: ReturnType<typeof readOutboxHistory>[number]["message"];
				acked: boolean;
			}> = [];
			for (const id of agentIds) {
				for (const entry of readOutboxHistory(cwd, batchId, id)) {
					all.push({ agentId: id, message: entry.message, acked: entry.acked });
				}
			}
			if (all.length === 0) {
				return textResult(
					params.from
						? `No replies from ${params.from} in batch ${batchId}.`
						: `No agent replies in batch ${batchId}.`,
				);
			}
			const lines: string[] = [`Agent replies (${all.length} message(s))`];
			for (const { agentId, message, acked } of all) {
				const ts = new Date(message.timestamp).toISOString().slice(0, 16).replace("T", " ");
				const statusTag = acked ? " (acked)" : " (pending)";
				lines.push(`\n[${message.type}] from ${agentId}${statusTag}`);
				lines.push(`  Time: ${ts}`);
				lines.push(`  ID: ${message.id}`);
				if (message.replyTo) lines.push(`  Reply to: ${message.replyTo}`);
				lines.push(`  Content: ${message.content.slice(0, 500)}`);
			}
			return textResult(lines.join("\n"));
		},
	});

	pi.registerTool({
		name: "trigger_wrap_up",
		label: "Trigger Wrap Up",
		description:
			"Write the .task-wrap-up signal file for a lane, telling the worker to finish its current step and exit gracefully.",
		parameters: Type.Object({
			lane: Type.Number({ description: "Lane number to signal" }),
		}),
		async execute(_id, params) {
			const state = getState();
			if (!state?.batch) return textResult("No active batch.");
			const batchState = await loadActiveBatchState(cwd);
			if (!batchState) return textResult("No persisted batch state found — cannot resolve lane paths.");
			const laneRec = batchState.lanes.find(l => l.laneNumber === params.lane);
			if (!laneRec) return textResult(`Lane ${params.lane} not found in batch ${batchState.batchId}.`);
			const runningTask = batchState.tasks.find(t => t.laneNumber === params.lane && t.status === "running");
			if (!runningTask) return textResult(`No running task on lane ${params.lane}.`);
			const taskFolder = runningTask.taskFolder;
			const worktreePath = laneRec.worktreePath;
			if (!taskFolder || !worktreePath) {
				return textResult(`Cannot resolve task folder for lane ${params.lane}.`);
			}
			const wrapUpPath = join(worktreePath, taskFolder, ".task-wrap-up");
			try {
				const dir = dirname(wrapUpPath);
				if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
				writeFileSync(wrapUpPath, `wrap-up signal for ${runningTask.taskId}\n`, "utf-8");
				return textResult(
					`Wrap-up signal written for ${runningTask.taskId} on lane ${params.lane}.\n` +
						`Path: ${wrapUpPath}\nThe worker will finish its current step and exit gracefully.`,
				);
			} catch (err) {
				return textResult(`Failed to write wrap-up signal: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// ── Integration & task recovery ────────────────────────────────

	pi.registerTool({
		name: "orch_integrate",
		label: "Integrate Batch",
		description:
			"Integrate a completed batch into the working branch. Supports fast-forward (default), merge commit, or pull request modes.",
		parameters: Type.Object({
			mode: Type.Optional(
				Type.Union([Type.Literal("fast-forward"), Type.Literal("merge"), Type.Literal("pr")], {
					description: "Integration mode (default: fast-forward)",
				}),
			),
			force: Type.Optional(Type.Boolean({ description: "Skip branch safety check (default: false)" })),
			branch: Type.Optional(
				Type.String({ description: "Mission branch name (auto-detected from batch state if omitted)" }),
			),
		}),
		async execute(_id, params) {
			const mode = params.mode ?? "fast-forward";
			const argParts: string[] = [];
			if (params.branch) argParts.push(params.branch);
			if (mode === "merge") argParts.push("--merge");
			else if (mode === "pr") argParts.push("--pr");
			if (params.force) argParts.push("--force");

			const parsed = parseIntegrateArgs(argParts.join(" "));
			if ("error" in parsed) return textResult(parsed.error);

			const batchState = await loadActiveBatchState(cwd);
			const resolution = resolveIntegrationContext(parsed, {
				loadBatchState: () => batchState,
				getCurrentBranch: () => getCurrentBranch(cwd),
				listOrchBranches: () => {
					const result = runGit(["branch", "--list", "orch/*"], cwd);
					if (!result.ok) return [];
					return result.stdout
						.split("\n")
						.map((b: string) => b.replace(/^\*?\s+/, "").trim())
						.filter(Boolean);
				},
				orchBranchExists: (branch: string) => runGit(["rev-parse", "--verify", `refs/heads/${branch}`], cwd).ok,
			});
			if ("error" in resolution) return textResult(resolution.error);

			const opId = resolveOperatorId();
			const executor = buildIntegrationExecutor(cwd, opId, cwd);
			const result = executor(parsed.mode, resolution);
			return textResult(result.success ? result.message : (result.error ?? result.message ?? "Integration failed."));
		},
	});

	pi.registerTool({
		name: "orch_start",
		label: "Start Batch",
		description:
			'Start a new batch. `target` is "all" to run every pending task, or a space-separated list of task IDs.',
		parameters: Type.Object({
			target: Type.String({
				description:
					'Target: "all" for every pending task, or a space-separated list of task IDs (e.g. "TP-001 TP-002").',
			}),
		}),
		async execute(_id, params) {
			const current = getState();
			if (!current) return textResult("No active mission. Use /mission first to create one.");
			if (
				current.batch &&
				current.batch.phase !== "complete" &&
				current.batch.phase !== "error" &&
				current.batch.phase !== "aborted"
			) {
				return textResult(
					`A batch is already active (phase: ${current.batch.phase}). Call orch_status() to check progress or orch_abort() to stop it.`,
				);
			}
			const trimmed = params.target.trim();
			const taskIds = trimmed === "" || trimmed === "all" ? [] : trimmed.split(/\s+/).filter(Boolean);
			const next = await engine.handlers.batch({ taskIds });
			if (!next?.batch) return textResult("Failed to promote mission to batch mode.");
			return textResult(
				`Batch ${next.batch.batchId} started — ${next.batch.laneCount} lanes, ${next.batch.waves.length} waves, ${next.batch.tasksTotal} tasks.`,
			);
		},
	});

	// Retry / skip / force-merge mutate the persisted batch state directly.
	// The lane-runner re-reads state on the next wave tick (or when the
	// operator calls orch_resume(force=true)), so the tools intentionally
	// do NOT try to cancel an already-running task — they prepare the state
	// for the next scheduling pass. Callers are told explicitly to pause or
	// resume(force=true) after mutating, so race conditions stay visible.

	pi.registerTool({
		name: "orch_retry_task",
		label: "Retry Failed Task",
		description: "Reset a failed task to pending so it will be re-executed on the next resume cycle.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID to retry (e.g. TP-003)" }),
		}),
		async execute(_id, params) {
			const state = await loadActiveBatchState(cwd);
			if (!state) return textResult("No persisted batch state found — cannot retry task.");
			const task = state.tasks.find(t => t.taskId === params.taskId);
			if (!task) {
				return textResult(`Task ${params.taskId} not found in batch ${state.batchId}.`);
			}
			if (task.status !== "failed" && task.status !== "stalled") {
				return textResult(
					`Task ${params.taskId} is ${task.status}, not failed/stalled. Only failed or stalled tasks can be retried.`,
				);
			}
			const wasFailed = task.status === "failed";
			task.status = "pending";
			task.exitReason = "";
			task.startedAt = null;
			task.endedAt = null;
			task.doneFileFound = false;
			task.exitDiagnostic = undefined;
			task.partialProgressCommits = undefined;
			task.partialProgressBranch = undefined;
			if (wasFailed && typeof state.failedTasks === "number") {
				state.failedTasks = Math.max(0, state.failedTasks - 1);
			}
			if (state.phase === "failed") {
				// Make the batch resumable. orch_resume(force=true) will pick up here.
				state.phase = "stopped";
			}
			try {
				await saveBatchState(JSON.stringify(state, null, 2), cwd);
			} catch (err) {
				return textResult(`Failed to persist retry: ${err instanceof Error ? err.message : String(err)}`);
			}
			return textResult(`Task ${params.taskId} reset to pending. Call orch_resume(force=true) to re-execute.`);
		},
	});

	pi.registerTool({
		name: "orch_skip_task",
		label: "Skip Task",
		description: "Skip a failed or pending task and unblock its dependents.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID to skip (e.g. TP-003)" }),
		}),
		async execute(_id, params) {
			const state = await loadActiveBatchState(cwd);
			if (!state) return textResult("No persisted batch state found — cannot skip task.");
			const task = state.tasks.find(t => t.taskId === params.taskId);
			if (!task) {
				return textResult(`Task ${params.taskId} not found in batch ${state.batchId}.`);
			}
			if (task.status !== "failed" && task.status !== "pending" && task.status !== "stalled") {
				return textResult(
					`Task ${params.taskId} is ${task.status}; only failed, stalled, or pending tasks can be skipped.`,
				);
			}
			const wasFailed = task.status === "failed";
			task.status = "skipped";
			task.exitReason = "skipped by supervisor";
			task.endedAt = Date.now();
			if (wasFailed && typeof state.failedTasks === "number") {
				state.failedTasks = Math.max(0, state.failedTasks - 1);
			}
			state.skippedTasks = (state.skippedTasks ?? 0) + 1;
			// Skipping a predecessor is an *unblock* signal in taskplane-compatible
			// semantics — downstream tasks that were only blocked by this task's
			// failure are freed. We don't recompute the dependency graph here
			// (it lives outside the persisted state) but we do drop this task's
			// id from the blocked list so `orch_resume` picks it up cleanly.
			if (Array.isArray(state.blockedTaskIds)) {
				const before = state.blockedTaskIds.length;
				state.blockedTaskIds = state.blockedTaskIds.filter(id => id !== task.taskId);
				const unblocked = before - state.blockedTaskIds.length;
				if (unblocked > 0 && typeof state.blockedTasks === "number") {
					state.blockedTasks = Math.max(0, state.blockedTasks - unblocked);
				}
			}
			try {
				await saveBatchState(JSON.stringify(state, null, 2), cwd);
			} catch (err) {
				return textResult(`Failed to persist skip: ${err instanceof Error ? err.message : String(err)}`);
			}
			return textResult(`Task ${params.taskId} marked skipped. Call orch_resume(force=true) to unblock dependents.`);
		},
	});

	pi.registerTool({
		name: "orch_force_merge",
		label: "Force Merge Wave",
		description:
			"Force-merge a wave that was rejected due to mixed-outcome lanes. Use when the batch is paused with a partial merge result.",
		parameters: Type.Object({
			waveIndex: Type.Optional(
				Type.Number({ description: "0-based wave index to force merge. Defaults to the current wave." }),
			),
			skipFailed: Type.Optional(
				Type.Boolean({
					description:
						"If true, automatically skip all failed tasks in the wave before merging. Defaults to false.",
				}),
			),
		}),
		async execute(_id, params) {
			const state = await loadActiveBatchState(cwd);
			if (!state) return textResult("No persisted batch state found — cannot force merge.");
			// Phase guard: refuse while the engine still owns the batch (executing,
			// merging, or planning). The operator must pause or abort first.
			const lockedPhases: ReadonlySet<string> = new Set(["executing", "merging", "planning"]);
			if (lockedPhases.has(state.phase)) {
				return textResult(
					`Batch is in phase "${state.phase}"; force-merge requires a paused or stopped batch. Call orch_pause or orch_abort first.`,
				);
			}
			const waveIndex = typeof params.waveIndex === "number" ? params.waveIndex : (state.currentWaveIndex ?? 0);
			const merges = state.mergeResults ?? [];
			const merge = merges.find(m => m.waveIndex === waveIndex);
			if (!merge) {
				return textResult(
					`No merge result recorded for wave ${waveIndex} in batch ${state.batchId}. Nothing to force.`,
				);
			}
			if (merge.status !== "partial" && merge.status !== "failed") {
				return textResult(
					`Wave ${waveIndex} merge status is ${merge.status}; only partial/failed merges can be forced.`,
				);
			}
			// Mixed-outcome guard: taskplane only supported forcing when the merge
			// failed due to mixed outcomes (some lanes succeeded, some failed).
			// Other failure modes (git conflict, network error) require manual
			// intervention — force-marking them "succeeded" would hide real damage.
			if (merge.failureReason && !/mixed.?outcome/i.test(merge.failureReason)) {
				return textResult(
					`Wave ${waveIndex} merge failure reason is "${merge.failureReason}"; force-merge only handles mixed-outcome partial merges. ` +
						`Resolve the underlying issue manually before resuming.`,
				);
			}
			// Milestone guard — refuse force-merge while a milestone is still in the
			// validation loop unless it has exhausted its rounds (status === "failed").
			const milestones = state.milestones ?? [];
			const blockingMilestone = milestones.find(
				m => m.status === "validating" && m.validationRounds < m.maxValidationRounds,
			);
			if (blockingMilestone) {
				return textResult(
					`Milestone ${blockingMilestone.id} is still in validation (round ${blockingMilestone.validationRounds}/${blockingMilestone.maxValidationRounds}). ` +
						`Wait for validators to complete, or mark the milestone failed explicitly, before force-merging.`,
				);
			}
			const wavePlan = state.wavePlan ?? [];
			const waveTaskIds = new Set(wavePlan[waveIndex] ?? []);
			let skipped = 0;
			if (params.skipFailed) {
				for (const t of state.tasks) {
					if (!waveTaskIds.has(t.taskId)) continue;
					if (t.status !== "failed") continue;
					t.status = "skipped";
					t.exitReason = "skipped by orch_force_merge";
					t.endedAt = Date.now();
					skipped += 1;
				}
				if (skipped > 0) {
					state.skippedTasks = (state.skippedTasks ?? 0) + skipped;
					if (typeof state.failedTasks === "number") {
						state.failedTasks = Math.max(0, state.failedTasks - skipped);
					}
				}
			}
			merge.status = "succeeded";
			merge.failureReason = null;
			merge.failedLane = null;
			// Transition to paused so orch_resume(force=true) can pick up cleanly.
			// "failed" / "stopped" phases would block the resume until cleared;
			// "paused" is the explicit supervisor-intervention slot.
			state.phase = "paused";
			try {
				await saveBatchState(JSON.stringify(state, null, 2), cwd);
			} catch (err) {
				return textResult(`Failed to persist force merge: ${err instanceof Error ? err.message : String(err)}`);
			}
			const suffix = skipped > 0 ? ` (${skipped} failed task(s) skipped)` : "";
			return textResult(
				`Wave ${waveIndex} merge forced to succeeded${suffix}. Call orch_resume(force=true) to continue.`,
			);
		},
	});

	// ── Milestone & validation contract (Track A) ───────────────
	//
	// Everything below mutates either the validation-contract.json file
	// (a side file owned by orchestrator planning) or the persisted batch
	// state. None of these tools cancel running work — they prepare state
	// for the next scheduling pass, consistent with orch_retry_task /
	// orch_skip_task conventions.

	pi.registerTool({
		name: "orch_write_validation_contract",
		label: "Write Validation Contract",
		description:
			"Write the mission validation contract — a finite checklist of behavioral assertions the mission must satisfy. Replaces any existing contract.",
		parameters: Type.Object({
			assertions: Type.Array(
				Type.Object({
					id: Type.String({ description: "Assertion ID (VA-### format)." }),
					area: Type.String({ description: "Functional area (e.g. 'cli', 'auth')." }),
					title: Type.String({ description: "Short title." }),
					description: Type.String({ description: "Long-form description." }),
					acceptanceCriteria: Type.Array(Type.String(), {
						minItems: 1,
						description: "Concrete acceptance criteria.",
					}),
					milestoneId: Type.Optional(Type.String({ description: "Bind to a specific milestone." })),
					notes: Type.Optional(Type.String()),
				}),
			),
		}),
		async execute(_id, params) {
			const mission = getState();
			const missionId = mission?.batch?.batchId ?? mission?.description ?? "mission";
			const assertions = params.assertions as BehavioralAssertion[];
			for (const a of assertions) {
				const idErr = validateAssertionId(a.id);
				if (idErr) return textResult(`Invalid assertion: ${idErr}`);
			}
			const seen = new Set<string>();
			for (const a of assertions) {
				if (seen.has(a.id)) return textResult(`Duplicate assertion id "${a.id}"`);
				seen.add(a.id);
			}
			const now = Date.now();
			const existing = await loadValidationContract(cwd).catch(() => null);
			const contract = {
				schemaVersion: 1 as const,
				missionId: existing?.missionId ?? missionId,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
				assertions,
			};
			try {
				await saveValidationContract(cwd, contract);
			} catch (err) {
				return textResult(
					`Failed to save validation contract: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return textResult(
				`Validation contract written with ${assertions.length} assertion(s) for mission ${contract.missionId}.`,
			);
		},
	});

	pi.registerTool({
		name: "orch_add_assertion",
		label: "Add Validation Assertion",
		description:
			"Add or replace a single behavioral assertion on the mission's validation contract. Creates the contract when it does not yet exist.",
		parameters: Type.Object({
			id: Type.String({ description: "Assertion ID (VA-### format)." }),
			area: Type.String(),
			title: Type.String(),
			description: Type.String(),
			acceptanceCriteria: Type.Array(Type.String(), { minItems: 1 }),
			milestoneId: Type.Optional(Type.String()),
			notes: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			const mission = getState();
			const missionId = mission?.batch?.batchId ?? mission?.description ?? "mission";
			const assertion: BehavioralAssertion = {
				id: params.id,
				area: params.area,
				title: params.title,
				description: params.description,
				acceptanceCriteria: params.acceptanceCriteria,
			};
			if (params.milestoneId) assertion.milestoneId = params.milestoneId;
			if (params.notes) assertion.notes = params.notes;
			try {
				const next = await handleAddAssertion({ cwd, missionId, assertion });
				return textResult(`Assertion ${assertion.id} recorded (total: ${next.assertions.length}).`);
			} catch (err) {
				return textResult(`Failed to add assertion: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	pi.registerTool({
		name: "orch_create_milestone",
		label: "Create Milestone",
		description:
			"Create a new milestone (or replace an existing one) in the persisted batch state. Milestones group features into validation boundaries.",
		parameters: Type.Object({
			id: Type.String({ description: "Milestone ID (M-### format recommended)." }),
			name: Type.String(),
			featureIds: Type.Optional(Type.Array(Type.String())),
			assertionIds: Type.Optional(Type.Array(Type.String())),
			maxValidationRounds: Type.Optional(Type.Number({ minimum: 1 })),
		}),
		async execute(_id, params) {
			const input: Parameters<typeof handleCreateMilestone>[0] = {
				cwd,
				id: params.id,
				name: params.name,
			};
			if (params.featureIds) input.featureIds = params.featureIds;
			if (params.assertionIds) input.assertionIds = params.assertionIds;
			if (params.maxValidationRounds !== undefined) input.maxValidationRounds = params.maxValidationRounds;
			try {
				const { milestone } = await handleCreateMilestone(input);
				return textResult(
					`Milestone ${milestone.id} (${milestone.name}) — ${milestone.featureIds.length} feature(s), ` +
						`${milestone.assertionIds.length} assertion(s), maxRounds=${milestone.maxValidationRounds}.`,
				);
			} catch (err) {
				return textResult(`Failed to create milestone: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	pi.registerTool({
		name: "orch_read_validation_status",
		label: "Read Validation Status",
		description:
			"Report the status of each milestone plus its validation rounds + bound assertions. Optional `milestoneId` filters to one milestone.",
		parameters: Type.Object({
			milestoneId: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			const state = await loadActiveBatchState(cwd);
			if (!state) return textResult("No persisted batch state found.");
			const milestones = state.milestones ?? [];
			const scope = params.milestoneId ? milestones.filter(m => m.id === params.milestoneId) : milestones;
			if (scope.length === 0) {
				return textResult(
					params.milestoneId
						? `Milestone ${params.milestoneId} not found in batch ${state.batchId}.`
						: `No milestones recorded for batch ${state.batchId}.`,
				);
			}
			const contract = await loadValidationContract(cwd).catch(() => null);
			const lines: string[] = [`Validation status — batch ${state.batchId}`];
			for (const m of scope) {
				lines.push(
					`  ${m.id} (${m.name}): ${m.status} — round ${m.validationRounds}/${m.maxValidationRounds}, ${m.featureIds.length} feature(s), ${m.assertionIds.length} assertion(s)`,
				);
				if (contract) {
					const bound = contract.assertions.filter(a => m.assertionIds.includes(a.id) || a.milestoneId === m.id);
					for (const a of bound) lines.push(`    - ${a.id} [${a.area}]: ${a.title}`);
				}
			}
			return textResult(lines.join("\n"));
		},
	});

	// ── Shared knowledge library (Track F) ─────────────────────

	pi.registerTool({
		name: "orch_read_knowledge",
		label: "Read Knowledge Library",
		description:
			"Read recent entries from the shared knowledge library. Optional `scope` filters to a milestone; optional `limit` caps entries (default 20, newest first).",
		parameters: Type.Object({
			scope: Type.Optional(
				Type.String({ description: "Milestone id, or '(project)' for cross-milestone entries." }),
			),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
		}),
		async execute(_id, params) {
			const limit = typeof params.limit === "number" ? params.limit : 20;
			let summary: string;
			try {
				summary = await summariseKnowledge(cwd, params.scope, limit);
			} catch (err) {
				return textResult(`Failed to read knowledge library: ${err instanceof Error ? err.message : String(err)}`);
			}
			return textResult(summary);
		},
	});

	pi.registerTool({
		name: "orch_write_knowledge_entry",
		label: "Write Knowledge Entry",
		description:
			"Append a knowledge entry to the shared library. Scope is usually a milestone id; use '(project)' for cross-milestone observations.",
		parameters: Type.Object({
			scope: Type.String({ description: "Milestone id, or '(project)' for cross-milestone entries." }),
			body: Type.String({ description: "Single-line observation. Multi-line content is collapsed to one line." }),
			title: Type.Optional(
				Type.String({ description: "Optional section title (rendered after the scope in the heading)." }),
			),
			author: Type.Optional(Type.String({ description: "Author label (default: 'orchestrator')." })),
		}),
		async execute(_id, params) {
			const body = params.body.trim();
			if (!body) return textResult("Empty body — nothing written.");
			const scope = params.scope.trim() || KNOWLEDGE_GLOBAL_SCOPE;
			const entry: KnowledgeEntry = {
				scope,
				timestamp: new Date().toISOString(),
				author: params.author?.trim() || "orchestrator",
				body,
			};
			if (params.title) entry.title = params.title.trim();
			try {
				await appendKnowledgeEntry(cwd, entry);
			} catch (err) {
				return textResult(`Failed to write knowledge entry: ${err instanceof Error ? err.message : String(err)}`);
			}
			return textResult(`Knowledge entry appended under scope "${scope}".`);
		},
	});

	pi.registerTool({
		name: "orch_summarise_knowledge",
		label: "Summarise Knowledge Library",
		description:
			"Report counts + newest entries across the knowledge library. Useful at planning time to surface lessons from prior missions.",
		parameters: Type.Object({
			scope: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			try {
				const entries = await readKnowledgeEntries(cwd);
				if (entries.length === 0) return textResult("Knowledge library is empty.");
				const inScope = params.scope
					? entries.filter(e => e.scope === params.scope || e.scope === KNOWLEDGE_GLOBAL_SCOPE)
					: entries;
				const byScope = new Map<string, number>();
				for (const e of entries) byScope.set(e.scope, (byScope.get(e.scope) ?? 0) + 1);
				const lines: string[] = [
					`Knowledge library — ${entries.length} total entr${entries.length === 1 ? "y" : "ies"} across ${byScope.size} scope(s).`,
				];
				for (const [scope, count] of [...byScope.entries()].sort((a, b) => b[1] - a[1])) {
					lines.push(`  ${scope}: ${count}`);
				}
				lines.push("");
				lines.push(await summariseKnowledge(cwd, params.scope, 10));
				return textResult(
					lines.join("\n").replace(/^/, "").replace(/\n$/, "") +
						(inScope.length === 0 ? "\n(no entries in requested scope)" : ""),
				);
			} catch (err) {
				return textResult(`Failed to summarise knowledge: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// ── Per-role model specialization (Track G) ─────────────

	pi.registerTool({
		name: "orch_set_role_model",
		label: "Set Role Model",
		description:
			"Override the model used by a Factory role (orchestrator | worker | scrutiny_validator | user_testing_validator). Empty string clears the override so the fallback chain resumes.",
		parameters: Type.Object({
			role: Type.String({
				description: "Role id: orchestrator | worker | scrutiny_validator | user_testing_validator",
			}),
			model: Type.String({
				description: "Model identifier (e.g. 'claude-sonnet-4-5'). Empty string clears the override.",
			}),
		}),
		async execute(_id, params) {
			if (!isMissionRole(params.role)) {
				return textResult(
					`Invalid role "${params.role}". Expected one of: orchestrator, worker, scrutiny_validator, user_testing_validator.`,
				);
			}
			const role: MissionRole = params.role;
			try {
				const updated = persistRoleModelOverride(cwd, role, params.model ?? "");
				const bound = updated[role];
				return textResult(
					bound
						? `Role "${role}" now bound to model "${bound}". Takes effect on the next spawn of this role.`
						: `Role "${role}" override cleared. The fallback chain will pick the next non-empty layer on the next spawn.`,
				);
			} catch (err) {
				return textResult(`Failed to persist role model: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// ── Skill-aware execution (Track E) ────────────────────

	pi.registerTool({
		name: "orch_list_skills",
		label: "List Skills",
		description:
			"List every project-local skill (promoted + drafts). Optional `includeDrafts: false` excludes in-progress drafts.",
		parameters: Type.Object({
			includeDrafts: Type.Optional(Type.Boolean({ description: "Include drafts. Default: true." })),
		}),
		async execute(_id, params) {
			const includeDrafts = params.includeDrafts !== false;
			try {
				const skills = await listAvailableSkills(cwd);
				const filtered = includeDrafts ? skills : skills.filter(s => s.origin === "promoted");
				if (filtered.length === 0) return textResult("No project-local skills found.");
				const lines: string[] = [`Project skills (${filtered.length}):`];
				for (const s of filtered) {
					const versionTag = s.version ? ` v${s.version}` : "";
					const originTag = s.origin === "draft" ? " [draft]" : "";
					lines.push(`  - ${s.name}${versionTag}${originTag} — ${s.description || "(no description)"}`);
				}
				return textResult(lines.join("\n"));
			} catch (err) {
				return textResult(`Failed to list skills: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	pi.registerTool({
		name: "orch_plan_skill_draft",
		label: "Plan Skill Draft",
		description:
			"Create a new skill draft under `.omp/skills/drafts/<name>/`. The draft is picked up by subsequent workers and reviewed by the scrutiny validator before promotion.",
		parameters: Type.Object({
			name: Type.String({ description: "Draft name (lowercase alphanumeric + hyphen)." }),
			description: Type.String({ description: "One-paragraph description." }),
			version: Type.Optional(Type.String()),
			tools: Type.Optional(
				Type.String({ description: "Comma-separated tool allow-list for workers loading this skill." }),
			),
			tags: Type.Optional(Type.Array(Type.String())),
			body: Type.Optional(Type.String({ description: "Optional long-form body for SKILL.md." })),
		}),
		async execute(_id, params) {
			try {
				const entry: SkillEntry = await createSkillDraft({
					cwd,
					name: params.name,
					description: params.description,
					version: params.version,
					tools: params.tools,
					tags: params.tags,
					body: params.body,
				});
				return textResult(
					`Skill draft "${entry.name}" created at ${entry.folderPath}. Run \`orch_promote_skill_draft\` after review to publish.`,
				);
			} catch (err) {
				return textResult(`Failed to create skill draft: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	pi.registerTool({
		name: "orch_promote_skill_draft",
		label: "Promote Skill Draft",
		description:
			"Promote a draft under `.omp/skills/drafts/<name>/` to a regular project-local skill. Fails if a promoted skill with the same name already exists.",
		parameters: Type.Object({
			name: Type.String(),
		}),
		async execute(_id, params) {
			try {
				const entry = await promoteSkillDraft(cwd, params.name);
				return textResult(`Skill "${entry.name}" promoted to ${entry.folderPath}.`);
			} catch (err) {
				return textResult(`Failed to promote skill: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	pi.registerTool({
		name: "orch_discard_skill_draft",
		label: "Discard Skill Draft",
		description: "Delete an in-progress draft under `.omp/skills/drafts/<name>/`. Missing drafts are a no-op.",
		parameters: Type.Object({
			name: Type.String(),
		}),
		async execute(_id, params) {
			try {
				const removed = await discardSkillDraft(cwd, params.name);
				return textResult(
					removed ? `Draft "${params.name}" discarded.` : `No draft named "${params.name}" — nothing to discard.`,
				);
			} catch (err) {
				return textResult(`Failed to discard draft: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// ── Mission checkpoint (Track H5) ──────────────────────

	pi.registerTool({
		name: "orch_write_checkpoint",
		label: "Write Mission Checkpoint",
		description:
			"Flush a human-readable checkpoint summary to `.omp/checkpoints/<batchId>-<timestamp>.md`. Useful for multi-day missions during operator handoff.",
		parameters: Type.Object({
			note: Type.Optional(Type.String({ description: "Free-form operator note appended to the checkpoint." })),
		}),
		async execute(_id, params) {
			const state = await loadActiveBatchState(cwd);
			if (!state) return textResult("No persisted batch state found — cannot write checkpoint.");
			const contract = await loadValidationContract(cwd).catch(() => null);
			try {
				const filePath = await writeMissionCheckpoint(cwd, {
					state,
					contract: contract ?? undefined,
					note: params.note,
				});
				return textResult(`Checkpoint written: ${filePath}`);
			} catch (err) {
				return textResult(`Failed to write checkpoint: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// ── Planning conversation (Track D) ───────────────────

	pi.registerTool({
		name: "orch_draft_feature",
		label: "Draft Feature",
		description:
			"Scaffold a feature task folder + PROMPT.md with Factory metadata (milestone, fulfills, size). Used during planning to record the agreed feature list. Refuses to overwrite existing PROMPT.md.",
		parameters: Type.Object({
			featureId: Type.String({ description: "Feature id (XX-NNN format)." }),
			title: Type.String(),
			milestoneId: Type.String(),
			fulfillsAssertionIds: Type.Array(Type.String()),
			size: Type.Optional(
				Type.Union([Type.Literal("S"), Type.Literal("M"), Type.Literal("L")], {
					description: "Size band (default M).",
				}),
			),
			description: Type.String(),
			fileScope: Type.Optional(Type.Array(Type.String())),
			dependencies: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params) {
			try {
				const result = await draftFeature({
					cwd,
					featureId: params.featureId,
					title: params.title,
					milestoneId: params.milestoneId,
					fulfillsAssertionIds: params.fulfillsAssertionIds,
					size: params.size,
					description: params.description,
					fileScope: params.fileScope,
					dependencies: params.dependencies,
				});
				return textResult(
					`Feature ${result.featureId} drafted at ${result.folderPath}. PROMPT.md has Milestone=${params.milestoneId}, Fulfills=[${params.fulfillsAssertionIds.join(", ")}].`,
				);
			} catch (err) {
				return textResult(`Failed to draft feature: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	pi.registerTool({
		name: "orch_request_clarification",
		label: "Request Clarification",
		description:
			"Record a clarification question for the operator. Appends to `.omp/missions/planning/clarifications.md`. The operator answers directly in the file; subsequent calls can read the answer via `orch_read_clarifications`.",
		parameters: Type.Object({
			question: Type.String(),
			context: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			try {
				const id = await recordClarification(cwd, params.question, { context: params.context });
				return textResult(`Clarification ${id} recorded. Operator answers directly in clarifications.md.`);
			} catch (err) {
				return textResult(`Failed to record clarification: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	pi.registerTool({
		name: "orch_read_clarifications",
		label: "Read Clarifications",
		description:
			"List every clarification recorded in `.omp/missions/planning/clarifications.md`, with any operator-provided answers. Returns a plain-text rendering ordered by CLR-id.",
		parameters: Type.Object({}),
		async execute() {
			try {
				const entries = await listClarifications(cwd);
				if (entries.length === 0) return textResult("No clarifications recorded yet.");
				const lines: string[] = [`${entries.length} clarification(s):`, ""];
				for (const entry of entries) {
					lines.push(`- ${entry.id} (${entry.timestamp})`);
					lines.push(`  Q: ${entry.question}`);
					if (entry.context) lines.push(`  Context: ${entry.context}`);
					if (entry.answer) {
						lines.push(`  A: ${entry.answer}${entry.answeredAt ? ` (${entry.answeredAt})` : ""}`);
					} else {
						lines.push("  A: (pending operator response)");
					}
				}
				return textResult(lines.join("\n"));
			} catch (err) {
				return textResult(`Failed to read clarifications: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	pi.registerTool({
		name: "orch_finalize_plan",
		label: "Finalize Plan",
		description:
			"Write the planning manifest that promotes the plan from draft to `awaiting-approval` (or `approved` when `approvedBy` is supplied). Batch execution only begins once the manifest reports `approved`.",
		parameters: Type.Object({
			missionId: Type.Optional(
				Type.String({ description: "Mission id. Defaults to the active batch id when omitted." }),
			),
			milestoneIds: Type.Array(Type.String(), { minItems: 1 }),
			featureIds: Type.Array(Type.String(), { minItems: 1 }),
			status: Type.Optional(
				Type.Union([Type.Literal("draft"), Type.Literal("awaiting-approval"), Type.Literal("approved")], {
					description: "Target status. Default: awaiting-approval.",
				}),
			),
			approvedBy: Type.Optional(
				Type.String({ description: "Operator label when transitioning straight to approved." }),
			),
		}),
		async execute(_id, params) {
			const state = getState();
			const missionId = params.missionId?.trim() || state?.batch?.batchId || state?.description || "mission";
			try {
				const manifest = await finalizePlan({
					cwd,
					missionId,
					milestoneIds: params.milestoneIds,
					featureIds: params.featureIds,
					status: params.status,
					approvedBy: params.approvedBy,
				});
				return textResult(
					`Plan finalized: mission ${manifest.missionId} (${manifest.milestoneIds.length} milestones, ${manifest.featureIds.length} features) → ${manifest.status}` +
						(manifest.status === "approved" ? `, approved by ${manifest.approvedBy}.` : "."),
				);
			} catch (err) {
				return textResult(`Failed to finalize plan: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}
