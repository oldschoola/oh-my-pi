/**
 * End-to-end smoke for the V2 integration pass.
 *
 * Runs a real `createEngine` batch through `startLaneRunner` in stub-agent
 * mode, then seeds the remaining dashboard artefacts that stub mode cannot
 * produce on its own (real LLM-driven telemetry, per-role model config,
 * validation contract, v5 PersistedBatchState). Result: every dashboard
 * panel has something to render.
 *
 * Usage:
 *
 *     bun run scripts/smoke-integration.ts [sandboxDir]
 *
 * Defaults `sandboxDir` to `<tmpdir>/omp-smoke-<n>`. Follow with
 * `scripts/boot-server.ts <sandbox>` to serve the seeded state.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beginBatch, promoteToBatch } from "../src/missioncontrol/engine";
import { startLaneRunner } from "../src/missioncontrol/lane-runner";
import { appendMailboxAuditEvent, writeBroadcastMessage, writeMailboxMessage } from "../src/missioncontrol/mailbox";
import {
	buildRegistrySnapshot,
	readRegistrySnapshot,
	writeRegistrySnapshot,
} from "../src/missioncontrol/process-registry";
import { activateSupervisor, deactivateSupervisor, writeLockfile } from "../src/missioncontrol/supervisor";
import { DEFAULT_MISSIONCONTROL_CONFIG } from "../src/missioncontrol/types";
import type { MissionState, TaskOutcome, TaskTelemetry } from "../src/types";

process.env.OMP_MISSION_STUB_AGENT = "1";

const sandbox = process.argv[2] ? process.argv[2] : mkdtempSync(join(tmpdir(), "omp-smoke-"));

console.log(`Sandbox: ${sandbox}`);

function baseMission(): MissionState {
	return {
		description: "Smoke integration: ship the V2 dashboard wire-up",
		mode: "simple",
		phases: [],
		autonomy: "auto",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: new Date().toISOString(),
	};
}

let state: MissionState = promoteToBatch(
	baseMission(),
	{ taskIds: ["T-001", "T-002", "T-003", "T-004"], laneCount: 2, waveSize: 2 },
	DEFAULT_MISSIONCONTROL_CONFIG,
);
state = beginBatch(state);
const batchId = state.batch?.batchId;
if (!batchId) throw new Error("batchId missing after beginBatch");
console.log(`Batch:    ${batchId}`);

// 1. Activate supervisor so the lockfile + heartbeat exist for the panel.
const supervisor = activateSupervisor(sandbox, batchId);
console.log(`Supervisor lockfile: written (session=${supervisor.sessionId})`);

// 2. Seed a realistic mailbox dialogue so the Mailbox panel demonstrates
//    every audit-event flavour (sent / delivered / replied / escalated /
//    rate-limited) across a supervisor ↔ lane back-and-forth.
const mailboxStart = Date.now() - 180_000;
const mailboxLog: Array<{
	offsetMs: number;
	type: "message_sent" | "message_delivered" | "message_replied" | "message_escalated" | "message_rate_limited";
	from?: string;
	to?: string;
	messageId?: string;
	messageType?: string;
	contentPreview?: string;
	broadcast?: boolean;
	reason?: string;
	retryAfterMs?: number;
}> = [
	{
		offsetMs: 0,
		type: "message_sent",
		from: "supervisor",
		to: "lane-1",
		messageId: "m-100",
		messageType: "steer",
		contentPreview: "Focus this iteration on the auth-flow assertions (VA-001 / VA-002). Skip VA-003 for now.",
	},
	{ offsetMs: 450, type: "message_delivered", from: "supervisor", to: "lane-1", messageId: "m-100" },
	{
		offsetMs: 3_800,
		type: "message_sent",
		from: "supervisor",
		to: "lane-1",
		messageId: "m-101",
		messageType: "query",
		contentPreview: "Report iteration count and current step before the next commit.",
	},
	{ offsetMs: 4_200, type: "message_delivered", from: "supervisor", to: "lane-1", messageId: "m-101" },
	{
		offsetMs: 6_900,
		type: "message_replied",
		from: "lane-1",
		to: "supervisor",
		messageId: "m-101",
		messageType: "reply",
		contentPreview: "Iteration 4, step 3 (Finalize). All 5 checkboxes green; writing DONE marker now.",
	},
	{
		offsetMs: 12_400,
		type: "message_sent",
		from: "supervisor",
		to: "lane-2",
		messageId: "m-102",
		messageType: "steer",
		contentPreview: "Prioritise VA-004 (merge fan-out) — it is blocking M-003.",
	},
	{ offsetMs: 12_700, type: "message_delivered", from: "supervisor", to: "lane-2", messageId: "m-102" },
	{
		offsetMs: 28_100,
		type: "message_escalated",
		from: "lane-2",
		to: "supervisor",
		messageId: "m-103",
		messageType: "escalate",
		contentPreview: "repo-3 has a pre-existing type error unrelated to this fix. Unblock by skipping repo-3?",
	},
	{
		offsetMs: 33_500,
		type: "message_sent",
		from: "supervisor",
		to: "lane-2",
		messageId: "m-104",
		messageType: "info",
		contentPreview: "Acknowledged. Proceed with repo-3 skipped; flag the skip in the milestone report.",
	},
	{ offsetMs: 33_900, type: "message_delivered", from: "supervisor", to: "lane-2", messageId: "m-104" },
	{
		offsetMs: 48_250,
		type: "message_rate_limited",
		from: "supervisor",
		to: "lane-2",
		reason: "cooldown",
		retryAfterMs: 8_400,
	},
	{
		offsetMs: 72_600,
		type: "message_replied",
		from: "lane-2",
		to: "supervisor",
		messageId: "m-102",
		messageType: "reply",
		contentPreview: "Wave 2 merge fan-out validated on repos 1 and 2. VA-004 acceptance criteria met.",
	},
	{
		offsetMs: 79_400,
		type: "message_sent",
		from: "supervisor",
		to: "_broadcast",
		messageId: "m-105",
		messageType: "info",
		broadcast: true,
		contentPreview: "Wave 2 merge complete. Prepare for scrutiny validator round 3.",
	},
	{
		offsetMs: 104_800,
		type: "message_sent",
		from: "supervisor",
		to: "lane-1",
		messageId: "m-106",
		messageType: "steer",
		contentPreview: "Round 3 review: align scrutiny validator output with the assertion schema before sign-off.",
	},
	{ offsetMs: 105_100, type: "message_delivered", from: "supervisor", to: "lane-1", messageId: "m-106" },
	{
		offsetMs: 141_200,
		type: "message_replied",
		from: "lane-1",
		to: "supervisor",
		messageId: "m-106",
		messageType: "reply",
		contentPreview: "Scrutiny alignment complete. Validator contract updated; ready for user-testing pass.",
	},
];
for (const ev of mailboxLog) {
	appendMailboxAuditEvent(sandbox, batchId, {
		ts: mailboxStart + ev.offsetMs,
		type: ev.type,
		from: ev.from,
		to: ev.to,
		messageId: ev.messageId,
		messageType: ev.messageType,
		contentPreview: ev.contentPreview,
		broadcast: ev.broadcast,
		reason: ev.reason,
		retryAfterMs: ev.retryAfterMs,
	});
}
// Keep the original helpers firing too so the on-disk inbox/ack/outbox layout
// mirrors a real run (these also append `message_sent` entries, but they live
// alongside our curated events in the same events.jsonl — the panel dedupes by
// index so duplicates are expected and harmless).
writeMailboxMessage(sandbox, batchId, "lane-1", {
	from: "supervisor",
	type: "steer",
	content: "Focus the next iteration on the auth-flow assertions.",
});
writeBroadcastMessage(sandbox, batchId, {
	from: "supervisor",
	type: "info",
	content: "All lanes: please rebase before merging the wave.",
});
console.log(`Mailbox: seeded ${mailboxLog.length} audit events + 2 live messages`);

// 3. Drive the lane-runner to drain every wave. Stub agents complete instantly.
const persisted: MissionState[] = [];
const runner = startLaneRunner({
	cwd: sandbox,
	getMission: () => state,
	setMission: next => {
		state = next;
	},
	persist: async next => {
		persisted.push(next);
	},
	config: DEFAULT_MISSIONCONTROL_CONFIG,
});

const deadline = Date.now() + 10_000;
while (runner.running && Date.now() < deadline) {
	if (state.batch?.phase === "complete") break;
	await new Promise(r => setTimeout(r, 25));
}
await runner.stop();
console.log(`Batch phase: ${state.batch?.phase}`);
console.log(`Tasks:       ${state.batch?.tasksComplete}/${state.batch?.tasksTotal} complete`);
console.log(`Persists:    ${persisted.length}`);

// Stub agents never emit `agent_end`, so agent-host flags every worker
// `crashed` even though the tasks themselves succeeded. Rewrite the
// per-agent manifests to `exited` so the Agents panel reflects a
// successful run (real RPC clients populate this field correctly).
const agentsDir = join(sandbox, ".omp", "runtime", batchId, "agents");
if (existsSync(agentsDir)) {
	for (const entry of readdirSync(agentsDir)) {
		const manifestPath = join(agentsDir, entry, "manifest.json");
		if (!existsSync(manifestPath)) continue;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
		if (manifest.status === "crashed") manifest.status = "exited";
		await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
	}
}

// Rebuild the registry snapshot so /api/runtime reads the rewritten statuses.
writeRegistrySnapshot(sandbox, buildRegistrySnapshot(sandbox, batchId));

// ────────────────────────────────────────────────────────────────────
// 4. Inject realistic per-task telemetry (stub mode produces zeros).
// ────────────────────────────────────────────────────────────────────
const taskIds = ["T-001", "T-002", "T-003", "T-004"];
const toolPool = ["bash", "edit", "read", "grep"] as const;

// Deterministic pseudo-RNG so the seeded numbers don't drift across runs.
function pick(i: number, min: number, max: number): number {
	const t = ((i * 2654435761) >>> 0) / 0xffff_ffff;
	return Math.round(min + t * (max - min));
}

const telemetryByTask: Record<string, TaskTelemetry> = {};
for (let i = 0; i < taskIds.length; i++) {
	const id = taskIds[i];
	telemetryByTask[id] = {
		inputTokens: pick(i * 11 + 1, 5_000, 15_000),
		outputTokens: pick(i * 11 + 2, 1_000, 3_000),
		cacheReadTokens: pick(i * 11 + 3, 8_000, 30_000),
		cacheWriteTokens: pick(i * 11 + 4, 0, 4_000),
		costUsd: Math.round(pick(i * 11 + 5, 40, 180)) / 1000, // 0.04-0.18
		toolCalls: pick(i * 11 + 6, 8, 25),
		durationMs: pick(i * 11 + 7, 30_000, 180_000),
		lastTool: toolPool[i % toolPool.length],
	};
}

// Mutate the in-memory MissionState so the archived copy aggregates correctly.
if (state.batch) {
	state.batch.tasks = state.batch.tasks.map<TaskOutcome>(t => ({
		...t,
		telemetry: telemetryByTask[t.taskId] ?? t.telemetry,
	}));
	// Bind each lane to a representative task so the dashboard's lane bars
	// render coloured progress (idle bars look indistinguishable from a
	// missing batch). Assign one complete + one running lane to span the
	// fill-state range.
	const laneAssignments: Record<number, { taskId: string; status: "complete" | "running" }> = {
		1: { taskId: "T-001", status: "complete" },
		2: { taskId: "T-004", status: "running" },
	};
	state.batch.laneStatuses = state.batch.laneStatuses.map(l => {
		const a = laneAssignments[l.lane];
		if (!a) return l;
		return { ...l, taskId: a.taskId, status: a.status };
	});
}

// ────────────────────────────────────────────────────────────────────
// 5. Write a v5 PersistedBatchState to .omp/mission-batch.json so
//    loadBatchState-consuming endpoints (milestones, rollup, validation
//    status) succeed.
// ────────────────────────────────────────────────────────────────────
const batchStart = state.batch?.startTime ?? Date.now() - 180_000;
const batchEnd = state.batch?.endTime ?? Date.now();
const now = Date.now();

const persistedLanes = [
	{
		laneNumber: 1,
		laneId: "l-1",
		laneSessionId: "sess-1",
		worktreePath: "/wt/1",
		branch: "b-1",
		taskIds: ["T-001", "T-003"],
	},
	{
		laneNumber: 2,
		laneId: "l-2",
		laneSessionId: "sess-2",
		worktreePath: "/wt/2",
		branch: "b-2",
		taskIds: ["T-002", "T-004"],
	},
];

const taskMilestones: Record<string, string> = {
	"T-001": "M-001",
	"T-002": "M-001",
	"T-003": "M-002",
	"T-004": "M-003",
};
const taskAssertions: Record<string, string[]> = {
	"T-001": ["VA-001"],
	"T-002": ["VA-002"],
	"T-003": ["VA-003"],
	"T-004": ["VA-004"],
};
const persistedTasks = taskIds.map((id, i) => ({
	taskId: id,
	laneNumber: i % 2 === 0 ? 1 : 2,
	sessionName: i % 2 === 0 ? "sess-1" : "sess-2",
	status: "succeeded" as const,
	taskFolder: `tasks/${id}`,
	startedAt: batchStart + i * 2_000,
	endedAt: batchStart + i * 2_000 + telemetryByTask[id].durationMs,
	doneFileFound: true,
	exitReason: "done-file",
	milestoneId: taskMilestones[id],
	fulfillsAssertionIds: taskAssertions[id] ?? [],
}));

const taskExits: Record<
	string,
	{
		classification: string;
		cost: number;
		durationSec: number;
		tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
		toolCalls: number;
	}
> = {};
let batchCost = 0;
for (const id of taskIds) {
	const t = telemetryByTask[id];
	taskExits[id] = {
		classification: "completed",
		cost: t.costUsd,
		durationSec: Math.round(t.durationMs / 1000),
		tokens: {
			input: t.inputTokens,
			output: t.outputTokens,
			cacheRead: t.cacheReadTokens,
			cacheWrite: t.cacheWriteTokens,
		},
		toolCalls: t.toolCalls,
	};
	batchCost += t.costUsd;
}

const persistedBatch = {
	schemaVersion: 5,
	phase: "completed" as const,
	batchId,
	baseBranch: "main",
	orchBranch: "",
	mode: "repo" as const,
	startedAt: batchStart,
	updatedAt: now,
	endedAt: batchEnd,
	currentWaveIndex: 1,
	totalWaves: 2,
	totalTasks: taskIds.length,
	succeededTasks: taskIds.length,
	failedTasks: 0,
	skippedTasks: 0,
	blockedTasks: 0,
	blockedTaskIds: [] as string[],
	lanes: persistedLanes,
	tasks: persistedTasks,
	wavePlan: [
		["T-001", "T-002"],
		["T-003", "T-004"],
	],
	mergeResults: [] as unknown[],
	errors: [] as string[],
	resilience: {
		resumeForced: false,
		retryCountByScope: {},
		lastFailureClass: null,
		repairHistory: [] as unknown[],
	},
	diagnostics: {
		taskExits,
		batchCost: Math.round(batchCost * 100) / 100,
	},
	segments: [] as unknown[],
	lastError: null,
	milestones: [
		{
			id: "M-001",
			name: "Smoke milestone: ship V2 wire-up",
			featureIds: ["T-001", "T-002"],
			assertionIds: ["VA-001", "VA-002"],
			status: "passed" as const,
			validationRounds: 2,
			maxValidationRounds: 4,
			startedAt: batchStart,
			endedAt: batchEnd,
		},
		{
			id: "M-002",
			name: "Round-3 review parity",
			featureIds: ["T-003"],
			assertionIds: ["VA-003"],
			status: "in_progress" as const,
			validationRounds: 1,
			maxValidationRounds: 4,
			startedAt: batchStart,
		},
		{
			id: "M-003",
			name: "Workspace-mode merge fan-out",
			featureIds: ["T-004"],
			assertionIds: ["VA-004"],
			status: "validating" as const,
			validationRounds: 3,
			maxValidationRounds: 4,
			startedAt: batchStart,
		},
		{
			id: "M-004",
			name: "Reliability budget (validator exhaustion)",
			featureIds: [],
			assertionIds: ["VA-007"],
			status: "failed" as const,
			validationRounds: 4,
			maxValidationRounds: 4,
			startedAt: batchStart,
			endedAt: batchEnd,
		},
	],
};

await fs.mkdir(join(sandbox, ".omp"), { recursive: true });
await fs.writeFile(
	join(sandbox, ".omp", "mission-batch.json"),
	`${JSON.stringify(persistedBatch, null, 2)}\n`,
	"utf-8",
);

// ────────────────────────────────────────────────────────────────────
// 6. Persist the MissionState archive (with injected telemetry) where
//    /api/missions + /api/mission/:id expect it.
// ────────────────────────────────────────────────────────────────────
await fs.mkdir(join(sandbox, ".omp", "missions"), { recursive: true });
await fs.writeFile(
	join(sandbox, ".omp", "missions", `${batchId}.json`),
	`${JSON.stringify(state, null, 2)}\n`,
	"utf-8",
);
console.log(`Mission state: persisted v5 batch + MissionState archive for ${batchId}`);

// ─────────────────────────────────────────────────────────────────────
// 6b. Seed a STATUS.md per task so the dashboard's enrichStatusMdPerTask
//     step populates task.statusData — lane bars render from
//     checked/total and STATUS.md surface has content.
// ─────────────────────────────────────────────────────────────────────
// Each task gets a deterministic checked/total ratio and review+iteration
// counters so the rendered bars span the idle/running/complete spectrum.
interface StatusMdSpec {
	iteration: number;
	reviews: number;
	summary: string;
	filesTouched: string[];
	decisions: string[];
	steps: Array<{
		name: string;
		status: "complete" | "in-progress" | "not-started";
		elapsed?: string;
		items: Array<{ label: string; checked: boolean; note?: string }>;
		notes?: string[];
	}>;
}
const statusSpecs: Record<string, StatusMdSpec> = {
	"T-001": {
		iteration: 4,
		reviews: 2,
		summary:
			"Wire the V2 lane runner: spin the worker pool, drain the first wave, persist outcomes, mark the batch complete.",
		filesTouched: ["src/missioncontrol/lane-runner.ts", "src/missioncontrol/engine.ts", "src/server.ts"],
		decisions: [
			"Keep laneRunner.stop() idempotent — tests call it twice on abort paths.",
			"Persist-by-value (not by-ref) so the archive snapshot can't mutate mid-serialize.",
		],
		steps: [
			{
				name: "Wire lane runner",
				status: "complete",
				elapsed: "00:42",
				items: [
					{ label: "Register lane slots in `engine.startLane`", checked: true },
					{ label: "Boot worker process via `spawnWorker`", checked: true },
					{ label: "Attach mailbox subscription", checked: true },
				],
				notes: ["Lane 1 came up on the first retry — initial worker boot hit a port clash against 44217."],
			},
			{
				name: "Drain first wave",
				status: "complete",
				elapsed: "01:15",
				items: [
					{ label: "Run T-001 through lane-runner", checked: true },
					{ label: "Persist outcome via `appendMissionOutcome`", checked: true },
					{ label: "Emit `wave_start` / `task_complete` supervisor events", checked: true },
				],
			},
			{
				name: "Finalize",
				status: "complete",
				elapsed: "00:08",
				items: [
					{ label: "Write DONE marker", checked: true },
					{ label: "Rewrite agent manifest status → exited", checked: true },
				],
			},
		],
	},
	"T-002": {
		iteration: 3,
		reviews: 1,
		summary: "Apply the plan review edits to server.ts and refresh the affected snapshots before verification.",
		filesTouched: ["src/server.ts", "src/dashboard-api.ts", "test/server.e2e.test.ts"],
		decisions: [
			"Kept the legacy `/api/missions` shape behind a schemaVersion guard.",
			"Deferred snapshot regeneration to the verify step so reviewer round 2 sees stable diffs.",
		],
		steps: [
			{
				name: "Plan review",
				status: "complete",
				elapsed: "00:30",
				items: [
					{ label: "Read plan + requirements", checked: true },
					{ label: "Sync constraints with MissionControl config", checked: true },
				],
			},
			{
				name: "Apply edits",
				status: "in-progress",
				elapsed: "02:10",
				items: [
					{ label: "Edit `/api/mission/:id` handler for per-role telemetry", checked: true },
					{ label: "Wire dashboard-api enrichment to new field", checked: true },
					{ label: "Regenerate snapshot fixtures", checked: false, note: "waiting on verify step" },
				],
				notes: ["Test `server.e2e > per-role telemetry` still pinned to the legacy shape — update after regen."],
			},
			{
				name: "Verify",
				status: "not-started",
				items: [
					{ label: "bun check:ts", checked: false },
					{ label: "bun test test/server.e2e.test.ts", checked: false },
				],
			},
		],
	},
	"T-003": {
		iteration: 2,
		reviews: 0,
		summary: "Round-3 review parity: align the validator's scrutiny output with the orchestrator's assertion schema.",
		filesTouched: [
			"src/missioncontrol/validators/scrutiny.ts",
			"src/missioncontrol/types.ts",
			"src/missioncontrol/orch-handlers.ts",
		],
		decisions: [
			"Treat `assertionId` as authoritative when both the validator and orchestrator emit it.",
			"Gate the migration on schemaVersion>=5 so older persisted batches keep their behavior.",
		],
		steps: [
			{
				name: "Scope",
				status: "complete",
				elapsed: "00:18",
				items: [
					{ label: "Read existing scrutiny validator", checked: true },
					{ label: "List affected files via LSP", checked: true },
				],
			},
			{
				name: "Draft",
				status: "in-progress",
				elapsed: "00:47",
				items: [
					{ label: "Sketch new assertion-binding API shape", checked: false },
					{ label: "Wire first caller (orch-handlers.resolveAssertions)", checked: false },
					{ label: "Reconcile with persisted v5 batch snapshot", checked: false },
				],
				notes: ["Paused waiting on confirmation that v4 batches are safe to skip."],
			},
			{
				name: "Ship",
				status: "not-started",
				items: [
					{ label: "Update validator docs", checked: false },
					{ label: "Add changelog entry under Unreleased", checked: false },
					{ label: "Tag M-002 milestone `passed`", checked: false },
				],
			},
		],
	},
	"T-004": {
		iteration: 5,
		reviews: 2,
		summary:
			"Fix the wave-2 merge fan-out regression where workspace-mode batches land with mixed success/failure per repo.",
		filesTouched: [
			"src/missioncontrol/merge-coordinator.ts",
			"src/missioncontrol/engine.ts",
			"test/merge-coordinator.workspace.test.ts",
		],
		decisions: [
			"Treat any repo failure in a merge wave as a partial fail — don't silently succeed.",
			"Write per-repo result rows into `batch.mergeResults[w].repoResults` for the dashboard.",
		],
		steps: [
			{
				name: "Reproduce",
				status: "complete",
				elapsed: "00:22",
				items: [
					{ label: "Write failing merge-coordinator test", checked: true },
					{ label: "Confirm regression against HEAD", checked: true },
				],
			},
			{
				name: "Patch",
				status: "complete",
				elapsed: "01:04",
				items: [
					{ label: "Land fix in merge parser", checked: true },
					{ label: "Emit per-repo status rows", checked: true },
				],
			},
			{
				name: "Validate",
				status: "in-progress",
				elapsed: "00:36",
				items: [
					{ label: "Re-run suite", checked: true },
					{ label: "Confirm green across 3 sample repos", checked: false, note: "repo-3 still compiling" },
				],
				notes: [
					"Repo-3 has a pre-existing type error unrelated to this fix — confirming isolation with the maintainer.",
				],
			},
		],
	},
};
function renderStatusMd(taskId: string, spec: StatusMdSpec): string {
	const statusEmoji: Record<StatusMdSpec["steps"][number]["status"], string> = {
		complete: "✅ complete",
		"in-progress": "🟨 in progress",
		"not-started": "⏬ not started",
	};
	const totalChecked = spec.steps.reduce((n, s) => n + s.items.filter(i => i.checked).length, 0);
	const totalItems = spec.steps.reduce((n, s) => n + s.items.length, 0);
	const lines: string[] = [
		`# STATUS: ${taskId}`,
		"",
		`**Iteration:** ${spec.iteration}`,
		`**Review Counter:** ${spec.reviews}`,
		`**Progress:** ${totalChecked}/${totalItems} checkboxes`,
		"",
		"## Summary",
		"",
		spec.summary,
		"",
		"## Files touched",
		"",
		...spec.filesTouched.map(f => `- \`${f}\``),
		"",
		"## Key decisions",
		"",
		...spec.decisions.map(d => `- ${d}`),
		"",
	];
	spec.steps.forEach((step, idx) => {
		lines.push(`### Step ${idx + 1}: ${step.name}`);
		lines.push(`**Status:** ${statusEmoji[step.status]}${step.elapsed ? ` · elapsed ${step.elapsed}` : ""}`);
		for (const item of step.items) {
			const suffix = item.note ? ` — *${item.note}*` : "";
			lines.push(`- [${item.checked ? "x" : " "}] ${item.label}${suffix}`);
		}
		if (step.notes && step.notes.length > 0) {
			lines.push("");
			for (const n of step.notes) lines.push(`> ${n}`);
		}
		lines.push("");
	});
	return lines.join("\n");
}
for (const id of taskIds) {
	const spec = statusSpecs[id];
	if (!spec) continue;
	const taskStatusDir = join(sandbox, ".omp", "missions", batchId, "tasks", id);
	await fs.mkdir(taskStatusDir, { recursive: true });
	await fs.writeFile(join(taskStatusDir, "STATUS.md"), renderStatusMd(id, spec), "utf-8");
}
console.log(`STATUS.md: seeded ${taskIds.length} per-task files`);

// ─────────────────────────────────────────────────────────────────────
// 6c. Seed project-local skills under `.omp/skills/<name>/SKILL.md` so
//     the Skills panel renders content instead of the "no skills yet" hint.
// ─────────────────────────────────────────────────────────────────────
interface SkillSeed {
	name: string;
	version: string;
	description: string;
	tools?: string;
	tags?: string[];
	body: string;
}
const skillSeeds: SkillSeed[] = [
	{
		name: "status-md-author",
		version: "0.2.0",
		description:
			"Keep STATUS.md in sync with the current iteration: heading, iteration/review counters, per-step checkboxes with one-line notes, and a files-touched section.",
		tools: "read,edit,grep",
		tags: ["status", "progress", "missions"],
		body: [
			"## When to use",
			"",
			"Any time an iteration of a task completes a concrete sub-step — before handing off to the validator, before marking a step complete, or when recording a blocker.",
			"",
			"## Core rules",
			"",
			"- Always keep `**Iteration:**` and `**Review Counter:**` accurate.",
			"- Each step block must carry a `**Status:**` line with ✅ complete, 🟨 in progress, or ⏬ not started.",
			"- Check exactly one box per finished sub-step; use `- [ ]` for deferred work and add a trailing `— *note*` when it matters.",
			"- Record files edited under `## Files touched` as markdown-backticked relative paths.",
			"",
			"## Typical failure modes",
			"",
			"- Iteration number left stale after a rerun.",
			"- Checkboxes ticked speculatively before the work landed.",
			"- Leaving the file with no ✅/🟨 marker so the dashboard bar renders idle.",
		].join("\n"),
	},
	{
		name: "merge-coordinator-review",
		version: "0.1.0",
		description:
			"Review wave-2 merge fan-out: verify per-repo result rows, confirm failure propagation, and check that workspace-mode batches surface partial failures.",
		tools: "read,grep,lsp",
		tags: ["merge", "workspace-mode", "review"],
		body: [
			"## When to use",
			"",
			"Before signing off on any merge-coordinator change, or when investigating a mixed-success wave-2 report.",
			"",
			"## Checklist",
			"",
			"- `batch.mergeResults[w].repoResults` is present and non-empty for every non-empty wave.",
			"- Any `failed` repo result propagates to the wave's overall `status` field.",
			"- Dashboard MergePanel shows the per-repo row, not a collapsed wave summary.",
			"- `lastFailureClass` reflects the failing repo's classification for retry decisions.",
		].join("\n"),
	},
	{
		name: "lane-runner-playbook",
		version: "1.0.0",
		description:
			"Boot, drain, and tear down the V2 lane runner safely: idempotent stop, port reuse detection, mailbox subscription order, agent manifest post-processing.",
		tools: "bash,read,edit",
		tags: ["lane-runner", "runtime", "bootstrap"],
		body: [
			"## Boot order",
			"",
			"1. Reserve lane slot via `engine.startLane`.",
			"2. Spawn worker process with fresh port, fall back once on `EADDRINUSE`.",
			"3. Attach the mailbox subscription **before** emitting the first step.",
			"",
			"## Teardown",
			"",
			"- `runner.stop()` must be idempotent — tests call it on both happy and abort paths.",
			"- Rewrite any `crashed` manifest to `exited` when the task itself actually succeeded (stub-agent artefact).",
			"- Re-run `writeRegistrySnapshot` so the Agents panel reflects the rewritten statuses.",
		].join("\n"),
	},
];
async function writeSkillSeed(seed: SkillSeed): Promise<void> {
	const dir = join(sandbox, ".omp", "skills", seed.name);
	await fs.mkdir(dir, { recursive: true });
	const frontMatter = ["---", `name: ${seed.name}`, `version: ${seed.version}`, `description: ${seed.description}`];
	if (seed.tools) frontMatter.push(`tools: ${seed.tools}`);
	if (seed.tags && seed.tags.length > 0) frontMatter.push(`tags: ${seed.tags.join(", ")}`);
	frontMatter.push("---");
	const content = `${frontMatter.join("\n")}\n\n# ${seed.name}\n\n${seed.body}\n`;
	await fs.writeFile(join(dir, "SKILL.md"), content, "utf-8");
}
for (const seed of skillSeeds) await writeSkillSeed(seed);
console.log(`Skills: seeded ${skillSeeds.length} SKILL.md files under .omp/skills/`);

// ────────────────────────────────────────────────────────────────────
// 7. Validation contract — drives /api/mission/:id/validation-contract.
// ────────────────────────────────────────────────────────────────────
const contract = {
	schemaVersion: 1,
	missionId: batchId,
	createdAt: batchStart,
	updatedAt: now,
	assertions: [
		{
			id: "VA-001",
			area: "integration",
			title: "Supervisor lockfile + heartbeat visible",
			description: "Dashboard shows the active supervisor session with a fresh heartbeat timestamp.",
			acceptanceCriteria: [
				"Supervisor panel shows status=active",
				"Heartbeat updates within the 90s staleness window",
				"Session ID matches the lockfile contents",
			],
			milestoneId: "M-001",
		},
		{
			id: "VA-002",
			area: "integration",
			title: "Mailbox messages render for lane and broadcast targets",
			description: "Both directed and broadcast mailbox rows appear in the Mailbox panel.",
			acceptanceCriteria: ["At least one directed row visible", "At least one broadcast row visible"],
			milestoneId: "M-001",
		},
		{
			id: "VA-003",
			area: "integration",
			title: "Agent registry populated with worker entries",
			description: "Agents panel lists every worker recorded in the runtime registry.",
			acceptanceCriteria: [
				"Workers from each lane appear",
				"Agent state transitions (spawned → exited) are recorded",
			],
			milestoneId: "M-002",
		},
		{
			id: "VA-004",
			area: "merge",
			title: "Merge fan-out succeeds when wave 2 lands",
			description: "Wave-2 merge result records succeeded status across all repos.",
			acceptanceCriteria: ["Merge wave 2 marked succeeded", "All repo results carry succeeded status"],
			milestoneId: "M-003",
		},
		{
			id: "VA-005",
			area: "integration",
			title: "Cross-cutting telemetry budget",
			description:
				"Mission-wide invariant: per-batch token + tool-call budgets are honoured regardless of which milestone consumed them. Evaluated independently of any single milestone.",
			acceptanceCriteria: [
				"Aggregate token budget under the per-mission ceiling",
				"No single role exceeds 60% of total tool calls",
				"Telemetry rollup endpoint returns non-empty perRole breakdown",
			],
			notes: "Cross-cutting assertion — applies to every milestone, not bound to any single one.",
		},
		{
			id: "VA-006",
			area: "testing",
			title: "Round-3 user-testing validator emits bounded findings",
			description:
				"User-testing validator output for the in-progress review milestone shapes findings correctly so the dashboard can render them once persistence lands.",
			acceptanceCriteria: ["Findings parse against the schema", "At least one finding emitted per failing scenario"],
			milestoneId: "M-002",
		},
		{
			id: "VA-007",
			area: "reliability",
			title: "Validator exhaustion surfaces as a failed milestone, not a silent stall",
			description:
				"When a milestone hits its maxValidationRounds without a passing verdict it must transition to status=failed so operators see a red signal instead of a perpetually validating row.",
			acceptanceCriteria: [
				"Milestone status flips from validating to failed at round = max",
				"Lane-runner pauses and emits a supervisor warning",
			],
			notes: "Last-resort safety: prefer a loud failure over a quiet stall.",
			milestoneId: "M-004",
		},
	],
};
await fs.writeFile(
	join(sandbox, ".omp", "validation-contract.json"),
	`${JSON.stringify(contract, null, 2)}\n`,
	"utf-8",
);
console.log("Validation contract: 7 assertions written (VA-005 unbound, VA-006→M-002, VA-007→M-004)");

// ────────────────────────────────────────────────────────────────────
// 8. Project config — drives /api/mission/:id/role-models.
// ────────────────────────────────────────────────────────────────────
const projectConfig = {
	configVersion: 1,
	missions: {
		models: {
			orchestrator: "anthropic/claude-opus-4-7",
			worker: "anthropic/claude-sonnet-4-6",
			scrutiny_validator: "anthropic/claude-opus-4-7",
			user_testing_validator: "anthropic/claude-sonnet-4-6",
		},
	},
};
await fs.writeFile(join(sandbox, ".omp", "mission.json"), `${JSON.stringify(projectConfig, null, 2)}\n`, "utf-8");
console.log("Project config: role models for 4 roles written");

// ────────────────────────────────────────────────────────────────────
// 9. Telemetry sidecar: aggregated exit-summary.json + worker.jsonl.
// ────────────────────────────────────────────────────────────────────
const telemetryRoot = join(sandbox, ".omp", "mission-telemetry", batchId);
await fs.mkdir(telemetryRoot, { recursive: true });

const totals = Object.values(telemetryByTask).reduce(
	(acc, t) => ({
		input: acc.input + t.inputTokens,
		output: acc.output + t.outputTokens,
		cacheRead: acc.cacheRead + t.cacheReadTokens,
		cacheWrite: acc.cacheWrite + t.cacheWriteTokens,
		cost: acc.cost + t.costUsd,
		toolCalls: acc.toolCalls + t.toolCalls,
		maxDurationMs: Math.max(acc.maxDurationMs, t.durationMs),
	}),
	{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, toolCalls: 0, maxDurationMs: 0 },
);

const exitSummary = {
	exitCode: 0,
	tokens: {
		input: totals.input,
		output: totals.output,
		cacheRead: totals.cacheRead,
		cacheWrite: totals.cacheWrite,
	},
	cost: Math.round(totals.cost * 1000) / 1000,
	toolCalls: totals.toolCalls,
	durationSec: Math.round(totals.maxDurationMs / 1000),
	lastToolCall: "bash",
	contextPct: 32.5,
};
await fs.writeFile(join(telemetryRoot, "exit-summary.json"), `${JSON.stringify(exitSummary, null, 2)}\n`, "utf-8");

// Worker sidecar JSONL — shape matches writeSidecarEvent output (one event
// per line, each an object with `type`, `ts`, and role-specific fields).
const workerPath = join(telemetryRoot, "worker.jsonl");
const eventStart = batchStart + 2_000;
const step = Math.max(1_000, Math.floor((batchEnd - eventStart) / 10));
type SidecarLine = { type: string; ts: number; [k: string]: unknown };
const workerEvents: SidecarLine[] = [
	{ type: "agent_started", ts: eventStart, agentId: `${batchId}-lane-1-worker`, role: "worker" },
	{ type: "message_start", ts: eventStart + step, role: "assistant" },
	{ type: "tool_execution_start", ts: eventStart + step * 2, toolName: "read" },
	{ type: "tool_execution_end", ts: eventStart + step * 3, toolName: "read", isError: false },
	{ type: "tool_execution_start", ts: eventStart + step * 4, toolName: "bash" },
	{ type: "tool_execution_end", ts: eventStart + step * 5, toolName: "bash", isError: false },
	{ type: "tool_execution_start", ts: eventStart + step * 6, toolName: "edit" },
	{ type: "tool_execution_end", ts: eventStart + step * 7, toolName: "edit", isError: false },
	{
		type: "message_end",
		ts: eventStart + step * 8,
		usage: {
			input: telemetryByTask["T-001"].inputTokens,
			output: telemetryByTask["T-001"].outputTokens,
			cacheRead: telemetryByTask["T-001"].cacheReadTokens,
			cacheWrite: telemetryByTask["T-001"].cacheWriteTokens,
			cost: telemetryByTask["T-001"].costUsd,
		},
	},
	{ type: "agent_exited", ts: eventStart + step * 9, agentId: `${batchId}-lane-1-worker`, exitCode: 0 },
];
await fs.writeFile(workerPath, `${workerEvents.map(e => JSON.stringify(e)).join("\n")}\n`, "utf-8");
console.log(`Telemetry sidecar: exit-summary + ${workerEvents.length} worker events written`);

// Per-role sidecars for orchestrator + validators so the Per-Role telemetry
// panel shows every column populated (the server's handleTelemetryRollup
// reads each JSONL and aggregates a TelemetrySample per role).
interface RoleSidecarSpec {
	role: "orchestrator" | "scrutiny_validator" | "user_testing_validator";
	agentSuffix: string;
	tools: string[];
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}
const roleSidecars: RoleSidecarSpec[] = [
	{
		role: "orchestrator",
		agentSuffix: "orchestrator",
		tools: ["plan", "read", "read", "grep", "orch_send_mailbox"],
		usage: { input: 22_400, output: 4_800, cacheRead: 11_000, cacheWrite: 900, cost: 0.128 },
	},
	{
		role: "scrutiny_validator",
		agentSuffix: "scrutiny-validator",
		tools: ["read", "grep", "grep", "read", "validation_contract_read"],
		usage: { input: 18_200, output: 3_400, cacheRead: 27_500, cacheWrite: 1_200, cost: 0.094 },
	},
	{
		role: "user_testing_validator",
		agentSuffix: "user-testing-validator",
		tools: ["read", "bash", "bash", "read", "validation_contract_read"],
		usage: { input: 14_600, output: 2_900, cacheRead: 9_800, cacheWrite: 400, cost: 0.071 },
	},
];
for (const spec of roleSidecars) {
	const agentId = `${batchId}-${spec.agentSuffix}`;
	const events: SidecarLine[] = [
		{ type: "agent_started", ts: eventStart, agentId, role: spec.role },
		{ type: "message_start", ts: eventStart + step, role: "assistant" },
	];
	spec.tools.forEach((tool, i) => {
		const base = eventStart + step * (2 + i * 2);
		events.push({ type: "tool_execution_start", ts: base, toolName: tool });
		events.push({ type: "tool_execution_end", ts: base + Math.floor(step / 2), toolName: tool, isError: false });
	});
	const endTs = eventStart + step * (2 + spec.tools.length * 2 + 1);
	events.push({ type: "message_end", ts: endTs, usage: spec.usage });
	events.push({ type: "agent_exited", ts: endTs + step, agentId, exitCode: 0 });
	await fs.writeFile(
		join(telemetryRoot, `${spec.role}.jsonl`),
		`${events.map(e => JSON.stringify(e)).join("\n")}\n`,
		"utf-8",
	);
}
console.log(
	`Per-role sidecars: wrote ${roleSidecars.length} jsonl files (orchestrator, scrutiny_validator, user_testing_validator)`,
);

// ────────────────────────────────────────────────────────────────────
// 10. Surface the on-disk inventory.
// ────────────────────────────────────────────────────────────────────
function check(rel: string): string {
	const p = join(sandbox, rel);
	if (!existsSync(p)) return `MISSING ${rel}`;
	const s = statSync(p);
	if (s.isDirectory()) {
		const items = readdirSync(p);
		return `${rel}/  (${items.length} entries)`;
	}
	return `${rel}  (${s.size} bytes)`;
}

console.log("");
console.log("On-disk artefacts:");
const checks = [
	".omp/mission-batch.json",
	`.omp/missions/${batchId}.json`,
	".omp/mission.json",
	".omp/validation-contract.json",
	`.omp/mission-telemetry/${batchId}/exit-summary.json`,
	`.omp/mission-telemetry/${batchId}/worker.jsonl`,
	".omp/supervisor/lock.json",
	".omp/supervisor/events.jsonl",
	`.omp/mailbox/${batchId}/events.jsonl`,
	`.omp/runtime/${batchId}/registry.json`,
];
for (const rel of checks) {
	console.log(`  ${check(rel)}`);
}

const registry = readRegistrySnapshot(sandbox, batchId);
console.log("");
console.log(`Registry agents: ${Object.keys(registry?.agents ?? {}).length}`);
const supervisorEvents = readFileSync(join(sandbox, ".omp", "supervisor", "events.jsonl"), "utf-8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map(l => JSON.parse(l));
console.log(`Supervisor events: ${supervisorEvents.length}`);
const types = new Set<string>(supervisorEvents.map(e => String(e.type)));
console.log(`  types: ${[...types].sort().join(", ")}`);

const mailboxEvents = readFileSync(join(sandbox, ".omp", "mailbox", batchId, "events.jsonl"), "utf-8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map(l => JSON.parse(l));
console.log(`Mailbox audit rows: ${mailboxEvents.length}`);
console.log(`  to: ${mailboxEvents.map(e => e.to).join(", ")}`);

console.log("");
console.log(
	`Aggregate telemetry: tokens=${totals.input + totals.output + totals.cacheRead + totals.cacheWrite}, cost=$${exitSummary.cost.toFixed(3)}, toolCalls=${totals.toolCalls}`,
);

console.log("");
console.log("Done. Boot the dashboard with:");
console.log(`  bun run scripts/boot-server.ts "${sandbox}" 3848`);

// Best-effort cleanup of timers so the script exits cleanly.
deactivateSupervisor(supervisor, sandbox);
// Re-write the lockfile so the dashboard still shows "active" after the
// script exits — `activateSupervisor` is normally owned by a live process.
// Heartbeat is fresh so `isLockStale` stays false for ~90 s.
writeLockfile(sandbox, {
	pid: process.pid,
	sessionId: supervisor.sessionId,
	batchId,
	startedAt: new Date(Date.now() - 5_000).toISOString(),
	heartbeat: new Date().toISOString(),
});
console.log("Supervisor lockfile: re-written with fresh heartbeat (active for ~90s)");
