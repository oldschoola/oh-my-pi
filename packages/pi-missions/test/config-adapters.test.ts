/**
 * Unit tests for config adapters + config.ts wrappers.
 *
 * Covers:
 *  - toOrchestratorConfig: camelCase → snake_case field mapping, dictionary
 *    key preservation (sizeWeights, preWarm.commands), default timeoutMinutes
 *  - toTaskRunnerConfig: repoId trimming, testing_commands gating, reviewer
 *    projection
 *  - toTaskConfig: standards_overrides snake_case, task_areas repo_id
 *    mapping, worker/reviewer/context/quality_gate projections
 *  - loadOrchestratorConfig / loadTaskRunnerConfig / loadSupervisorConfig:
 *    end-to-end load against scratch `.omp/mission.json` + supervisor section
 *    fallback when missing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAgentDir } from "@oh-my-pi/pi-utils";

import {
	CONFIG_VERSION,
	DEFAULT_PROJECT_CONFIG,
	DEFAULT_SUPERVISOR_CONFIG,
	loadOrchestratorConfig,
	loadSupervisorConfig,
	loadTaskRunnerConfig,
	toOrchestratorConfig,
	toTaskConfig,
	toTaskRunnerConfig,
} from "../src/missioncontrol";

function mkTmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function writeOmp(root: string, name: string, content: string): void {
	const dir = join(root, ".omp");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), content, "utf-8");
}

let savedAgentDir: string | undefined;
let tmpAgentDir: string;

beforeEach(() => {
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	tmpAgentDir = mkTmp("omp-config-agent");
	process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
	setAgentDir(tmpAgentDir);
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	setAgentDir(savedAgentDir ?? "");
	rmSync(tmpAgentDir, { recursive: true, force: true });
});

describe("toOrchestratorConfig", () => {
	test("projects camelCase → snake_case and preserves dictionary keys", () => {
		const out = toOrchestratorConfig(DEFAULT_PROJECT_CONFIG);
		expect(out.orchestrator.max_lanes).toBe(DEFAULT_PROJECT_CONFIG.orchestrator.orchestrator.maxLanes);
		expect(out.orchestrator.worktree_prefix).toBe(DEFAULT_PROJECT_CONFIG.orchestrator.orchestrator.worktreePrefix);
		expect(out.orchestrator.operator_id).toBe(DEFAULT_PROJECT_CONFIG.orchestrator.orchestrator.operatorId);
		expect(out.assignment.size_weights).toEqual(DEFAULT_PROJECT_CONFIG.orchestrator.assignment.sizeWeights);
	});

	test("clones size_weights + preWarm.commands to avoid aliasing", () => {
		const out = toOrchestratorConfig(DEFAULT_PROJECT_CONFIG);
		expect(out.assignment.size_weights).not.toBe(DEFAULT_PROJECT_CONFIG.orchestrator.assignment.sizeWeights);
		expect(out.pre_warm.commands).not.toBe(DEFAULT_PROJECT_CONFIG.orchestrator.preWarm.commands);
		expect(out.pre_warm.always).not.toBe(DEFAULT_PROJECT_CONFIG.orchestrator.preWarm.always);
	});

	test("fills merge.timeout_minutes default when unset", () => {
		const cfg = structuredClone(DEFAULT_PROJECT_CONFIG);
		cfg.orchestrator.merge.timeoutMinutes = undefined;
		const out = toOrchestratorConfig(cfg);
		expect(out.merge.timeout_minutes).toBe(90);
	});
});

describe("toTaskRunnerConfig", () => {
	test("trims non-empty repoId and drops whitespace-only", () => {
		const cfg = structuredClone(DEFAULT_PROJECT_CONFIG);
		cfg.taskRunner.taskAreas = {
			a: { path: "tasks/a", prefix: "a", context: "", repoId: "  repo-1  " },
			b: { path: "tasks/b", prefix: "b", context: "", repoId: "   " },
			c: { path: "tasks/c", prefix: "c", context: "" },
		};
		const out = toTaskRunnerConfig(cfg);
		expect(out.task_areas.a.repoId).toBe("repo-1");
		expect(out.task_areas.b.repoId).toBeUndefined();
		expect(out.task_areas.c.repoId).toBeUndefined();
	});

	test("omits testing_commands when empty", () => {
		const cfg = structuredClone(DEFAULT_PROJECT_CONFIG);
		cfg.taskRunner.testing.commands = {};
		const out = toTaskRunnerConfig(cfg);
		expect(out.testing_commands).toBeUndefined();
	});

	test("includes testing_commands when populated", () => {
		const cfg = structuredClone(DEFAULT_PROJECT_CONFIG);
		cfg.taskRunner.testing.commands = { unit: "bun test" };
		const out = toTaskRunnerConfig(cfg);
		expect(out.testing_commands).toEqual({ unit: "bun test" });
	});

	test("projects reviewer + model_fallback defaults", () => {
		const out = toTaskRunnerConfig(DEFAULT_PROJECT_CONFIG);
		expect(out.reviewer).toEqual({
			model: DEFAULT_PROJECT_CONFIG.taskRunner.reviewer.model,
			thinking: DEFAULT_PROJECT_CONFIG.taskRunner.reviewer.thinking,
			tools: DEFAULT_PROJECT_CONFIG.taskRunner.reviewer.tools,
		});
		expect(out.model_fallback).toBe("inherit");
	});
});

describe("toTaskConfig", () => {
	test("maps standardsOverrides to snake_case outer shape", () => {
		const cfg = structuredClone(DEFAULT_PROJECT_CONFIG);
		cfg.taskRunner.standardsOverrides = {
			backend: { docs: ["docs/back.md"], rules: ["rule-1"] },
			frontend: { docs: ["docs/front.md"] },
		};
		const out = toTaskConfig(cfg);
		expect(out.standards_overrides).toEqual({
			backend: { docs: ["docs/back.md"], rules: ["rule-1"] },
			frontend: { docs: ["docs/front.md"], rules: undefined },
		});
	});

	test("maps taskAreas with repo_id snake_case when repoId set", () => {
		const cfg = structuredClone(DEFAULT_PROJECT_CONFIG);
		cfg.taskRunner.taskAreas = {
			backend: { path: "tasks/backend", prefix: "be", context: "server", repoId: "api" },
			frontend: { path: "tasks/frontend", prefix: "fe", context: "web" },
		};
		const out = toTaskConfig(cfg);
		expect(out.task_areas.backend).toEqual({
			path: "tasks/backend",
			prefix: "be",
			context: "server",
			repo_id: "api",
		});
		expect(out.task_areas.frontend).toEqual({
			path: "tasks/frontend",
			prefix: "fe",
			context: "web",
		});
		expect("repo_id" in out.task_areas.frontend).toBe(false);
	});

	test("projects worker.spawn_mode + reviewer + context + quality_gate", () => {
		const out = toTaskConfig(DEFAULT_PROJECT_CONFIG);
		expect(out.worker.spawn_mode).toBe(DEFAULT_PROJECT_CONFIG.taskRunner.worker.spawnMode);
		expect(out.reviewer).toEqual({
			model: DEFAULT_PROJECT_CONFIG.taskRunner.reviewer.model,
			tools: DEFAULT_PROJECT_CONFIG.taskRunner.reviewer.tools,
			thinking: DEFAULT_PROJECT_CONFIG.taskRunner.reviewer.thinking,
		});
		expect(out.context.worker_context_window).toBe(DEFAULT_PROJECT_CONFIG.taskRunner.context.workerContextWindow);
		expect(out.context.warn_percent).toBe(DEFAULT_PROJECT_CONFIG.taskRunner.context.warnPercent);
		expect(out.quality_gate.review_model).toBe(DEFAULT_PROJECT_CONFIG.taskRunner.qualityGate.reviewModel);
		expect(out.quality_gate.pass_threshold).toBe(DEFAULT_PROJECT_CONFIG.taskRunner.qualityGate.passThreshold);
	});
});

describe("loadOrchestratorConfig / loadTaskRunnerConfig", () => {
	test("loads from .omp/mission.json and returns snake_case shapes", () => {
		const cwd = mkTmp("omp-mission-load");
		try {
			const cfg = structuredClone(DEFAULT_PROJECT_CONFIG);
			cfg.orchestrator.orchestrator.maxLanes = 7;
			cfg.orchestrator.orchestrator.operatorId = "lucy";
			writeOmp(cwd, "mission.json", JSON.stringify({ ...cfg, configVersion: CONFIG_VERSION }));

			const orch = loadOrchestratorConfig(cwd);
			expect(orch.orchestrator.max_lanes).toBe(7);
			expect(orch.orchestrator.operator_id).toBe("lucy");

			const tr = loadTaskRunnerConfig(cwd);
			expect(tr.model_fallback).toBe("inherit");
			expect(tr.reviewer?.model).toBe(DEFAULT_PROJECT_CONFIG.taskRunner.reviewer.model);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("loadSupervisorConfig", () => {
	test("returns defaults when supervisor section missing", () => {
		const cwd = mkTmp("omp-supervisor-missing");
		try {
			const cfg = structuredClone(DEFAULT_PROJECT_CONFIG);
			(cfg.orchestrator as { supervisor?: unknown }).supervisor = undefined;
			writeOmp(cwd, "mission.json", JSON.stringify({ ...cfg, configVersion: CONFIG_VERSION }));

			const sup = loadSupervisorConfig(cwd);
			expect(sup).toEqual({ ...DEFAULT_SUPERVISOR_CONFIG });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("extracts supervisor fields from unified config", () => {
		const cwd = mkTmp("omp-supervisor-set");
		try {
			const cfg = structuredClone(DEFAULT_PROJECT_CONFIG);
			cfg.orchestrator.supervisor = { model: "claude-opus-4-7", autonomy: "supervised" };
			writeOmp(cwd, "mission.json", JSON.stringify({ ...cfg, configVersion: CONFIG_VERSION }));

			const sup = loadSupervisorConfig(cwd);
			expect(sup.model).toBe("claude-opus-4-7");
			expect(sup.autonomy).toBe("supervised");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
