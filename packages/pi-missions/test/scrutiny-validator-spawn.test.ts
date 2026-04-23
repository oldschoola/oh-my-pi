/**
 * Unit tests for spawnScrutinyValidator + renderScrutinyPrompt (Track B2).
 *
 * Uses an injectable `spawn` fake to avoid booting the real RPC coding
 * agent. Asserts the spawn receives a fully-prepared prompt, agent id,
 * env wiring, and that the output directory is created up-front.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AgentHostOptions, AgentHostResult, spawnHostedAgent } from "../src/missioncontrol";
import { renderScrutinyPrompt, spawnScrutinyValidator } from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-scrutiny-spawn-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function fakeResult(): AgentHostResult {
	return {
		exitCode: 0,
		signal: null,
		durationMs: 5,
		killed: false,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		toolCalls: 0,
		lastTool: "",
		contextUsage: null,
		error: null,
		agentEnded: true,
	};
}

function captureSpawn(): {
	spawn: typeof spawnHostedAgent;
	captured: { options: AgentHostOptions | null };
} {
	const captured: { options: AgentHostOptions | null } = { options: null };
	const spawn: typeof spawnHostedAgent = opts => {
		captured.options = opts;
		return {
			promise: Promise.resolve(fakeResult()),
			kill: () => {},
		};
	};
	return { spawn, captured };
}

describe("renderScrutinyPrompt", () => {
	test("interpolates every placeholder", () => {
		const rendered = renderScrutinyPrompt(
			"{{milestoneId}} {{round}} {{contractPath}} {{batchStatePath}} {{outputPath}}",
			{
				milestoneId: "M-001",
				round: 2,
				contractPath: "/c.json",
				batchStatePath: "/s.json",
				outputPath: "/o.json",
			},
		);
		expect(rendered).toBe("M-001 2 /c.json /s.json /o.json");
	});

	test("repeats placeholders replace every occurrence", () => {
		const rendered = renderScrutinyPrompt("{{milestoneId}} -> {{milestoneId}}", {
			milestoneId: "M-042",
			round: 1,
			contractPath: "",
			batchStatePath: "",
			outputPath: "",
		});
		expect(rendered).toBe("M-042 -> M-042");
	});
});

describe("spawnScrutinyValidator", () => {
	test("creates the output parent directory before spawn", async () => {
		const outputPath = join(sandbox, "validation", "b-1", "M-001-scrutiny-round1.json");
		expect(existsSync(dirname(outputPath))).toBe(false);
		const { spawn, captured } = captureSpawn();
		await spawnScrutinyValidator({
			cwd: sandbox,
			batchId: "b-1",
			milestoneId: "M-001",
			round: 1,
			outputPath,
			contractPath: "/c.json",
			batchStatePath: "/s.json",
			spawn,
			loadTemplate: async () => "tpl {{milestoneId}}",
			now: () => 1000,
		});
		expect(existsSync(dirname(outputPath))).toBe(true);
		expect(captured.options).not.toBeNull();
	});

	test("wires placeholders into the prompt", async () => {
		const { spawn, captured } = captureSpawn();
		await spawnScrutinyValidator({
			cwd: sandbox,
			batchId: "b-2",
			milestoneId: "M-002",
			round: 3,
			outputPath: join(sandbox, "out.json"),
			contractPath: "/c.json",
			batchStatePath: "/s.json",
			spawn,
			loadTemplate: async () =>
				"id={{milestoneId}} round={{round}} contract={{contractPath}} batch={{batchStatePath}} out={{outputPath}}",
			now: () => 100,
		});
		const prompt = captured.options?.prompt ?? "";
		expect(prompt).toContain("id=M-002");
		expect(prompt).toContain("round=3");
		expect(prompt).toContain("contract=/c.json");
		expect(prompt).toContain("batch=/s.json");
		expect(prompt).toContain("out=");
	});

	test("sets agent role to reviewer and attaches milestone env vars", async () => {
		const outputPath = join(sandbox, "out.json");
		const { spawn, captured } = captureSpawn();
		await spawnScrutinyValidator({
			cwd: sandbox,
			batchId: "b-1",
			milestoneId: "M-007",
			round: 2,
			outputPath,
			contractPath: "/c.json",
			batchStatePath: "/s.json",
			spawn,
			loadTemplate: async () => "stub",
			now: () => 42,
		});
		const opts = captured.options;
		expect(opts?.role).toBe("reviewer");
		expect(opts?.taskId).toBe("M-007");
		expect(opts?.laneNumber).toBeNull();
		expect(opts?.env?.MISSION_VALIDATOR_KIND).toBe("scrutiny");
		expect(opts?.env?.MISSION_VALIDATOR_MILESTONE).toBe("M-007");
		expect(opts?.env?.MISSION_VALIDATOR_ROUND).toBe("2");
		expect(opts?.env?.MISSION_VALIDATOR_OUTPUT_PATH).toBe(outputPath);
	});

	test("uses explicit agent id when provided", async () => {
		const { spawn, captured } = captureSpawn();
		await spawnScrutinyValidator({
			cwd: sandbox,
			batchId: "b-1",
			milestoneId: "M-001",
			round: 1,
			outputPath: join(sandbox, "out.json"),
			contractPath: "/c.json",
			batchStatePath: "/s.json",
			agentId: "fixed-id",
			spawn,
			loadTemplate: async () => "stub",
		});
		expect(captured.options?.agentId).toBe("fixed-id");
	});

	test("generates a deterministic agent id from clock when not provided", async () => {
		const { spawn, captured } = captureSpawn();
		await spawnScrutinyValidator({
			cwd: sandbox,
			batchId: "b-1",
			milestoneId: "M-001",
			round: 1,
			outputPath: join(sandbox, "out.json"),
			contractPath: "/c.json",
			batchStatePath: "/s.json",
			spawn,
			loadTemplate: async () => "stub",
			now: () => 99,
		});
		expect(captured.options?.agentId).toBe("scrutiny-M-001-r1-99");
	});

	test("propagates model + timeout passthrough", async () => {
		const { spawn, captured } = captureSpawn();
		await spawnScrutinyValidator({
			cwd: sandbox,
			batchId: "b-1",
			milestoneId: "M-001",
			round: 1,
			outputPath: join(sandbox, "out.json"),
			contractPath: "/c.json",
			batchStatePath: "/s.json",
			model: "claude-sonnet-4-5",
			timeoutMs: 60_000,
			stateRoot: "/state",
			spawn,
			loadTemplate: async () => "stub",
		});
		expect(captured.options?.model).toBe("claude-sonnet-4-5");
		expect(captured.options?.timeoutMs).toBe(60_000);
		expect(captured.options?.stateRoot).toBe("/state");
	});

	test("resolves with the spawn's AgentHostResult", async () => {
		const { spawn } = captureSpawn();
		const result = await spawnScrutinyValidator({
			cwd: sandbox,
			batchId: "b-1",
			milestoneId: "M-001",
			round: 1,
			outputPath: join(sandbox, "out.json"),
			contractPath: "/c.json",
			batchStatePath: "/s.json",
			spawn,
			loadTemplate: async () => "stub",
		});
		expect(result.agentEnded).toBe(true);
		expect(result.exitCode).toBe(0);
	});
});
