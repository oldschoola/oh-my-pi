import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AllocatedLane,
	LaneTaskOutcome,
	MissionBatchRuntimeState,
	MissionControlConfig,
	PersistedTaskRecord,
} from "../src/missioncontrol";
import {
	assembleDiagnosticInput,
	buildDiagnosticEvents,
	buildMarkdownReport,
	DEFAULT_MISSIONCONTROL_CONFIG,
	type DiagnosticReportInput,
	defaultBatchDiagnostics,
	diagnosticsDir,
	emitDiagnosticReports,
	eventsToJsonl,
	freshMissionBatchState,
} from "../src/missioncontrol";

function mkTempRoot(): string {
	return join(tmpdir(), `mc-diag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function mkTaskRecord(overrides: Partial<PersistedTaskRecord> = {}): PersistedTaskRecord {
	return {
		taskId: "T-1",
		laneNumber: 1,
		sessionName: "op-repo-20260101T120000-l1",
		status: "succeeded",
		taskFolder: "",
		startedAt: 1_000,
		endedAt: 61_000,
		doneFileFound: true,
		exitReason: "",
		...overrides,
	};
}

function mkBaseInput(overrides: Partial<DiagnosticReportInput> = {}): DiagnosticReportInput {
	return {
		missionConfig: DEFAULT_MISSIONCONTROL_CONFIG,
		batchId: "20260101T120000",
		phase: "completed",
		mode: "repo",
		startedAt: 1_000,
		endedAt: 301_000,
		tasks: [mkTaskRecord()],
		diagnostics: defaultBatchDiagnostics(),
		succeededTasks: 1,
		failedTasks: 0,
		skippedTasks: 0,
		blockedTasks: 0,
		totalTasks: 1,
		stateRoot: mkTempRoot(),
		...overrides,
	};
}

describe("buildDiagnosticEvents", () => {
	test("sorts tasks by taskId for deterministic output", () => {
		const input = mkBaseInput({
			tasks: [mkTaskRecord({ taskId: "T-3" }), mkTaskRecord({ taskId: "T-1" }), mkTaskRecord({ taskId: "T-2" })],
			totalTasks: 3,
			succeededTasks: 3,
		});

		const events = buildDiagnosticEvents(input);
		expect(events.map(e => e.taskId)).toEqual(["T-1", "T-2", "T-3"]);
	});

	test("prefers taskExits over exitDiagnostic for classification", () => {
		const input = mkBaseInput({
			tasks: [
				mkTaskRecord({
					taskId: "T-1",
					exitDiagnostic: {
						classification: "stall_timeout",
						exitCode: null,
						errorMessage: null,
						tokensUsed: null,
						contextPct: null,
						partialProgressCommits: 0,
						partialProgressBranch: null,
						durationSec: 0,
						lastKnownStep: null,
						lastKnownCheckbox: null,
						repoId: "",
					},
				}),
			],
			diagnostics: {
				taskExits: {
					"T-1": { classification: "process_crash", cost: 0.25, durationSec: 42, retries: 1 },
				},
				batchCost: 0.25,
			},
		});

		const [event] = buildDiagnosticEvents(input);
		expect(event).toBeDefined();
		expect(event?.classification).toBe("process_crash");
		expect(event?.cost).toBe(0.25);
		expect(event?.durationSec).toBe(42);
		expect(event?.retries).toBe(1);
	});

	test("falls back to exitDiagnostic classification when no taskExits entry", () => {
		const input = mkBaseInput({
			tasks: [
				mkTaskRecord({
					taskId: "T-1",
					exitDiagnostic: {
						classification: "stall_timeout",
						exitCode: null,
						errorMessage: null,
						tokensUsed: null,
						contextPct: null,
						partialProgressCommits: 0,
						partialProgressBranch: null,
						durationSec: 0,
						lastKnownStep: null,
						lastKnownCheckbox: null,
						repoId: "",
					},
				}),
			],
		});

		const [event] = buildDiagnosticEvents(input);
		expect(event?.classification).toBe("stall_timeout");
		expect(event?.cost).toBe(0);
	});

	test("classification is 'unknown' when no diagnostic sources present", () => {
		const input = mkBaseInput();
		const [event] = buildDiagnosticEvents(input);
		expect(event?.classification).toBe("unknown");
	});

	test("computes duration from timestamps when taskExits missing", () => {
		const input = mkBaseInput({
			tasks: [mkTaskRecord({ startedAt: 1_000, endedAt: 121_000 })],
		});
		const [event] = buildDiagnosticEvents(input);
		expect(event?.durationSec).toBe(120);
	});

	test("duration is 0 when neither source nor timestamps available", () => {
		const input = mkBaseInput({
			tasks: [mkTaskRecord({ startedAt: null, endedAt: null })],
		});
		const [event] = buildDiagnosticEvents(input);
		expect(event?.durationSec).toBe(0);
	});

	test("repoId prefers resolvedRepoId over repoId", () => {
		const input = mkBaseInput({
			tasks: [mkTaskRecord({ repoId: "declared", resolvedRepoId: "routed" })],
		});
		const [event] = buildDiagnosticEvents(input);
		expect(event?.repoId).toBe("routed");
	});

	test("repoId falls back to repoId when resolvedRepoId missing", () => {
		const input = mkBaseInput({
			tasks: [mkTaskRecord({ repoId: "declared" })],
		});
		const [event] = buildDiagnosticEvents(input);
		expect(event?.repoId).toBe("declared");
	});

	test("repoId is null when neither field set (repo mode)", () => {
		const [event] = buildDiagnosticEvents(mkBaseInput());
		expect(event?.repoId).toBeNull();
	});
});

describe("eventsToJsonl", () => {
	test("empty array produces empty string", () => {
		expect(eventsToJsonl([])).toBe("");
	});

	test("serializes one event per line with trailing newline", () => {
		const events = buildDiagnosticEvents(mkBaseInput());
		const jsonl = eventsToJsonl(events);
		expect(jsonl.endsWith("\n")).toBe(true);
		const lines = jsonl.trim().split("\n");
		expect(lines).toHaveLength(1);
		const firstLine = lines[0];
		if (!firstLine) throw new Error("expected first line");
		const parsed = JSON.parse(firstLine) as { taskId: string };
		expect(parsed.taskId).toBe("T-1");
	});

	test("multiple events each on own line", () => {
		const input = mkBaseInput({
			tasks: [mkTaskRecord({ taskId: "T-1" }), mkTaskRecord({ taskId: "T-2" })],
			totalTasks: 2,
			succeededTasks: 2,
		});
		const jsonl = eventsToJsonl(buildDiagnosticEvents(input));
		expect(jsonl.trim().split("\n")).toHaveLength(2);
	});
});

describe("buildMarkdownReport", () => {
	test("renders header, overview, and per-task table", () => {
		const input = mkBaseInput();
		const events = buildDiagnosticEvents(input);
		const md = buildMarkdownReport(input, events);

		expect(md).toContain("# Mission Batch Diagnostic Report");
		expect(md).toContain("## Batch Overview");
		expect(md).toContain("| Batch ID | `20260101T120000` |");
		expect(md).toContain("| Final Phase | completed |");
		expect(md).toContain("## Per-Task Results");
		expect(md).toContain("| T-1 | succeeded | unknown | $0.00 |");
	});

	test("shows placeholder when no tasks", () => {
		const input = mkBaseInput({ tasks: [], totalTasks: 0, succeededTasks: 0 });
		const md = buildMarkdownReport(input, buildDiagnosticEvents(input));
		expect(md).toContain("_No task records available._");
	});

	test("adds per-repo breakdown only in workspace mode", () => {
		const repoInput = mkBaseInput();
		expect(buildMarkdownReport(repoInput, buildDiagnosticEvents(repoInput))).not.toContain("## Per-Repo Breakdown");

		const workspaceInput = mkBaseInput({
			mode: "workspace",
			tasks: [
				mkTaskRecord({ taskId: "T-1", resolvedRepoId: "api" }),
				mkTaskRecord({ taskId: "T-2", resolvedRepoId: "web", status: "failed" }),
			],
			totalTasks: 2,
			succeededTasks: 1,
			failedTasks: 1,
		});
		const md = buildMarkdownReport(workspaceInput, buildDiagnosticEvents(workspaceInput));
		expect(md).toContain("## Per-Repo Breakdown");
		expect(md).toContain("### api");
		expect(md).toContain("### web");
	});

	test("formats cost with 4 decimals for nonzero", () => {
		const input = mkBaseInput({
			diagnostics: {
				taskExits: {
					"T-1": { classification: "completed", cost: 0.1234, durationSec: 60, retries: 0 },
				},
				batchCost: 0.1234,
			},
		});
		const md = buildMarkdownReport(input, buildDiagnosticEvents(input));
		expect(md).toContain("| Total Cost | $0.1234 |");
	});
});

describe("diagnosticsDir", () => {
	test("returns .omp/diagnostics subpath", () => {
		expect(diagnosticsDir("/state")).toContain(join(".omp", "diagnostics"));
	});
});

describe("emitDiagnosticReports", () => {
	test("writes JSONL + markdown to .omp/diagnostics/", () => {
		const stateRoot = mkTempRoot();
		try {
			const input = mkBaseInput({ stateRoot });
			emitDiagnosticReports(input);

			const dir = diagnosticsDir(stateRoot);
			expect(existsSync(dir)).toBe(true);

			const files = readdirSync(dir);
			expect(files.some(f => f.endsWith("-events.jsonl"))).toBe(true);
			expect(files.some(f => f.endsWith("-report.md"))).toBe(true);
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	test("is non-fatal on unwritable stateRoot (no throw)", () => {
		// Invalid path triggers fs error path — must not throw.
		const input = mkBaseInput({ stateRoot: "" });
		expect(() => emitDiagnosticReports(input)).not.toThrow();
	});

	test("writes report content matching buildMarkdownReport", () => {
		const stateRoot = mkTempRoot();
		try {
			const input = mkBaseInput({ stateRoot });
			emitDiagnosticReports(input);

			const dir = diagnosticsDir(stateRoot);
			const reportName = readdirSync(dir).find(f => f.endsWith("-report.md"));
			if (!reportName) throw new Error("report missing");
			const body = readFileSync(join(dir, reportName), "utf-8");
			expect(body).toContain("# Mission Batch Diagnostic Report");
			expect(body).toContain("20260101T120000");
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});
});

describe("assembleDiagnosticInput", () => {
	const config: MissionControlConfig = DEFAULT_MISSIONCONTROL_CONFIG;

	function mkOutcome(overrides: Partial<LaneTaskOutcome> = {}): LaneTaskOutcome {
		return {
			taskId: "T-1",
			status: "succeeded",
			startTime: 1_000,
			endTime: 61_000,
			exitReason: "",
			sessionName: "op-r-b-l1",
			doneFileFound: true,
			...overrides,
		};
	}

	function mkLane(overrides: Partial<AllocatedLane> = {}): AllocatedLane {
		return {
			laneNumber: 1,
			laneId: "lane-1",
			laneSessionId: "op-r-b-l1",
			worktreePath: "/tmp/wt",
			branch: "mission/op/b/t-1",
			tasks: [],
			strategy: "round-robin",
			estimatedLoad: 1,
			estimatedMinutes: 30,
			...overrides,
		};
	}

	test("builds task records from wavePlan + outcomes with deterministic order", () => {
		const batch: MissionBatchRuntimeState = {
			...freshMissionBatchState(),
			batchId: "b1",
			phase: "completed",
			totalTasks: 3,
			succeededTasks: 2,
			failedTasks: 1,
		};

		const input = assembleDiagnosticInput(
			config,
			batch,
			[["T-2", "T-3"], ["T-1"]],
			[mkLane()],
			[mkOutcome({ taskId: "T-3", status: "failed" }), mkOutcome({ taskId: "T-1" }), mkOutcome({ taskId: "T-2" })],
			mkTempRoot(),
		);

		expect(input.tasks.map(t => t.taskId)).toEqual(["T-1", "T-2", "T-3"]);
		const failed = input.tasks.find(t => t.taskId === "T-3");
		expect(failed?.status).toBe("failed");
	});

	test("assigns pending status to tasks with no outcome", () => {
		const batch: MissionBatchRuntimeState = {
			...freshMissionBatchState(),
			batchId: "b1",
		};
		const input = assembleDiagnosticInput(config, batch, [["T-1", "T-2"]], [], [], mkTempRoot());
		for (const task of input.tasks) {
			expect(task.status).toBe("pending");
		}
	});

	test("defaults diagnostics to empty when batchState.diagnostics undefined", () => {
		const batch: MissionBatchRuntimeState = {
			...freshMissionBatchState(),
			batchId: "b1",
		};
		const input = assembleDiagnosticInput(config, batch, [], [], [], mkTempRoot());
		expect(input.diagnostics.taskExits).toEqual({});
		expect(input.diagnostics.batchCost).toBe(0);
	});

	test("defaults mode to 'repo' when unset", () => {
		const { mode: _dropped, ...rest } = freshMissionBatchState();
		void _dropped;
		const batch = { ...rest, batchId: "b1" } as MissionBatchRuntimeState;
		const input = assembleDiagnosticInput(config, batch, [], [], [], mkTempRoot());
		expect(input.mode).toBe("repo");
	});
});
