/**
 * Unit tests for `buildMissionPlanReport` + `parseMissionPlanArgs`.
 *
 * Covers the plan command's contract: argument parsing, target
 * expansion, discovery + wave plan rendering, and error surfaces.
 * Uses real filesystem fixtures so runDiscovery/computeWaveAssignments
 * run end-to-end against a small tasks tree.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import {
	buildMissionPlanReport,
	CONFIG_VERSION,
	DEFAULT_PROJECT_CONFIG,
	parseMissionPlanArgs,
} from "../src/missioncontrol";
import * as worktree from "../src/missioncontrol/worktree";

function mkTmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function writeOmp(root: string, content: string): void {
	const dir = join(root, ".omp");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "mission.json"), content, "utf-8");
}

function writeTask(areaDir: string, taskId: string, deps: string[] = []): void {
	const folder = join(areaDir, taskId);
	mkdirSync(folder, { recursive: true });
	const depsBlock = deps.length > 0 ? `\n\n## Dependencies\n\n${deps.map(d => `- ${d}`).join("\n")}\n` : "";
	writeFileSync(join(folder, "PROMPT.md"), `# ${taskId} — example task${depsBlock}`, "utf-8");
}

function fullConfig(taskAreas: Record<string, { path: string; prefix: string; context: string }>): string {
	const cfg = structuredClone(DEFAULT_PROJECT_CONFIG);
	cfg.taskRunner.taskAreas = taskAreas;
	return JSON.stringify({ version: CONFIG_VERSION, ...cfg });
}

let savedAgentDir: string | undefined;
let tmpAgentDir: string;

beforeEach(() => {
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	tmpAgentDir = mkTmp("omp-plan-agent");
	process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
	setAgentDir(tmpAgentDir);
	// Preflight depends on the host's `git --version` + `git worktree` support.
	// Stub to "passed" so the tests exercise the plan pipeline instead of
	// environmental git capability.
	spyOn(worktree, "runPreflight").mockReturnValue({
		passed: true,
		checks: [{ name: "git", status: "pass", message: "Git 2.40.0 available" }],
	});
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	setAgentDir(savedAgentDir ?? "");
	rmSync(tmpAgentDir, { recursive: true, force: true });
	mock.restore();
});

describe("parseMissionPlanArgs", () => {
	test("empty input returns no targets, refresh=false", () => {
		const parsed = parseMissionPlanArgs("");
		expect(parsed.targets).toEqual([]);
		expect(parsed.refresh).toBe(false);
		expect(parsed.help).toBe(false);
	});

	test("--help flag is captured", () => {
		const parsed = parseMissionPlanArgs("--help");
		expect(parsed.help).toBe(true);
	});

	test("--refresh flag strips from targets", () => {
		const parsed = parseMissionPlanArgs("all --refresh");
		expect(parsed.refresh).toBe(true);
		expect(parsed.targets).toEqual(["all"]);
	});

	test("multiple area targets are preserved in order", () => {
		const parsed = parseMissionPlanArgs("api frontend auth");
		expect(parsed.targets).toEqual(["api", "frontend", "auth"]);
		expect(parsed.refresh).toBe(false);
	});
});

describe("buildMissionPlanReport", () => {
	test("empty args returns usage help at info level", () => {
		const cwd = mkTmp("omp-plan-cwd");
		try {
			const result = buildMissionPlanReport(cwd, "", null);
			expect(result.level).toBe("info");
			expect(result.message).toContain("Usage:");
			expect(result.message).toContain("/mission-plan");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("--help explicitly returns usage at info level", () => {
		const cwd = mkTmp("omp-plan-cwd");
		try {
			const result = buildMissionPlanReport(cwd, "--help", null);
			expect(result.level).toBe("info");
			expect(result.message).toContain("Usage:");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("successful plan includes preflight + discovery + wave plan sections", () => {
		const cwd = mkTmp("omp-plan-cwd");
		try {
			writeOmp(cwd, fullConfig({ api: { path: "tasks/api", prefix: "API", context: "" } }));
			writeTask(join(cwd, "tasks/api"), "API-001");
			writeTask(join(cwd, "tasks/api"), "API-002", ["API-001"]);
			const result = buildMissionPlanReport(cwd, "all", null);
			// Preflight header appears
			expect(result.message).toContain("Preflight Check:");
			// Discovery results
			expect(result.message).toContain("Discovery Results");
			expect(result.message).toContain("API-001");
			expect(result.message).toContain("API-002");
			// Wave plan
			expect(result.message).toContain("Execution Plan");
			expect(result.level).toBe("info");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("area with no pending tasks yields warning without wave plan", () => {
		const cwd = mkTmp("omp-plan-cwd");
		try {
			writeOmp(cwd, fullConfig({ api: { path: "tasks/api", prefix: "API", context: "" } }));
			mkdirSync(join(cwd, "tasks/api"), { recursive: true });
			const result = buildMissionPlanReport(cwd, "all", null);
			expect(result.level).toBe("warning");
			expect(result.message).toContain("Pending tasks:   0");
			// Wave plan rendering is skipped when there are no pending tasks.
			expect(result.message).not.toContain("Execution Plan");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
