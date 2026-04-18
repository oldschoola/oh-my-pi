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
