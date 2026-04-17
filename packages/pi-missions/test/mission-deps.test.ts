/**
 * Unit tests for `buildMissionDepsReport` + `parseMissionDepsArgs`.
 *
 * Covers:
 *  - Empty args → usage help
 *  - Valid targets but no areas configured → warning
 *  - Unknown area name → error
 *  - "all" target expands to all configured areas
 *  - Successful task folder discovery + dependency-graph rendering
 *  - --task filter narrows output
 *  - Completed tasks from mission.batch surface as ✅ in graph
 *  - Mixed known + unknown areas → warning level
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAgentDir } from "@oh-my-pi/pi-utils";

import {
	buildMissionDepsReport,
	CONFIG_VERSION,
	DEFAULT_PROJECT_CONFIG,
	parseMissionDepsArgs,
} from "../src/missioncontrol";
import type { MissionState } from "../src/types";

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
	tmpAgentDir = mkTmp("omp-deps-agent");
	process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
	setAgentDir(tmpAgentDir);
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	setAgentDir(savedAgentDir ?? "");
	rmSync(tmpAgentDir, { recursive: true, force: true });
});

describe("parseMissionDepsArgs", () => {
	test("extracts --task filter and strips from targets", () => {
		const parsed = parseMissionDepsArgs("all --task TO-014");
		expect(parsed.filterTaskId).toBe("TO-014");
		expect(parsed.targets).toEqual(["all"]);
	});

	test("uppercases task ID case-insensitively", () => {
		const parsed = parseMissionDepsArgs("api --task to-001");
		expect(parsed.filterTaskId).toBe("TO-001");
	});

	test("multiple targets parsed as tokens", () => {
		const parsed = parseMissionDepsArgs("api frontend auth");
		expect(parsed.targets).toEqual(["api", "frontend", "auth"]);
		expect(parsed.filterTaskId).toBeUndefined();
	});

	test("empty input yields no targets", () => {
		const parsed = parseMissionDepsArgs("");
		expect(parsed.targets).toEqual([]);
		expect(parsed.filterTaskId).toBeUndefined();
	});

	test("--task without target yields empty targets", () => {
		const parsed = parseMissionDepsArgs("--task TO-001");
		expect(parsed.filterTaskId).toBe("TO-001");
		expect(parsed.targets).toEqual([]);
	});
});

describe("buildMissionDepsReport", () => {
	test("empty args returns usage help", () => {
		const cwd = mkTmp("omp-deps-cwd");
		try {
			const result = buildMissionDepsReport(cwd, "", null);
			expect(result.level).toBe("info");
			expect(result.message).toContain("Usage:");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("--task alone (no target) returns error", () => {
		const cwd = mkTmp("omp-deps-cwd");
		try {
			writeOmp(cwd, fullConfig({ api: { path: "tasks/api", prefix: "API", context: "" } }));
			const result = buildMissionDepsReport(cwd, "--task TO-001", null);
			expect(result.level).toBe("error");
			expect(result.message).toContain("target argument required");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("no areas configured returns warning", () => {
		const cwd = mkTmp("omp-deps-cwd");
		try {
			writeOmp(cwd, fullConfig({}));
			const result = buildMissionDepsReport(cwd, "all", null);
			expect(result.level).toBe("warning");
			expect(result.message).toContain("No task areas configured");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("unknown area returns error with known-areas hint", () => {
		const cwd = mkTmp("omp-deps-cwd");
		try {
			writeOmp(cwd, fullConfig({ api: { path: "tasks/api", prefix: "API", context: "" } }));
			const result = buildMissionDepsReport(cwd, "frontend", null);
			expect(result.level).toBe("error");
			expect(result.message).toContain("Unknown area");
			expect(result.message).toContain("api");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("'all' target expands to all configured areas and renders graph", () => {
		const cwd = mkTmp("omp-deps-cwd");
		try {
			writeOmp(
				cwd,
				fullConfig({
					api: { path: "tasks/api", prefix: "API", context: "" },
					fe: { path: "tasks/fe", prefix: "FE", context: "" },
				}),
			);
			writeTask(join(cwd, "tasks/api"), "API-001");
			writeTask(join(cwd, "tasks/fe"), "FE-010", ["API-001"]);
			const result = buildMissionDepsReport(cwd, "all", null);
			expect(result.level).toBe("info");
			expect(result.message).toContain("Dependency Graph");
			expect(result.message).toContain("FE-010");
			expect(result.message).toContain("API-001");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("--task filter narrows graph to single task", () => {
		const cwd = mkTmp("omp-deps-cwd");
		try {
			writeOmp(cwd, fullConfig({ api: { path: "tasks/api", prefix: "API", context: "" } }));
			writeTask(join(cwd, "tasks/api"), "API-001");
			writeTask(join(cwd, "tasks/api"), "API-002", ["API-001"]);
			writeTask(join(cwd, "tasks/api"), "API-003", ["API-002"]);
			const result = buildMissionDepsReport(cwd, "all --task API-002", null);
			expect(result.level).toBe("info");
			expect(result.message).toContain("Dependencies for API-002");
			expect(result.message).toContain("Upstream");
			expect(result.message).toContain("Downstream");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("completed tasks from mission.batch render as ✅", () => {
		const cwd = mkTmp("omp-deps-cwd");
		try {
			writeOmp(cwd, fullConfig({ api: { path: "tasks/api", prefix: "API", context: "" } }));
			writeTask(join(cwd, "tasks/api"), "API-001");
			writeTask(join(cwd, "tasks/api"), "API-002", ["API-001"]);
			const mission: MissionState = {
				description: "demo",
				mode: "simple",
				templateKey: "adaptive",
				phases: [],
				autonomy: "medium",
				modelAssignment: {},
				paused: false,
				pauseHistory: [],
				progressLog: [],
				startedAt: new Date().toISOString(),
				kind: "batch",
				batch: {
					batchId: "b1",
					phase: "running",
					waves: [],
					currentWave: 0,
					laneCount: 1,
					laneStatuses: [],
					tasks: [
						{
							taskId: "API-001",
							status: "succeeded",
							startTime: null,
							endTime: null,
							exitReason: "",
							sessionName: "",
							doneFileFound: true,
						},
					],
					tasksTotal: 2,
					tasksComplete: 1,
					tasksFailed: 0,
					startTime: Date.now(),
					errors: [],
				},
			};
			const result = buildMissionDepsReport(cwd, "api", mission);
			expect(result.level).toBe("info");
			expect(result.message).toContain("✅ complete");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("mixed known + unknown areas yields warning with skip notice", () => {
		const cwd = mkTmp("omp-deps-cwd");
		try {
			writeOmp(cwd, fullConfig({ api: { path: "tasks/api", prefix: "API", context: "" } }));
			writeTask(join(cwd, "tasks/api"), "API-001");
			const result = buildMissionDepsReport(cwd, "api unknown", null);
			expect(result.level).toBe("warning");
			expect(result.message).toContain("Skipped unknown area");
			expect(result.message).toContain("unknown");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("configured area with no tasks yields warning", () => {
		const cwd = mkTmp("omp-deps-cwd");
		try {
			writeOmp(cwd, fullConfig({ api: { path: "tasks/api", prefix: "API", context: "" } }));
			mkdirSync(join(cwd, "tasks/api"), { recursive: true });
			const result = buildMissionDepsReport(cwd, "all", null);
			expect(result.level).toBe("warning");
			expect(result.message).toContain("No pending tasks");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
