/**
 * Tests for `buildSupervisorSystemPrompt` + `buildRoutingSystemPrompt`
 * ported from taskplane `extensions/taskplane/supervisor.ts:2096,2340`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	buildRoutingSystemPrompt,
	buildSupervisorSystemPrompt,
	DEFAULT_ORCHESTRATOR_CONFIG,
	DEFAULT_SUPERVISOR_CONFIG,
	type MissionBatchRuntimeState,
	projectDir,
	resolvePrimerPath,
	type SupervisorRoutingContext,
} from "../src/missioncontrol";

function sandbox(label: string): string {
	return mkdtempSync(join(tmpdir(), `omp-sys-prompt-${label}-`));
}

function runtimeState(overrides?: Partial<MissionBatchRuntimeState>): MissionBatchRuntimeState {
	return {
		batchId: "b-42",
		phase: "running",
		baseBranch: "main",
		orchBranch: "mission/b-42",
		currentWaveIndex: 0,
		totalWaves: 2,
		totalTasks: 5,
		succeededTasks: 1,
		failedTasks: 0,
		skippedTasks: 0,
		blockedTasks: 0,
		...overrides,
	} as MissionBatchRuntimeState;
}

describe("resolvePrimerPath", () => {
	test("points at templates/supervisor-primer.md in the package", () => {
		const p = resolvePrimerPath();
		expect(basename(p)).toBe("supervisor-primer.md");
		expect(existsSync(p)).toBe(true);
	});
});

describe("buildSupervisorSystemPrompt", () => {
	test("prefers the shipped template when available", () => {
		const dir = sandbox("template");
		try {
			const out = buildSupervisorSystemPrompt(
				runtimeState(),
				DEFAULT_ORCHESTRATOR_CONFIG,
				DEFAULT_SUPERVISOR_CONFIG,
				dir,
			);
			// Shipped template contains `{{batchId}}` → resolves to "b-42" when rendered.
			expect(out).toContain("b-42");
			expect(out.length).toBeGreaterThan(500);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("composes shipped template + local override when present", () => {
		const dir = sandbox("compose");
		try {
			mkdirSync(join(projectDir(dir), "agents"), { recursive: true });
			writeFileSync(
				join(projectDir(dir), "agents", "supervisor.md"),
				"Project hint: be extra cautious with db migrations.",
				"utf-8",
			);
			const out = buildSupervisorSystemPrompt(
				runtimeState(),
				DEFAULT_ORCHESTRATOR_CONFIG,
				DEFAULT_SUPERVISOR_CONFIG,
				dir,
			);
			expect(out).toContain("## Project-Specific Guidance");
			expect(out).toContain("be extra cautious with db migrations");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("shows planning when totalWaves = 0", () => {
		const dir = sandbox("planning");
		try {
			const out = buildSupervisorSystemPrompt(
				runtimeState({ totalWaves: 0, currentWaveIndex: -1 }),
				DEFAULT_ORCHESTRATOR_CONFIG,
				DEFAULT_SUPERVISOR_CONFIG,
				dir,
			);
			expect(out).toContain("planning");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("buildRoutingSystemPrompt", () => {
	function ctx(state: string, msg = "detected"): SupervisorRoutingContext {
		return { routingState: state, contextMessage: msg } as SupervisorRoutingContext;
	}

	test("no-config routing mentions .omp/ onboarding artifacts", () => {
		const dir = sandbox("no-config");
		try {
			const out = buildRoutingSystemPrompt(ctx("no-config"), dir);
			expect(out).toContain("no MissionControl configuration");
			expect(out).toContain(".omp/mission.json");
			expect(out).toContain(".omp/agents/task-worker.md");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("pending-tasks routing references Script 6 batch planning", () => {
		const dir = sandbox("pending");
		try {
			const out = buildRoutingSystemPrompt(ctx("pending-tasks"), dir);
			expect(out).toContain("Batch Planning");
			expect(out).toContain("/mission-plan all");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("completed-batch routing mentions integration + retrospective", () => {
		const dir = sandbox("completed");
		try {
			const out = buildRoutingSystemPrompt(ctx("completed-batch"), dir);
			expect(out).toContain("Integration & Retrospective");
			expect(out).toContain("/mission-integrate");
			expect(out).toContain("mission-batch.json");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("unknown routing state falls back to Project Assistance", () => {
		const dir = sandbox("unknown");
		try {
			const out = buildRoutingSystemPrompt(ctx("weird-state"), dir);
			expect(out).toContain("Project Assistance");
			expect(out).toContain("Detected state: weird-state");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
