import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendAgentEvent,
	buildRegistrySnapshot,
	cleanupBatchRuntime,
	createManifest,
	detectOrphans,
	getAgentsByRole,
	getLiveAgents,
	isProcessAlive,
	isTerminalStatus,
	readLaneSnapshot,
	readManifest,
	readMergeSnapshot,
	readRegistrySnapshot,
	updateManifestStatus,
	writeLaneSnapshot,
	writeManifest,
	writeMergeSnapshot,
	writeRegistrySnapshot,
} from "../src/missioncontrol/process-registry";
import type { RuntimeAgentManifest, RuntimeMergeSnapshot, RuntimeRegistry } from "../src/missioncontrol/types";
import { runtimeAgentEventsPath, runtimeRoot } from "../src/missioncontrol/types";

function mkTempRoot(): string {
	const root = join(tmpdir(), `mc-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	return root;
}

function mkManifest(overrides: Partial<RuntimeAgentManifest> = {}): RuntimeAgentManifest {
	return {
		batchId: "b-1",
		agentId: "orch-test-lane-1-worker",
		role: "worker",
		laneNumber: 1,
		taskId: "T-1",
		repoId: "main",
		pid: 99999,
		parentPid: 88888,
		startedAt: Date.now(),
		status: "running",
		cwd: "/tmp/cwd",
		packet: null,
		...overrides,
	};
}

describe("process-registry writeManifest/readManifest", () => {
	test("round-trips a valid manifest", () => {
		const root = mkTempRoot();
		try {
			const m = mkManifest();
			writeManifest(root, m);
			const read = readManifest(root, m.batchId, m.agentId);
			expect(read).not.toBeNull();
			expect(read?.agentId).toBe(m.agentId);
			expect(read?.status).toBe("running");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("returns null for missing manifest", () => {
		const root = mkTempRoot();
		try {
			expect(readManifest(root, "nope", "nope")).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects invalid manifest JSON", async () => {
		const root = mkTempRoot();
		try {
			const m = mkManifest();
			writeManifest(root, m);
			const path = join(runtimeRoot(root, m.batchId), "agents", m.agentId, "manifest.json");
			await Bun.write(path, "not json");
			expect(readManifest(root, m.batchId, m.agentId)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("process-registry updateManifestStatus", () => {
	test("updates status field", () => {
		const root = mkTempRoot();
		try {
			const m = mkManifest();
			writeManifest(root, m);
			updateManifestStatus(root, m.batchId, m.agentId, "exited");
			expect(readManifest(root, m.batchId, m.agentId)?.status).toBe("exited");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("no-op for missing manifest", () => {
		const root = mkTempRoot();
		try {
			// Should not throw
			updateManifestStatus(root, "b-1", "ghost", "exited");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("process-registry createManifest", () => {
	test("fills required fields with defaults", () => {
		const m = createManifest({
			batchId: "b-1",
			agentId: "a-1",
			role: "worker",
			laneNumber: 1,
			taskId: null,
			repoId: "main",
			pid: 1,
			parentPid: 2,
			cwd: "/tmp",
			packet: null,
		});
		expect(m.status).toBe("spawning");
		expect(m.startedAt).toBeGreaterThan(0);
	});
});

describe("process-registry buildRegistrySnapshot", () => {
	test("scans and aggregates all manifests", () => {
		const root = mkTempRoot();
		try {
			writeManifest(root, mkManifest({ agentId: "a-1" }));
			writeManifest(root, mkManifest({ agentId: "a-2", role: "reviewer" }));
			const reg = buildRegistrySnapshot(root, "b-1");
			expect(Object.keys(reg.agents).length).toBe(2);
			expect(reg.agents["a-1"]?.role).toBe("worker");
			expect(reg.agents["a-2"]?.role).toBe("reviewer");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("empty dir → empty agents map", () => {
		const root = mkTempRoot();
		try {
			const reg = buildRegistrySnapshot(root, "b-1");
			expect(Object.keys(reg.agents).length).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("process-registry registry snapshot I/O", () => {
	test("round-trips registry", () => {
		const root = mkTempRoot();
		try {
			const reg: RuntimeRegistry = {
				batchId: "b-1",
				updatedAt: 12345,
				agents: { "a-1": mkManifest({ agentId: "a-1" }) },
			};
			writeRegistrySnapshot(root, reg);
			const read = readRegistrySnapshot(root, "b-1");
			expect(read?.updatedAt).toBe(12345);
			expect(read?.agents["a-1"]?.role).toBe("worker");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("returns null for missing snapshot", () => {
		const root = mkTempRoot();
		try {
			expect(readRegistrySnapshot(root, "nope")).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("process-registry isProcessAlive", () => {
	test("live current pid", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	test("invalid pid → false", () => {
		expect(isProcessAlive(0)).toBe(false);
		expect(isProcessAlive(-1)).toBe(false);
		expect(isProcessAlive(Number.NaN)).toBe(false);
	});

	test("definitely dead pid → false", () => {
		// Pick an unlikely-to-exist PID
		expect(isProcessAlive(999_999_999)).toBe(false);
	});
});

describe("process-registry terminal status", () => {
	test("terminal statuses flagged", () => {
		expect(isTerminalStatus("exited")).toBe(true);
		expect(isTerminalStatus("crashed")).toBe(true);
		expect(isTerminalStatus("killed")).toBe(true);
		expect(isTerminalStatus("timed_out")).toBe(true);
	});

	test("non-terminal statuses not flagged", () => {
		expect(isTerminalStatus("running")).toBe(false);
		expect(isTerminalStatus("spawning")).toBe(false);
	});
});

describe("process-registry live + role queries", () => {
	const reg: RuntimeRegistry = {
		batchId: "b-1",
		updatedAt: 0,
		agents: {
			"a-1": mkManifest({ agentId: "a-1", status: "running" }),
			"a-2": mkManifest({ agentId: "a-2", status: "exited" }),
			"a-3": mkManifest({ agentId: "a-3", role: "reviewer" }),
		},
	};

	test("getLiveAgents filters terminal", () => {
		const live = getLiveAgents(reg);
		expect(live.length).toBe(2);
		expect(live.some(m => m.agentId === "a-2")).toBe(false);
	});

	test("getAgentsByRole filters by role", () => {
		expect(getAgentsByRole(reg, "reviewer").length).toBe(1);
		expect(getAgentsByRole(reg, "worker").length).toBe(2);
	});
});

describe("process-registry detectOrphans", () => {
	test("non-alive pid flagged as orphan", () => {
		const reg: RuntimeRegistry = {
			batchId: "b-1",
			updatedAt: 0,
			agents: {
				"alive-agent": mkManifest({ agentId: "alive-agent", pid: process.pid }),
				"dead-agent": mkManifest({ agentId: "dead-agent", pid: 999_999_999 }),
				"done-agent": mkManifest({ agentId: "done-agent", pid: 999_999_999, status: "exited" }),
			},
		};
		const orphans = detectOrphans(reg);
		expect(orphans).toContain("dead-agent");
		expect(orphans).not.toContain("alive-agent");
		expect(orphans).not.toContain("done-agent");
	});
});

describe("process-registry appendAgentEvent", () => {
	test("appends JSONL line", () => {
		const root = mkTempRoot();
		try {
			appendAgentEvent(root, "b-1", "a-1", { type: "agent_started", ts: 1 });
			appendAgentEvent(root, "b-1", "a-1", { type: "agent_exited", ts: 2 });
			const path = runtimeAgentEventsPath(root, "b-1", "a-1");
			const body = readFileSync(path, "utf-8");
			const lines = body.trim().split("\n");
			expect(lines.length).toBe(2);
			expect(JSON.parse(lines[0] ?? "").type).toBe("agent_started");
			expect(JSON.parse(lines[1] ?? "").type).toBe("agent_exited");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("process-registry lane + merge snapshots", () => {
	test("lane snapshot round-trip", () => {
		const root = mkTempRoot();
		try {
			writeLaneSnapshot(root, "b-1", 1, { taskId: "T-1", status: "running", updatedAt: 5 });
			const read = readLaneSnapshot(root, "b-1", 1);
			expect(read?.status).toBe("running");
			expect(read?.taskId).toBe("T-1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("merge snapshot round-trip", () => {
		const root = mkTempRoot();
		try {
			const snap: RuntimeMergeSnapshot = {
				batchId: "b-1",
				mergeNumber: 1,
				sessionName: "orch-test-merge-1",
				waveIndex: 0,
				status: "running",
				agent: null,
				updatedAt: 0,
			};
			writeMergeSnapshot(root, "b-1", 1, snap);
			const read = readMergeSnapshot(root, "b-1", 1);
			expect(read?.sessionName).toBe("orch-test-merge-1");
			expect(read?.status).toBe("running");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("missing snapshot → null", () => {
		const root = mkTempRoot();
		try {
			expect(readLaneSnapshot(root, "b-1", 99)).toBeNull();
			expect(readMergeSnapshot(root, "b-1", 99)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("process-registry cleanupBatchRuntime", () => {
	test("removes runtime tree", () => {
		const root = mkTempRoot();
		try {
			writeManifest(root, mkManifest());
			const result = cleanupBatchRuntime(root, "b-1");
			expect(result.removed).toBe(true);
			expect(readRegistrySnapshot(root, "b-1")).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("no-op when no runtime tree", () => {
		const root = mkTempRoot();
		try {
			const result = cleanupBatchRuntime(root, "b-nothing");
			expect(result.removed).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
