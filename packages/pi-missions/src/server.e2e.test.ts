import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuiBridge, type MissionStartRequest } from "./gui-bridge";
import { startServer } from "./server";

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
