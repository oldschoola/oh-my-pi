/**
 * Unit tests for `missioncontrol/engine-agent-ids.ts` — worker-agent-ID
 * resolution for outbox/mailbox paths.
 */

import { describe, expect, test } from "bun:test";

import { resolveTaskWorkerAgentId } from "../src/missioncontrol/engine-agent-ids";
import type { AllocatedLane, LaneTaskOutcome } from "../src/missioncontrol/types";

function makeOutcome(overrides: Partial<LaneTaskOutcome> = {}): LaneTaskOutcome {
	return {
		taskId: "TP-001",
		status: "succeeded",
		startTime: null,
		endTime: null,
		exitReason: "done",
		sessionName: "",
		doneFileFound: true,
		...overrides,
	};
}

function makeLane(overrides: Partial<AllocatedLane> = {}): AllocatedLane {
	return {
		laneNumber: 3,
		laneId: "lane-3",
		laneSessionId: "orch-op-api-lane-1",
		worktreePath: "/tmp/wt",
		branch: "task/lane-3",
		tasks: [],
		strategy: "round-robin",
		estimatedLoad: 0,
		estimatedMinutes: 0,
		...overrides,
	};
}

describe("resolveTaskWorkerAgentId", () => {
	test("returns outcome.sessionName when task already has a completed outcome", () => {
		const outcome = makeOutcome({ taskId: "TP-001", sessionName: "orch-op-lane-2-worker" });
		const result = resolveTaskWorkerAgentId("TP-001", [outcome], new Map(), "orch-op");
		expect(result).toBe("orch-op-lane-2-worker");
	});

	test("outcome without sessionName falls through to lane reconstruction", () => {
		const outcome = makeOutcome({ taskId: "TP-001", sessionName: "" });
		const lanes = new Map<string, AllocatedLane>([["TP-001", makeLane({ laneNumber: 3 })]]);
		const result = resolveTaskWorkerAgentId("TP-001", [outcome], lanes, "orch-op");
		expect(result).toBe("orch-op-lane-3-worker");
	});

	test("reconstructs `{prefix}-lane-{laneNumber}-worker` from lane when no outcome", () => {
		const lanes = new Map<string, AllocatedLane>([["TP-001", makeLane({ laneNumber: 7 })]]);
		const result = resolveTaskWorkerAgentId("TP-001", [], lanes, "orch-op");
		expect(result).toBe("orch-op-lane-7-worker");
	});

	test("uses GLOBAL laneNumber, not laneSessionId-derived local numbering (TP-165)", () => {
		// Workspace mode: laneSessionId uses repo-scoped local numbering,
		// laneNumber is the global ID — result MUST use laneNumber.
		const lane = makeLane({ laneNumber: 5, laneSessionId: "orch-op-api-lane-1" });
		const lanes = new Map<string, AllocatedLane>([["TP-001", lane]]);
		const result = resolveTaskWorkerAgentId("TP-001", [], lanes, "orch-op");
		expect(result).toBe("orch-op-lane-5-worker");
		expect(result).not.toContain("api");
	});

	test("legacy fallback: uses `{laneSessionId}-worker` when no agentIdPrefix given", () => {
		const lane = makeLane({ laneSessionId: "legacy-session-id", laneNumber: 9 });
		const lanes = new Map<string, AllocatedLane>([["TP-001", lane]]);
		const result = resolveTaskWorkerAgentId("TP-001", [], lanes);
		expect(result).toBe("legacy-session-id-worker");
	});

	test("returns null when task has no outcome and no lane allocation", () => {
		const result = resolveTaskWorkerAgentId("TP-404", [], new Map(), "orch-op");
		expect(result).toBeNull();
	});

	test("outcome lookup finds matching taskId among many", () => {
		const outcomes = [
			makeOutcome({ taskId: "TP-001", sessionName: "worker-A" }),
			makeOutcome({ taskId: "TP-002", sessionName: "worker-B" }),
			makeOutcome({ taskId: "TP-003", sessionName: "worker-C" }),
		];
		expect(resolveTaskWorkerAgentId("TP-002", outcomes, new Map())).toBe("worker-B");
	});
});
