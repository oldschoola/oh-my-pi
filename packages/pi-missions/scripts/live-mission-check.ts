/**
 * Live end-to-end check: boot the dashboard server against a seeded sandbox
 * and exercise every critical dashboard endpoint. Proves that the panels
 * (Missions, Milestones, Validation Contract, Telemetry, Mailbox,
 * Supervisor) all see the same data the UI fetches.
 *
 * Usage:
 *
 *     bun run scripts/smoke-integration.ts /tmp/omp-live
 *     bun run scripts/live-mission-check.ts /tmp/omp-live
 *
 * Exits with code 0 when every assertion passes, 1 otherwise.
 */

import { appendMailboxAuditEvent } from "../src/missioncontrol/mailbox";
import { startServer } from "../src/server";

const cwd = process.argv[2];
if (!cwd) {
	console.error("Usage: bun run scripts/live-mission-check.ts <sandbox>");
	process.exit(1);
}

interface Result {
	label: string;
	ok: boolean;
	detail?: string;
}

const results: Result[] = [];

function assertTrue(ok: boolean, label: string, detail?: string): void {
	results.push({ label, ok, detail });
}

function assertEqual<T>(got: T, want: T, label: string): void {
	const ok = got === want;
	results.push({ label, ok, detail: ok ? undefined : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}` });
}

async function fetchJson<T>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url} -> ${res.status}`);
	return (await res.json()) as T;
}

const server = await startServer({ cwd, port: 0 });
const base = `http://localhost:${server.port}`;
console.log(`Live check: serving ${cwd} at ${base}`);

try {
	// --- /api/missions --------------------------------------------------
	const missions = await fetchJson<Array<{ id: string; description: string; status: string }>>(`${base}/api/missions`);
	assertEqual(missions.length, 1, "GET /api/missions returns exactly one mission");
	const mission = missions[0];
	assertTrue(
		typeof mission?.id === "string" && mission.id.length > 0,
		"mission.id is a non-empty string",
		`got ${JSON.stringify(mission?.id)}`,
	);
	assertTrue(
		typeof mission?.description === "string" &&
			mission.description.length > 0 &&
			mission.description !== "(no description)",
		"mission.description is populated (not the fallback placeholder)",
		`got ${JSON.stringify(mission?.description)}`,
	);

	const missionId = mission.id;

	// --- /api/mission/:id ----------------------------------------------
	const detail = await fetchJson<{
		id: string;
		state: {
			description: string;
			batch?: {
				phase: string;
				tasksTotal: number;
				tasks: unknown[];
			};
		};
	}>(`${base}/api/mission/${encodeURIComponent(missionId)}`);
	assertEqual(detail.id, missionId, "mission detail id matches");
	assertTrue(!!detail.state.batch, "mission detail has .state.batch");
	assertEqual(detail.state.batch?.phase, "complete", "batch phase is 'complete'");
	assertEqual(detail.state.batch?.tasksTotal, 4, "batch tasksTotal = 4");
	assertEqual(detail.state.batch?.tasks.length, 4, "batch tasks array length = 4");

	// --- /api/mission/:id/milestones -----------------------------------
	const milestonesBody = await fetchJson<{
		milestones: Array<{ id: string; status: string }>;
	}>(`${base}/api/mission/${encodeURIComponent(missionId)}/milestones`);
	const milestones = milestonesBody.milestones;
	assertEqual(milestones.length, 4, "milestones endpoint returns 4 rows (M-001..M-004)");
	const statusById = new Map(milestones.map(m => [m.id, m.status]));
	assertEqual(statusById.get("M-001"), "passed", "M-001 status = passed");
	assertEqual(statusById.get("M-002"), "in_progress", "M-002 status = in_progress");
	assertEqual(statusById.get("M-003"), "validating", "M-003 status = validating");
	assertEqual(statusById.get("M-004"), "failed", "M-004 status = failed");

	// --- /api/mission/:id/validation-contract --------------------------
	const contract = await fetchJson<{
		schemaVersion: number;
		assertions: Array<{ id: string; area: string; milestoneId?: string }>;
	} | null>(`${base}/api/mission/${encodeURIComponent(missionId)}/validation-contract`);
	assertTrue(contract !== null, "validation-contract endpoint returns non-null");
	assertEqual(contract?.schemaVersion, 1, "contract.schemaVersion = 1");
	assertEqual(contract?.assertions.length, 7, "contract has 7 assertions");
	const ids = new Set((contract?.assertions ?? []).map(a => a.id));
	for (const id of ["VA-001", "VA-002", "VA-003", "VA-004", "VA-005", "VA-006", "VA-007"]) {
		assertTrue(ids.has(id), `contract includes ${id}`);
	}
	const va005 = contract?.assertions.find(a => a.id === "VA-005");
	assertTrue(va005 !== undefined && !va005.milestoneId, "VA-005 is unbound (no milestoneId)");
	const va007 = contract?.assertions.find(a => a.id === "VA-007");
	assertEqual(va007?.milestoneId, "M-004", "VA-007 binds to M-004");

	// --- /api/mission/:id/validation-status ----------------------------
	const vstatus = await fetchJson<{
		rows: Array<{ milestone: { id: string }; boundAssertions: Array<{ id: string }> }>;
	} | null>(`${base}/api/mission/${encodeURIComponent(missionId)}/validation-status`);
	assertTrue(vstatus !== null, "validation-status endpoint returns non-null");
	const rowsByMs = new Map((vstatus?.rows ?? []).map(r => [r.milestone.id, r]));
	for (const id of ["M-001", "M-002", "M-003", "M-004"]) {
		const row = rowsByMs.get(id);
		assertTrue(!!row, `validation-status has row for ${id}`);
		assertTrue(
			(row?.boundAssertions?.length ?? 0) > 0,
			`${id} boundAssertions non-empty`,
			`got ${row?.boundAssertions?.length ?? 0}`,
		);
	}

	// --- /api/mission/:id/telemetry-rollup -----------------------------
	const rollup = await fetchJson<{
		perRole?: Array<{ role: string }>;
	} | null>(`${base}/api/mission/${encodeURIComponent(missionId)}/telemetry-rollup`);
	assertTrue(rollup !== null, "telemetry-rollup endpoint returns non-null");
	const roleSet = new Set((rollup?.perRole ?? []).map(r => r.role));
	for (const role of ["orchestrator", "worker", "scrutiny_validator", "user_testing_validator"]) {
		assertTrue(roleSet.has(role), `rollup.perRole contains ${role}`);
	}

	// --- /api/mailbox/events -------------------------------------------
	const mailbox = await fetchJson<{
		events: Array<{ type?: string }>;
	}>(`${base}/api/mailbox/events?batchId=${encodeURIComponent(missionId)}`);
	const initialCount = mailbox.events.length;
	assertTrue(initialCount >= 18, `mailbox events >= 18 (got ${initialCount})`);
	const typeSet = new Set(mailbox.events.map(e => e.type));
	for (const t of [
		"message_sent",
		"message_delivered",
		"message_replied",
		"message_escalated",
		"message_rate_limited",
	]) {
		assertTrue(typeSet.has(t), `mailbox has event type ${t}`);
	}

	// --- Live-append delta ---------------------------------------------
	// Proves the server reads fresh state every call — the 2s poll in the
	// MailboxPanel depends on this being a true round-trip, not a cached
	// snapshot.
	appendMailboxAuditEvent(cwd, missionId, {
		type: "message_sent",
		from: "supervisor",
		to: "lane-1",
		messageId: "live-check-1",
		messageType: "info",
		contentPreview: "live-check append #1",
	});
	appendMailboxAuditEvent(cwd, missionId, {
		type: "message_delivered",
		from: "supervisor",
		to: "lane-1",
		messageId: "live-check-1",
	});
	const mailboxAfter = await fetchJson<{
		events: Array<{ messageId?: string }>;
	}>(`${base}/api/mailbox/events?batchId=${encodeURIComponent(missionId)}`);
	assertEqual(
		mailboxAfter.events.length,
		initialCount + 2,
		"live-append delta: mailbox events grew by 2 after appendMailboxAuditEvent",
	);
	const hasLiveCheck = mailboxAfter.events.some(e => e.messageId === "live-check-1");
	assertTrue(hasLiveCheck, "live-append delta: new event surfaces in response");

	// --- /api/supervisor/detail ---------------------------------------
	const supervisor = await fetchJson<{
		status: { state: string; heartbeatAgeMs: number | null };
	}>(`${base}/api/supervisor/detail`);
	assertTrue(
		supervisor.status.state === "active" || supervisor.status.state === "stale",
		"supervisor state is active or stale (session present)",
		`got ${supervisor.status.state}`,
	);
	// In practice smoke-integration writes a fresh heartbeat; if the sandbox
	// is old the heartbeat could be stale — both are valid; we just want
	// the lockfile to exist. Treat a populated heartbeatAgeMs as evidence.
	assertTrue(supervisor.status.heartbeatAgeMs !== null, "supervisor heartbeat present");
} finally {
	server.stop();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

let fails = 0;
for (const r of results) {
	if (r.ok) {
		console.log(`[OK]   ${r.label}`);
	} else {
		fails += 1;
		console.log(`[FAIL] ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
	}
}

const summary = `\n${results.length - fails}/${results.length} passed, ${fails} failed`;
console.log(summary);
process.exit(fails === 0 ? 0 : 1);
