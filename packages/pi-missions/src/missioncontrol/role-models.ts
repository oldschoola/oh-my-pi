/**
 * Per-role model resolution (Track G).
 *
 * Centralises how the engine picks a model for each Factory role. A
 * single function `resolveModelForRole` walks the fallback chain so
 * callers never reach into config structs directly.
 *
 * Fallback chain (first non-empty wins):
 *
 *   1. `missions.models[role]` \u2014 explicit per-role override from
 *      `.omp/mission.json`'s `missions` section (Track G).
 *   2. Role-specific legacy seat:
 *        - orchestrator \u2192 `orchestrator.supervisor.model`
 *        - worker \u2192 `taskRunner.worker.model`
 *        - scrutiny_validator, user_testing_validator \u2192 `taskRunner.reviewer.model`
 *   3. A provided default (caller-supplied, typically the global agent model).
 *   4. `\"\"` sentinel \u2014 caller decides what to do with an unset model.
 *
 * A `\"\"` value at any step is treated as \"not set\" so operators can
 * explicitly blank a slot to cascade to the next layer.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { projectDir } from "./adapter";
import type { MissionProjectConfig, MissionRole, MissionRoleModels } from "./config-schema";
import { PROJECT_CONFIG_FILENAME } from "./config-schema";

/**
 * The four mission roles that participate in per-role model resolution.
 * Canonical ordering used for UI + rendering.
 */
export const MISSION_ROLES: readonly MissionRole[] = [
	"orchestrator",
	"worker",
	"scrutiny_validator",
	"user_testing_validator",
] as const;

/** Type-guard for untrusted role inputs. */
export function isMissionRole(value: unknown): value is MissionRole {
	return typeof value === "string" && (MISSION_ROLES as readonly string[]).includes(value);
}

/** Normalise an optional model string \u2014 empty / whitespace-only \u2192 undefined. */
function normalise(model: string | undefined): string | undefined {
	if (typeof model !== "string") return undefined;
	const trimmed = model.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Extract the legacy "role's primary seat" from the project config. Used
 * as the 2nd step in the fallback chain when no per-role override exists.
 */
function legacyRoleModel(config: MissionProjectConfig, role: MissionRole): string | undefined {
	switch (role) {
		case "orchestrator":
			return normalise(config.orchestrator?.supervisor?.model);
		case "worker":
			return normalise(config.taskRunner?.worker?.model);
		case "scrutiny_validator":
		case "user_testing_validator":
			return normalise(config.taskRunner?.reviewer?.model);
	}
}

/**
 * Resolve the model ID to spawn for `role`.
 *
 * @param config      Project config (`.omp/mission.json`).
 * @param role        The mission role requesting a model.
 * @param defaultModel Caller-supplied fallback (e.g. the host coding-agent's global model).
 * @returns The resolved model id, or `""` when every layer is blank.
 */
export function resolveModelForRole(
	config: MissionProjectConfig,
	role: MissionRole,
	defaultModel: string = "",
): string {
	return normalise(config.missions?.models?.[role]) ?? legacyRoleModel(config, role) ?? normalise(defaultModel) ?? "";
}

/**
 * Inverse of {@link resolveModelForRole} \u2014 show, for a given role, which
 * layer's value currently wins. Useful for `orch_read_validation_status`-
 * style surfaces and debug UIs.
 */
export type ModelSource = "missions-override" | "legacy-seat" | "default" | "none";

export interface ResolvedRoleModel {
	role: MissionRole;
	model: string;
	source: ModelSource;
}

/** Compute `{ model, source }` so callers can render the resolution trace. */
export function describeModelResolution(
	config: MissionProjectConfig,
	role: MissionRole,
	defaultModel: string = "",
): ResolvedRoleModel {
	const override = normalise(config.missions?.models?.[role]);
	if (override) return { role, model: override, source: "missions-override" };
	const legacy = legacyRoleModel(config, role);
	if (legacy) return { role, model: legacy, source: "legacy-seat" };
	const fallback = normalise(defaultModel);
	if (fallback) return { role, model: fallback, source: "default" };
	return { role, model: "", source: "none" };
}

/** Describe every mission role's model resolution. */
export function describeAllRoleModels(config: MissionProjectConfig, defaultModel: string = ""): ResolvedRoleModel[] {
	return MISSION_ROLES.map(r => describeModelResolution(config, r, defaultModel));
}

/**
 * Apply a role override to a `MissionRoleModels` map. Returns a new map;
 * never mutates the input. Blank model strings clear the override so
 * the legacy-seat seat resumes control.
 */
export function applyRoleModelOverride(
	models: MissionRoleModels | undefined,
	role: MissionRole,
	model: string,
): MissionRoleModels {
	const base = models ? { ...models } : {};
	const trimmed = model.trim();
	if (trimmed.length === 0) {
		delete base[role];
	} else {
		base[role] = trimmed;
	}
	return base;
}

// ── Persistence (Track G4) ────────────────────────────
//
// `orch_set_role_model` mutates the `missions.models` block of
// `.omp/mission.json` (project config) in place. To keep the tool
// self-contained and testable, persistence lives in this module next to
// the resolver.

/** Absolute path to the project's `mission.json`. */
export function projectConfigPath(cwd: string): string {
	return path.join(projectDir(cwd), PROJECT_CONFIG_FILENAME);
}

/**
 * Persist a per-role model override to `.omp/mission.json`. Reads the
 * current overrides (or seeds an empty document when absent), merges the
 * `missions.models[role] = model` change, and writes the file atomically.
 *
 * `model = ""` clears the override so the fallback chain resumes.
 *
 * Returns the persisted `MissionRoleModels` map for UI/test inspection.
 */
export function persistRoleModelOverride(cwd: string, role: MissionRole, model: string): MissionRoleModels {
	const filePath = projectConfigPath(cwd);
	const dir = path.dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	let existing: Record<string, unknown> = {};
	if (existsSync(filePath)) {
		try {
			existing = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
			if (!existing || typeof existing !== "object" || Array.isArray(existing)) existing = {};
		} catch {
			existing = {};
		}
	}

	const missions = (existing.missions as { models?: MissionRoleModels } | undefined) ?? {};
	const updatedModels = applyRoleModelOverride(missions.models, role, model);
	const nextMissions = { ...missions, models: updatedModels };
	const nextConfig: Record<string, unknown> = {
		// Ensure configVersion is present so the loader accepts the file.
		configVersion: typeof existing.configVersion === "number" ? existing.configVersion : 1,
		...existing,
		missions: nextMissions,
	};

	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf-8");
	renameSync(tmp, filePath);
	return updatedModels;
}
