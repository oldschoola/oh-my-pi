import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	_resetRateLimits,
	ackMessage,
	ackOutboxMessage,
	appendMailboxAuditEvent,
	broadcastInboxDir,
	checkRateLimit,
	discoverMailboxAgentIds,
	isValidMailboxMessage,
	MAILBOX_MAX_CONTENT_BYTES,
	mailboxRoot,
	RATE_LIMIT_WINDOW_MS,
	readInbox,
	readOutbox,
	readOutboxHistory,
	recordSend,
	sessionAckDir,
	sessionInboxDir,
	sessionOutboxDir,
	writeBroadcastMessage,
	writeMailboxMessage,
	writeOutboxMessage,
} from "../src/missioncontrol/mailbox";

let ROOT: string;

beforeEach(() => {
	ROOT = mkdtempSync(join(tmpdir(), "mc-mailbox-"));
	_resetRateLimits();
});
afterEach(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

describe("mailbox paths", () => {
	test("all paths route under .omp/mailbox/{batchId}", () => {
		const root = mailboxRoot(ROOT, "b-1");
		expect(root).toContain(join(".omp", "mailbox", "b-1"));
		expect(sessionInboxDir(ROOT, "b-1", "lane-1")).toBe(join(root, "lane-1", "inbox"));
		expect(sessionAckDir(ROOT, "b-1", "lane-1")).toBe(join(root, "lane-1", "ack"));
		expect(sessionOutboxDir(ROOT, "b-1", "lane-1")).toBe(join(root, "lane-1", "outbox"));
		expect(broadcastInboxDir(ROOT, "b-1")).toBe(join(root, "_broadcast", "inbox"));
	});
});

describe("writeMailboxMessage + readInbox", () => {
	test("round-trips a message to a specific agent", () => {
		writeMailboxMessage(ROOT, "b-1", "lane-1", {
			from: "supervisor",
			type: "steer",
			content: "Review src/foo before proceeding",
		});

		const inbox = readInbox(sessionInboxDir(ROOT, "b-1", "lane-1"), "b-1");
		expect(inbox).toHaveLength(1);
		expect(inbox[0]?.message.type).toBe("steer");
		expect(inbox[0]?.message.content).toBe("Review src/foo before proceeding");
		expect(inbox[0]?.message.batchId).toBe("b-1");
		expect(inbox[0]?.message.from).toBe("supervisor");
	});

	test("readInbox filters out mismatched batchId", () => {
		writeMailboxMessage(ROOT, "b-1", "lane-1", { from: "supervisor", type: "info", content: "hi" });
		const inbox = readInbox(sessionInboxDir(ROOT, "b-1", "lane-1"), "b-2");
		expect(inbox).toHaveLength(0);
	});

	test("readInbox sorts by timestamp ascending", () => {
		writeMailboxMessage(ROOT, "b-1", "lane-1", { from: "supervisor", type: "info", content: "one" });
		// Slight wait so timestamps differ.
		const until = Date.now() + 2;
		while (Date.now() < until) {
			/* spin */
		}
		writeMailboxMessage(ROOT, "b-1", "lane-1", { from: "supervisor", type: "info", content: "two" });
		const inbox = readInbox(sessionInboxDir(ROOT, "b-1", "lane-1"), "b-1");
		expect(inbox.map(e => e.message.content)).toEqual(["one", "two"]);
	});

	test("rejects oversize content", () => {
		const big = "x".repeat(MAILBOX_MAX_CONTENT_BYTES + 1);
		expect(() =>
			writeMailboxMessage(ROOT, "b-1", "lane-1", { from: "supervisor", type: "info", content: big }),
		).toThrow(/exceeds/);
	});

	test("readInbox returns empty for missing directory", () => {
		expect(readInbox(sessionInboxDir(ROOT, "b-xyz", "lane-xyz"), "b-xyz")).toEqual([]);
	});

	test("skips temp (.msg.json.tmp) files during read", () => {
		// Write a real message so the inbox dir exists.
		writeMailboxMessage(ROOT, "b-1", "lane-1", { from: "supervisor", type: "info", content: "real" });
		const inboxDir = sessionInboxDir(ROOT, "b-1", "lane-1");
		// Drop a stray .tmp file.
		Bun.write(join(inboxDir, "stray.msg.json.tmp"), "{}");
		const inbox = readInbox(inboxDir, "b-1");
		expect(inbox).toHaveLength(1);
	});
});

describe("ackMessage", () => {
	test("moves message from inbox to ack", () => {
		const msg = writeMailboxMessage(ROOT, "b-1", "lane-1", {
			from: "supervisor",
			type: "info",
			content: "hi",
		});
		const inboxDir = sessionInboxDir(ROOT, "b-1", "lane-1");
		const filename = `${msg.id}.msg.json`;
		expect(existsSync(join(inboxDir, filename))).toBe(true);

		const ok = ackMessage(inboxDir, filename);
		expect(ok).toBe(true);
		expect(existsSync(join(inboxDir, filename))).toBe(false);
		expect(existsSync(join(sessionAckDir(ROOT, "b-1", "lane-1"), filename))).toBe(true);
	});

	test("returns false when file already acked", () => {
		const msg = writeMailboxMessage(ROOT, "b-1", "lane-1", { from: "supervisor", type: "info", content: "hi" });
		const inboxDir = sessionInboxDir(ROOT, "b-1", "lane-1");
		const filename = `${msg.id}.msg.json`;
		expect(ackMessage(inboxDir, filename)).toBe(true);
		expect(ackMessage(inboxDir, filename)).toBe(false);
	});
});

describe("broadcast", () => {
	test("writeBroadcastMessage writes under _broadcast/inbox", () => {
		writeBroadcastMessage(ROOT, "b-1", { from: "supervisor", type: "info", content: "all hands" });
		const files = readdirSync(broadcastInboxDir(ROOT, "b-1"));
		expect(files.some(f => f.endsWith(".msg.json"))).toBe(true);
	});
});

describe("outbox", () => {
	test("writeOutboxMessage + readOutbox + ack", () => {
		const msg = writeOutboxMessage(ROOT, "b-1", "lane-1", {
			from: "lane-1",
			type: "reply",
			content: "ack",
		});
		const pending = readOutbox(ROOT, "b-1", "lane-1");
		expect(pending).toHaveLength(1);
		expect(pending[0]?.to).toBe("supervisor");
		expect(ackOutboxMessage(ROOT, "b-1", "lane-1", msg.id)).toBe(true);
		expect(readOutbox(ROOT, "b-1", "lane-1")).toHaveLength(0);
	});

	test("readOutboxHistory includes acked messages", () => {
		const msg = writeOutboxMessage(ROOT, "b-1", "lane-1", { from: "lane-1", type: "reply", content: "ack" });
		ackOutboxMessage(ROOT, "b-1", "lane-1", msg.id);
		const history = readOutboxHistory(ROOT, "b-1", "lane-1");
		expect(history).toHaveLength(1);
		expect(history[0]?.acked).toBe(true);
	});
});

describe("discoverMailboxAgentIds", () => {
	test("lists agent directories, excluding _broadcast", () => {
		writeMailboxMessage(ROOT, "b-1", "lane-1", { from: "supervisor", type: "info", content: "a" });
		writeMailboxMessage(ROOT, "b-1", "lane-2", { from: "supervisor", type: "info", content: "b" });
		writeBroadcastMessage(ROOT, "b-1", { from: "supervisor", type: "info", content: "c" });
		const ids = discoverMailboxAgentIds(ROOT, "b-1").sort();
		expect(ids).toEqual(["lane-1", "lane-2"]);
	});

	test("returns empty for missing batch", () => {
		expect(discoverMailboxAgentIds(ROOT, "does-not-exist")).toEqual([]);
	});
});

describe("appendMailboxAuditEvent", () => {
	test("writes to events.jsonl under the batch mailbox root", () => {
		appendMailboxAuditEvent(ROOT, "b-1", { type: "message_sent", from: "supervisor", to: "lane-1" });
		const path = join(mailboxRoot(ROOT, "b-1"), "events.jsonl");
		expect(existsSync(path)).toBe(true);
		const content = readFileSync(path, "utf-8").trim();
		const parsed = JSON.parse(content);
		expect(parsed.type).toBe("message_sent");
		expect(parsed.batchId).toBe("b-1");
	});
});

describe("rate limiting", () => {
	test("allows first send, blocks second within window", () => {
		expect(checkRateLimit("lane-1").allowed).toBe(true);
		recordSend("lane-1");
		const second = checkRateLimit("lane-1");
		expect(second.allowed).toBe(false);
		expect(second.retryAfterMs).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_MS);
	});

	test("allows send once window elapses (window=0)", () => {
		recordSend("lane-1");
		const soon = checkRateLimit("lane-1", 0);
		expect(soon.allowed).toBe(true);
	});
});

describe("isValidMailboxMessage", () => {
	test("accepts well-formed message", () => {
		const good = {
			id: "1",
			batchId: "b",
			from: "s",
			to: "l",
			timestamp: 1,
			type: "info",
			content: "c",
		};
		expect(isValidMailboxMessage(good)).toBe(true);
	});

	test("rejects invalid type", () => {
		const bad = { id: "1", batchId: "b", from: "s", to: "l", timestamp: 1, type: "garbage", content: "c" };
		expect(isValidMailboxMessage(bad)).toBe(false);
	});

	test("rejects missing fields", () => {
		expect(isValidMailboxMessage({})).toBe(false);
		expect(isValidMailboxMessage(null)).toBe(false);
	});
});
