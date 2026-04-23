/**
 * Worker-side agent bridge — tools workers use to talk back to the
 * supervisor and the engine without hand-rolling JSON via bash/write.
 *
 * Ported from `taskplane/extensions/taskplane/agent-bridge-extension.ts`.
 * Key divergences from the source:
 *
 *   - Env var prefix: `TASKPLANE_*` → `MISSION_*`.
 *   - Outbox writer: reuses the mailbox module's `atomicWriteJsonFile`
 *     instead of hand-rolling the tmp+rename dance, so worker outbox
 *     writes share the same durability guarantees as supervisor inbox
 *     writes.
 *   - `review_step` is not ported — pi-missions uses a dedicated
 *     persistent reviewer (`./missioncontrol/reviewer.ts`) with a
 *     signal-dir protocol, and the round 6 plan scoped this module to
 *     the three structured worker→supervisor tools only.
 *
 * Self-gates on `MISSION_AGENT_ID` + `MISSION_OUTBOX_DIR`. When either
 * is missing the function is a no-op — safe to call from the main
 * extension entry point without affecting non-worker sessions.
 *
 * Registered tools:
 *   1. `notify_supervisor(content, replyTo?)` — write a `reply`
 *      message to the worker outbox. Acknowledgments + status pings.
 *   2. `escalate_to_supervisor(content)` — write an `escalate` message
 *      (`expectsReply: true`). Blockers + ambiguities.
 *   3. `request_segment_expansion(requestedRepoIds, rationale, ...)` —
 *      write a `segment-expansion-<requestId>.json` request file the
 *      lane-runner polls on segment boundaries. Only registered when
 *      `MISSION_ACTIVE_SEGMENT_ID` is set (segment-scoped workers).
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { atomicWriteJsonFile } from "./missioncontrol/mailbox";
import type { SegmentExpansionRequest, SegmentId } from "./missioncontrol/types";
import { buildExpansionRequestId } from "./missioncontrol/types";

/** Max content size for notify/escalate messages. Matches the mailbox inbox limit. */
const OUTBOX_CONTENT_MAX_BYTES = 4096;

/** Repo IDs must be lowercase alphanumeric with `._-` separators (no leading separator). */
const REPO_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Supervisor autonomy levels the lane-runner may assign to a worker. */
const AUTONOMY_PATTERN = /^(interactive|supervised|autonomous)$/;

type Autonomy = "interactive" | "supervised" | "autonomous";

/** Generate a mailbox-style message id: `<ms>-<5 hex>`. */
function newMessageId(): string {
	const timestamp = Date.now();
	const nonce = randomBytes(3).toString("hex").slice(0, 5);
	return `${timestamp}-${nonce}`;
}

/**
 * Write a worker→supervisor outbox message. The outbox dir is set by
 * the lane-runner via `MISSION_OUTBOX_DIR`; the message lands as
 * `<outbox>/<id>.msg.json` where the lane-runner's poller picks it up.
 */
function writeOutbox(
	outboxDir: string,
	batchId: string,
	agentId: string,
	type: "reply" | "escalate",
	content: string,
	replyTo: string | undefined,
): { id: string } {
	const contentBytes = Buffer.byteLength(content, "utf8");
	if (contentBytes > OUTBOX_CONTENT_MAX_BYTES) {
		throw new Error(
			`Outbox message exceeds ${OUTBOX_CONTENT_MAX_BYTES} byte limit (got ${contentBytes} bytes). ` +
				"Keep content concise; write larger context to a file and reference it by path.",
		);
	}

	const id = newMessageId();
	const message = {
		id,
		batchId,
		from: agentId,
		to: "supervisor",
		timestamp: Date.now(),
		type,
		content,
		expectsReply: type === "escalate",
		replyTo: replyTo ?? null,
	};

	atomicWriteJsonFile(join(outboxDir, `${id}.msg.json`), message);
	return { id };
}

/** Resolve the active segment id from env, handling placeholder strings. */
function resolveActiveSegmentId(): string | null {
	const raw = (process.env.MISSION_ACTIVE_SEGMENT_ID || process.env.MISSION_SEGMENT_ID || "").trim();
	if (!raw || raw === "null" || raw === "(none / whole-task execution)") return null;
	return raw;
}

/**
 * Derive the owning task id. Prefers the explicit `MISSION_TASK_ID`
 * env; falls back to parsing the segment id (`<taskId>::<repo>`) and
 * finally the task folder name (`TP-003` style).
 */
function resolveTaskId(fromSegmentId: string): string {
	const envTaskId = process.env.MISSION_TASK_ID?.trim();
	if (envTaskId) return envTaskId;
	const idx = fromSegmentId.indexOf("::");
	if (idx > 0) return fromSegmentId.slice(0, idx);
	const folder = process.env.MISSION_TASK_FOLDER || "";
	const name = folder.split(/[\\/]/).filter(Boolean).at(-1) || "";
	const match = name.match(/^[A-Z]+-\d+/);
	return match ? match[0] : "unknown";
}

function resolveSupervisorAutonomy(): Autonomy {
	const value = (process.env.MISSION_SUPERVISOR_AUTONOMY || "autonomous").trim().toLowerCase();
	if (AUTONOMY_PATTERN.test(value)) {
		return value as Autonomy;
	}
	return "autonomous";
}

/**
 * Register the worker-side tools. No-op unless the process was spawned
 * by the lane-runner (identified by `MISSION_AGENT_ID` +
 * `MISSION_OUTBOX_DIR` being set in the environment).
 */
export function registerAgentBridge(pi: ExtensionAPI): void {
	const agentId = process.env.MISSION_AGENT_ID;
	const outboxDir = process.env.MISSION_OUTBOX_DIR;
	if (!agentId || !outboxDir) return;
	const batchId = process.env.ORCH_BATCH_ID || "unknown";

	pi.registerTool({
		name: "notify_supervisor",
		label: "Notify Supervisor",
		description:
			"Send a reply or acknowledgment to the supervisor. " +
			"Use this to confirm you've received a steering message, report a status update, or share a discovery.",
		parameters: Type.Object({
			content: Type.String({ description: "Reply content (max 4KB)" }),
			replyTo: Type.Optional(Type.String({ description: "Message ID being replied to (from a steering message)" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = writeOutbox(outboxDir, batchId, agentId, "reply", params.content, params.replyTo);
				return {
					content: [
						{
							type: "text" as const,
							text: `Reply sent to supervisor (ID: ${result.id})`,
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to send reply: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
				};
			}
		},
	});

	pi.registerTool({
		name: "escalate_to_supervisor",
		label: "Escalate to Supervisor",
		description:
			"Escalate a blocker, ambiguity, or question to the supervisor. " +
			"Use this when you're stuck, confused, or need guidance before proceeding.",
		parameters: Type.Object({
			content: Type.String({ description: "Description of the blocker or question (max 4KB)" }),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = writeOutbox(outboxDir, batchId, agentId, "escalate", params.content, undefined);
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Escalation sent to supervisor (ID: ${result.id}). ` +
								"Continue working on other items while waiting for guidance.",
						},
					],
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to escalate: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
				};
			}
		},
	});

	const activeSegmentId = resolveActiveSegmentId();
	if (!activeSegmentId) return;

	pi.registerTool({
		name: "request_segment_expansion",
		label: "Request Segment Expansion",
		description:
			"Request additional repository segments for the current task at runtime. " +
			"Writes a request file to the worker outbox for engine processing.",
		parameters: Type.Object({
			requestedRepoIds: Type.Array(Type.String({ description: "Repo ID to add" }), {
				description: "Repo IDs to add as new segments",
			}),
			rationale: Type.String({ description: "Why these repos are needed" }),
			placement: Type.Optional(
				Type.Union([Type.Literal("after-current"), Type.Literal("end")], {
					description: "Where to place new segments: after-current (default) or end",
				}),
			),
			edges: Type.Optional(
				Type.Array(
					Type.Object({
						from: Type.String({ description: "Source repo ID" }),
						to: Type.String({ description: "Destination repo ID" }),
					}),
					{ description: "Optional ordering edges between requested repos" },
				),
			),
		}),
		async execute(_toolCallId, params) {
			const autonomy = resolveSupervisorAutonomy();
			if (autonomy !== "autonomous") {
				const rejected = {
					accepted: false,
					requestId: null,
					message: "Segment expansion requires autonomous supervisor mode",
				};
				return {
					content: [{ type: "text" as const, text: JSON.stringify(rejected) }],
				};
			}

			const requestedRepoIds = Array.isArray(params.requestedRepoIds)
				? params.requestedRepoIds.map(id => String(id).trim()).filter(Boolean)
				: [];
			const rejections: Array<{ repoId: string; reason: string }> = [];

			if (requestedRepoIds.length === 0) {
				rejections.push({ repoId: "", reason: "requestedRepoIds must be a non-empty array" });
			} else {
				const seen = new Set<string>();
				for (const repoId of requestedRepoIds) {
					if (!REPO_ID_PATTERN.test(repoId)) {
						rejections.push({ repoId, reason: "invalid repo ID format" });
						continue;
					}
					if (seen.has(repoId)) {
						rejections.push({ repoId, reason: "duplicate repo ID in request" });
						continue;
					}
					seen.add(repoId);
				}
			}

			if (rejections.length > 0) {
				const rejected = {
					accepted: false,
					requestId: null,
					message: "Segment expansion request rejected by tool validation",
					rejections,
				};
				return {
					content: [{ type: "text" as const, text: JSON.stringify(rejected) }],
				};
			}

			const requestId = buildExpansionRequestId();
			const request: SegmentExpansionRequest = {
				requestId,
				taskId: resolveTaskId(activeSegmentId),
				fromSegmentId: activeSegmentId as SegmentId,
				requestedRepoIds,
				rationale: String(params.rationale ?? "").trim(),
				placement: params.placement === "end" ? "end" : "after-current",
				edges: Array.isArray(params.edges)
					? params.edges
							.filter((edge): edge is { from: string; to: string } =>
								Boolean(edge && typeof edge.from === "string" && typeof edge.to === "string"),
							)
							.map(edge => ({ from: edge.from.trim(), to: edge.to.trim() }))
							.filter(edge => edge.from.length > 0 && edge.to.length > 0)
					: [],
				timestamp: Date.now(),
			};

			try {
				atomicWriteJsonFile(join(outboxDir, `segment-expansion-${requestId}.json`), request);
				const accepted = {
					accepted: true,
					requestId,
					message: "Segment expansion request accepted",
				};
				return {
					content: [{ type: "text" as const, text: JSON.stringify(accepted) }],
				};
			} catch (err) {
				const failed = {
					accepted: false,
					requestId: null,
					message: err instanceof Error ? err.message : String(err),
				};
				return {
					content: [{ type: "text" as const, text: JSON.stringify(failed) }],
				};
			}
		},
	});
}
