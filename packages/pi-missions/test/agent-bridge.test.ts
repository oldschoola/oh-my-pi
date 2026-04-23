/**
 * Contract tests for the worker-side agent bridge.
 *
 * The bridge is what lets worker agents talk back to the supervisor
 * with structured JSON (instead of hand-rolling writes via bash). The
 * three tools it registers are:
 *
 *   - notify_supervisor       → writes a `reply` message to outbox
 *   - escalate_to_supervisor  → writes an `escalate` message to outbox
 *   - request_segment_expansion → writes a segment-expansion request
 *
 * These tests drive the tools by stubbing the ExtensionAPI surface and
 * directly invoking the captured `execute` callbacks. For each tool
 * the test asserts the observable outcome (file on disk) matches the
 * contract the lane-runner's polling side depends on — message shape,
 * filename convention, atomic write guarantee.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerAgentBridge } from "../src/agent-bridge";

interface CapturedTool {
	name: string;
	label: string;
	description: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
	) => Promise<{
		content: Array<{ type: "text"; text: string }>;
	}>;
}

interface StubApi {
	registerTool(tool: CapturedTool): void;
}

interface StubPi {
	api: StubApi;
	tools: Map<string, CapturedTool>;
}

function makeStubPi(): StubPi {
	const tools = new Map<string, CapturedTool>();
	const api: StubApi = {
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
	};
	return { api, tools };
}

/**
 * Sandboxed env reset helper. Restores any pre-test values on teardown
 * so a test that scrambled env vars cannot leak into other files.
 */
function swapEnv(key: string, value: string | undefined): string | undefined {
	const prev = process.env[key];
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
	return prev;
}

// ── Test harness ────────────────────────────────────────────────────

let tempDir: string;
const envKeys = [
	"MISSION_AGENT_ID",
	"MISSION_OUTBOX_DIR",
	"MISSION_TASK_ID",
	"MISSION_TASK_FOLDER",
	"MISSION_ACTIVE_SEGMENT_ID",
	"MISSION_SEGMENT_ID",
	"MISSION_SUPERVISOR_AUTONOMY",
	"ORCH_BATCH_ID",
] as const;
const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

beforeEach(async () => {
	// Snapshot env so teardown restores the exact pre-test state.
	for (const key of envKeys) savedEnv[key] = process.env[key];
	// Fresh outbox per test — isolates file-existence assertions.
	tempDir = await fs.mkdtemp(path.join(tmpdir(), "agent-bridge-test-"));
});

afterEach(async () => {
	for (const key of envKeys) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	// Best-effort cleanup. We never rely on the dir being gone for
	// correctness; this is hygiene so CI workspaces stay tidy.
	try {
		await fs.rm(tempDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

function primeWorkerEnv(overrides: Partial<Record<string, string | undefined>> = {}): void {
	swapEnv("MISSION_AGENT_ID", "orch-ab-repo-b1-l1-worker");
	swapEnv("MISSION_OUTBOX_DIR", tempDir);
	swapEnv("ORCH_BATCH_ID", "batch-1");
	swapEnv("MISSION_TASK_ID", "TP-001");
	swapEnv("MISSION_TASK_FOLDER", "tasks/TP-001");
	swapEnv("MISSION_SUPERVISOR_AUTONOMY", "autonomous");
	for (const [k, v] of Object.entries(overrides)) swapEnv(k, v);
}

/** Read and JSON-parse every `.msg.json` file in the outbox (excludes .tmp files). */
async function readOutboxMessages(): Promise<Array<Record<string, unknown>>> {
	const entries = await fs.readdir(tempDir);
	const results: Array<Record<string, unknown>> = [];
	for (const name of entries) {
		if (!name.endsWith(".msg.json") || name.endsWith(".tmp")) continue;
		const raw = await fs.readFile(path.join(tempDir, name), "utf-8");
		results.push(JSON.parse(raw) as Record<string, unknown>);
	}
	return results;
}

async function listOutboxFiles(): Promise<string[]> {
	return (await fs.readdir(tempDir)).sort();
}

describe("registerAgentBridge gating", () => {
	test("registers nothing when MISSION_AGENT_ID is unset", () => {
		swapEnv("MISSION_AGENT_ID", undefined);
		swapEnv("MISSION_OUTBOX_DIR", tempDir);
		const stub = makeStubPi();
		registerAgentBridge(stub.api as unknown as ExtensionAPI);
		expect(stub.tools.size).toBe(0);
	});

	test("registers nothing when MISSION_OUTBOX_DIR is unset", () => {
		swapEnv("MISSION_AGENT_ID", "worker-1");
		swapEnv("MISSION_OUTBOX_DIR", undefined);
		const stub = makeStubPi();
		registerAgentBridge(stub.api as unknown as ExtensionAPI);
		expect(stub.tools.size).toBe(0);
	});

	test("registers notify + escalate when both env vars are set (segment tool stays off without segment id)", () => {
		primeWorkerEnv({ MISSION_ACTIVE_SEGMENT_ID: undefined, MISSION_SEGMENT_ID: undefined });
		const stub = makeStubPi();
		registerAgentBridge(stub.api as unknown as ExtensionAPI);
		expect(stub.tools.has("notify_supervisor")).toBe(true);
		expect(stub.tools.has("escalate_to_supervisor")).toBe(true);
		expect(stub.tools.has("request_segment_expansion")).toBe(false);
	});

	test("registers all three tools when MISSION_ACTIVE_SEGMENT_ID is set", () => {
		primeWorkerEnv({ MISSION_ACTIVE_SEGMENT_ID: "TP-001::repo-foo" });
		const stub = makeStubPi();
		registerAgentBridge(stub.api as unknown as ExtensionAPI);
		expect(stub.tools.has("notify_supervisor")).toBe(true);
		expect(stub.tools.has("escalate_to_supervisor")).toBe(true);
		expect(stub.tools.has("request_segment_expansion")).toBe(true);
	});
});

describe("notify_supervisor", () => {
	test("writes a well-formed reply message to outbox", async () => {
		primeWorkerEnv();
		const stub = makeStubPi();
		registerAgentBridge(stub.api as unknown as ExtensionAPI);
		const tool = stub.tools.get("notify_supervisor");
		if (!tool) throw new Error("notify_supervisor not registered");

		const result = await tool.execute("call-1", { content: "received, working on it" });
		expect(result.content[0].text).toContain("Reply sent");

		const messages = await readOutboxMessages();
		expect(messages).toHaveLength(1);
		const m = messages[0];
		expect(m.type).toBe("reply");
		expect(m.from).toBe("orch-ab-repo-b1-l1-worker");
		expect(m.to).toBe("supervisor");
		expect(m.batchId).toBe("batch-1");
		expect(m.content).toBe("received, working on it");
		expect(m.expectsReply).toBe(false);
		expect(m.replyTo).toBeNull();
		expect(typeof m.id).toBe("string");
		expect((m.id as string).length).toBeGreaterThan(5);
		expect(typeof m.timestamp).toBe("number");
	});

	test("carries replyTo when provided", async () => {
		primeWorkerEnv();
		const stub = makeStubPi();
		registerAgentBridge(stub.api as unknown as ExtensionAPI);
		const tool = stub.tools.get("notify_supervisor");
		if (!tool) throw new Error("notify_supervisor not registered");

		await tool.execute("call-1", { content: "ack", replyTo: "prev-msg-123" });
		const messages = await readOutboxMessages();
		expect(messages[0].replyTo).toBe("prev-msg-123");
	});

	test("rejects content that exceeds the 4096-byte cap", async () => {
		primeWorkerEnv();
		const stub = makeStubPi();
		registerAgentBridge(stub.api as unknown as ExtensionAPI);
		const tool = stub.tools.get("notify_supervisor");
		if (!tool) throw new Error("notify_supervisor not registered");

		// Build 4097-byte ASCII payload so the check trips exactly at the boundary.
		const huge = "x".repeat(4097);
		const result = await tool.execute("call-1", { content: huge });
		expect(result.content[0].text).toContain("Failed to send reply");
		expect(result.content[0].text).toContain("4096");
		expect(await listOutboxFiles()).toHaveLength(0);
	});
});

describe("escalate_to_supervisor", () => {
	test("writes an escalate message with expectsReply:true", async () => {
		primeWorkerEnv();
		const stub = makeStubPi();
		registerAgentBridge(stub.api as unknown as ExtensionAPI);
		const tool = stub.tools.get("escalate_to_supervisor");
		if (!tool) throw new Error("escalate_to_supervisor not registered");

		const result = await tool.execute("call-1", {
			content: "stuck on test infrastructure — options A, B",
		});
		expect(result.content[0].text).toContain("Escalation sent");

		const messages = await readOutboxMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].type).toBe("escalate");
		expect(messages[0].expectsReply).toBe(true);
		expect(messages[0].replyTo).toBeNull();
	});
});

describe("request_segment_expansion", () => {
	test("writes a segment-expansion-<id>.json file with the correct shape", async () => {
		primeWorkerEnv({ MISSION_ACTIVE_SEGMENT_ID: "TP-001::repo-foo" });
		const stub = makeStubPi();
		registerAgentBridge(stub.api as unknown as ExtensionAPI);
		const tool = stub.tools.get("request_segment_expansion");
		if (!tool) throw new Error("request_segment_expansion not registered");

		const result = await tool.execute("call-1", {
			requestedRepoIds: ["repo-bar", "repo-baz"],
			rationale: "bar depends on baz for integration test",
			placement: "after-current",
		});

		const parsed = JSON.parse(result.content[0].text) as {
			accepted: boolean;
			requestId: string | null;
			message: string;
		};
		expect(parsed.accepted).toBe(true);
		expect(parsed.requestId).toMatch(/^exp-\d+-[a-z0-9]{5}$/);

		const files = await listOutboxFiles();
		const expansionFiles = files.filter(f => f.startsWith("segment-expansion-") && f.endsWith(".json"));
		expect(expansionFiles).toHaveLength(1);
		expect(expansionFiles[0]).toBe(`segment-expansion-${parsed.requestId}.json`);

		const raw = await fs.readFile(path.join(tempDir, expansionFiles[0]), "utf-8");
		const req = JSON.parse(raw) as Record<string, unknown>;
		expect(req.requestId).toBe(parsed.requestId);
		expect(req.taskId).toBe("TP-001");
		expect(req.fromSegmentId).toBe("TP-001::repo-foo");
		expect(req.requestedRepoIds).toEqual(["repo-bar", "repo-baz"]);
		expect(req.rationale).toBe("bar depends on baz for integration test");
		expect(req.placement).toBe("after-current");
		expect(Array.isArray(req.edges)).toBe(true);
	});

	test("defaults placement to after-current and edges to []", async () => {
		primeWorkerEnv({ MISSION_ACTIVE_SEGMENT_ID: "TP-001::repo-foo" });
		const stub = makeStubPi();
		registerAgentBridge(stub.api as unknown as ExtensionAPI);
		const tool = stub.tools.get("request_segment_expansion");
		if (!tool) throw new Error("request_segment_expansion not registered");

		await tool.execute("call-1", {
			requestedRepoIds: ["repo-bar"],
			rationale: "need bar",
		});

		const files = (await listOutboxFiles()).filter(f => f.startsWith("segment-expansion-"));
		const raw = await fs.readFile(path.join(tempDir, files[0]), "utf-8");
		const req = JSON.parse(raw) as Record<string, unknown>;
		expect(req.placement).toBe("after-current");
		expect(req.edges).toEqual([]);
	});

	test("rejects non-autonomous autonomy without writing a file", async () => {
		primeWorkerEnv({
			MISSION_ACTIVE_SEGMENT_ID: "TP-001::repo-foo",
			MISSION_SUPERVISOR_AUTONOMY: "supervised",
		});
		const stub = makeStubPi();
		registerAgentBridge(stub.api as unknown as ExtensionAPI);
		const tool = stub.tools.get("request_segment_expansion");
		if (!tool) throw new Error("request_segment_expansion not registered");

		const result = await tool.execute("call-1", {
			requestedRepoIds: ["repo-bar"],
			rationale: "need bar",
		});

		const parsed = JSON.parse(result.content[0].text) as { accepted: boolean; requestId: null };
		expect(parsed.accepted).toBe(false);
		expect(parsed.requestId).toBeNull();
		const files = await listOutboxFiles();
		expect(files.filter(f => f.startsWith("segment-expansion-"))).toHaveLength(0);
	});

	test("rejects invalid repo IDs with rejection details", async () => {
		primeWorkerEnv({ MISSION_ACTIVE_SEGMENT_ID: "TP-001::repo-foo" });
		const stub = makeStubPi();
		registerAgentBridge(stub.api as unknown as ExtensionAPI);
		const tool = stub.tools.get("request_segment_expansion");
		if (!tool) throw new Error("request_segment_expansion not registered");

		const result = await tool.execute("call-1", {
			requestedRepoIds: ["BADCAPS", "-leadingdash", "repo-good"],
			rationale: "test",
		});
		const parsed = JSON.parse(result.content[0].text) as {
			accepted: boolean;
			rejections: Array<{ repoId: string; reason: string }>;
		};
		expect(parsed.accepted).toBe(false);
		// Two invalids should produce rejections even though the third is fine.
		expect(parsed.rejections.length).toBeGreaterThanOrEqual(2);
	});

	test("rejects duplicate repo IDs", async () => {
		primeWorkerEnv({ MISSION_ACTIVE_SEGMENT_ID: "TP-001::repo-foo" });
		const stub = makeStubPi();
		registerAgentBridge(stub.api as unknown as ExtensionAPI);
		const tool = stub.tools.get("request_segment_expansion");
		if (!tool) throw new Error("request_segment_expansion not registered");

		const result = await tool.execute("call-1", {
			requestedRepoIds: ["repo-x", "repo-x"],
			rationale: "dup",
		});
		const parsed = JSON.parse(result.content[0].text) as {
			accepted: boolean;
			rejections: Array<{ repoId: string; reason: string }>;
		};
		expect(parsed.accepted).toBe(false);
		expect(parsed.rejections.some(r => r.reason.includes("duplicate"))).toBe(true);
	});
});

describe("atomic write guarantee", () => {
	test("no .tmp files survive after a successful notify", async () => {
		primeWorkerEnv();
		const stub = makeStubPi();
		registerAgentBridge(stub.api as unknown as ExtensionAPI);
		const tool = stub.tools.get("notify_supervisor");
		if (!tool) throw new Error("notify_supervisor not registered");

		// Fire several concurrent writes to stress the tmp+rename dance.
		const nonces = Array.from({ length: 8 }, () => randomBytes(4).toString("hex"));
		await Promise.all(nonces.map(n => tool.execute(`call-${n}`, { content: `ping ${n}` })));

		const files = await listOutboxFiles();
		expect(files.every(f => !f.endsWith(".tmp"))).toBe(true);
		expect(files.filter(f => f.endsWith(".msg.json"))).toHaveLength(8);
	});
});
