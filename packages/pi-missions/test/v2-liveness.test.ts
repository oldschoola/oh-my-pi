/**
 * Tests for `isV2AgentAlive` + `setV2LivenessRegistryCache` ported from
 * taskplane `extensions/taskplane/execution.ts:76,111`.
 *
 * `killV2LaneAgents` is exercised in the integration test for the abort
 * flow — unit-testing process.kill would require a real child process and
 * offer little over what `isV2AgentAlive` already covers.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { RuntimeAgentManifest, RuntimeRegistry } from "../src/missioncontrol";
import { isV2AgentAlive, setV2LivenessRegistryCache } from "../src/missioncontrol";

function manifest(overrides: Partial<RuntimeAgentManifest>): RuntimeAgentManifest {
	return {
		batchId: "b-1",
		agentId: "mission-b-1-lane-1-worker",
		role: "worker",
		laneNumber: 1,
		taskId: "TP-1",
		repoId: "default",
		pid: process.pid, // always alive for current process
		parentPid: process.ppid || 1,
		startedAt: Date.now(),
		status: "running",
		cwd: process.cwd(),
		packet: null,
		...overrides,
	};
}

function registry(agents: Record<string, RuntimeAgentManifest>): RuntimeRegistry {
	return { batchId: "b-1", updatedAt: Date.now(), agents };
}

describe("isV2AgentAlive", () => {
	afterEach(() => {
		setV2LivenessRegistryCache(null);
	});

	test("returns false when no registry is cached", () => {
		setV2LivenessRegistryCache(null);
		expect(isV2AgentAlive("mission-b-1-lane-1-worker")).toBe(false);
	});

	test("returns true on direct agentId match with alive PID + non-terminal status", () => {
		setV2LivenessRegistryCache(
			registry({
				"mission-b-1-lane-1-worker": manifest({ agentId: "mission-b-1-lane-1-worker" }),
			}),
		);
		expect(isV2AgentAlive("mission-b-1-lane-1-worker")).toBe(true);
	});

	test("returns false when manifest status is terminal (exited)", () => {
		setV2LivenessRegistryCache(
			registry({
				"mission-b-1-lane-1-worker": manifest({ status: "exited" }),
			}),
		);
		expect(isV2AgentAlive("mission-b-1-lane-1-worker")).toBe(false);
	});

	test("returns false when PID is dead", () => {
		setV2LivenessRegistryCache(
			registry({
				"mission-b-1-lane-1-worker": manifest({ pid: 0 }),
			}),
		);
		expect(isV2AgentAlive("mission-b-1-lane-1-worker")).toBe(false);
	});

	test("falls back to <name>-worker suffix lookup", () => {
		setV2LivenessRegistryCache(
			registry({
				"mission-b-1-lane-1-worker": manifest({ agentId: "mission-b-1-lane-1-worker" }),
			}),
		);
		expect(isV2AgentAlive("mission-b-1-lane-1")).toBe(true);
	});

	test("falls back to laneNumber scan when direct+suffix both miss", () => {
		setV2LivenessRegistryCache(
			registry({
				"unrelated-key": manifest({
					agentId: "mission-b-1-lane-42-worker",
					laneNumber: 42,
					role: "worker",
				}),
			}),
		);
		expect(isV2AgentAlive("different-session-name", "v2", 42)).toBe(true);
	});

	test("laneNumber scan does not match reviewer role", () => {
		setV2LivenessRegistryCache(
			registry({
				"r-key": manifest({ role: "reviewer", laneNumber: 7 }),
			}),
		);
		expect(isV2AgentAlive("missing-name", "v2", 7)).toBe(false);
	});
});
