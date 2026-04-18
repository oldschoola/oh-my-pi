import { describe, expect, test } from "bun:test";
import {
	CONFIG_VERSION,
	DEFAULT_BOOTSTRAP_GLOBAL_PREFERENCES,
	DEFAULT_GLOBAL_PREFERENCES,
	DEFAULT_ORCHESTRATOR_SECTION,
	DEFAULT_PROJECT_CONFIG,
	DEFAULT_TASK_RUNNER_SECTION,
	GLOBAL_PREFERENCES_FILENAME,
	GLOBAL_PREFERENCES_SUBDIR,
	type MissionProjectConfig,
	PROJECT_CONFIG_FILENAME,
} from "../src/missioncontrol/config-schema";

describe("config-schema constants", () => {
	test("filename renames targeting .omp", () => {
		expect(PROJECT_CONFIG_FILENAME).toBe("mission.json");
		expect(GLOBAL_PREFERENCES_SUBDIR).toBe("missioncontrol");
		expect(GLOBAL_PREFERENCES_FILENAME).toBe("preferences.json");
	});

	test("CONFIG_VERSION is 1 (initial)", () => {
		expect(CONFIG_VERSION).toBe(1);
	});
});

describe("DEFAULT_TASK_RUNNER_SECTION", () => {
	test("exposes sensible defaults", () => {
		expect(DEFAULT_TASK_RUNNER_SECTION.project.name).toBe("Project");
		expect(DEFAULT_TASK_RUNNER_SECTION.worker.tools).toContain("read");
		expect(DEFAULT_TASK_RUNNER_SECTION.reviewer.thinking).toBe("on");
		expect(DEFAULT_TASK_RUNNER_SECTION.context.warnPercent).toBe(85);
		expect(DEFAULT_TASK_RUNNER_SECTION.context.killPercent).toBe(95);
		expect(DEFAULT_TASK_RUNNER_SECTION.modelFallback).toBe("inherit");
	});

	test("quality gate defaults to disabled with no_critical threshold", () => {
		expect(DEFAULT_TASK_RUNNER_SECTION.qualityGate.enabled).toBe(false);
		expect(DEFAULT_TASK_RUNNER_SECTION.qualityGate.passThreshold).toBe("no_critical");
	});
});

describe("DEFAULT_ORCHESTRATOR_SECTION", () => {
	test("uses mission-flavored defaults (not taskplane)", () => {
		expect(DEFAULT_ORCHESTRATOR_SECTION.orchestrator.worktreePrefix).toBe("mission-wt");
		expect(DEFAULT_ORCHESTRATOR_SECTION.orchestrator.sessionPrefix).toBe("mission");
		expect(DEFAULT_ORCHESTRATOR_SECTION.orchestrator.maxLanes).toBe(3);
		expect(DEFAULT_ORCHESTRATOR_SECTION.orchestrator.spawnMode).toBe("subprocess");
	});

	test("assignment size weights S/M/L ascending", () => {
		const w = DEFAULT_ORCHESTRATOR_SECTION.assignment.sizeWeights;
		expect(w.S).toBe(1);
		expect(w.M).toBe(2);
		expect(w.L).toBe(4);
	});

	test("verification defaults are permissive and disabled", () => {
		expect(DEFAULT_ORCHESTRATOR_SECTION.verification.enabled).toBe(false);
		expect(DEFAULT_ORCHESTRATOR_SECTION.verification.mode).toBe("permissive");
		expect(DEFAULT_ORCHESTRATOR_SECTION.verification.flakyReruns).toBe(1);
	});

	test("failure defaults favor skip-dependents + pause on merge failure", () => {
		expect(DEFAULT_ORCHESTRATOR_SECTION.failure.onTaskFailure).toBe("skip-dependents");
		expect(DEFAULT_ORCHESTRATOR_SECTION.failure.onMergeFailure).toBe("pause");
		expect(DEFAULT_ORCHESTRATOR_SECTION.failure.abortGracePeriod).toBe(60);
	});
});

describe("DEFAULT_PROJECT_CONFIG", () => {
	test("includes current CONFIG_VERSION + both sections", () => {
		const cfg: MissionProjectConfig = DEFAULT_PROJECT_CONFIG;
		expect(cfg.configVersion).toBe(CONFIG_VERSION);
		expect(cfg.taskRunner).toBe(DEFAULT_TASK_RUNNER_SECTION);
		expect(cfg.orchestrator).toBe(DEFAULT_ORCHESTRATOR_SECTION);
		expect(cfg.workspace).toBeUndefined();
	});
});

describe("DEFAULT_GLOBAL_PREFERENCES + bootstrap defaults", () => {
	test("runtime default is empty (no overrides)", () => {
		expect(DEFAULT_GLOBAL_PREFERENCES).toEqual({});
	});

	test("bootstrap seed populates initAgentDefaults with thinking=high", () => {
		const b = DEFAULT_BOOTSTRAP_GLOBAL_PREFERENCES.initAgentDefaults;
		expect(b).toBeDefined();
		expect(b?.workerThinking).toBe("high");
		expect(b?.reviewerThinking).toBe("high");
		expect(b?.mergeThinking).toBe("high");
		expect(b?.workerModel).toBe("");
	});
});
