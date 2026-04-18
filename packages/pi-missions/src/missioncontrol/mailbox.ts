/**
 * Agent Mailbox — file-based cross-agent messaging utilities.
 *
 * Ported from taskplane `extensions/taskplane/mailbox.ts` (690 LOC).
 * Path change: `.pi/mailbox/{batchId}` → `.omp/mailbox/{batchId}` (all paths
 * are resolved via `projectDir(stateRoot)` from the adapter shim).
 *
 * Directory layout:
 *   .omp/mailbox/{batchId}/
 *   ├── {sessionName}/
 *   │   ├── inbox/           ← pending messages (supervisor → agent)
 *   │   ├── ack/             ← processed messages
 *   │   └── outbox/          ← pending agent → supervisor messages
 *   │       └── processed/   ← acked outbox messages
 *   ├── _broadcast/
 *   │   └── inbox/           ← messages to all agents
 *   └── events.jsonl         ← audit trail
 *
 * All file operations are synchronous (matching rpc-wrapper pattern).
 * Writes are atomic (temp file + rename in the same directory).
 * Reads and acks are best-effort (log warnings, never crash).
 */

import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { projectDir } from "./adapter";

// ── Types ────────────────────────────────────────────────────────────

/** Mailbox directory name under `.omp/`. */
export const MAILBOX_DIR_NAME = "mailbox";

/** Maximum content size in UTF-8 bytes. */
export const MAILBOX_MAX_CONTENT_BYTES = 4096;

/**
 * Mailbox message types.
 *
 * | Type       | Direction           | Purpose                                   |
 * |------------|---------------------|-------------------------------------------|
 * | `steer`    | supervisor → agent  | Course correction. Agent must follow.      |
 * | `query`    | supervisor → agent  | Request for status/info. Agent replies.    |
 * | `abort`    | supervisor → agent  | Graceful stop. Agent wraps up and exits.   |
 * | `info`     | supervisor → agent  | FYI context. No action required.           |
 * | `reply`    | agent → supervisor  | Response to query or steer acknowledgment. |
 * | `escalate` | agent → supervisor  | Agent-initiated: blocked or needs help.    |
 */
export type MailboxMessageType = "steer" | "query" | "abort" | "info" | "reply" | "escalate";

export const MAILBOX_MESSAGE_TYPES: ReadonlySet<string> = new Set<MailboxMessageType>([
	"steer",
	"query",
	"abort",
	"info",
	"reply",
	"escalate",
]);

export interface MailboxMessage {
	id: string;
	batchId: string;
	from: string;
	to: string;
	timestamp: number;
	type: MailboxMessageType;
	content: string;
	expectsReply?: boolean;
	replyTo?: string | null;
}

export interface WriteMailboxMessageOpts {
	from: string;
	type: MailboxMessageType;
	content: string;
	expectsReply?: boolean;
	replyTo?: string | null;
}

// ── Path Helpers ─────────────────────────────────────────────────────

export function mailboxRoot(stateRoot: string, batchId: string): string {
	return join(projectDir(stateRoot), MAILBOX_DIR_NAME, batchId);
}

export function sessionInboxDir(stateRoot: string, batchId: string, sessionName: string): string {
	return join(mailboxRoot(stateRoot, batchId), sessionName, "inbox");
}

export function sessionAckDir(stateRoot: string, batchId: string, sessionName: string): string {
	return join(mailboxRoot(stateRoot, batchId), sessionName, "ack");
}

export function broadcastInboxDir(stateRoot: string, batchId: string): string {
	return join(mailboxRoot(stateRoot, batchId), "_broadcast", "inbox");
}

export function sessionOutboxDir(stateRoot: string, batchId: string, sessionName: string): string {
	return join(mailboxRoot(stateRoot, batchId), sessionName, "outbox");
}

// ── Validation ───────────────────────────────────────────────────────

export function isValidMailboxMessage(obj: unknown): obj is MailboxMessage {
	if (!obj || typeof obj !== "object") return false;
	const m = obj as Record<string, unknown>;
	return (
		typeof m.id === "string" &&
		typeof m.batchId === "string" &&
		typeof m.from === "string" &&
		typeof m.to === "string" &&
		typeof m.timestamp === "number" &&
		Number.isFinite(m.timestamp) &&
		typeof m.type === "string" &&
		MAILBOX_MESSAGE_TYPES.has(m.type) &&
		typeof m.content === "string"
	);
}

// ── Internal helpers ─────────────────────────────────────────────────

function newMessageId(): { id: string; timestamp: number } {
	const timestamp = Date.now();
	const nonce = randomBytes(3).toString("hex").slice(0, 5);
	return { id: `${timestamp}-${nonce}`, timestamp };
}

function atomicWriteJson(dir: string, id: string, payload: unknown): void {
	mkdirSync(dir, { recursive: true });
	const finalPath = join(dir, `${id}.msg.json`);
	const tempPath = join(dir, `${id}.msg.json.tmp`);
	try {
		writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
		renameSync(tempPath, finalPath);
	} catch (err) {
		try {
			if (existsSync(tempPath)) unlinkSync(tempPath);
		} catch {
			// best-effort cleanup
		}
		throw new Error(
			`Failed to write mailbox message to ${finalPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function readMessageFiles(dir: string): Array<{ filename: string; message: MailboxMessage }> {
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (err) {
		process.stderr.write(
			`[mailbox] WARNING: failed to read ${dir}: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		return [];
	}

	const msgFiles = entries.filter(f => f.endsWith(".msg.json") && !f.endsWith(".msg.json.tmp"));
	const results: Array<{ filename: string; message: MailboxMessage }> = [];

	for (const filename of msgFiles) {
		const filePath = join(dir, filename);
		let raw: string;
		try {
			raw = readFileSync(filePath, "utf-8");
		} catch (err) {
			process.stderr.write(
				`[mailbox] WARNING: failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
			);
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			process.stderr.write(`[mailbox] WARNING: malformed JSON in ${filename}, skipping\n`);
			continue;
		}

		if (!isValidMailboxMessage(parsed)) {
			process.stderr.write(`[mailbox] WARNING: invalid message shape in ${filename}, skipping\n`);
			continue;
		}

		results.push({ filename, message: parsed });
	}

	return results;
}

// ── Write (supervisor → agent) ───────────────────────────────────────

export function writeMailboxMessage(
	stateRoot: string,
	batchId: string,
	to: string,
	opts: WriteMailboxMessageOpts,
): MailboxMessage {
	const contentBytes = Buffer.byteLength(opts.content, "utf8");
	if (contentBytes > MAILBOX_MAX_CONTENT_BYTES) {
		throw new Error(
			`Mailbox message content exceeds ${MAILBOX_MAX_CONTENT_BYTES} byte limit ` +
				`(${contentBytes} bytes). Steering messages should be concise directives. ` +
				`Write larger context to a file and reference it by path.`,
		);
	}

	const { id, timestamp } = newMessageId();
	const message: MailboxMessage = {
		id,
		batchId,
		from: opts.from,
		to,
		timestamp,
		type: opts.type,
		content: opts.content,
		expectsReply: opts.expectsReply ?? false,
		replyTo: opts.replyTo ?? null,
	};

	const inboxDir =
		to === "_broadcast" ? broadcastInboxDir(stateRoot, batchId) : sessionInboxDir(stateRoot, batchId, to);
	atomicWriteJson(inboxDir, id, message);
	return message;
}

// ── Read ─────────────────────────────────────────────────────────────

export function readInbox(
	inboxDir: string,
	expectedBatchId: string,
): Array<{ filename: string; message: MailboxMessage }> {
	const raw = readMessageFiles(inboxDir);
	const results: Array<{ filename: string; message: MailboxMessage }> = [];
	for (const entry of raw) {
		if (entry.message.batchId !== expectedBatchId) {
			process.stderr.write(
				`[mailbox] WARNING: batchId mismatch in ${entry.filename} (expected ${expectedBatchId}, got ${entry.message.batchId}), skipping\n`,
			);
			continue;
		}
		results.push(entry);
	}

	results.sort((a, b) => {
		const tsDiff = a.message.timestamp - b.message.timestamp;
		if (tsDiff !== 0) return tsDiff;
		return a.filename.localeCompare(b.filename);
	});

	return results;
}

// ── Acknowledge ──────────────────────────────────────────────────────

export function ackMessage(inboxDir: string, filename: string): boolean {
	const ackDir = join(dirname(inboxDir), "ack");
	try {
		mkdirSync(ackDir, { recursive: true });
	} catch (err) {
		process.stderr.write(
			`[mailbox] WARNING: failed to create ack dir ${ackDir}: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		return false;
	}

	const srcPath = join(inboxDir, filename);
	const dstPath = join(ackDir, filename);
	try {
		renameSync(srcPath, dstPath);
		return true;
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return false;
		process.stderr.write(
			`[mailbox] WARNING: failed to ack ${filename}: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		return false;
	}
}

// ── Outbox (agent → supervisor) ──────────────────────────────────────

export function writeOutboxMessage(
	stateRoot: string,
	batchId: string,
	from: string,
	opts: WriteMailboxMessageOpts,
): MailboxMessage {
	const contentBytes = Buffer.byteLength(opts.content, "utf8");
	if (contentBytes > MAILBOX_MAX_CONTENT_BYTES) {
		throw new Error(
			`Outbox message content exceeds ${MAILBOX_MAX_CONTENT_BYTES} byte limit (${contentBytes} bytes).`,
		);
	}

	const outboxDir = sessionOutboxDir(stateRoot, batchId, from);
	const { id, timestamp } = newMessageId();
	const message: MailboxMessage = {
		id,
		batchId,
		from,
		to: "supervisor",
		timestamp,
		type: opts.type,
		content: opts.content,
		expectsReply: opts.expectsReply ?? false,
		replyTo: opts.replyTo ?? null,
	};

	atomicWriteJson(outboxDir, id, message);
	return message;
}

export function readOutbox(stateRoot: string, batchId: string, agentId: string): MailboxMessage[] {
	const outboxDir = sessionOutboxDir(stateRoot, batchId, agentId);
	const entries = readMessageFiles(outboxDir);
	const messages = entries.map(e => e.message);
	messages.sort((a, b) => a.timestamp - b.timestamp);
	return messages;
}

export function readOutboxHistory(
	stateRoot: string,
	batchId: string,
	agentId: string,
): Array<{ message: MailboxMessage; acked: boolean }> {
	const outboxDir = sessionOutboxDir(stateRoot, batchId, agentId);
	const results: Array<{ message: MailboxMessage; acked: boolean }> = [];

	for (const [dir, acked] of [
		[outboxDir, false],
		[join(outboxDir, "processed"), true],
	] as const) {
		for (const { message } of readMessageFiles(dir)) {
			results.push({ message, acked });
		}
	}

	results.sort((a, b) => a.message.timestamp - b.message.timestamp);
	return results;
}

export function ackOutboxMessage(stateRoot: string, batchId: string, agentId: string, messageId: string): boolean {
	const outboxDir = sessionOutboxDir(stateRoot, batchId, agentId);
	const processedDir = join(outboxDir, "processed");
	const file = `${messageId}.msg.json`;
	const srcPath = join(outboxDir, file);
	const dstPath = join(processedDir, file);

	try {
		mkdirSync(processedDir, { recursive: true });
		renameSync(srcPath, dstPath);
		return true;
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return false;
		process.stderr.write(
			`[mailbox] WARNING: failed to ack outbox ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		return false;
	}
}

// ── Discovery ────────────────────────────────────────────────────────

export function discoverMailboxAgentIds(stateRoot: string, batchId: string): string[] {
	const mbRoot = mailboxRoot(stateRoot, batchId);
	if (!existsSync(mbRoot)) return [];
	try {
		return readdirSync(mbRoot, { withFileTypes: true })
			.filter(e => e.isDirectory() && e.name !== "_broadcast")
			.map(e => e.name);
	} catch {
		return [];
	}
}

// ── Audit Events ─────────────────────────────────────────────────────

export type MailboxAuditEventType =
	| "message_sent"
	| "message_delivered"
	| "message_replied"
	| "message_escalated"
	| "message_rate_limited";

export function appendMailboxAuditEvent(
	stateRoot: string,
	batchId: string,
	event: {
		type: MailboxAuditEventType;
		ts?: number;
		from?: string;
		to?: string;
		messageId?: string;
		messageType?: string;
		contentPreview?: string;
		broadcast?: boolean;
		reason?: string;
		retryAfterMs?: number;
	},
): void {
	const eventsPath = join(mailboxRoot(stateRoot, batchId), "events.jsonl");
	try {
		mkdirSync(dirname(eventsPath), { recursive: true });
		appendFileSync(eventsPath, `${JSON.stringify({ batchId, ts: event.ts ?? Date.now(), ...event })}\n`, "utf-8");
	} catch (err) {
		process.stderr.write(
			`[mailbox] WARNING: failed to append mailbox event: ${err instanceof Error ? err.message : String(err)}\n`,
		);
	}
}

// ── Broadcast ────────────────────────────────────────────────────────

export function writeBroadcastMessage(
	stateRoot: string,
	batchId: string,
	opts: WriteMailboxMessageOpts,
): MailboxMessage {
	return writeMailboxMessage(stateRoot, batchId, "_broadcast", {
		...opts,
		from: opts.from || "supervisor",
	});
}

// ── Rate Limiting ────────────────────────────────────────────────────

/** Default rate limit: max 1 message per agent per 30 seconds. */
export const RATE_LIMIT_WINDOW_MS = 30_000;

const rateLimitTracker = new Map<string, number>();

export function checkRateLimit(
	targetAgentId: string,
	windowMs: number = RATE_LIMIT_WINDOW_MS,
): { allowed: boolean; retryAfterMs?: number } {
	const lastSent = rateLimitTracker.get(targetAgentId);
	if (!lastSent) return { allowed: true };
	const elapsed = Date.now() - lastSent;
	if (elapsed >= windowMs) return { allowed: true };
	return { allowed: false, retryAfterMs: windowMs - elapsed };
}

export function recordSend(targetAgentId: string): void {
	rateLimitTracker.set(targetAgentId, Date.now());
}

/** Reset rate limit state (testing only). */
export function _resetRateLimits(): void {
	rateLimitTracker.clear();
}
