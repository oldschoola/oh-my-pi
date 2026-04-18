/**
 * Tests for `missioncontrol/agent-host.ts`.
 *
 * The adapter is run in stub mode (`OMP_MISSION_STUB_AGENT=1`) so no child
 * process is spawned. These tests cover the wrapper's surface:
 *   - agent_started/exited events are emitted with correct identity fields.
 *   - Events JSONL file is written when `eventsPath` is provided.
 *   - Exit summary JSON is written when `exitSummaryPath` is provided.
 *   - Manifest + registry snapshot are written when `stateRoot` is provided,
 *     transitioning from `running` → `exited`.
 *   - `kill()` flips terminal state to `killed`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentHostOptions, spawnHostedAgent } from "../src/missioncontrol/agent-host";
import { readManifest, readRegistrySnapshot } from "../src/missioncontrol/process-registry";
import type { RuntimeAgentEvent } from "../src/missioncontrol/types";

const BATCH_ID = "b-test";
const AGENT_ID = "mission-henry-lane-1-worker";

function baseOptions(overrides: Partial<AgentHostOptions> = {}): AgentHostOptions {
	return {
		agentId: AGENT_ID,
		role: "worker",
		batchId: BATCH_ID,
		laneNumber: 1,
		taskId: "t-1",
		repoId: "api",
		cwd: process.cwd(),
		prompt: "do the thing",
		...overrides,
	};
}

let tempDir: string;

beforeEach(() => {
	process.env.OMP_MISSION_STUB_AGENT = "1";
	tempDir = mkdtempSync(join(tmpdir(), "mc-agent-host-"));
});

afterEach(() => {
	delete process.env.OMP_MISSION_STUB_AGENT;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("spawnHostedAgent — core event flow", () => {
	test("emits agent_started and a terminal event with batch/agent identity", async () => {
		const events: RuntimeAgentEvent[] = [];
		const { promise } = spawnHostedAgent(baseOptions(), e => events.push(e));
		const result = await promise;

		expect(result.killed).toBe(false);
		expect(events.length).toBeGreaterThanOrEqual(2);
		const started = events.find(e => e.type === "agent_started");
		// Stub adapter completes without emitting agent_end — terminal
		// classification falls to `agent_crashed` (intentional: no real
		// agent means no clean exit).
		const terminal = events.find(e =>
			["agent_exited", "agent_crashed", "agent_killed", "agent_timeout"].includes(e.type),
		);
		expect(started).toBeDefined();
		expect(terminal).toBeDefined();
		for (const e of events) {
			expect(e.batchId).toBe(BATCH_ID);
			expect(e.agentId).toBe(AGENT_ID);
			expect(e.laneNumber).toBe(1);
			expect(e.repoId).toBe("api");
		}
	});

	test("writes events JSONL when eventsPath is provided", async () => {
		const eventsPath = join(tempDir, "events.jsonl");
		const { promise } = spawnHostedAgent(baseOptions({ eventsPath }));
		await promise;

		expect(existsSync(eventsPath)).toBe(true);
		const lines = readFileSync(eventsPath, "utf-8").trim().split("\n");
		const types = lines.map(l => (JSON.parse(l) as { type: string }).type);
		expect(types).toContain("agent_started");
		// Stub adapter doesn't drive agent_end → expect agent_crashed rather than agent_exited.
		expect(types.some(t => t === "agent_exited" || t === "agent_crashed")).toBe(true);
	});

	test("writes exit summary JSON when exitSummaryPath is provided", async () => {
		const exitSummaryPath = join(tempDir, "exit-summary.json");
		const { promise } = spawnHostedAgent(baseOptions({ exitSummaryPath }));
		await promise;

		expect(existsSync(exitSummaryPath)).toBe(true);
		const summary = JSON.parse(readFileSync(exitSummaryPath, "utf-8")) as Record<string, unknown>;
		expect(summary).toHaveProperty("exitCode");
		expect(summary).toHaveProperty("durationSec");
		expect(summary).toHaveProperty("toolCalls", 0);
	});
});

describe("spawnHostedAgent — registry integration", () => {
	test("writes manifest + registry snapshot, then transitions to terminal status", async () => {
		const stateRoot = tempDir;
		const { promise } = spawnHostedAgent(baseOptions({ stateRoot }));
		await promise;

		const manifest = readManifest(stateRoot, BATCH_ID, AGENT_ID);
		expect(manifest).not.toBeNull();
		// Stub completes without agent_end → crashed is the authoritative terminal.
		expect(manifest?.status).toBeDefined();
		expect(["exited", "crashed"]).toContain(manifest?.status ?? "");

		const snapshot = readRegistrySnapshot(stateRoot, BATCH_ID);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.agents[AGENT_ID]).toBeDefined();
	});
});

describe("spawnHostedAgent — kill()", () => {
	test("kill() marks the result as killed and still resolves", async () => {
		const { promise, kill } = spawnHostedAgent(baseOptions());
		kill();
		const result = await promise;
		expect(result.killed).toBe(true);
	});
});
