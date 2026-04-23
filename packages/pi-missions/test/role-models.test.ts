/**
 * Unit tests for per-role model resolution + persistence (Track G).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MissionProjectConfig, MissionRoleModels } from "../src/missioncontrol";
import {
	applyRoleModelOverride,
	DEFAULT_PROJECT_CONFIG,
	describeAllRoleModels,
	describeModelResolution,
	isMissionRole,
	MISSION_ROLES,
	persistRoleModelOverride,
	projectConfigPath,
	resolveModelForRole,
} from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-role-models-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function cfg(overrides: Partial<MissionProjectConfig> = {}): MissionProjectConfig {
	return {
		...DEFAULT_PROJECT_CONFIG,
		...overrides,
		taskRunner: {
			...DEFAULT_PROJECT_CONFIG.taskRunner,
			...(overrides.taskRunner ?? {}),
		},
		orchestrator: {
			...DEFAULT_PROJECT_CONFIG.orchestrator,
			...(overrides.orchestrator ?? {}),
		},
	};
}

describe("MISSION_ROLES + isMissionRole", () => {
	test("canonical ordering covers every role", () => {
		expect(MISSION_ROLES).toEqual(["orchestrator", "worker", "scrutiny_validator", "user_testing_validator"]);
	});

	test("isMissionRole guards untrusted input", () => {
		expect(isMissionRole("orchestrator")).toBe(true);
		expect(isMissionRole("scrutiny_validator")).toBe(true);
		expect(isMissionRole("planner")).toBe(false);
		expect(isMissionRole(42)).toBe(false);
		expect(isMissionRole(undefined)).toBe(false);
	});
});

describe("resolveModelForRole \u2014 fallback chain", () => {
	test("blank → '' when nothing is configured", () => {
		expect(resolveModelForRole(cfg(), "worker")).toBe("");
	});

	test("defaultModel wins when no config layers set", () => {
		expect(resolveModelForRole(cfg(), "worker", "claude-haiku-default")).toBe("claude-haiku-default");
	});

	test("legacy worker model beats default", () => {
		const c = cfg({
			taskRunner: {
				...DEFAULT_PROJECT_CONFIG.taskRunner,
				worker: { ...DEFAULT_PROJECT_CONFIG.taskRunner.worker, model: "legacy-worker" },
			},
		});
		expect(resolveModelForRole(c, "worker", "default-fallback")).toBe("legacy-worker");
	});

	test("legacy supervisor model backs orchestrator role", () => {
		const c = cfg({
			orchestrator: {
				...DEFAULT_PROJECT_CONFIG.orchestrator,
				supervisor: { model: "legacy-sup", autonomy: "supervised" },
			},
		});
		expect(resolveModelForRole(c, "orchestrator")).toBe("legacy-sup");
	});

	test("legacy reviewer model backs both validators", () => {
		const c = cfg({
			taskRunner: {
				...DEFAULT_PROJECT_CONFIG.taskRunner,
				reviewer: { ...DEFAULT_PROJECT_CONFIG.taskRunner.reviewer, model: "legacy-rev" },
			},
		});
		expect(resolveModelForRole(c, "scrutiny_validator")).toBe("legacy-rev");
		expect(resolveModelForRole(c, "user_testing_validator")).toBe("legacy-rev");
	});

	test("missions.models override wins over legacy seat", () => {
		const c = cfg({
			taskRunner: {
				...DEFAULT_PROJECT_CONFIG.taskRunner,
				worker: { ...DEFAULT_PROJECT_CONFIG.taskRunner.worker, model: "legacy-worker" },
			},
			missions: { models: { worker: "overridden-worker" } },
		});
		expect(resolveModelForRole(c, "worker")).toBe("overridden-worker");
	});

	test("empty string in missions.models falls through to legacy seat", () => {
		const c = cfg({
			taskRunner: {
				...DEFAULT_PROJECT_CONFIG.taskRunner,
				worker: { ...DEFAULT_PROJECT_CONFIG.taskRunner.worker, model: "legacy-worker" },
			},
			missions: { models: { worker: "" } },
		});
		expect(resolveModelForRole(c, "worker")).toBe("legacy-worker");
	});

	test("whitespace-only model treated as unset", () => {
		const c = cfg({ missions: { models: { worker: "   " } } });
		expect(resolveModelForRole(c, "worker", "default")).toBe("default");
	});
});

describe("describeModelResolution", () => {
	test("reports missions-override when set", () => {
		const c = cfg({ missions: { models: { worker: "o" } } });
		expect(describeModelResolution(c, "worker")).toEqual({
			role: "worker",
			model: "o",
			source: "missions-override",
		});
	});

	test("reports legacy-seat when missions blank + legacy set", () => {
		const c = cfg({
			taskRunner: {
				...DEFAULT_PROJECT_CONFIG.taskRunner,
				worker: { ...DEFAULT_PROJECT_CONFIG.taskRunner.worker, model: "legacy" },
			},
		});
		expect(describeModelResolution(c, "worker").source).toBe("legacy-seat");
	});

	test("reports default when only defaultModel supplied", () => {
		const c = cfg();
		expect(describeModelResolution(c, "worker", "fallback")).toEqual({
			role: "worker",
			model: "fallback",
			source: "default",
		});
	});

	test("reports none when nothing resolves", () => {
		const c = cfg();
		expect(describeModelResolution(c, "worker").source).toBe("none");
	});
});

describe("describeAllRoleModels", () => {
	test("emits one entry per role in canonical order", () => {
		const resolved = describeAllRoleModels(cfg());
		expect(resolved).toHaveLength(MISSION_ROLES.length);
		expect(resolved.map(r => r.role)).toEqual([...MISSION_ROLES]);
	});
});

describe("applyRoleModelOverride", () => {
	test("sets new override in immutable fashion", () => {
		const base: MissionRoleModels = { worker: "w" };
		const next = applyRoleModelOverride(base, "orchestrator", "o");
		expect(next).toEqual({ worker: "w", orchestrator: "o" });
		expect(base).toEqual({ worker: "w" });
	});

	test("blank model clears the role override", () => {
		const base: MissionRoleModels = { worker: "w", orchestrator: "o" };
		const next = applyRoleModelOverride(base, "worker", "");
		expect(next).toEqual({ orchestrator: "o" });
	});

	test("trims whitespace in new overrides", () => {
		const next = applyRoleModelOverride(undefined, "worker", "   claude-haiku   ");
		expect(next).toEqual({ worker: "claude-haiku" });
	});
});

describe("persistRoleModelOverride", () => {
	test("writes mission.json with missions.models override when file absent", () => {
		const updated = persistRoleModelOverride(sandbox, "worker", "claude-sonnet");
		expect(updated).toEqual({ worker: "claude-sonnet" });
		const path = projectConfigPath(sandbox);
		expect(existsSync(path)).toBe(true);
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		expect(parsed.missions).toEqual({ models: { worker: "claude-sonnet" } });
	});

	test("merges with existing mission.json fields", () => {
		const path = projectConfigPath(sandbox);
		const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
		mkdirSync(join(sandbox, ".omp"), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				configVersion: 1,
				orchestrator: { supervisor: { model: "legacy-sup" } },
			}),
			"utf-8",
		);
		persistRoleModelOverride(sandbox, "scrutiny_validator", "claude-opus");
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		expect(parsed.configVersion).toBe(1);
		expect(parsed.orchestrator).toEqual({ supervisor: { model: "legacy-sup" } });
		expect(parsed.missions).toEqual({ models: { scrutiny_validator: "claude-opus" } });
	});

	test("blank model clears the role override", () => {
		persistRoleModelOverride(sandbox, "worker", "a");
		const updated = persistRoleModelOverride(sandbox, "worker", "");
		expect(updated).toEqual({});
		const parsed = JSON.parse(readFileSync(projectConfigPath(sandbox), "utf-8")) as Record<string, unknown>;
		expect(parsed.missions).toEqual({ models: {} });
	});

	test("falls back to empty document when mission.json is malformed", () => {
		const path = projectConfigPath(sandbox);
		const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
		mkdirSync(join(sandbox, ".omp"), { recursive: true });
		writeFileSync(path, "{not-json", "utf-8");
		const updated = persistRoleModelOverride(sandbox, "worker", "recovery");
		expect(updated).toEqual({ worker: "recovery" });
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		expect(parsed.missions).toEqual({ models: { worker: "recovery" } });
	});
});
