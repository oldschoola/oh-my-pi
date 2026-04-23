/**
 * Contract tests for the supervisor-side orchestrator tools.
 *
 * The supervisor prompt templates reference 16 `orch_*` + mailbox
 * tools. These tests exercise the surface registerSupervisorTools
 * exposes:
 *
 *   - Registration: every referenced tool is present, and the
 *     operator session (no MISSION_AGENT_ID) is the one that gets
 *     them.
 *   - Control: pause/resume/abort dispatch through the injected engine
 *     handlers and surface the right error text when there's no batch.
 *   - Observational: orch_status returns the status report from the
 *     same helper /mission-status uses.
 *   - Integration: orch_integrate delegates to the same
 *     buildIntegrationExecutor the /mission-integrate command uses.
 *   - Stubs: retry/skip/force-merge return a clear "not implemented"
 *     message instead of failing silently.
 *
 * Tests use spyOn on the missioncontrol module object so no real git,
 * filesystem, or persistence touches happen. Per AGENTS.md: no
 * mock.module, no file-wide env mutation.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as missioncontrol from "../src/missioncontrol";
import registerSupervisorTools from "../src/supervisor-tools";
import type { BatchState, MissionState } from "../src/types";

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
	return {
		api: {
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
		},
		tools,
	};
}

function makeBatchState(overrides: Partial<BatchState> = {}): BatchState {
	return {
		batchId: "batch-1",
		phase: "running",
		waves: [],
		currentWave: 0,
		laneCount: 2,
		laneStatuses: [
			{
				lane: 1,
				taskId: "TP-001",
				status: "running",
				stepProgress: "step 2 · implementing",
				iteration: 1,
				elapsed: 120,
				sessionName: "lane-1",
			},
			{
				lane: 2,
				taskId: null,
				status: "idle",
				stepProgress: "",
				iteration: 0,
				elapsed: 0,
				sessionName: "lane-2",
			},
		],
		tasks: [],
		tasksTotal: 2,
		tasksComplete: 0,
		tasksFailed: 0,
		startTime: Date.now() - 60_000,
		errors: [],
		...overrides,
	};
}

function makeMissionState(batch?: BatchState | null): MissionState {
	return {
		mode: "simple",
		kind: batch ? "batch" : "simple",
		description: "test mission",
		phases: [],
		autonomy: "medium",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: new Date().toISOString(),
		batch: batch ?? undefined,
	};
}

/**
 * Fake engine. Each handler records its call and returns a caller-
 * supplied next-state so tests can assert both the dispatch and the
 * response without running real runtime.
 */
interface FakeEngine {
	batchCalls: Array<{ opts?: { taskIds?: string[] } }>;
	pauseCalls: number;
	resumeCalls: number;
	abortCalls: Array<string | undefined>;
	handlers: missioncontrol.Engine["handlers"];
	status: missioncontrol.Engine["status"];
	hooks: missioncontrol.Engine["hooks"];
	config: missioncontrol.Engine["config"];
}

function makeFakeEngine(nextState: MissionState | null): FakeEngine {
	const fake: FakeEngine = {
		batchCalls: [],
		pauseCalls: 0,
		resumeCalls: 0,
		abortCalls: [],
		handlers: {
			batch: async opts => {
				fake.batchCalls.push({ opts });
				return nextState;
			},
			pause: async () => {
				fake.pauseCalls += 1;
				return nextState;
			},
			resume: async () => {
				fake.resumeCalls += 1;
				return nextState;
			},
			abort: async reason => {
				fake.abortCalls.push(reason);
				return nextState;
			},
		},
		status: () => ({ active: false }),
		hooks: {
			onSessionStart: async () => {},
			onMessageEnd: async () => {},
			onSessionEnd: async () => {},
		},
		config: {
			laneCount: 2,
			waveSize: 2,
			model: "claude-sonnet-4-6",
			autonomy: "medium" as const,
			qualityGates: { typecheck: true, lint: true, test: true },
		},
	};
	return fake;
}

/**
 * Wire up registerSupervisorTools with the minimum stubs each test
 * needs. Returns the tool map plus the fake engine for assertions.
 */
function setup(
	options: { state: MissionState | null; cwd?: string; nextState?: MissionState | null } = {
		state: null,
	},
): { tools: Map<string, CapturedTool>; engine: FakeEngine; cwd: string } {
	const stub = makeStubPi();
	const engine = makeFakeEngine(options.nextState ?? options.state);
	const cwd = options.cwd ?? "/tmp/supervisor-tools-test";
	registerSupervisorTools(
		stub.api as unknown as ExtensionAPI,
		() => options.state,
		() => {},
		cwd,
		engine as unknown as missioncontrol.Engine,
	);
	return { tools: stub.tools, engine, cwd };
}

function getTool(tools: Map<string, CapturedTool>, name: string): CapturedTool {
	const tool = tools.get(name);
	if (!tool) throw new Error(`tool not registered: ${name}`);
	return tool;
}

afterEach(() => {
	mock.restore();
});

describe("registerSupervisorTools — registration surface", () => {
	test("registers every tool referenced by the supervisor prompt templates", () => {
		const { tools } = setup({ state: null });
		const expected = [
			"orch_status",
			"orch_pause",
			"orch_resume",
			"orch_abort",
			"orch_start",
			"orch_integrate",
			"orch_retry_task",
			"orch_skip_task",
			"orch_force_merge",
			"send_agent_message",
			"read_agent_replies",
			"broadcast_message",
			"trigger_wrap_up",
			"read_agent_status",
			"read_lane_logs",
			"list_active_agents",
			"orch_read_clarifications",
		];
		for (const name of expected) {
			expect(tools.has(name)).toBe(true);
		}
	});
});

describe("orch_status", () => {
	test("formats mission state via buildMissionStatusReport when a batch exists", async () => {
		const state = makeMissionState(makeBatchState());
		const { tools } = setup({ state });
		const res = await getTool(tools, "orch_status").execute("call-1", {});
		expect(res.content[0].text).toContain("Batch batch-1");
		expect(res.content[0].text).toContain("running");
	});

	test("returns a warning message when no batch is active", async () => {
		const { tools } = setup({ state: null });
		const res = await getTool(tools, "orch_status").execute("call-1", {});
		expect(res.content[0].text).toContain("No batch");
	});
});

describe("orch_pause / orch_resume / orch_abort", () => {
	test("orch_pause dispatches through engine.handlers.pause() when a batch is running", async () => {
		const state = makeMissionState(makeBatchState({ phase: "running" }));
		const paused = makeMissionState(makeBatchState({ phase: "paused" }));
		const { tools, engine } = setup({ state, nextState: paused });
		const res = await getTool(tools, "orch_pause").execute("call-1", {});
		expect(engine.pauseCalls).toBe(1);
		expect(res.content[0].text).toContain("batch-1");
		expect(res.content[0].text).toContain("paused");
	});

	test("orch_pause refuses when there is no active batch", async () => {
		const { tools, engine } = setup({ state: null });
		const res = await getTool(tools, "orch_pause").execute("call-1", {});
		expect(engine.pauseCalls).toBe(0);
		expect(res.content[0].text).toContain("No active batch");
	});

	test("orch_pause is idempotent when batch is already paused", async () => {
		const state = makeMissionState(makeBatchState({ phase: "paused" }));
		const { tools, engine } = setup({ state });
		const res = await getTool(tools, "orch_pause").execute("call-1", {});
		expect(engine.pauseCalls).toBe(0);
		expect(res.content[0].text).toContain("already paused");
	});

	test("orch_resume dispatches through engine.handlers.resume() for a paused batch", async () => {
		const state = makeMissionState(makeBatchState({ phase: "paused" }));
		const running = makeMissionState(makeBatchState({ phase: "running" }));
		const { tools, engine } = setup({ state, nextState: running });
		await getTool(tools, "orch_resume").execute("call-1", {});
		expect(engine.resumeCalls).toBe(1);
	});

	test("orch_resume refuses when batch is not paused", async () => {
		const state = makeMissionState(makeBatchState({ phase: "running" }));
		const { tools, engine } = setup({ state });
		const res = await getTool(tools, "orch_resume").execute("call-1", {});
		expect(engine.resumeCalls).toBe(0);
		expect(res.content[0].text).toContain("not paused");
	});

	test("orch_abort graceful passes a reason to engine.handlers.abort()", async () => {
		const state = makeMissionState(makeBatchState());
		const { tools, engine } = setup({ state });
		await getTool(tools, "orch_abort").execute("call-1", {});
		expect(engine.abortCalls).toEqual(["aborted by supervisor"]);
	});

	test("orch_abort hard=true passes a hard-abort reason", async () => {
		const state = makeMissionState(makeBatchState());
		const { tools, engine } = setup({ state });
		await getTool(tools, "orch_abort").execute("call-1", { hard: true });
		expect(engine.abortCalls).toEqual(["hard abort by supervisor"]);
	});
});

describe("orch_start", () => {
	test("dispatches engine.handlers.batch with parsed task IDs", async () => {
		const state = makeMissionState(null);
		const promoted = makeMissionState(makeBatchState({ batchId: "batch-new" }));
		const { tools, engine } = setup({ state, nextState: promoted });
		const res = await getTool(tools, "orch_start").execute("call-1", { target: "TP-001 TP-002" });
		expect(engine.batchCalls).toHaveLength(1);
		expect(engine.batchCalls[0].opts?.taskIds).toEqual(["TP-001", "TP-002"]);
		expect(res.content[0].text).toContain("batch-new");
	});

	test("'all' target dispatches with empty task list", async () => {
		const state = makeMissionState(null);
		const promoted = makeMissionState(makeBatchState({ batchId: "batch-all" }));
		const { tools, engine } = setup({ state, nextState: promoted });
		await getTool(tools, "orch_start").execute("call-1", { target: "all" });
		expect(engine.batchCalls[0].opts?.taskIds).toEqual([]);
	});

	test("refuses to start when an active batch is running", async () => {
		const state = makeMissionState(makeBatchState({ phase: "running" }));
		const { tools, engine } = setup({ state });
		const res = await getTool(tools, "orch_start").execute("call-1", { target: "all" });
		expect(engine.batchCalls).toHaveLength(0);
		expect(res.content[0].text).toContain("already active");
	});
});

describe("orch_integrate", () => {
	test("builds args from mode/force/branch and surfaces executor result", async () => {
		const loadSpy = spyOn(missioncontrol, "loadBatchState");
		loadSpy.mockResolvedValue({
			phase: "completed",
			batchId: "batch-42",
			baseBranch: "main",
			orchBranch: "orch/batch-42",
			lanes: [],
			tasks: [],
			wavePlan: [],
		} as unknown as import("../src/missioncontrol/types").PersistedBatchState);
		const resolveSpy = spyOn(missioncontrol, "resolveIntegrationContext");
		resolveSpy.mockReturnValue({
			orchBranch: "orch/batch-42",
			baseBranch: "main",
			batchId: "batch-42",
			currentBranch: "main",
			notices: [],
		});
		const execSpy = spyOn(missioncontrol, "buildIntegrationExecutor");
		const executorFn = (mode: "ff" | "merge" | "pr") => ({
			success: true,
			integratedLocally: true,
			commitCount: "3",
			message: `Integrated via ${mode}.`,
		});
		execSpy.mockReturnValue(executorFn as ReturnType<typeof missioncontrol.buildIntegrationExecutor>);

		const state = makeMissionState(makeBatchState({ phase: "complete", batchId: "batch-42" }));
		const { tools } = setup({ state });
		const res = await getTool(tools, "orch_integrate").execute("call-1", {
			mode: "merge",
			force: true,
			branch: "orch/batch-42",
		});
		expect(res.content[0].text).toContain("Integrated via merge");
		// buildIntegrationExecutor is called with (cwd, opId, cwd).
		expect(execSpy).toHaveBeenCalled();
	});

	test("surfaces resolution error text when context resolution fails", async () => {
		spyOn(missioncontrol, "loadBatchState").mockResolvedValue(null);
		spyOn(missioncontrol, "resolveIntegrationContext").mockReturnValue({
			error: "No completed batch found.",
			severity: "error" as const,
		});

		const state = makeMissionState(null);
		const { tools } = setup({ state });
		const res = await getTool(tools, "orch_integrate").execute("call-1", {});
		expect(res.content[0].text).toContain("No completed batch found");
	});
});

describe("send_agent_message / broadcast_message", () => {
	test("send_agent_message rejects unknown agent IDs with a valid-targets preview", async () => {
		spyOn(missioncontrol, "readRegistrySnapshot").mockReturnValue(null);
		spyOn(missioncontrol, "discoverMailboxAgentIds").mockReturnValue(["agent-a", "agent-b"]);

		const state = makeMissionState(makeBatchState());
		const { tools } = setup({ state });
		const res = await getTool(tools, "send_agent_message").execute("call-1", {
			to: "unknown-agent",
			content: "hello",
		});
		expect(res.content[0].text).toContain("Unknown agent");
		expect(res.content[0].text).toContain("agent-a");
	});

	test("send_agent_message writes via writeMailboxMessage when the target is known", async () => {
		spyOn(missioncontrol, "readRegistrySnapshot").mockReturnValue(null);
		spyOn(missioncontrol, "discoverMailboxAgentIds").mockReturnValue(["agent-a"]);
		const writeSpy = spyOn(missioncontrol, "writeMailboxMessage");
		writeSpy.mockReturnValue({
			id: "msg-1",
			batchId: "batch-1",
			from: "supervisor",
			to: "agent-a",
			timestamp: Date.now(),
			type: "steer",
			content: "hello",
			expectsReply: false,
			replyTo: null,
		});

		const state = makeMissionState(makeBatchState());
		const { tools, cwd } = setup({ state });
		const res = await getTool(tools, "send_agent_message").execute("call-1", {
			to: "agent-a",
			content: "focus on test coverage",
			type: "steer",
		});
		expect(writeSpy).toHaveBeenCalledWith(cwd, "batch-1", "agent-a", {
			from: "supervisor",
			type: "steer",
			content: "focus on test coverage",
		});
		expect(res.content[0].text).toContain("Message sent to agent-a");
	});

	test("broadcast_message dispatches via writeBroadcastMessage and reports the recipient count", async () => {
		spyOn(missioncontrol, "readRegistrySnapshot").mockReturnValue(null);
		spyOn(missioncontrol, "discoverMailboxAgentIds").mockReturnValue(["a", "b", "c"]);
		const writeSpy = spyOn(missioncontrol, "writeBroadcastMessage");
		writeSpy.mockReturnValue({
			id: "bcast-1",
			batchId: "batch-1",
			from: "supervisor",
			to: "_broadcast",
			timestamp: Date.now(),
			type: "info",
			content: "heartbeat",
			expectsReply: false,
			replyTo: null,
		});

		const state = makeMissionState(makeBatchState());
		const { tools } = setup({ state });
		const res = await getTool(tools, "broadcast_message").execute("call-1", {
			content: "heartbeat",
		});
		expect(writeSpy).toHaveBeenCalled();
		expect(res.content[0].text).toContain("Recipients: 3");
	});
});

describe("orch_retry_task / orch_skip_task / orch_force_merge", () => {
	function persisted(overrides: Partial<import("../src/missioncontrol/types").PersistedBatchState> = {}) {
		return {
			batchId: "batch-1",
			phase: "paused" as const,
			baseBranch: "main",
			orchBranch: "orch/batch-1",
			currentWaveIndex: 0,
			lanes: [],
			tasks: [
				{
					taskId: "TP-001",
					laneNumber: 1,
					sessionName: "lane-1",
					status: "failed" as const,
					taskFolder: "tasks/TP-001",
					startedAt: 1,
					endedAt: 2,
					doneFileFound: false,
					exitReason: "boom",
				},
			],
			wavePlan: [["TP-001"]],
			totalTasks: 1,
			succeededTasks: 0,
			failedTasks: 1,
			skippedTasks: 0,
			blockedTasks: 0,
			blockedTaskIds: [] as string[],
			mergeResults: [
				{
					waveIndex: 0,
					status: "partial" as const,
					failedLane: 1,
					failureReason: "mixed-outcome",
				},
			],
			...overrides,
		} as unknown as import("../src/missioncontrol/types").PersistedBatchState;
	}

	test("orch_retry_task resets a failed task to pending and persists it", async () => {
		const state = persisted();
		spyOn(missioncontrol, "loadBatchState").mockResolvedValue(state);
		const saveSpy = spyOn(missioncontrol, "saveBatchState").mockResolvedValue(undefined);

		const { tools } = setup({ state: makeMissionState(makeBatchState()) });
		const res = await getTool(tools, "orch_retry_task").execute("call-1", { taskId: "TP-001" });

		expect(res.content[0].text).toContain("TP-001");
		expect(res.content[0].text).toContain("reset to pending");
		expect(saveSpy).toHaveBeenCalledTimes(1);
		const [json] = saveSpy.mock.calls[0];
		const persistedState = JSON.parse(json as string);
		expect(persistedState.tasks[0].status).toBe("pending");
		expect(persistedState.tasks[0].exitReason).toBe("");
		expect(persistedState.tasks[0].startedAt).toBeNull();
	});

	test("orch_retry_task decrements failedTasks and clears phase when batch was failed", async () => {
		const state = persisted({ phase: "failed" as const });
		spyOn(missioncontrol, "loadBatchState").mockResolvedValue(state);
		const saveSpy = spyOn(missioncontrol, "saveBatchState").mockResolvedValue(undefined);

		const { tools } = setup({ state: makeMissionState(makeBatchState()) });
		await getTool(tools, "orch_retry_task").execute("call-1", { taskId: "TP-001" });
		const [json] = saveSpy.mock.calls[0];
		const persistedState = JSON.parse(json as string);
		expect(persistedState.failedTasks).toBe(0);
		expect(persistedState.phase).toBe("stopped");
	});

	test("orch_retry_task accepts stalled tasks", async () => {
		const state = persisted();
		state.tasks[0].status = "stalled";
		spyOn(missioncontrol, "loadBatchState").mockResolvedValue(state);
		const saveSpy = spyOn(missioncontrol, "saveBatchState").mockResolvedValue(undefined);

		const { tools } = setup({ state: makeMissionState(makeBatchState()) });
		const res = await getTool(tools, "orch_retry_task").execute("call-1", { taskId: "TP-001" });
		expect(res.content[0].text).toContain("reset to pending");
		const [json] = saveSpy.mock.calls[0];
		const persistedState = JSON.parse(json as string);
		expect(persistedState.tasks[0].status).toBe("pending");
	});

	test("orch_retry_task refuses non-failed tasks", async () => {
		const state = persisted();
		state.tasks[0].status = "succeeded";
		spyOn(missioncontrol, "loadBatchState").mockResolvedValue(state);
		const saveSpy = spyOn(missioncontrol, "saveBatchState").mockResolvedValue(undefined);

		const { tools } = setup({ state: makeMissionState(makeBatchState()) });
		const res = await getTool(tools, "orch_retry_task").execute("call-1", { taskId: "TP-001" });
		expect(res.content[0].text).toContain("not failed/stalled");
		expect(saveSpy).not.toHaveBeenCalled();
	});

	test("orch_skip_task marks failed task as skipped", async () => {
		const state = persisted();
		spyOn(missioncontrol, "loadBatchState").mockResolvedValue(state);
		const saveSpy = spyOn(missioncontrol, "saveBatchState").mockResolvedValue(undefined);

		const { tools } = setup({ state: makeMissionState(makeBatchState()) });
		const res = await getTool(tools, "orch_skip_task").execute("call-1", { taskId: "TP-001" });
		expect(res.content[0].text).toContain("marked skipped");
		const [json] = saveSpy.mock.calls[0];
		const persistedState = JSON.parse(json as string);
		expect(persistedState.tasks[0].status).toBe("skipped");
		expect(persistedState.skippedTasks).toBe(1);
		expect(persistedState.failedTasks).toBe(0);
	});

	test("orch_skip_task accepts stalled tasks", async () => {
		const state = persisted();
		state.tasks[0].status = "stalled";
		spyOn(missioncontrol, "loadBatchState").mockResolvedValue(state);
		const saveSpy = spyOn(missioncontrol, "saveBatchState").mockResolvedValue(undefined);

		const { tools } = setup({ state: makeMissionState(makeBatchState()) });
		const res = await getTool(tools, "orch_skip_task").execute("call-1", { taskId: "TP-001" });
		expect(res.content[0].text).toContain("marked skipped");
		const [json] = saveSpy.mock.calls[0];
		const persistedState = JSON.parse(json as string);
		expect(persistedState.tasks[0].status).toBe("skipped");
	});

	test("orch_skip_task drops the task from blockedTaskIds when present", async () => {
		const state = persisted({ blockedTaskIds: ["TP-001", "TP-002"], blockedTasks: 2 });
		spyOn(missioncontrol, "loadBatchState").mockResolvedValue(state);
		const saveSpy = spyOn(missioncontrol, "saveBatchState").mockResolvedValue(undefined);

		const { tools } = setup({ state: makeMissionState(makeBatchState()) });
		await getTool(tools, "orch_skip_task").execute("call-1", { taskId: "TP-001" });
		const [json] = saveSpy.mock.calls[0];
		const persistedState = JSON.parse(json as string);
		expect(persistedState.blockedTaskIds).toEqual(["TP-002"]);
		expect(persistedState.blockedTasks).toBe(1);
	});

	test("orch_force_merge flips a partial merge to succeeded and optionally skips failed tasks", async () => {
		const state = persisted();
		spyOn(missioncontrol, "loadBatchState").mockResolvedValue(state);
		const saveSpy = spyOn(missioncontrol, "saveBatchState").mockResolvedValue(undefined);

		const { tools } = setup({ state: makeMissionState(makeBatchState()) });
		const res = await getTool(tools, "orch_force_merge").execute("call-1", {
			waveIndex: 0,
			skipFailed: true,
		});
		expect(res.content[0].text).toContain("Wave 0 merge forced to succeeded");
		expect(res.content[0].text).toContain("1 failed task(s) skipped");
		const [json] = saveSpy.mock.calls[0];
		const persistedState = JSON.parse(json as string);
		expect(persistedState.mergeResults[0].status).toBe("succeeded");
		expect(persistedState.mergeResults[0].failureReason).toBeNull();
		expect(persistedState.tasks[0].status).toBe("skipped");
	});

	test("orch_force_merge refuses already-succeeded merge results", async () => {
		const state = persisted();
		if (state.mergeResults) state.mergeResults[0].status = "succeeded";
		spyOn(missioncontrol, "loadBatchState").mockResolvedValue(state);
		const saveSpy = spyOn(missioncontrol, "saveBatchState").mockResolvedValue(undefined);

		const { tools } = setup({ state: makeMissionState(makeBatchState()) });
		const res = await getTool(tools, "orch_force_merge").execute("call-1", { waveIndex: 0 });
		expect(res.content[0].text).toContain("only partial/failed merges can be forced");
		expect(saveSpy).not.toHaveBeenCalled();
	});

	test("orch_force_merge refuses when batch phase is executing", async () => {
		const state = persisted({ phase: "executing" as const });
		spyOn(missioncontrol, "loadBatchState").mockResolvedValue(state);
		const saveSpy = spyOn(missioncontrol, "saveBatchState").mockResolvedValue(undefined);

		const { tools } = setup({ state: makeMissionState(makeBatchState()) });
		const res = await getTool(tools, "orch_force_merge").execute("call-1", { waveIndex: 0 });
		expect(res.content[0].text).toContain("force-merge requires a paused or stopped batch");
		expect(saveSpy).not.toHaveBeenCalled();
	});

	test("orch_force_merge refuses non-mixed-outcome failure reasons", async () => {
		const state = persisted();
		if (state.mergeResults) state.mergeResults[0].failureReason = "git conflict";
		spyOn(missioncontrol, "loadBatchState").mockResolvedValue(state);
		const saveSpy = spyOn(missioncontrol, "saveBatchState").mockResolvedValue(undefined);

		const { tools } = setup({ state: makeMissionState(makeBatchState()) });
		const res = await getTool(tools, "orch_force_merge").execute("call-1", { waveIndex: 0 });
		expect(res.content[0].text).toContain("only handles mixed-outcome");
		expect(saveSpy).not.toHaveBeenCalled();
	});

	test("orch_force_merge transitions the batch to paused on success", async () => {
		const state = persisted();
		spyOn(missioncontrol, "loadBatchState").mockResolvedValue(state);
		const saveSpy = spyOn(missioncontrol, "saveBatchState").mockResolvedValue(undefined);

		const { tools } = setup({ state: makeMissionState(makeBatchState()) });
		await getTool(tools, "orch_force_merge").execute("call-1", { waveIndex: 0, skipFailed: true });
		const [json] = saveSpy.mock.calls[0];
		const persistedState = JSON.parse(json as string);
		expect(persistedState.phase).toBe("paused");
		expect(persistedState.skippedTasks).toBe(1);
		expect(persistedState.failedTasks).toBe(0);
	});
});

describe("orch_read_clarifications", () => {
	test("registers and returns the empty-state message when no file exists", async () => {
		const listSpy = spyOn(missioncontrol, "listClarifications").mockResolvedValue([]);
		const { tools } = setup({ state: null });
		const res = await getTool(tools, "orch_read_clarifications").execute("call-1", {});
		expect(listSpy).toHaveBeenCalledTimes(1);
		expect(res.content[0].text).toContain("No clarifications recorded");
	});

	test("renders every entry with answered + pending states", async () => {
		spyOn(missioncontrol, "listClarifications").mockResolvedValue([
			{
				id: "CLR-001",
				timestamp: "2026-04-22T00:00:00Z",
				question: "auth provider?",
				context: "session module",
				answer: "use OIDC",
				answeredAt: "2026-04-22T01:00:00Z",
			},
			{
				id: "CLR-002",
				timestamp: "2026-04-22T02:00:00Z",
				question: "where to persist?",
			},
		]);
		const { tools } = setup({ state: null });
		const res = await getTool(tools, "orch_read_clarifications").execute("call-1", {});
		const text = res.content[0].text;
		expect(text).toContain("2 clarification(s)");
		expect(text).toContain("CLR-001");
		expect(text).toContain("auth provider?");
		expect(text).toContain("Context: session module");
		expect(text).toContain("A: use OIDC");
		expect(text).toContain("CLR-002");
		expect(text).toContain("A: (pending operator response)");
	});
});
