/**
 * Unit tests for `killMergeAgentV2` + `killAllMergeAgentsV2`.
 *
 * The helpers terminate merge-agent processes via the Runtime V2 process
 * registry. Tests stub the registry + `process.kill` + `isProcessAlive` so
 * no real processes are signalled. Contracts under test:
 *
 *   - Only role=`merger` manifests are targeted.
 *   - Terminal-status manifests are skipped.
 *   - `killMergeAgentV2` substring-matches the base session name.
 *   - Manifest status is flipped to `"killed"` after a kill attempt.
 *   - `killAllMergeAgentsV2` returns the count of agents signalled.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { killAllMergeAgentsV2, killMergeAgentV2 } from "../src/missioncontrol/killers";
import * as processRegistry from "../src/missioncontrol/process-registry";
import type { RuntimeAgentManifest, RuntimeRegistry } from "../src/missioncontrol/types";

function mkManifest(overrides: Partial<RuntimeAgentManifest> = {}): RuntimeAgentManifest {
	return {
		batchId: "batch-1",
		agentId: "mission-merge-1",
		role: "merger",
		laneNumber: null,
		taskId: null,
		repoId: "default",
		pid: 12345,
		parentPid: 1,
		startedAt: Date.now(),
		status: "running",
		cwd: "/tmp",
		packet: null,
		...overrides,
	};
}

function mkRegistry(manifests: RuntimeAgentManifest[]): RuntimeRegistry {
	const agents: Record<string, RuntimeAgentManifest> = {};
	for (const m of manifests) agents[m.agentId] = m;
	return { batchId: "batch-1", updatedAt: Date.now(), agents };
}

afterEach(() => {
	mock.restore();
});

describe("killMergeAgentV2", () => {
	test("returns false when the registry has no snapshot", () => {
		spyOn(processRegistry, "readRegistrySnapshot").mockReturnValue(null);
		expect(killMergeAgentV2("/root", "batch-1", "mission-merge-1")).toBe(false);
	});

	test("returns false for an empty session name", () => {
		const snapshot = spyOn(processRegistry, "readRegistrySnapshot");
		expect(killMergeAgentV2("/root", "batch-1", "")).toBe(false);
		expect(snapshot).not.toHaveBeenCalled();
	});

	test("skips non-merger roles even when agentId matches", () => {
		spyOn(processRegistry, "readRegistrySnapshot").mockReturnValue(
			mkRegistry([mkManifest({ role: "worker", agentId: "mission-merge-1-worker" })]),
		);
		spyOn(processRegistry, "isProcessAlive").mockReturnValue(true);
		const killSpy = spyOn(process, "kill").mockReturnValue(true);
		const updateSpy = spyOn(processRegistry, "updateManifestStatus");

		expect(killMergeAgentV2("/root", "batch-1", "mission-merge-1")).toBe(false);
		expect(killSpy).not.toHaveBeenCalled();
		expect(updateSpy).not.toHaveBeenCalled();
	});

	test("skips terminal-status manifests", () => {
		spyOn(processRegistry, "readRegistrySnapshot").mockReturnValue(mkRegistry([mkManifest({ status: "exited" })]));
		const killSpy = spyOn(process, "kill").mockReturnValue(true);
		expect(killMergeAgentV2("/root", "batch-1", "mission-merge-1")).toBe(false);
		expect(killSpy).not.toHaveBeenCalled();
	});

	test("signals + updates manifest when live merger matches", () => {
		spyOn(processRegistry, "readRegistrySnapshot").mockReturnValue(mkRegistry([mkManifest({ pid: 42 })]));
		spyOn(processRegistry, "isProcessAlive").mockReturnValue(true);
		const killSpy = spyOn(process, "kill").mockReturnValue(true);
		const updateSpy = spyOn(processRegistry, "updateManifestStatus");

		const result = killMergeAgentV2("/root", "batch-1", "mission-merge-1");
		expect(result).toBe(true);
		expect(killSpy).toHaveBeenCalledWith(42, "SIGTERM");
		expect(updateSpy).toHaveBeenCalledWith("/root", "batch-1", "mission-merge-1", "killed");
	});

	test("dead PID still triggers status flip (manifest intent must be killed)", () => {
		spyOn(processRegistry, "readRegistrySnapshot").mockReturnValue(mkRegistry([mkManifest({ pid: 99 })]));
		spyOn(processRegistry, "isProcessAlive").mockReturnValue(false);
		const killSpy = spyOn(process, "kill").mockReturnValue(true);
		const updateSpy = spyOn(processRegistry, "updateManifestStatus");

		expect(killMergeAgentV2("/root", "batch-1", "mission-merge-1")).toBe(true);
		expect(killSpy).not.toHaveBeenCalled();
		expect(updateSpy).toHaveBeenCalledWith("/root", "batch-1", "mission-merge-1", "killed");
	});

	test("only matches manifests whose agentId contains the base session name", () => {
		spyOn(processRegistry, "readRegistrySnapshot").mockReturnValue(
			mkRegistry([
				mkManifest({ agentId: "mission-merge-1", pid: 10 }),
				mkManifest({ agentId: "mission-merge-2", pid: 20 }),
			]),
		);
		spyOn(processRegistry, "isProcessAlive").mockReturnValue(true);
		const killSpy = spyOn(process, "kill").mockReturnValue(true);
		const updateSpy = spyOn(processRegistry, "updateManifestStatus");

		expect(killMergeAgentV2("/root", "batch-1", "mission-merge-1")).toBe(true);
		expect(killSpy).toHaveBeenCalledWith(10, "SIGTERM");
		expect(killSpy).not.toHaveBeenCalledWith(20, "SIGTERM");
		expect(updateSpy).toHaveBeenCalledWith("/root", "batch-1", "mission-merge-1", "killed");
		expect(updateSpy).not.toHaveBeenCalledWith("/root", "batch-1", "mission-merge-2", "killed");
	});
});

describe("killAllMergeAgentsV2", () => {
	test("returns 0 when registry is empty", () => {
		spyOn(processRegistry, "readRegistrySnapshot").mockReturnValue(null);
		expect(killAllMergeAgentsV2("/root", "batch-1")).toBe(0);
	});

	test("returns the count of mergers signalled and flips each manifest", () => {
		spyOn(processRegistry, "readRegistrySnapshot").mockReturnValue(
			mkRegistry([
				mkManifest({ agentId: "mission-merge-1", pid: 10 }),
				mkManifest({ agentId: "mission-merge-2", pid: 20 }),
				mkManifest({ agentId: "lane-1-worker", role: "worker", pid: 30 }),
				mkManifest({ agentId: "mission-merge-3", pid: 40, status: "exited" }),
			]),
		);
		spyOn(processRegistry, "isProcessAlive").mockReturnValue(true);
		const killSpy = spyOn(process, "kill").mockReturnValue(true);
		const updateSpy = spyOn(processRegistry, "updateManifestStatus");

		expect(killAllMergeAgentsV2("/root", "batch-1")).toBe(2);
		expect(killSpy).toHaveBeenCalledWith(10, "SIGTERM");
		expect(killSpy).toHaveBeenCalledWith(20, "SIGTERM");
		expect(killSpy).not.toHaveBeenCalledWith(30, "SIGTERM");
		expect(killSpy).not.toHaveBeenCalledWith(40, "SIGTERM");
		// Exactly two mergers got their manifest flipped.
		const killedCalls = updateSpy.mock.calls.filter(args => args[3] === "killed");
		expect(killedCalls).toHaveLength(2);
	});
});
