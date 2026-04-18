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
