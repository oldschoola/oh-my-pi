/**
 * MissionControl agent host — Runtime V2 thin wrapper over the oh-my-pi
 * RPC coding agent.
 *
 * Ported from `taskplane/extensions/taskplane/agent-host.ts` (745 LOC).
 * The oh-my-pi `RpcClient` already owns stdout parsing, event streaming,
 * stderr capture, and process lifetime, so this port is dramatically
 * smaller than taskplane's — we subscribe to `RpcClient.onEvent` and
 * translate each `AgentEvent` into the canonical `RuntimeAgentEvent`
 * that the rest of the engine consumes.
 *
 * Feature parity with taskplane (kept):
 *   - Runtime V2 manifest + registry integration (spawning → running → terminal).
 *   - Normalized `RuntimeAgentEvent` emission with JSONL persistence.
 *   - Token/cost/tool-call telemetry from `message_end` events.
 *   - Exit summary JSON write on terminate.
 *   - Timeout with SIGTERM kill.
 *   - `AgentHostResult` surface compatible with taskplane callers.
 *
 * Deferred (lands with the full mailbox + re-prompt port):
 *   - Mailbox steering injection (`_broadcast` inbox, ack files).
 *   - Exit interception / re-prompt loop (TP-172).
 *   - `get_session_stats` polling cadence.
 *
 * Stub mode: set `OMP_MISSION_STUB_AGENT=1` to short-circuit to a no-op
 * handle that resolves immediately with zeroed telemetry. Used by tests.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { logger, type SpawnAgentHandle, spawnAgent as spawnAdapterAgent } from "./adapter";
import {
	buildRegistrySnapshot,
	createManifest,
	updateManifestStatus,
	writeManifest,
	writeRegistrySnapshot,
} from "./process-registry";
import type {
	PacketPaths,
	RuntimeAgentEvent,
	RuntimeAgentEventType,
	RuntimeAgentId,
	RuntimeAgentRole,
	RuntimeAgentStatus,
} from "./types";

// ── Options / Result shapes ──────────────────────────────────────────

/** Options for spawning an agent via the direct host. */
export interface AgentHostOptions {
	/** Stable agent identity. */
	agentId: RuntimeAgentId;
	/** Agent role. */
	role: RuntimeAgentRole;
	/** Batch ID this agent belongs to. */
	batchId: string;
	/** Lane number (null for merge agents). */
	laneNumber: number | null;
	/** Task ID being executed (null before first assignment). */
	taskId: string | null;
	/** Repo ID the agent is operating in. */
	repoId: string;
	/** Working directory for the agent process. */
	cwd: string;
	/** User prompt content. */
	prompt: string;
	/** Optional model override (e.g. `anthropic/claude-sonnet-4-5`). */
	model?: string;
	/** Optional session directory for the child agent. */
	sessionDir?: string;
	/** Path to persist normalized events as JSONL. */
	eventsPath?: string | null;
	/** Path to write the exit summary JSON. */
	exitSummaryPath?: string | null;
	/** Timeout in milliseconds (0 = no timeout). */
	timeoutMs?: number;
	/** State root for process-registry integration (null = skip registry). */
	stateRoot?: string | null;
	/** Packet paths for the registry manifest (null for merge agents). */
	packet?: PacketPaths | null;
	/** Extra environment variables for the child process. */
	env?: Record<string, string>;
	/** Additional CLI args passed through to the coding-agent RPC process. */
	extraArgs?: string[];
	/** System prompt composed from the role's agent definition (+ segment overlay). */
	systemPrompt?: string;
	/** Tool allow-list passed through to the worker (comma-separated). */
	tools?: string;
	/** Thinking mode passthrough (provider-specific). */
	thinking?: string;
	/** Mailbox directory root for the agent (inbox/outbox/ack subdirs). */
	mailboxDir?: string;
	/** Path where pending steering messages accumulate (cleared each iteration). */
	steeringPendingPath?: string;
	/** Extension file paths loaded by the RPC coding-agent (bridge wiring). */
	extensions?: string[];
	/**
	 * Premature-exit intercept callback (TP-172). Invoked when the worker exits
	 * without visible progress; may return a new prompt to re-spawn with, or
	 * `null` to let the session close.
	 */
	onPrematureExit?: (assistantMessage: string) => Promise<string | null>;
}

/** Accumulated telemetry from a completed agent session. */
export interface AgentHostResult {
	/** Process exit code (null if killed before producing one). */
	exitCode: number | null;
	/** Signal that killed the process (null if exited normally). */
	signal: string | null;
	/** Wall-clock duration in milliseconds. */
	durationMs: number;
	/** Whether the process was killed by the caller. */
	killed: boolean;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Cumulative cost in USD. */
	costUsd: number;
	/** Number of tool calls. */
	toolCalls: number;
	/** Last tool call name / description. */
	lastTool: string;
	/** Authoritative context usage reported by the agent (null = none seen). */
	contextUsage: { tokens: number; contextWindow: number; percent: number } | null;
	/** Final error message (null if clean exit). */
	error: string | null;
	/** Whether `agent_end` was received. */
	agentEnded: boolean;
}

/** Callback for normalized agent events. */
export type AgentEventCallback = (event: RuntimeAgentEvent) => void;

/** Callback for telemetry updates (fired on each telemetry-affecting event). */
export type AgentTelemetryCallback = (result: Partial<AgentHostResult>) => void;

// ── Internal helpers ─────────────────────────────────────────────────

const MAX_CONV_PAYLOAD_CHARS = 2000;

function truncatePayload(text: string, maxLen: number): string {
	return text.length <= maxLen ? text : `${text.slice(0, maxLen)}…`;
}

interface MessageWithContent {
	role?: unknown;
	content?: unknown;
	usage?: Record<string, unknown>;
}

function extractAssistantText(message: MessageWithContent | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		const textBlocks = message.content
			.filter(
				(b): b is { type: string; text: string } =>
					typeof b === "object" &&
					b !== null &&
					(b as { type?: unknown }).type === "text" &&
					typeof (b as { text?: unknown }).text === "string",
			)
			.map(b => b.text);
		if (textBlocks.length > 0) return textBlocks.join("\n");
	}
	return "";
}

// ── Core spawn function ──────────────────────────────────────────────

/**
 * Spawn and manage an RPC coding-agent as a direct child process.
 *
 * Returns a promise that resolves with the full session result when the
 * agent exits, plus a `kill()` function for early termination.
 *
 * This is the Runtime V2 *hosted* spawn — it writes a manifest, normalizes
 * events, and produces an exit summary. For a raw RPC spawn without any
 * registry/event plumbing, use `spawnAgent` from `./adapter`.
 */
export function spawnHostedAgent(
	opts: AgentHostOptions,
	onEvent?: AgentEventCallback,
	onTelemetry?: AgentTelemetryCallback,
): { promise: Promise<AgentHostResult>; kill: () => void } {
	const startedAt = Date.now();
	let killed = false;
	let timedOut = false;
	let agentEnded = false;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let costUsd = 0;
	let toolCalls = 0;
	let lastTool = "";
	const contextUsage: AgentHostResult["contextUsage"] = null;
	let error: string | null = null;

	function emitEvent(type: RuntimeAgentEventType, payload: Record<string, unknown> = {}): void {
		const event: RuntimeAgentEvent = {
			batchId: opts.batchId,
			agentId: opts.agentId,
			role: opts.role,
			laneNumber: opts.laneNumber,
			taskId: opts.taskId,
			repoId: opts.repoId,
			ts: Date.now(),
			type,
			payload,
		};
		if (onEvent) onEvent(event);
		if (opts.eventsPath) {
			try {
				mkdirSync(dirname(opts.eventsPath), { recursive: true });
				appendFileSync(opts.eventsPath, `${JSON.stringify(event)}\n`, "utf-8");
			} catch {
				// best-effort
			}
		}
	}

	const REGISTRY_REFRESH_INTERVAL_MS = 1_000;
	let lastRegistryRefreshAt = 0;
	function refreshRegistrySnapshot(force = false): void {
		if (!opts.stateRoot) return;
		const now = Date.now();
		if (!force && now - lastRegistryRefreshAt < REGISTRY_REFRESH_INTERVAL_MS) return;
		try {
			const snapshot = buildRegistrySnapshot(opts.stateRoot, opts.batchId);
			writeRegistrySnapshot(opts.stateRoot, snapshot);
			lastRegistryRefreshAt = now;
		} catch {
			// best-effort
		}
	}

	// Registry: write manifest before the agent is considered visible.
	if (opts.stateRoot) {
		const manifest = createManifest({
			batchId: opts.batchId,
			agentId: opts.agentId,
			role: opts.role,
			laneNumber: opts.laneNumber,
			taskId: opts.taskId,
			repoId: opts.repoId,
			// RpcClient owns the child process lifetime; without a dedicated
			// pid channel we use the parent's pid as a placeholder so the
			// manifest passes validation (pid > 0). Downstream orphan
			// detection treats equal pid/parentPid as "hosted in-proc".
			pid: process.pid,
			parentPid: process.pid,
			cwd: opts.cwd,
			packet: opts.packet ?? null,
		});
		manifest.status = "running";
		writeManifest(opts.stateRoot, manifest);
		refreshRegistrySnapshot(true);
	}

	emitEvent("agent_started", { cwd: opts.cwd, model: opts.model ?? null });

	let handle: SpawnAgentHandle | null = null;
	let timeoutHandle: NodeJS.Timeout | null = null;

	function pushTelemetry(): void {
		if (!onTelemetry) return;
		onTelemetry({
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			costUsd,
			toolCalls,
			lastTool,
			contextUsage,
		});
	}

	function onAgentEvent(raw: unknown): void {
		const evt = raw as {
			type: string;
			message?: MessageWithContent;
			toolName?: string;
			args?: unknown;
			isError?: boolean;
		};
		switch (evt.type) {
			case "agent_start":
				// Already emitted agent_started above; swallow to avoid dup.
				break;
			case "agent_end":
				agentEnded = true;
				break;
			case "message_end": {
				const msg = evt.message;
				const usage = msg?.usage as Record<string, number | { total?: number }> | undefined;
				if (usage) {
					inputTokens += (usage.input as number) || 0;
					outputTokens += (usage.output as number) || 0;
					cacheReadTokens += (usage.cacheRead as number) || 0;
					cacheWriteTokens += (usage.cacheWrite as number) || 0;
					const cost = usage.cost;
					if (typeof cost === "number") {
						costUsd += cost;
					} else if (cost && typeof cost === "object" && typeof cost.total === "number") {
						costUsd += cost.total;
					}
				}
				if (msg?.role === "assistant") {
					const text = extractAssistantText(msg);
					if (text) {
						emitEvent("assistant_message", { text: truncatePayload(text, MAX_CONV_PAYLOAD_CHARS) });
					}
				}
				pushTelemetry();
				break;
			}
			case "tool_execution_start": {
				toolCalls += 1;
				const toolName = evt.toolName ?? "";
				if (toolName) lastTool = toolName;
				emitEvent("tool_call", { toolName, args: evt.args });
				pushTelemetry();
				break;
			}
			case "tool_execution_end": {
				const toolName = evt.toolName ?? "";
				const isError = Boolean(evt.isError);
				emitEvent("tool_result", { toolName, isError });
				break;
			}
			default:
				// Other events (turn_start / turn_end / message_start / message_update)
				// are not promoted to RuntimeAgentEvent — they’re redundant with
				// message_end + tool_execution_* for downstream consumers.
				break;
		}
	}

	const promise = (async (): Promise<AgentHostResult> => {
		try {
			handle = await spawnAdapterAgent({
				cwd: opts.cwd,
				modelId: opts.model ?? "",
				prompt: opts.prompt,
				sessionDir: opts.sessionDir,
				env: opts.env,
				extraArgs: opts.extraArgs,
				onEvent: onAgentEvent,
			});
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			logger.error("[missioncontrol] agent-host spawn failed", { agentId: opts.agentId, error });
		}

		if (handle && opts.timeoutMs && opts.timeoutMs > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				killed = true;
				handle?.stop().catch(() => {});
			}, opts.timeoutMs);
		}

		if (handle) {
			try {
				await handle.done;
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}
		}

		if (timeoutHandle) clearTimeout(timeoutHandle);

		const durationMs = Date.now() - startedAt;
		const exitCode = killed ? null : agentEnded ? 0 : null;
		const signal = killed ? "SIGTERM" : null;

		const result: AgentHostResult = {
			exitCode,
			signal,
			durationMs,
			killed,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			costUsd,
			toolCalls,
			lastTool,
			contextUsage,
			error,
			agentEnded,
		};

		if (opts.exitSummaryPath) {
			try {
				mkdirSync(dirname(opts.exitSummaryPath), { recursive: true });
				const summary = {
					exitCode,
					exitSignal: signal,
					tokens:
						inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens > 0
							? {
									input: inputTokens,
									output: outputTokens,
									cacheRead: cacheReadTokens,
									cacheWrite: cacheWriteTokens,
								}
							: null,
					cost: costUsd > 0 ? costUsd : null,
					toolCalls,
					durationSec: Math.round(durationMs / 1000),
					lastToolCall: lastTool || null,
					error: error ?? null,
					contextUsage,
				};
				writeFileSync(opts.exitSummaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
			} catch {
				// best-effort
			}
		}

		const exitEventType: RuntimeAgentEventType = timedOut
			? "agent_timeout"
			: killed
				? "agent_killed"
				: agentEnded
					? "agent_exited"
					: "agent_crashed";
		emitEvent(exitEventType, { exitCode, signal, durationMs, timedOut });

		if (opts.stateRoot) {
			const terminalStatus: RuntimeAgentStatus = timedOut
				? "timed_out"
				: killed
					? "killed"
					: agentEnded
						? "exited"
						: "crashed";
			updateManifestStatus(opts.stateRoot, opts.batchId, opts.agentId, terminalStatus);
			refreshRegistrySnapshot(true);
		}

		return result;
	})();

	function kill(): void {
		killed = true;
		handle?.stop().catch(() => {});
	}

	return { promise, kill };
}
