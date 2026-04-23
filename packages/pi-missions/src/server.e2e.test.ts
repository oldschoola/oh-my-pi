import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuiBridge, type MissionStartRequest, registerDefaultBridge, removeDefaultBridge } from "./gui-bridge";
import { appendMailboxAuditEvent } from "./missioncontrol/mailbox";
import { startServer } from "./server";
import { clearMissionServerHooks, setMissionServerHooks } from "./server-hooks";

let baseUrl = "";
let stop: () => void = () => {};
let workDir = "";

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "omp-mission-e2e-"));
	// Seed project history so /api/history returns data.
	const projectDir = join(workDir, ".omp");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(
		join(projectDir, "mission-history.json"),
		JSON.stringify([
			{
				batchId: "batch-seed-1",
				description: "seed batch",
				phase: "complete",
				tasksTotal: 4,
				tasksComplete: 4,
				tasksFailed: 0,
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			},
		]),
	);

	const server = await startServer({ port: 0, cwd: workDir });
	baseUrl = `http://localhost:${server.port}`;
	stop = server.stop;
});

afterAll(() => {
	try {
		stop();
	} catch {}
	if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test("GET /api/history returns seeded entry", async () => {
	const res = await fetch(`${baseUrl}/api/history`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as { entries: Array<{ batchId: string; description?: string }> };
	expect(body.entries.length).toBeGreaterThanOrEqual(1);
	expect(body.entries[0].batchId).toBe("batch-seed-1");
	expect(body.entries[0].description).toBe("seed batch");
});

test("GET /api/history/:id returns matching entry or 404", async () => {
	const ok = await fetch(`${baseUrl}/api/history/batch-seed-1`);
	expect(ok.status).toBe(200);
	const bad = await fetch(`${baseUrl}/api/history/does-not-exist`);
	expect(bad.status).toBe(404);
});

test("GET /api/supervisor/events returns empty entries when no log", async () => {
	const res = await fetch(`${baseUrl}/api/supervisor/events?limit=10`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as { entries: unknown[] };
	expect(Array.isArray(body.entries)).toBe(true);
});

test("GET /api/mailbox/events returns empty when no active batch", async () => {
	const res = await fetch(`${baseUrl}/api/mailbox/events`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as { events: unknown[] };
	expect(body.events).toEqual([]);
});

test("GET /api/agents returns null registry with no active batch", async () => {
	const res = await fetch(`${baseUrl}/api/agents`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as { batchId: string | null; registry: unknown };
	expect(body.batchId).toBeNull();
	expect(body.registry).toBeNull();
});

test("POST /api/mission/start rejects unknown token with 403", async () => {
	const res = await fetch(`${baseUrl}/api/mission/start`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			token: "00000000-0000-0000-0000-000000000000",
			templateKey: "minimal",
			description: "nope",
			autonomy: "medium",
			modelAssignment: {},
		}),
	});
	expect(res.status).toBe(403);
	const body = (await res.json()) as { ok: boolean; reason?: string };
	expect(body.ok).toBe(false);
	expect(body.reason).toBe("unknown_token");
});

test("POST /api/mission/start dispatches to bridge and returns 202", async () => {
	const bridge = createGuiBridge();
	try {
		const pending = bridge.waitForStart();
		const payload: MissionStartRequest = {
			token: bridge.token,
			templateKey: "minimal",
			description: "e2e test mission",
			autonomy: "medium",
			modelAssignment: { planner: "claude-sonnet-4-6", worker: "claude-sonnet-4-6" },
			laneCount: 2,
			waveSize: 2,
		};
		const res = await fetch(`${baseUrl}/api/mission/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		expect(res.status).toBe(202);
		const received = await pending;
		expect(received.description).toBe("e2e test mission");
		expect(received.laneCount).toBe(2);
	} finally {
		bridge.close();
	}
});

test("GET /api/conversation/missing returns 404", async () => {
	const res = await fetch(`${baseUrl}/api/conversation/lane-99`);
	expect(res.status).toBe(404);
});

test("GET /api/status-md/missing returns 404", async () => {
	const res = await fetch(`${baseUrl}/api/status-md/task-99`);
	expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// SSE lifecycle — verifies server stops polling on completion / disconnect.
// ---------------------------------------------------------------------------

async function readSSEMessage(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	const decoder = new TextDecoder();
	let buffer = "";
	while (!buffer.includes("\n\n")) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
	}
	return buffer;
}

function writeMission(id: string, state: Record<string, unknown>): void {
	const missionsDir = join(workDir, ".omp", "missions");
	mkdirSync(missionsDir, { recursive: true });
	writeFileSync(join(missionsDir, `${id}.json`), JSON.stringify(state));
}

test("SSE stream closes immediately once mission is completed", async () => {
	writeMission("sse-completed", {
		description: "completed",
		mode: "simple",
		phases: [{ name: "Plan", emoji: "P", status: "done" }],
		autonomy: "high",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: "2025-01-01T10:00:00Z",
		completedAt: "2025-01-01T11:00:00Z",
		kind: "simple",
	});

	const res = await fetch(`${baseUrl}/api/mission/sse-completed/stream`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toContain("text/event-stream");
	const reader = res.body?.getReader();
	expect(reader).toBeDefined();

	const first = await readSSEMessage(reader as ReadableStreamDefaultReader<Uint8Array>);
	expect(first).toContain('"type":"snapshot"');
	expect(first).toContain('"completedAt":"2025-01-01T11:00:00Z"');

	// After emitting the terminal snapshot, the server must close the stream.
	const { done } = await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
	expect(done).toBe(true);
});

test("SSE stream delivers snapshot for active missions without closing", async () => {
	writeMission("sse-active", {
		description: "active",
		mode: "simple",
		phases: [{ name: "Plan", emoji: "P", status: "active" }],
		autonomy: "high",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: "2025-01-01T10:00:00Z",
		kind: "simple",
	});

	const ctrl = new AbortController();
	const res = await fetch(`${baseUrl}/api/mission/sse-active/stream`, { signal: ctrl.signal });
	expect(res.status).toBe(200);
	const reader = res.body?.getReader();
	expect(reader).toBeDefined();

	const first = await readSSEMessage(reader as ReadableStreamDefaultReader<Uint8Array>);
	expect(first).toContain('"type":"snapshot"');
	expect(first).not.toContain('"completedAt"');

	// Abort client-side to trigger server cancel() — release resources.
	ctrl.abort();
	expect(ctrl.signal.aborted).toBe(true);
});

// ---------------------------------------------------------------------------
// Telemetry endpoint — server shape → client shape field mapping.
// ---------------------------------------------------------------------------

function writeTelemetry(id: string, raw: unknown): void {
	const dir = join(workDir, ".omp", "mission-telemetry", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "exit-summary.json"), JSON.stringify(raw));
}

interface TelemetryResponse {
	exitCode?: number;
	durationMs?: number;
	tokens?: {
		inputTokens: number;
		outputTokens: number;
		cacheCreationInputTokens: number;
		cacheReadInputTokens: number;
		totalCostUsd: number;
	};
	toolCalls?: number;
	lastToolCall?: string;
	contextPct?: number;
	retries?: number;
	retryActive?: boolean;
	lastRetryError?: string;
	compactions?: number;
}

test("GET /api/mission/:id/telemetry maps server fields to client shape", async () => {
	writeTelemetry("telemetry-mapped", {
		exitCode: 0,
		tokens: { input: 12_000, output: 3400, cacheRead: 800, cacheWrite: 150 },
		cost: 0.042,
		toolCalls: 7,
		durationSec: 42,
		lastToolCall: "read",
	});

	const res = await fetch(`${baseUrl}/api/mission/telemetry-mapped/telemetry`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as TelemetryResponse;

	expect(body.exitCode).toBe(0);
	expect(body.durationMs).toBe(42_000);
	expect(body.toolCalls).toBe(7);
	expect(body.lastToolCall).toBe("read");
	expect(body.tokens).toEqual({
		inputTokens: 12_000,
		outputTokens: 3400,
		cacheCreationInputTokens: 150,
		cacheReadInputTokens: 800,
		totalCostUsd: 0.042,
	});
});

test("GET /api/mission/:id/telemetry tolerates null tokens/cost (pre-usage state)", async () => {
	writeTelemetry("telemetry-empty", {
		tokens: null,
		cost: null,
		toolCalls: 0,
		durationSec: 0,
	});

	const res = await fetch(`${baseUrl}/api/mission/telemetry-empty/telemetry`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as TelemetryResponse;

	expect(body.toolCalls).toBe(0);
	expect(body.tokens).toEqual({
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		totalCostUsd: 0,
	});
});

test("GET /api/mission/:id/telemetry returns empty object when no file exists", async () => {
	const res = await fetch(`${baseUrl}/api/mission/telemetry-missing/telemetry`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as TelemetryResponse;
	expect(body.tokens).toBeUndefined();
	expect(body.toolCalls).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Extended telemetry — context%, retries, compactions, arg preview.
// ---------------------------------------------------------------------------

test("GET /api/mission/:id/telemetry surfaces context%, retries, compactions", async () => {
	writeTelemetry("telemetry-extended", {
		tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
		cost: 0.01,
		toolCalls: 3,
		durationSec: 12,
		lastToolCall: "read src/foo.ts",
		contextPct: 47.5,
		retries: 2,
		retryActive: true,
		lastRetryError: "429 rate limit",
		compactions: 1,
	});

	const res = await fetch(`${baseUrl}/api/mission/telemetry-extended/telemetry`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as TelemetryResponse;

	expect(body.contextPct).toBe(47.5);
	expect(body.retries).toBe(2);
	expect(body.retryActive).toBe(true);
	expect(body.lastRetryError).toBe("429 rate limit");
	expect(body.compactions).toBe(1);
	expect(body.lastToolCall).toBe("read src/foo.ts");
});

test("GET /api/mission/:id/telemetry omits retries/compactions when zero", async () => {
	writeTelemetry("telemetry-zero-retries", {
		tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
		toolCalls: 1,
		durationSec: 1,
		retries: 0,
		compactions: 0,
	});

	const res = await fetch(`${baseUrl}/api/mission/telemetry-zero-retries/telemetry`);
	const body = (await res.json()) as TelemetryResponse;

	expect(body.retries).toBeUndefined();
	expect(body.compactions).toBeUndefined();
	expect(body.retryActive).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Batch STATUS.md enrichment — getMission attaches parsed progress to tasks.
// ---------------------------------------------------------------------------

test("GET /api/mission/:id enriches batch tasks with STATUS.md progress", async () => {
	const batchId = "enrich-1";
	const statusMdBody = [
		"# T-1: Demo — Status",
		"",
		"**Current Step:** Step 1",
		"**Iteration:** 2",
		"**Review Counter:** 1",
		"",
		"### Step 1: Implementation",
		"**Status:** ✅ complete",
		"- [x] wrote the code",
		"- [x] ran the tests",
		"### Step 2: Review",
		"**Status:** 🟨 in-progress",
		"- [ ] tidy up",
		"",
	].join("\n");
	const taskDir = join(workDir, ".omp", "missions", batchId, "tasks", "T-1");
	mkdirSync(taskDir, { recursive: true });
	writeFileSync(join(taskDir, "STATUS.md"), statusMdBody);

	writeMission(batchId, {
		description: "enrichment test",
		mode: "simple",
		phases: [{ name: "Plan", emoji: "P", status: "active" }],
		autonomy: "high",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: "2025-01-01T10:00:00Z",
		kind: "batch",
		batch: {
			batchId,
			phase: "running",
			waves: [{ wave: 0, taskIds: ["T-1"] }],
			currentWave: 0,
			laneCount: 1,
			laneStatuses: [
				{ lane: 1, taskId: "T-1", status: "running", stepProgress: "", iteration: 1, elapsed: 0, sessionName: "s" },
			],
			tasks: [
				{
					taskId: "T-1",
					status: "running",
					startTime: null,
					endTime: null,
					exitReason: "",
					sessionName: "s",
					doneFileFound: false,
				},
			],
			tasksTotal: 1,
			tasksComplete: 0,
			tasksFailed: 0,
			startTime: 0,
			errors: [],
		},
	});

	const res = await fetch(`${baseUrl}/api/mission/${batchId}`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		state: {
			batch: {
				tasks: Array<{
					taskId: string;
					statusData?: {
						checked: number;
						total: number;
						currentStep?: string;
						iteration: number;
						reviews: number;
					};
				}>;
			};
		};
	};
	const task = body.state.batch.tasks.find(t => t.taskId === "T-1");
	expect(task?.statusData).toBeDefined();
	expect(task?.statusData).toMatchObject({
		checked: 2,
		total: 3,
		iteration: 2,
		reviews: 1,
	});
	// currentStep resolves to the first in-progress step; Step 2 is in-progress.
	expect(task?.statusData?.currentStep).toBe("Review");
});

test("GET /api/mission/:id leaves simple missions untouched by enrichment", async () => {
	writeMission("simple-no-status", {
		description: "simple",
		mode: "simple",
		phases: [{ name: "Plan", emoji: "P", status: "active" }],
		autonomy: "high",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: "2025-01-01T10:00:00Z",
		kind: "simple",
	});

	const res = await fetch(`${baseUrl}/api/mission/simple-no-status`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as { state: { batch?: unknown } };
	expect(body.state.batch).toBeUndefined();
});

// ---------------------------------------------------------------------------
// G9 Mission List — aggregate task counts + cost
// ---------------------------------------------------------------------------

test("GET /api/missions exposes task counts + aggregate cost for batch missions", async () => {
	writeMission("g9-batch", {
		description: "batch with telemetry",
		mode: "simple",
		startedAt: "2025-01-02T10:00:00Z",
		kind: "batch",
		batch: {
			batchId: "g9-batch",
			phase: "running",
			waves: [{ wave: 0, taskIds: ["T-1", "T-2"] }],
			currentWave: 0,
			laneCount: 2,
			laneStatuses: [],
			tasks: [
				{
					taskId: "T-1",
					status: "succeeded",
					startTime: 0,
					endTime: 1,
					exitReason: "",
					sessionName: "s1",
					doneFileFound: true,
					telemetry: {
						inputTokens: 1000,
						outputTokens: 400,
						cacheReadTokens: 50,
						cacheWriteTokens: 20,
						costUsd: 0.03,
						toolCalls: 3,
						durationMs: 1000,
					},
				},
				{
					taskId: "T-2",
					status: "failed",
					startTime: 0,
					endTime: 1,
					exitReason: "timeout",
					sessionName: "s2",
					doneFileFound: false,
					telemetry: {
						inputTokens: 500,
						outputTokens: 200,
						cacheReadTokens: 10,
						cacheWriteTokens: 5,
						costUsd: 0.02,
						toolCalls: 1,
						durationMs: 500,
					},
				},
			],
			tasksTotal: 2,
			tasksComplete: 1,
			tasksFailed: 1,
			startTime: 0,
			errors: [],
		},
	});

	const res = await fetch(`${baseUrl}/api/missions`);
	expect(res.status).toBe(200);
	const summaries = (await res.json()) as Array<{
		id: string;
		tasksTotal?: number;
		tasksComplete?: number;
		tasksFailed?: number;
		cost?: number;
		aggregateTokens?: {
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
		};
	}>;
	const found = summaries.find(m => m.id === "g9-batch");
	expect(found).toBeDefined();
	expect(found?.tasksTotal).toBe(2);
	expect(found?.tasksComplete).toBe(1);
	expect(found?.tasksFailed).toBe(1);
	expect(found?.cost).toBeCloseTo(0.05, 5);
	expect(found?.aggregateTokens).toEqual({
		inputTokens: 1500,
		outputTokens: 600,
		cacheReadTokens: 60,
		cacheWriteTokens: 25,
	});
});

test("GET /api/missions omits aggregate fields for batch with no telemetry", async () => {
	writeMission("g9-batch-empty", {
		description: "batch no telemetry",
		mode: "simple",
		startedAt: "2025-01-02T10:00:00Z",
		kind: "batch",
		batch: {
			batchId: "g9-batch-empty",
			phase: "running",
			waves: [{ wave: 0, taskIds: ["T-1"] }],
			currentWave: 0,
			laneCount: 1,
			laneStatuses: [],
			tasks: [
				{
					taskId: "T-1",
					status: "running",
					startTime: null,
					endTime: null,
					exitReason: "",
					sessionName: "s",
					doneFileFound: false,
				},
			],
			tasksTotal: 1,
			tasksComplete: 0,
			tasksFailed: 0,
			startTime: 0,
			errors: [],
		},
	});
	const res = await fetch(`${baseUrl}/api/missions`);
	const summaries = (await res.json()) as Array<{ id: string; aggregateTokens?: unknown; cost?: unknown }>;
	const found = summaries.find(m => m.id === "g9-batch-empty");
	expect(found?.aggregateTokens).toBeUndefined();
	expect(found?.cost).toBeUndefined();
});

// ---------------------------------------------------------------------------
// G4 Supervisor detail endpoint
// ---------------------------------------------------------------------------

function writeSupervisorFile(relPath: string, content: string): void {
	const dir = join(workDir, ".omp", "supervisor");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, relPath), content);
}

test("GET /api/supervisor/detail returns inactive state with no lockfile", async () => {
	const res = await fetch(`${baseUrl}/api/supervisor/detail`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		status: { state: string; lock: unknown };
		conversation: unknown[];
		timeline: unknown[];
		summary: string | null;
	};
	expect(body.status.state).toBe("inactive");
	expect(body.status.lock).toBeNull();
	expect(body.conversation).toEqual([]);
	expect(body.summary).toBeNull();
});

test("GET /api/supervisor/detail reports active lock + conversation + summary + timeline", async () => {
	const heartbeat = new Date().toISOString();
	writeSupervisorFile(
		"lock.json",
		JSON.stringify({
			pid: 12345,
			sessionId: "sup-abc",
			batchId: "g4-batch",
			startedAt: heartbeat,
			heartbeat,
		}),
	);
	writeSupervisorFile(
		"conversation.jsonl",
		`${JSON.stringify({ ts: heartbeat, role: "operator", content: "status?" })}\n${JSON.stringify({ ts: heartbeat, role: "supervisor", content: "all good" })}\n`,
	);
	writeSupervisorFile(
		"actions.jsonl",
		`${JSON.stringify({ ts: heartbeat, batchId: "g4-batch", action: "retry_lane", classification: "tier0_known", context: "", command: "", result: "success", detail: "retried lane 1", laneNumber: 1 })}\n`,
	);
	writeSupervisorFile(
		"events.jsonl",
		`${JSON.stringify({ timestamp: heartbeat, type: "tier0_recovery_attempt", batchId: "g4-batch", waveIndex: 0, pattern: "stall", attempt: 1, maxAttempts: 3, taskId: "T-1" })}\n`,
	);
	writeSupervisorFile("summary.md", "# Batch Summary\n\n- [x] first item\n- [ ] second item\n");

	const res = await fetch(`${baseUrl}/api/supervisor/detail?batchId=g4-batch`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		status: { state: string; lock: { batchId: string }; heartbeatAgeMs: number | null };
		conversation: Array<{ role: string; content: string }>;
		timeline: Array<{ action: string; label: string; tier: number; taskId?: string }>;
		summary: string | null;
	};
	expect(body.status.state).toBe("active");
	expect(body.status.lock?.batchId).toBe("g4-batch");
	expect(body.conversation.length).toBe(2);
	expect(body.conversation[0].role).toBe("operator");
	expect(body.conversation[1].role).toBe("supervisor");
	expect(body.summary).toContain("Batch Summary");
	expect(body.timeline.length).toBe(2);
	const t1 = body.timeline.find(t => t.tier === 1);
	const t0 = body.timeline.find(t => t.tier === 0);
	expect(t1?.action).toBe("retry_lane");
	expect(t1?.label).toBe("Retry lane");
	expect(t0?.action).toBe("tier0_recovery_attempt");
	expect(t0?.taskId).toBe("T-1");
});

test("GET /api/supervisor/detail marks lock as stale beyond threshold", async () => {
	const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
	writeSupervisorFile(
		"lock.json",
		JSON.stringify({
			pid: 1,
			sessionId: "old-session",
			batchId: "stale-batch",
			startedAt: oldTs,
			heartbeat: oldTs,
		}),
	);
	const res = await fetch(`${baseUrl}/api/supervisor/detail?batchId=stale-batch`);
	const body = (await res.json()) as { status: { state: string; heartbeatAgeMs: number | null } };
	expect(body.status.state).toBe("stale");
	expect(body.status.heartbeatAgeMs).toBeGreaterThan(0);
});

test("POST /api/supervisor/send appends operator entries to conversation.jsonl", async () => {
	// Cleanup conversation.jsonl so preceding tests don't colour this assertion.
	const convPath = join(workDir, ".omp", "supervisor", "conversation.jsonl");
	try {
		rmSync(convPath, { force: true });
	} catch {}

	const res = await fetch(`${baseUrl}/api/supervisor/send`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ content: "hello from the start tab" }),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { ok: boolean };
	expect(body.ok).toBe(true);

	// The appended row is visible via /api/supervisor/detail.
	const detail = await fetch(`${baseUrl}/api/supervisor/detail`);
	const parsed = (await detail.json()) as { conversation: Array<{ role: string; content: string }> };
	const match = parsed.conversation.find(e => e.content === "hello from the start tab");
	expect(match).toBeTruthy();
	expect(match?.role).toBe("operator");
});

test("POST /api/supervisor/send rejects empty content with 400", async () => {
	const res = await fetch(`${baseUrl}/api/supervisor/send`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ content: "   " }),
	});
	expect(res.status).toBe(400);
	const body = (await res.json()) as { ok: boolean; reason?: string };
	expect(body.ok).toBe(false);
	expect(body.reason).toBe("empty_message");
});

test("GET /api/supervisor/detail skips malformed conversation lines", async () => {
	const ts = new Date().toISOString();
	// Line 2 is corrupt. A JSONL reader that parses the whole blob would
	// drop every entry; the line-by-line reader must preserve the valid two.
	writeSupervisorFile(
		"conversation.jsonl",
		[
			JSON.stringify({ ts, role: "operator", content: "first" }),
			"not json",
			JSON.stringify({ ts, role: "supervisor", content: "second" }),
		].join("\n"),
	);
	const res = await fetch(`${baseUrl}/api/supervisor/detail`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as { conversation: Array<{ role: string; content: string }> };
	expect(body.conversation.length).toBe(2);
	expect(body.conversation[0].content).toBe("first");
	expect(body.conversation[1].content).toBe("second");
});

// ---------------------------------------------------------------------------
// G6 History detail — extended shape
// ---------------------------------------------------------------------------

test("GET /api/history/:id returns full per-task + per-wave detail", async () => {
	const projectDir = join(workDir, ".omp");
	// Read existing history, add a richer entry, rewrite.
	const path = join(projectDir, "mission-history.json");
	const existing = JSON.parse(await Bun.file(path).text()) as unknown[];
	existing.push({
		batchId: "g6-batch",
		description: "detailed history",
		status: "completed",
		startedAt: Date.parse("2025-01-02T10:00:00Z"),
		endedAt: Date.parse("2025-01-02T10:30:00Z"),
		durationMs: 30 * 60_000,
		totalWaves: 1,
		totalTasks: 2,
		succeededTasks: 2,
		failedTasks: 0,
		skippedTasks: 0,
		blockedTasks: 0,
		tokens: { input: 1000, output: 500, cacheRead: 100, cacheWrite: 50, costUsd: 0.12 },
		tasks: [
			{
				taskId: "T-1",
				taskName: "First",
				status: "succeeded",
				wave: 1,
				lane: 1,
				durationMs: 1000,
				tokens: { input: 500, output: 200, cacheRead: 50, cacheWrite: 20, costUsd: 0.05 },
				exitReason: null,
			},
			{
				taskId: "T-2",
				taskName: "Second",
				status: "succeeded",
				wave: 1,
				lane: 2,
				durationMs: 2000,
				tokens: { input: 500, output: 300, cacheRead: 50, cacheWrite: 30, costUsd: 0.07 },
				exitReason: null,
			},
		],
		waves: [
			{
				wave: 1,
				tasks: ["T-1", "T-2"],
				mergeStatus: "succeeded",
				durationMs: 2000,
				tokens: { input: 1000, output: 500, cacheRead: 100, cacheWrite: 50, costUsd: 0.12 },
			},
		],
	});
	writeFileSync(path, JSON.stringify(existing));

	const res = await fetch(`${baseUrl}/api/history/g6-batch`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		batchId: string;
		totalTasks?: number;
		succeededTasks?: number;
		tasks?: Array<{ taskId: string; status: string; lane: number; wave: number }>;
		waves?: Array<{ wave: number; tasks: string[]; mergeStatus: string }>;
		tokens?: { costUsd: number };
	};
	expect(body.totalTasks).toBe(2);
	expect(body.succeededTasks).toBe(2);
	expect(body.tasks?.length).toBe(2);
	expect(body.waves?.length).toBe(1);
	expect(body.waves?.[0].mergeStatus).toBe("succeeded");
	expect(body.tokens?.costUsd).toBeCloseTo(0.12, 5);
});

// ---------------------------------------------------------------------------
// G7 Errors + G8 Mailbox status
// ---------------------------------------------------------------------------

test("GET /api/mission/:id exposes batch.errors array", async () => {
	writeMission("g7-errors", {
		description: "with errors",
		mode: "simple",
		startedAt: "2025-01-02T10:00:00Z",
		kind: "batch",
		batch: {
			batchId: "g7-errors",
			phase: "error",
			waves: [],
			currentWave: 0,
			laneCount: 1,
			laneStatuses: [],
			tasks: [],
			tasksTotal: 0,
			tasksComplete: 0,
			tasksFailed: 0,
			startTime: 0,
			errors: ["err-a", "err-b"],
		},
	});
	const res = await fetch(`${baseUrl}/api/mission/g7-errors`);
	const body = (await res.json()) as { state: { batch: { errors: string[] } } };
	expect(body.state.batch.errors).toEqual(["err-a", "err-b"]);
});

test("GET /api/mailbox/events preserves event.type (for status badge mapping)", async () => {
	const dir = join(workDir, ".omp", "mailbox", "mb-1");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "events.jsonl"),
		`${JSON.stringify({ batchId: "mb-1", ts: Date.now(), type: "message_sent", from: "a", to: "b", messageType: "request", contentPreview: "hello" })}\n${JSON.stringify({ batchId: "mb-1", ts: Date.now(), type: "message_rate_limited", from: "a", reason: "throttled" })}\n`,
	);
	const res = await fetch(`${baseUrl}/api/mailbox/events?batchId=mb-1`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		events: Array<{ type?: string; messageType?: string; contentPreview?: string }>;
	};
	expect(body.events.length).toBe(2);
	expect(body.events[0].type).toBe("message_sent");
	expect(body.events[0].messageType).toBe("request");
	expect(body.events[1].type).toBe("message_rate_limited");
});

// ---------------------------------------------------------------------------
// Round 3 — dashboard parity with engine fields
// ---------------------------------------------------------------------------

interface TaskRecord {
	taskId: string;
	laneNumber: number;
	sessionName: string;
	status: "pending" | "running" | "succeeded" | "failed" | "stalled" | "skipped";
	taskFolder: string;
	startedAt: number | null;
	endedAt: number | null;
	doneFileFound: boolean;
	exitReason: string;
	repoId?: string;
	resolvedRepoId?: string;
	segmentIds?: string[];
	activeSegmentId?: string | null;
}

interface LaneRecord {
	laneNumber: number;
	laneId: string;
	laneSessionId: string;
	worktreePath: string;
	branch: string;
	taskIds: string[];
	repoId?: string;
}

interface PersistedBatchFixture {
	batchId: string;
	phase: string;
	mode: "repo" | "workspace";
	tasks: TaskRecord[];
	lanes: LaneRecord[];
	wavePlan: string[][];
	mergeResults?: Array<{
		waveIndex: number;
		status: "succeeded" | "failed" | "partial";
		failedLane: number | null;
		failureReason: string | null;
		repoResults?: Array<{
			repoId: string;
			status: "succeeded" | "failed" | "partial";
			laneNumbers: number[];
			failedLane: number | null;
			failureReason: string | null;
		}>;
	}>;
}

function writePersistedBatch(fixture: PersistedBatchFixture): void {
	const now = Date.now();
	const totalTasks = fixture.tasks.length;
	const succeeded = fixture.tasks.filter(t => t.status === "succeeded").length;
	const failed = fixture.tasks.filter(t => t.status === "failed").length;
	const persisted = {
		schemaVersion: 4,
		batchId: fixture.batchId,
		phase: fixture.phase,
		baseBranch: "main",
		orchBranch: "orch/main",
		mode: fixture.mode,
		startedAt: now - 60_000,
		updatedAt: now,
		endedAt: null,
		currentWaveIndex: 0,
		totalWaves: fixture.wavePlan.length,
		totalTasks,
		succeededTasks: succeeded,
		failedTasks: failed,
		skippedTasks: 0,
		blockedTasks: 0,
		blockedTaskIds: [] as string[],
		lanes: fixture.lanes,
		tasks: fixture.tasks,
		wavePlan: fixture.wavePlan,
		mergeResults: fixture.mergeResults ?? [],
		lastError: null as unknown,
		errors: [] as string[],
		resilience: {
			resumeForced: false,
			retryCountByScope: {} as Record<string, number>,
			lastFailureClass: null,
			repairHistory: [] as unknown[],
		},
		diagnostics: {
			taskExits: {} as Record<string, unknown>,
			batchCost: 0,
		},
		segments: [] as unknown[],
	};
	mkdirSync(join(workDir, ".omp"), { recursive: true });
	writeFileSync(join(workDir, ".omp", "mission-batch.json"), JSON.stringify(persisted));
}

function writeV2LaneSnapshot(batchId: string, laneNumber: number, snapshot: unknown): void {
	const dir = join(workDir, ".omp", "runtime", batchId, "lanes");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `lane-${laneNumber}.json`), JSON.stringify(snapshot));
}

function writeReviewerState(batchId: string, taskId: string, state: unknown): void {
	const dir = join(workDir, ".omp", "missions", batchId, "tasks", taskId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".reviewer-state.json"), JSON.stringify(state));
}

function writeMissionConfig(content: unknown): void {
	const dir = join(workDir, ".omp");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "mission.json"), JSON.stringify(content));
}

function minimalBatchMission(id: string, batchId: string, extras: Partial<Record<string, unknown>> = {}): void {
	writeMission(id, {
		description: "round3",
		mode: "simple",
		phases: [{ name: "Plan", emoji: "P", status: "active" }],
		autonomy: "high",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: "2025-01-01T10:00:00Z",
		kind: "batch",
		batch: {
			batchId,
			phase: "running",
			waves: [{ wave: 0, taskIds: ["T-1"] }],
			currentWave: 0,
			laneCount: 1,
			laneStatuses: [
				{
					lane: 1,
					taskId: "T-1",
					status: "running",
					stepProgress: "",
					iteration: 1,
					elapsed: 0,
					sessionName: "s",
				},
			],
			tasks: [
				{
					taskId: "T-1",
					status: "running",
					startTime: null,
					endTime: null,
					exitReason: "",
					sessionName: "s",
					doneFileFound: false,
				},
			],
			tasksTotal: 1,
			tasksComplete: 0,
			tasksFailed: 0,
			startTime: 0,
			errors: [],
			...extras,
		},
	});
}

test("GET /api/mission/:id exposes mode/repoId/segmentIds from persisted batch state", async () => {
	const batchId = "r3-workspace-1";
	minimalBatchMission(batchId, batchId);
	writePersistedBatch({
		batchId,
		phase: "executing",
		mode: "workspace",
		wavePlan: [["T-1"]],
		lanes: [
			{
				laneNumber: 1,
				laneId: "lane-1",
				laneSessionId: "mission-xy-lane-1",
				worktreePath: "/tmp/wt",
				branch: "orch/l-1",
				taskIds: ["T-1"],
				repoId: "frontend",
			},
		],
		tasks: [
			{
				taskId: "T-1",
				laneNumber: 1,
				sessionName: "mission-xy-lane-1",
				status: "running",
				taskFolder: "/tmp/tf",
				startedAt: null,
				endedAt: null,
				doneFileFound: false,
				exitReason: "",
				repoId: "backend",
				resolvedRepoId: "backend",
				segmentIds: ["T-1::backend", "T-1::frontend"],
				activeSegmentId: "T-1::backend",
			},
		],
	});
	const res = await fetch(`${baseUrl}/api/mission/${batchId}`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		state: {
			batch: {
				mode?: string;
				laneStatuses: Array<{ repoId?: string }>;
				tasks: Array<{
					taskId: string;
					repoId?: string;
					resolvedRepoId?: string;
					segmentIds?: string[];
					activeSegmentId?: string | null;
				}>;
			};
		};
	};
	expect(body.state.batch.mode).toBe("workspace");
	expect(body.state.batch.laneStatuses[0].repoId).toBe("frontend");
	const task = body.state.batch.tasks[0];
	expect(task.repoId).toBe("backend");
	expect(task.resolvedRepoId).toBe("backend");
	expect(task.segmentIds).toEqual(["T-1::backend", "T-1::frontend"]);
	expect(task.activeSegmentId).toBe("T-1::backend");
});

test("GET /api/mission/:id exposes mergeResults with per-repo sub-rows", async () => {
	const batchId = "r3-merge-1";
	minimalBatchMission(batchId, batchId);
	writePersistedBatch({
		batchId,
		phase: "executing",
		mode: "workspace",
		wavePlan: [["T-1"]],
		lanes: [
			{
				laneNumber: 1,
				laneId: "lane-1",
				laneSessionId: "mission-xy-lane-1",
				worktreePath: "/tmp/wt",
				branch: "orch/l-1",
				taskIds: ["T-1"],
			},
		],
		tasks: [
			{
				taskId: "T-1",
				laneNumber: 1,
				sessionName: "mission-xy-lane-1",
				status: "succeeded",
				taskFolder: "/tmp/tf",
				startedAt: 1,
				endedAt: 2,
				doneFileFound: true,
				exitReason: "",
			},
		],
		mergeResults: [
			{
				waveIndex: 0,
				status: "partial",
				failedLane: 2,
				failureReason: "conflict in frontend",
				repoResults: [
					{
						repoId: "backend",
						status: "succeeded",
						laneNumbers: [1],
						failedLane: null,
						failureReason: null,
					},
					{
						repoId: "frontend",
						status: "failed",
						laneNumbers: [2],
						failedLane: 2,
						failureReason: "conflict in frontend",
					},
				],
			},
		],
	});
	const res = await fetch(`${baseUrl}/api/mission/${batchId}`);
	const body = (await res.json()) as {
		state: {
			batch: {
				mergeResults?: Array<{
					waveIndex: number;
					status: string;
					failureReason?: string | null;
					repoResults?: Array<{ repoId?: string; status: string; laneNumbers: number[] }>;
				}>;
			};
		};
	};
	const mr = body.state.batch.mergeResults?.[0];
	expect(mr?.waveIndex).toBe(0);
	expect(mr?.status).toBe("partial");
	expect(mr?.failureReason).toBe("conflict in frontend");
	expect(mr?.repoResults?.length).toBe(2);
	expect(mr?.repoResults?.[0].repoId).toBe("backend");
	expect(mr?.repoResults?.[1].status).toBe("failed");
});

test("GET /api/mission/:id surfaces per-task contextPct/lastTool from V2 lane snapshot", async () => {
	const batchId = "r3-v2-snap";
	minimalBatchMission(batchId, batchId);
	writeV2LaneSnapshot(batchId, 1, {
		batchId,
		laneNumber: 1,
		laneId: "lane-1",
		repoId: "main",
		taskId: "T-1",
		segmentId: null,
		status: "running",
		worker: {
			agentId: "mission-xy-lane-1-worker",
			status: "running",
			elapsedMs: 12_000,
			toolCalls: 5,
			contextPct: 34.5,
			costUsd: 0.012,
			lastTool: "read src/main.ts",
			inputTokens: 2000,
			outputTokens: 500,
			cacheReadTokens: 100,
			cacheWriteTokens: 50,
		},
		reviewer: null,
		progress: null,
		updatedAt: Date.now(),
	});
	const res = await fetch(`${baseUrl}/api/mission/${batchId}`);
	const body = (await res.json()) as {
		state: {
			batch: {
				tasks: Array<{ taskId: string; telemetry?: { contextPct?: number; lastTool?: string } }>;
			};
		};
	};
	const task = body.state.batch.tasks.find(t => t.taskId === "T-1");
	expect(task?.telemetry?.contextPct).toBe(34.5);
	expect(task?.telemetry?.lastTool).toBe("read src/main.ts");
});

test("GET /api/mission/:id exposes reviewer sub-row from V2 snapshot", async () => {
	const batchId = "r3-reviewer-v2";
	minimalBatchMission(batchId, batchId);
	writeV2LaneSnapshot(batchId, 1, {
		batchId,
		laneNumber: 1,
		laneId: "lane-1",
		repoId: "main",
		taskId: "T-1",
		segmentId: null,
		status: "running",
		worker: null,
		reviewer: {
			agentId: "mission-xy-lane-1-reviewer",
			status: "running",
			elapsedMs: 4_000,
			toolCalls: 2,
			contextPct: 12.1,
			costUsd: 0.004,
			lastTool: "read reviews/step-1.md",
			inputTokens: 400,
			outputTokens: 200,
			cacheReadTokens: 20,
			cacheWriteTokens: 10,
		},
		progress: null,
		updatedAt: Date.now(),
	});
	const res = await fetch(`${baseUrl}/api/mission/${batchId}`);
	const body = (await res.json()) as {
		state: {
			batch: {
				laneStatuses: Array<{
					lane: number;
					reviewer?: { active: boolean; toolCalls?: number; contextPct?: number; lastTool?: string };
				}>;
			};
		};
	};
	const lane = body.state.batch.laneStatuses[0];
	expect(lane.reviewer?.active).toBe(true);
	expect(lane.reviewer?.toolCalls).toBe(2);
	expect(lane.reviewer?.contextPct).toBe(12.1);
	expect(lane.reviewer?.lastTool).toBe("read reviews/step-1.md");
});

test("GET /api/mission/:id falls back to .reviewer-state.json when V2 reviewer missing", async () => {
	const batchId = "r3-reviewer-fs";
	minimalBatchMission(batchId, batchId);
	writeReviewerState(batchId, "T-1", {
		status: "running",
		elapsedMs: 8_000,
		toolCalls: 4,
		contextPct: 22.2,
		costUsd: 0.008,
		lastTool: "grep security/*",
		inputTokens: 800,
		outputTokens: 300,
		cacheReadTokens: 40,
		cacheWriteTokens: 20,
		updatedAt: Date.now(),
		reviewType: "step-review",
		reviewStep: 2,
	});
	writeV2LaneSnapshot(batchId, 1, {
		batchId,
		laneNumber: 1,
		laneId: "lane-1",
		repoId: "main",
		taskId: "T-1",
		segmentId: null,
		status: "running",
		worker: null,
		reviewer: null,
		progress: null,
		updatedAt: Date.now(),
	});
	const res = await fetch(`${baseUrl}/api/mission/${batchId}`);
	const body = (await res.json()) as {
		state: {
			batch: {
				laneStatuses: Array<{
					reviewer?: { active: boolean; reviewType?: string; reviewStep?: number; lastTool?: string };
				}>;
			};
		};
	};
	const reviewer = body.state.batch.laneStatuses[0].reviewer;
	expect(reviewer?.active).toBe(true);
	expect(reviewer?.reviewType).toBe("step-review");
	expect(reviewer?.reviewStep).toBe(2);
	expect(reviewer?.lastTool).toBe("grep security/*");
});

test("GET /api/supervisor/detail surfaces autonomy from mission config", async () => {
	writeMissionConfig({
		configVersion: 1,
		orchestrator: {
			supervisor: {
				model: "",
				autonomy: "autonomous",
			},
		},
	});
	const res = await fetch(`${baseUrl}/api/supervisor/detail`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		status: { state: string; autonomy?: string };
	};
	expect(body.status.autonomy).toBe("autonomous");
});

test("GET /api/conversation/:laneId/events parses JSONL events", async () => {
	const batchId = "r3-conv-events";
	const dir = join(workDir, ".omp", "missions", batchId, "lanes", "lane-1");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "conversation.jsonl"),
		[
			JSON.stringify({ ts: 1000, type: "tool_execution_start", toolName: "read", argsPreview: "src/foo.ts" }),
			JSON.stringify({ ts: 2000, type: "message_end", role: "assistant", text: "hello" }),
			JSON.stringify({ ts: 3000, type: "auto_retry_start", attempt: 1, maxAttempts: 3 }),
		].join("\n"),
	);
	const res = await fetch(`${baseUrl}/api/conversation/${batchId}:lane-1/events`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as { events: Array<{ type: string; ts: number; toolName?: string; role?: string }> };
	expect(body.events.length).toBe(3);
	expect(body.events[0].type).toBe("tool_execution_start");
	expect(body.events[0].toolName).toBe("read");
	expect(body.events[1].role).toBe("assistant");
	expect(body.events[2].type).toBe("auto_retry_start");
});

// ---------------------------------------------------------------------------
// Round 4: /mission integration + preferences endpoints
// ---------------------------------------------------------------------------

test("GET /api/mission-gui/token returns 404 when no default bridge is registered", async () => {
	removeDefaultBridge();
	const res = await fetch(`${baseUrl}/api/mission-gui/token`);
	expect(res.status).toBe(404);
});

test("GET /api/mission-gui/token returns the default bridge token when registered", async () => {
	const token = registerDefaultBridge(() => {});
	try {
		const res = await fetch(`${baseUrl}/api/mission-gui/token`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { token: string; kind: string };
		expect(body.token).toBe(token);
		expect(body.kind).toBe("default");
	} finally {
		removeDefaultBridge();
	}
});

test("POST /api/mission/start accepts the default bridge token and fires the handler", async () => {
	const received: string[] = [];
	registerDefaultBridge(req => {
		received.push(req.description);
	});
	try {
		const tokenRes = await fetch(`${baseUrl}/api/mission-gui/token`);
		const { token } = (await tokenRes.json()) as { token: string };
		const res = await fetch(`${baseUrl}/api/mission/start`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				token,
				templateKey: "minimal",
				description: "default bridge mission",
				autonomy: "medium",
				modelAssignment: { planner: "claude-sonnet-4-6", worker: "claude-sonnet-4-6" },
			}),
		});
		expect(res.status).toBe(202);
		const body = (await res.json()) as { ok: boolean; kind?: string };
		expect(body.ok).toBe(true);
		expect(body.kind).toBe("default");
		await Bun.sleep(10);
		expect(received).toEqual(["default bridge mission"]);

		// Default bridges persist across submits — a second token request must
		// still resolve to the same token.
		const tokenRes2 = await fetch(`${baseUrl}/api/mission-gui/token`);
		const { token: sameToken } = (await tokenRes2.json()) as { token: string };
		expect(sameToken).toBe(token);
	} finally {
		removeDefaultBridge();
	}
});

test("POST /api/mission/:id/redirect dispatches through the redirect hook", async () => {
	const calls: string[] = [];
	setMissionServerHooks({
		redirect: (msg: string) => {
			calls.push(msg);
			return { ok: true };
		},
	});
	try {
		const res = await fetch(`${baseUrl}/api/mission/active-session/redirect`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "please pivot to phase B" }),
		});
		expect(res.status).toBe(200);
		expect(calls).toEqual(["please pivot to phase B"]);
	} finally {
		clearMissionServerHooks();
	}
});

test("POST /api/mission/:id/redirect returns 400 on empty message", async () => {
	setMissionServerHooks({
		redirect: () => ({ ok: true }),
	});
	try {
		const res = await fetch(`${baseUrl}/api/mission/active-session/redirect`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: " " }),
		});
		expect(res.status).toBe(400);
	} finally {
		clearMissionServerHooks();
	}
});

test("POST /api/mission/:id/skip-phase calls the skipPhase hook and surfaces completedPhaseName", async () => {
	setMissionServerHooks({
		skipPhase: () => ({ ok: true, completedPhaseName: "Plan" }),
	});
	try {
		const res = await fetch(`${baseUrl}/api/mission/active-session/skip-phase`, { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; completedPhaseName?: string };
		expect(body.ok).toBe(true);
		expect(body.completedPhaseName).toBe("Plan");
	} finally {
		clearMissionServerHooks();
	}
});

test("PATCH /api/mission/:id calls the patchMission hook with the request body", async () => {
	const received: Array<Record<string, unknown>> = [];
	setMissionServerHooks({
		patchMission: patch => {
			received.push(patch as unknown as Record<string, unknown>);
			return { ok: true };
		},
	});
	try {
		const res = await fetch(`${baseUrl}/api/mission/active-session`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ autonomy: "high", constraints: "keep auth module intact" }),
		});
		expect(res.status).toBe(200);
		expect(received).toEqual([{ autonomy: "high", constraints: "keep auth module intact" }]);
	} finally {
		clearMissionServerHooks();
	}
});

test("PATCH /api/mission/:id returns 503 when no patchMission hook is set", async () => {
	clearMissionServerHooks();
	const res = await fetch(`${baseUrl}/api/mission/active-session`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ autonomy: "low" }),
	});
	expect(res.status).toBe(503);
});

test("GET /api/preferences returns {} when the file is missing", async () => {
	const res = await fetch(`${baseUrl}/api/preferences`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body).toEqual({});
});

test("POST /api/preferences merges and persists values", async () => {
	const res = await fetch(`${baseUrl}/api/preferences`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ theme: "dark", lastSelectedMissionId: "abc" }),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { ok: boolean; preferences: { theme?: string; lastSelectedMissionId?: string } };
	expect(body.ok).toBe(true);
	expect(body.preferences.theme).toBe("dark");
	expect(body.preferences.lastSelectedMissionId).toBe("abc");

	// Second POST merges only the supplied fields.
	const res2 = await fetch(`${baseUrl}/api/preferences`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ theme: "light" }),
	});
	expect(res2.status).toBe(200);
	const body2 = (await res2.json()) as { preferences: { theme?: string; lastSelectedMissionId?: string } };
	expect(body2.preferences.theme).toBe("light");
	expect(body2.preferences.lastSelectedMissionId).toBe("abc");
});

// ---------------------------------------------------------------------------
// GET /api/agent-events/:agentId (Runtime V2 event stream) — round 5
// ---------------------------------------------------------------------------

function cleanupActiveBatch(): void {
	try {
		rmSync(join(workDir, ".omp", "mission-batch.json"), { force: true });
	} catch {}
}

function writeActiveBatchMission(batchId: string): void {
	// Minimal MissionState shape that loadActiveBatch + activeBatchId(server)
	// can read: must have `.batch.batchId` after JSON.parse.
	const state = {
		id: batchId,
		description: "round5-agent-events",
		mode: "simple",
		phases: [{ name: "Plan", emoji: "P", status: "active" }],
		autonomy: "high",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: "2025-01-01T10:00:00Z",
		kind: "batch",
		batch: { batchId, phase: "running", laneCount: 1 },
	};
	mkdirSync(join(workDir, ".omp"), { recursive: true });
	writeFileSync(join(workDir, ".omp", "mission-batch.json"), JSON.stringify(state));
}

function writeRuntimeAgentEvents(batchId: string, agentId: string, events: Array<Record<string, unknown>>): void {
	const dir = join(workDir, ".omp", "runtime", batchId, "agents", agentId);
	mkdirSync(dir, { recursive: true });
	const body = events.map(e => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : "");
	writeFileSync(join(dir, "events.jsonl"), body);
}

test("GET /api/agent-events/:agentId returns 404 when no batch is active", async () => {
	cleanupActiveBatch();
	const res = await fetch(`${baseUrl}/api/agent-events/some-agent`);
	expect(res.status).toBe(404);
});

test("GET /api/agent-events/:agentId rejects invalid agent ids with 400", async () => {
	writeActiveBatchMission("mb-agent-events-invalid");
	try {
		// Characters outside [\w-]: dot, space. Both must reject as 400 since
		// the batch exists — ruling out the 404 early-exit path.
		const bad1 = await fetch(`${baseUrl}/api/agent-events/${encodeURIComponent("foo.bar")}`);
		expect(bad1.status).toBe(400);
		const bad2 = await fetch(`${baseUrl}/api/agent-events/${encodeURIComponent("foo bar")}`);
		expect(bad2.status).toBe(400);
	} finally {
		cleanupActiveBatch();
	}
});

test("GET /api/agent-events/:agentId returns events for a seeded agent", async () => {
	const batchId = "mb-agent-events-1";
	const agentId = "mb-agent-events-1-lane-1-worker";
	writeActiveBatchMission(batchId);
	try {
		writeRuntimeAgentEvents(batchId, agentId, [
			{ ts: 1000, type: "agent_started", payload: {} },
			{ ts: 2000, type: "assistant_message", payload: { text: "hi" } },
			{ ts: 3000, type: "agent_exited", payload: { exitCode: 0 } },
		]);
		const res = await fetch(`${baseUrl}/api/agent-events/${agentId}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { events: Array<{ ts: number; type: string }> };
		expect(body.events.length).toBe(3);
		expect(body.events.map(e => e.type)).toEqual(["agent_started", "assistant_message", "agent_exited"]);
	} finally {
		cleanupActiveBatch();
	}
});

test("GET /api/agent-events/:agentId?sinceTs=N drops older events", async () => {
	const batchId = "mb-agent-events-2";
	const agentId = "mb-agent-events-2-lane-1-worker";
	writeActiveBatchMission(batchId);
	try {
		writeRuntimeAgentEvents(batchId, agentId, [
			{ ts: 1000, type: "agent_started" },
			{ ts: 2000, type: "assistant_message" },
			{ ts: 3000, type: "agent_exited" },
		]);
		const res = await fetch(`${baseUrl}/api/agent-events/${agentId}?sinceTs=1500`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { events: Array<{ ts: number; type: string }> };
		// Strictly greater than sinceTs: 2000 and 3000 stay; 1000 drops.
		expect(body.events.map(e => e.ts)).toEqual([2000, 3000]);
	} finally {
		cleanupActiveBatch();
	}
});

// ---------------------------------------------------------------------------
// Mailbox live poll — proves that events appended *after* the server boots
// surface on the next fetch (the contract the MailboxPanel's 2s poll relies
// on). Uses the real `appendMailboxAuditEvent` writer, not hand-crafted JSON.
// ---------------------------------------------------------------------------

test("mailbox live poll: each audit-event type survives round-trip", async () => {
	const batchId = "mb-live-1";
	appendMailboxAuditEvent(workDir, batchId, {
		type: "message_sent",
		from: "supervisor",
		to: "lane-1",
		messageId: "live-1",
		messageType: "steer",
		contentPreview: "focus on VA-005",
	});
	appendMailboxAuditEvent(workDir, batchId, {
		type: "message_delivered",
		from: "supervisor",
		to: "lane-1",
		messageId: "live-1",
	});
	appendMailboxAuditEvent(workDir, batchId, {
		type: "message_replied",
		from: "lane-1",
		to: "supervisor",
		messageId: "live-1",
		messageType: "reply",
		contentPreview: "acknowledged",
	});
	appendMailboxAuditEvent(workDir, batchId, {
		type: "message_escalated",
		from: "lane-1",
		to: "supervisor",
		messageId: "live-2",
		messageType: "escalate",
		contentPreview: "blocked on repo-3",
	});
	appendMailboxAuditEvent(workDir, batchId, {
		type: "message_rate_limited",
		from: "supervisor",
		to: "lane-1",
		reason: "cooldown",
		retryAfterMs: 5_000,
	});

	const res = await fetch(`${baseUrl}/api/mailbox/events?batchId=${batchId}`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		events: Array<{ type?: string; messageId?: string; reason?: string; retryAfterMs?: number }>;
	};
	expect(body.events.length).toBe(5);
	// Server preserves append order (oldest first). The MailboxPanel reverses
	// client-side, so the server contract is oldest-first.
	expect(body.events.map(e => e.type)).toEqual([
		"message_sent",
		"message_delivered",
		"message_replied",
		"message_escalated",
		"message_rate_limited",
	]);
	expect(body.events[4].reason).toBe("cooldown");
	expect(body.events[4].retryAfterMs).toBe(5_000);
});

test("mailbox live poll: delta surfaces on next fetch", async () => {
	const batchId = "mb-live-2";
	appendMailboxAuditEvent(workDir, batchId, {
		type: "message_sent",
		from: "supervisor",
		to: "lane-1",
		messageId: "initial-1",
	});
	appendMailboxAuditEvent(workDir, batchId, {
		type: "message_delivered",
		from: "supervisor",
		to: "lane-1",
		messageId: "initial-1",
	});

	const first = await fetch(`${baseUrl}/api/mailbox/events?batchId=${batchId}`);
	const firstBody = (await first.json()) as { events: Array<{ messageId?: string }> };
	expect(firstBody.events.length).toBe(2);
	const initialCount = firstBody.events.length;

	// Two more events written *after* the server has served a fetch for this
	// batch — proves the reader reads fresh state every call (no caching).
	appendMailboxAuditEvent(workDir, batchId, {
		type: "message_sent",
		from: "supervisor",
		to: "lane-2",
		messageId: "delta-1",
		messageType: "info",
		contentPreview: "new after first fetch",
	});
	appendMailboxAuditEvent(workDir, batchId, {
		type: "message_delivered",
		from: "supervisor",
		to: "lane-2",
		messageId: "delta-1",
	});

	const second = await fetch(`${baseUrl}/api/mailbox/events?batchId=${batchId}`);
	const secondBody = (await second.json()) as {
		events: Array<{ messageId?: string; type?: string }>;
	};
	expect(secondBody.events.length).toBe(initialCount + 2);
	// Delta at the tail — newer events written last, returned last (oldest-first).
	expect(secondBody.events[secondBody.events.length - 2].messageId).toBe("delta-1");
	expect(secondBody.events[secondBody.events.length - 2].type).toBe("message_sent");
	expect(secondBody.events[secondBody.events.length - 1].messageId).toBe("delta-1");
	expect(secondBody.events[secondBody.events.length - 1].type).toBe("message_delivered");
});

// ---------------------------------------------------------------------------
// list missions: V5 PersistedBatchState active batch visibility
//
// Regression for the active-tab page-swap layout feature: when the engine
// has written a V5 `PersistedBatchState` to `.omp/mission-batch.json` but
// the MissionState archive under `.omp/missions/<id>.json` has not yet been
// written, the mission must still appear in /api/missions with correct
// status + task counts. Previously `readActiveBatch()` short-circuited on
// the V5 shape and returned null, hiding the active batch from the list.
// ---------------------------------------------------------------------------

test("list missions: V5 active batch is visible with correct status and counts", async () => {
	const batchId = "v5-active-visible";
	// Wipe any leftover mission archive from earlier tests.
	try {
		rmSync(join(workDir, ".omp", "missions", `${batchId}.json`), { force: true });
	} catch {}
	writePersistedBatch({
		batchId,
		phase: "executing",
		mode: "repo",
		wavePlan: [["T-1", "T-2"]],
		lanes: [
			{
				laneNumber: 1,
				laneId: "lane-1",
				laneSessionId: "mission-v5-lane-1",
				worktreePath: "/tmp/wt",
				branch: "orch/l-1",
				taskIds: ["T-1"],
			},
			{
				laneNumber: 2,
				laneId: "lane-2",
				laneSessionId: "mission-v5-lane-2",
				worktreePath: "/tmp/wt",
				branch: "orch/l-2",
				taskIds: ["T-2"],
			},
		],
		tasks: [
			{
				taskId: "T-1",
				laneNumber: 1,
				sessionName: "mission-v5-lane-1",
				status: "succeeded",
				taskFolder: "/tmp/tf",
				startedAt: 1,
				endedAt: 2,
				doneFileFound: true,
				exitReason: "",
			},
			{
				taskId: "T-2",
				laneNumber: 2,
				sessionName: "mission-v5-lane-2",
				status: "running",
				taskFolder: "/tmp/tf",
				startedAt: 3,
				endedAt: null,
				doneFileFound: false,
				exitReason: "",
			},
		],
	});
	try {
		const res = await fetch(`${baseUrl}/api/missions`);
		expect(res.status).toBe(200);
		const summaries = (await res.json()) as Array<{
			id: string;
			kind: string;
			status: string;
			tasksTotal?: number;
			tasksComplete?: number;
			batchPhase?: string;
		}>;
		const found = summaries.find(m => m.id === batchId);
		expect(found).toBeDefined();
		expect(found?.kind).toBe("batch");
		// executing → running wire phase → active list status.
		expect(found?.status).toBe("active");
		expect(found?.batchPhase).toBe("running");
		expect(found?.tasksTotal).toBe(2);
		expect(found?.tasksComplete).toBe(1);
	} finally {
		cleanupActiveBatch();
	}
});

test("list missions: V5 paused batch surfaces with paused status", async () => {
	const batchId = "v5-active-paused";
	try {
		rmSync(join(workDir, ".omp", "missions", `${batchId}.json`), { force: true });
	} catch {}
	writePersistedBatch({
		batchId,
		phase: "paused",
		mode: "repo",
		wavePlan: [["T-1"]],
		lanes: [
			{
				laneNumber: 1,
				laneId: "lane-1",
				laneSessionId: "mission-pz-lane-1",
				worktreePath: "/tmp/wt",
				branch: "orch/l-1",
				taskIds: ["T-1"],
			},
		],
		tasks: [
			{
				taskId: "T-1",
				laneNumber: 1,
				sessionName: "mission-pz-lane-1",
				status: "pending",
				taskFolder: "/tmp/tf",
				startedAt: null,
				endedAt: null,
				doneFileFound: false,
				exitReason: "",
			},
		],
	});
	try {
		const res = await fetch(`${baseUrl}/api/missions`);
		const summaries = (await res.json()) as Array<{ id: string; status: string; batchPhase?: string }>;
		const found = summaries.find(m => m.id === batchId);
		expect(found).toBeDefined();
		expect(found?.status).toBe("paused");
		expect(found?.batchPhase).toBe("paused");
	} finally {
		cleanupActiveBatch();
	}
});
