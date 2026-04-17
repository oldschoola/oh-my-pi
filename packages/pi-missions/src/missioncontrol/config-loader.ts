/**
 * Unified config loader for `.omp/mission.json` with YAML fallback.
 *
 * Ported from taskplane/extensions/taskplane/config-loader.ts (Layer 1 +
 * Layer 2 loaders — Runtime V2 `to*Config` adapters and `loadConfig` are
 * deferred until the orchestrator/task-runner type modules land).
 *
 * Effective precedence:
 *   1. Schema defaults (internal — `DEFAULT_PROJECT_CONFIG`)
 *   2. Global preferences (`<agentDir>/missioncontrol/preferences.json`)
 *   3. Project overrides (`.omp/mission.json` or YAML fallback)
 *
 * Renames vs taskplane:
 *   `TaskplaneConfig`              → `MissionProjectConfig`
 *   `.pi/taskplane-config.json`    → `.omp/mission.json`
 *   `.pi/task-runner.yaml`         → `.omp/task-runner.yaml`
 *   `.pi/task-orchestrator.yaml`   → `.omp/task-orchestrator.yaml`
 *   `.pi/taskplane-workspace.yaml` → `.omp/mission-workspace.yaml`
 *   `~/.pi/agent/taskplane/`       → `<userAgentDir()>/missioncontrol/`
 *   `TASKPLANE_WORKSPACE_ROOT`     → `OMP_WORKSPACE_ROOT` (legacy accepted)
 *   `[taskplane]` log prefixes     → `[missioncontrol]`
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import { logger, projectDir, userAgentDir } from "./adapter";
import {
	CONFIG_VERSION,
	DEFAULT_BOOTSTRAP_GLOBAL_PREFERENCES,
	DEFAULT_GLOBAL_PREFERENCES,
	DEFAULT_PROJECT_CONFIG,
	GLOBAL_PREFERENCES_FILENAME,
	GLOBAL_PREFERENCES_SUBDIR,
	type GlobalPreferences,
	type MissionProjectConfig,
	type OrchestratorSection,
	PROJECT_CONFIG_FILENAME,
	type TaskRunnerSection,
	type WorkspaceSectionConfig,
} from "./config-schema";
import type { OrchestratorConfig, TaskArea, TaskRunnerConfig } from "./types";
import { type PointerResolution, WORKSPACE_CONFIG_FILENAME } from "./types";
import { loadWorkspaceConfig, resolvePointer } from "./workspace";

// ── Error Types ──────────────────────────────────────────────────────

export type ConfigLoadErrorCode =
	| "CONFIG_JSON_MALFORMED"
	| "CONFIG_VERSION_UNSUPPORTED"
	| "CONFIG_VERSION_MISSING"
	| "CONFIG_LEGACY_FIELD";

export class ConfigLoadError extends Error {
	code: ConfigLoadErrorCode;

	constructor(code: ConfigLoadErrorCode, message: string) {
		super(message);
		this.name = "ConfigLoadError";
		this.code = code;
	}
}

// ── Deep Clone + Merge Helpers ───────────────────────────────────────

function deepClone<T>(obj: T): T {
	return JSON.parse(JSON.stringify(obj));
}

function deepMerge<T extends Record<string, any>>(target: T, source: Record<string, any>): T {
	for (const key of Object.keys(source)) {
		const srcVal = source[key];
		const tgtVal = (target as any)[key];
		if (
			srcVal !== null &&
			srcVal !== undefined &&
			typeof srcVal === "object" &&
			!Array.isArray(srcVal) &&
			tgtVal !== null &&
			tgtVal !== undefined &&
			typeof tgtVal === "object" &&
			!Array.isArray(tgtVal)
		) {
			deepMerge(tgtVal, srcVal);
		} else if (srcVal !== undefined) {
			(target as any)[key] = srcVal;
		}
	}
	return target;
}

function hasOwn(obj: unknown, key: string): boolean {
	return !!obj && typeof obj === "object" && Object.hasOwn(obj, key);
}

function normalizeInheritAlias(value: string): string {
	return value.trim().toLowerCase() === "inherit" ? "" : value;
}

/** Empty string = canonical "inherit from active session" for per-agent model/thinking. */
function normalizeInheritanceAliases(config: MissionProjectConfig): void {
	const normalizeField = (obj: Record<string, any>, key: string) => {
		if (typeof obj[key] === "string") {
			obj[key] = normalizeInheritAlias(obj[key]);
		}
	};

	normalizeField(config.taskRunner.worker as Record<string, any>, "model");
	normalizeField(config.taskRunner.worker as Record<string, any>, "thinking");
	normalizeField(config.taskRunner.reviewer as Record<string, any>, "model");
	normalizeField(config.taskRunner.reviewer as Record<string, any>, "thinking");
	normalizeField(config.orchestrator.merge as Record<string, any>, "model");
	normalizeField(config.orchestrator.merge as Record<string, any>, "thinking");
	normalizeField(config.orchestrator.supervisor as Record<string, any>, "model");
	normalizeField(config.taskRunner.qualityGate as Record<string, any>, "reviewModel");
}

// ── Migration (legacy TMUX fields) ───────────────────────────────────

let _projectMigrationDone = false;

/** @internal */
export function _resetMigrationGuard(): void {
	_projectMigrationDone = false;
}

function migrateGlobalPreferences(raw: Record<string, any>, prefsPath: string): boolean {
	let migrated = false;
	if (hasOwn(raw, "tmuxPrefix")) {
		if (!hasOwn(raw, "sessionPrefix") || raw.sessionPrefix === undefined) {
			raw.sessionPrefix = raw.tmuxPrefix;
		}
		raw.tmuxPrefix = undefined;
		logger.warn("[missioncontrol] Auto-migrated global preference: tmuxPrefix → sessionPrefix");
		migrated = true;
	}
	if (raw.spawnMode === "tmux") {
		raw.spawnMode = "subprocess";
		logger.warn('[missioncontrol] Auto-migrated global preference: spawnMode "tmux" → "subprocess"');
		migrated = true;
	}
	if (raw.orchestrator?.orchestrator?.spawnMode === "tmux") {
		raw.orchestrator.orchestrator.spawnMode = "subprocess";
		logger.warn(
			'[missioncontrol] Auto-migrated global preference: orchestrator.orchestrator.spawnMode "tmux" → "subprocess"',
		);
		migrated = true;
	}
	if (raw.taskRunner?.worker?.spawnMode === "tmux") {
		raw.taskRunner.worker.spawnMode = "subprocess";
		logger.warn(
			'[missioncontrol] Auto-migrated global preference: taskRunner.worker.spawnMode "tmux" → "subprocess"',
		);
		migrated = true;
	}
	if (migrated) {
		try {
			// Drop tmuxPrefix from on-disk shape before persisting
			if (raw.tmuxPrefix === undefined) delete raw.tmuxPrefix;
			const tmpPath = `${prefsPath}.migration-tmp`;
			writeFileSync(tmpPath, `${JSON.stringify(raw, null, 2)}\n`);
			renameSync(tmpPath, prefsPath);
			logger.warn(`[missioncontrol] Preferences file updated: ${prefsPath}`);
		} catch (err) {
			logger.warn(
				`[missioncontrol] Warning: could not persist preferences migration to disk: ${err instanceof Error ? err.message : err}`,
			);
		}
	}
	return migrated;
}

// ── YAML snake_case → camelCase mapping ──────────────────────────────

function snakeToCamel(s: string): string {
	return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function convertStructuralKeys(obj: any): any {
	if (obj === null || obj === undefined) return obj;
	if (Array.isArray(obj)) return obj.map(convertStructuralKeys);
	if (typeof obj !== "object") return obj;

	const result: Record<string, any> = {};
	for (const [key, val] of Object.entries(obj)) {
		const camelKey = snakeToCamel(key);
		if (val !== null && typeof val === "object" && !Array.isArray(val)) {
			result[camelKey] = convertStructuralKeys(val);
		} else if (Array.isArray(val)) {
			result[camelKey] = val.map(convertStructuralKeys);
		} else {
			result[camelKey] = val;
		}
	}
	return result;
}

function convertRecordSection(obj: any): any {
	if (obj === null || obj === undefined) return obj;
	if (typeof obj !== "object" || Array.isArray(obj)) return obj;

	const result: Record<string, any> = {};
	for (const [key, val] of Object.entries(obj)) {
		if (val !== null && typeof val === "object" && !Array.isArray(val)) {
			result[key] = convertStructuralKeys(val);
		} else {
			result[key] = val;
		}
	}
	return result;
}

function preserveRecord(obj: any): any {
	if (obj === null || obj === undefined) return obj;
	if (typeof obj !== "object" || Array.isArray(obj)) return obj;
	return { ...obj };
}

function mapTaskRunnerYaml(raw: any): Partial<TaskRunnerSection> {
	const result: any = {};

	if (raw.project) result.project = convertStructuralKeys(raw.project);
	if (raw.paths) result.paths = convertStructuralKeys(raw.paths);
	if (raw.worker) result.worker = convertStructuralKeys(raw.worker);
	if (raw.reviewer) result.reviewer = convertStructuralKeys(raw.reviewer);
	if (raw.context) result.context = convertStructuralKeys(raw.context);
	if (raw.standards) result.standards = convertStructuralKeys(raw.standards);

	if (raw.testing) {
		result.testing = {};
		if (raw.testing.commands) {
			result.testing.commands = preserveRecord(raw.testing.commands);
		}
	}

	if (raw.task_areas) result.taskAreas = convertRecordSection(raw.task_areas);
	if (raw.standards_overrides) result.standardsOverrides = convertRecordSection(raw.standards_overrides);

	if (raw.reference_docs) result.referenceDocs = preserveRecord(raw.reference_docs);
	if (raw.self_doc_targets) result.selfDocTargets = preserveRecord(raw.self_doc_targets);

	if (raw.never_load) result.neverLoad = [...raw.never_load];
	if (raw.protected_docs) result.protectedDocs = [...raw.protected_docs];

	if (raw.quality_gate) result.qualityGate = convertStructuralKeys(raw.quality_gate);

	if (raw.model_fallback) result.modelFallback = raw.model_fallback;

	return result;
}

function mapOrchestratorYaml(raw: any): Partial<OrchestratorSection> {
	const result: any = {};

	if (raw.orchestrator) result.orchestrator = convertStructuralKeys(raw.orchestrator);
	if (raw.dependencies) result.dependencies = convertStructuralKeys(raw.dependencies);
	if (raw.merge) result.merge = convertStructuralKeys(raw.merge);
	if (raw.failure) result.failure = convertStructuralKeys(raw.failure);
	if (raw.monitoring) result.monitoring = convertStructuralKeys(raw.monitoring);

	if (raw.assignment) {
		result.assignment = {};
		if (raw.assignment.strategy !== undefined) result.assignment.strategy = raw.assignment.strategy;
		if (raw.assignment.size_weights) result.assignment.sizeWeights = preserveRecord(raw.assignment.size_weights);
	}

	if (raw.pre_warm) {
		result.preWarm = {};
		if (raw.pre_warm.auto_detect !== undefined) result.preWarm.autoDetect = raw.pre_warm.auto_detect;
		if (raw.pre_warm.commands) result.preWarm.commands = preserveRecord(raw.pre_warm.commands);
		if (raw.pre_warm.always) result.preWarm.always = [...raw.pre_warm.always];
	}

	if (raw.verification) result.verification = convertStructuralKeys(raw.verification);
	if (raw.supervisor) result.supervisor = convertStructuralKeys(raw.supervisor);

	return result;
}

function normalizeWorkspaceSection(rawWorkspace: any, sourcePath: string): WorkspaceSectionConfig | undefined {
	if (!rawWorkspace || typeof rawWorkspace !== "object" || Array.isArray(rawWorkspace)) {
		return undefined;
	}

	const rawRepos = rawWorkspace.repos;
	if (!rawRepos || typeof rawRepos !== "object" || Array.isArray(rawRepos)) {
		return undefined;
	}

	const rawRouting = rawWorkspace.routing;
	if (!rawRouting || typeof rawRouting !== "object" || Array.isArray(rawRouting)) {
		return undefined;
	}

	const repos: WorkspaceSectionConfig["repos"] = {};
	for (const [repoId, repoVal] of Object.entries(rawRepos as Record<string, any>)) {
		if (!repoVal || typeof repoVal !== "object" || Array.isArray(repoVal)) continue;
		const repoObj = repoVal as Record<string, any>;
		if (typeof repoObj.path !== "string" || repoObj.path.trim() === "") continue;
		repos[repoId] = {
			path: repoObj.path,
			...(typeof repoObj.defaultBranch === "string" && repoObj.defaultBranch.trim()
				? { defaultBranch: repoObj.defaultBranch }
				: {}),
		};
	}

	const defaultRepo = typeof rawRouting.defaultRepo === "string" ? rawRouting.defaultRepo.trim() : "";
	const tasksRoot = typeof rawRouting.tasksRoot === "string" ? rawRouting.tasksRoot.trim() : "";
	let taskPacketRepo = typeof rawRouting.taskPacketRepo === "string" ? rawRouting.taskPacketRepo.trim() : "";

	if (!taskPacketRepo && defaultRepo) {
		taskPacketRepo = defaultRepo;
		logger.warn(
			`[missioncontrol] config compatibility: workspace.routing.taskPacketRepo is missing in ${sourcePath}; defaulting to workspace.routing.defaultRepo ('${defaultRepo}').`,
		);
	}

	if (!tasksRoot || !defaultRepo || !taskPacketRepo) {
		return undefined;
	}

	const strict = rawRouting.strict === true;

	return {
		repos,
		routing: {
			tasksRoot,
			defaultRepo,
			taskPacketRepo,
			...(strict ? { strict: true } : {}),
		},
	};
}

// ── Config File Path Resolution ──────────────────────────────────────

/**
 * Resolve a config filename under `configRoot`. Supports two layouts:
 *   1. Standard: `<root>/.omp/<filename>` (via `projectDir`).
 *   2. Flat:     `<root>/<filename>` (pointer-resolved roots).
 * Standard wins when both exist. Returns standard when neither exists.
 */
function resolveConfigFilePath(configRoot: string, filename: string): string {
	const standardPath = join(projectDir(configRoot), filename);
	if (existsSync(standardPath)) return standardPath;

	const flatPath = join(configRoot, filename);
	if (existsSync(flatPath)) return flatPath;

	return standardPath;
}

// ── JSON Loading ─────────────────────────────────────────────────────

function loadJsonConfig(configRoot: string): Partial<MissionProjectConfig> | null {
	const jsonPath = resolveConfigFilePath(configRoot, PROJECT_CONFIG_FILENAME);
	if (!existsSync(jsonPath)) return null;

	let raw: string;
	try {
		raw = readFileSync(jsonPath, "utf-8");
	} catch {
		return null;
	}

	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch (e: unknown) {
		throw new ConfigLoadError(
			"CONFIG_JSON_MALFORMED",
			`Failed to parse ${jsonPath}: ${e instanceof Error ? e.message : "invalid JSON"}`,
		);
	}

	if (parsed.configVersion === undefined || parsed.configVersion === null) {
		throw new ConfigLoadError(
			"CONFIG_VERSION_MISSING",
			`${jsonPath} is missing required field "configVersion". Expected configVersion: ${CONFIG_VERSION}.`,
		);
	}

	if (parsed.configVersion !== CONFIG_VERSION) {
		throw new ConfigLoadError(
			"CONFIG_VERSION_UNSUPPORTED",
			`${jsonPath} has configVersion ${parsed.configVersion}, but this version of MissionControl only supports configVersion ${CONFIG_VERSION}. Please upgrade.`,
		);
	}

	const overrides: Partial<MissionProjectConfig> = {};
	if (parsed.taskRunner && typeof parsed.taskRunner === "object" && !Array.isArray(parsed.taskRunner)) {
		overrides.taskRunner = deepClone(parsed.taskRunner);
	}
	if (parsed.orchestrator && typeof parsed.orchestrator === "object" && !Array.isArray(parsed.orchestrator)) {
		overrides.orchestrator = deepClone(parsed.orchestrator);
	}
	if (parsed.workspace) {
		const normalizedWorkspace = normalizeWorkspaceSection(parsed.workspace, jsonPath);
		if (normalizedWorkspace) {
			overrides.workspace = normalizedWorkspace;
		}
	}

	return overrides;
}

// ── YAML Loading ─────────────────────────────────────────────────────

function loadTaskRunnerYaml(configRoot: string): Partial<TaskRunnerSection> {
	const yamlPath = resolveConfigFilePath(configRoot, "task-runner.yaml");
	if (!existsSync(yamlPath)) return {};

	try {
		const raw = readFileSync(yamlPath, "utf-8");
		const loaded = yamlParse(raw) as any;
		if (!loaded || typeof loaded !== "object") return {};

		const mapped = mapTaskRunnerYaml(loaded);

		if (mapped.taskAreas) {
			for (const area of Object.values(mapped.taskAreas)) {
				if (area.repoId !== undefined) {
					const trimmed = typeof area.repoId === "string" ? area.repoId.trim() : "";
					if (trimmed) {
						area.repoId = trimmed;
					} else {
						delete area.repoId;
					}
				}
			}
		}

		return mapped;
	} catch {
		return {};
	}
}

function loadOrchestratorYaml(configRoot: string): Partial<OrchestratorSection> {
	const yamlPath = resolveConfigFilePath(configRoot, "task-orchestrator.yaml");
	if (!existsSync(yamlPath)) return {};

	try {
		const raw = readFileSync(yamlPath, "utf-8");
		const loaded = yamlParse(raw) as any;
		if (!loaded || typeof loaded !== "object") return {};

		return mapOrchestratorYaml(loaded);
	} catch {
		return {};
	}
}

function loadWorkspaceYaml(configRoot: string): WorkspaceSectionConfig | undefined {
	const yamlPath = resolveConfigFilePath(configRoot, WORKSPACE_CONFIG_FILENAME);
	if (!existsSync(yamlPath)) return undefined;

	try {
		const raw = readFileSync(yamlPath, "utf-8");
		const loaded = yamlParse(raw) as any;
		if (!loaded || typeof loaded !== "object") return undefined;

		const converted = convertStructuralKeys(loaded);
		return normalizeWorkspaceSection(converted, yamlPath);
	} catch {
		return undefined;
	}
}

// ── Global Preferences (Layer 2) ─────────────────────────────────────

/**
 * Resolve the absolute path to the global preferences file.
 *   `<userAgentDir>/missioncontrol/preferences.json`
 * `userAgentDir()` handles the `PI_CODING_AGENT_DIR` env override plus
 * the `~/.omp/agent` fallback.
 */
export function resolveGlobalPreferencesPath(): string {
	return join(userAgentDir(), GLOBAL_PREFERENCES_SUBDIR, GLOBAL_PREFERENCES_FILENAME);
}

export interface GlobalPreferencesLoadResult {
	preferences: GlobalPreferences;
	wasBootstrapped: boolean;
}

function writePreferencesAtomically(prefsPath: string, prefs: GlobalPreferences): void {
	const tmpPath = `${prefsPath}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmpPath, `${JSON.stringify(prefs, null, 2)}\n`, "utf-8");
	renameSync(tmpPath, prefsPath);
}

function bootstrapGlobalPreferencesFile(prefsPath: string): GlobalPreferences {
	const bootstrapPrefs = deepClone(DEFAULT_BOOTSTRAP_GLOBAL_PREFERENCES);
	try {
		const dir = join(prefsPath, "..");
		mkdirSync(dir, { recursive: true });
		writePreferencesAtomically(prefsPath, bootstrapPrefs);
	} catch {
		// Best-effort; still return bootstrap defaults in-memory if disk write fails.
	}
	return bootstrapPrefs;
}

export function loadGlobalPreferencesWithMeta(): GlobalPreferencesLoadResult {
	const prefsPath = resolveGlobalPreferencesPath();

	if (!existsSync(prefsPath)) {
		return {
			preferences: bootstrapGlobalPreferencesFile(prefsPath),
			wasBootstrapped: true,
		};
	}

	let raw: string;
	try {
		raw = readFileSync(prefsPath, "utf-8");
	} catch {
		return { preferences: deepClone(DEFAULT_GLOBAL_PREFERENCES), wasBootstrapped: false };
	}

	if (!raw.trim()) {
		return {
			preferences: bootstrapGlobalPreferencesFile(prefsPath),
			wasBootstrapped: true,
		};
	}

	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			preferences: bootstrapGlobalPreferencesFile(prefsPath),
			wasBootstrapped: true,
		};
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
		return {
			preferences: bootstrapGlobalPreferencesFile(prefsPath),
			wasBootstrapped: true,
		};
	}

	return {
		preferences: extractAllowlistedPreferences(parsed, prefsPath),
		wasBootstrapped: false,
	};
}

export function loadGlobalPreferences(): GlobalPreferences {
	return loadGlobalPreferencesWithMeta().preferences;
}

function normalizePreferenceThinkingMode(value: unknown): string {
	const cleaned = String(value ?? "")
		.trim()
		.toLowerCase();
	if (!cleaned || cleaned === "inherit") return "";
	if (cleaned === "on") return "high";
	if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(cleaned)) {
		return cleaned;
	}
	return "";
}

function extractInitAgentDefaults(rawInitDefaults: unknown): GlobalPreferences["initAgentDefaults"] | undefined {
	if (!rawInitDefaults || typeof rawInitDefaults !== "object" || Array.isArray(rawInitDefaults)) {
		return undefined;
	}

	const raw = rawInitDefaults as Record<string, unknown>;
	const extracted: NonNullable<GlobalPreferences["initAgentDefaults"]> = {};

	if (typeof raw.workerModel === "string") extracted.workerModel = raw.workerModel;
	if (typeof raw.reviewerModel === "string") extracted.reviewerModel = raw.reviewerModel;
	if (typeof raw.mergeModel === "string") extracted.mergeModel = raw.mergeModel;
	if (raw.workerThinking !== undefined) extracted.workerThinking = normalizePreferenceThinkingMode(raw.workerThinking);
	if (raw.reviewerThinking !== undefined)
		extracted.reviewerThinking = normalizePreferenceThinkingMode(raw.reviewerThinking);
	if (raw.mergeThinking !== undefined) extracted.mergeThinking = normalizePreferenceThinkingMode(raw.mergeThinking);

	return Object.keys(extracted).length > 0 ? extracted : undefined;
}

function extractConfigOverrideSection(rawSection: unknown): Record<string, any> | undefined {
	if (!rawSection || typeof rawSection !== "object" || Array.isArray(rawSection)) {
		return undefined;
	}
	return deepClone(rawSection as Record<string, any>);
}

function extractAllowlistedPreferences(raw: Record<string, any>, prefsPath: string): GlobalPreferences {
	migrateGlobalPreferences(raw, prefsPath);

	const prefs: GlobalPreferences = {};

	const taskRunnerOverrides = extractConfigOverrideSection(raw.taskRunner);
	if (taskRunnerOverrides) {
		prefs.taskRunner = taskRunnerOverrides as GlobalPreferences["taskRunner"];
	}

	const orchestratorOverrides = extractConfigOverrideSection(raw.orchestrator);
	if (orchestratorOverrides) {
		prefs.orchestrator = orchestratorOverrides as GlobalPreferences["orchestrator"];
	}

	const workspaceOverrides = extractConfigOverrideSection(raw.workspace);
	if (workspaceOverrides) {
		prefs.workspace = workspaceOverrides as GlobalPreferences["workspace"];
	}

	if (typeof raw.operatorId === "string") prefs.operatorId = raw.operatorId;
	if (typeof raw.sessionPrefix === "string") {
		prefs.sessionPrefix = raw.sessionPrefix;
	}
	if (raw.spawnMode === "subprocess") {
		prefs.spawnMode = "subprocess";
	}
	if (typeof raw.workerModel === "string") prefs.workerModel = raw.workerModel;
	if (typeof raw.reviewerModel === "string") prefs.reviewerModel = raw.reviewerModel;
	if (typeof raw.mergeModel === "string") prefs.mergeModel = raw.mergeModel;
	if (typeof raw.mergeThinking === "string") prefs.mergeThinking = raw.mergeThinking;
	if (typeof raw.supervisorModel === "string") prefs.supervisorModel = raw.supervisorModel;

	if (typeof raw.dashboardPort === "number" && Number.isFinite(raw.dashboardPort)) {
		prefs.dashboardPort = raw.dashboardPort;
	}
	const initAgentDefaults = extractInitAgentDefaults(raw.initAgentDefaults);
	if (initAgentDefaults) {
		prefs.initAgentDefaults = initAgentDefaults;
	}

	return prefs;
}

/**
 * Apply global preferences (Layer 2) onto a project config (Layer 1).
 */
export function applyGlobalPreferences(config: MissionProjectConfig, prefs: GlobalPreferences): MissionProjectConfig {
	const applyStr = (val: string | undefined, setter: (v: string) => void) => {
		if (val !== undefined && val !== "") setter(val);
	};

	applyStr(prefs.operatorId, v => {
		config.orchestrator.orchestrator.operatorId = v;
	});
	applyStr(prefs.sessionPrefix, v => {
		config.orchestrator.orchestrator.sessionPrefix = v;
	});
	applyStr(prefs.workerModel, v => {
		config.taskRunner.worker.model = v;
	});
	applyStr(prefs.reviewerModel, v => {
		config.taskRunner.reviewer.model = v;
	});
	applyStr(prefs.mergeModel, v => {
		config.orchestrator.merge.model = v;
	});
	applyStr(prefs.mergeThinking, v => {
		config.orchestrator.merge.thinking = v;
	});
	applyStr(prefs.supervisorModel, v => {
		config.orchestrator.supervisor.model = v;
	});

	if (prefs.spawnMode !== undefined) {
		if ((prefs.spawnMode as any) === "tmux") {
			prefs.spawnMode = "subprocess";
			logger.warn('[missioncontrol] Auto-migrated runtime preference: spawnMode "tmux" → "subprocess"');
		}
		config.orchestrator.orchestrator.spawnMode = prefs.spawnMode;
	}

	if (prefs.taskRunner) {
		deepMerge(config.taskRunner as Record<string, any>, prefs.taskRunner as Record<string, any>);
	}
	if (prefs.orchestrator) {
		deepMerge(config.orchestrator as Record<string, any>, prefs.orchestrator as Record<string, any>);
	}
	if (prefs.workspace) {
		if (!config.workspace || typeof config.workspace !== "object") {
			config.workspace = {} as MissionProjectConfig["workspace"];
		}
		deepMerge(config.workspace as Record<string, any>, prefs.workspace as Record<string, any>);
	}

	if ((config.orchestrator.orchestrator as Record<string, any>).spawnMode === "tmux") {
		config.orchestrator.orchestrator.spawnMode = "subprocess";
		logger.warn(
			'[missioncontrol] Auto-migrated runtime global preference: orchestrator.orchestrator.spawnMode "tmux" → "subprocess"',
		);
	}
	if ((config.taskRunner.worker as Record<string, any>).spawnMode === "tmux") {
		config.taskRunner.worker.spawnMode = "subprocess";
		logger.warn(
			'[missioncontrol] Auto-migrated runtime global preference: taskRunner.worker.spawnMode "tmux" → "subprocess"',
		);
	}

	return config;
}

// ── Unified Loader ───────────────────────────────────────────────────

/**
 * Check whether any recognized project-config file exists under `root`.
 * Workspace YAML intentionally excluded (it's a coordination file, not a
 * project config — see taskplane issue #424).
 */
export function hasConfigFiles(root: string): boolean {
	const files = [PROJECT_CONFIG_FILENAME, "task-runner.yaml", "task-orchestrator.yaml"];
	for (const f of files) {
		if (existsSync(join(projectDir(root), f)) || existsSync(join(root, f))) return true;
	}
	return false;
}

/**
 * Resolve the config root directory.
 *
 * Resolution order:
 *   1. `cwd` has project-config files → use cwd (local override wins)
 *   2. pointerConfigRoot has config files → use it (pointer redirect)
 *   3. OMP_WORKSPACE_ROOT (or legacy TASKPLANE_WORKSPACE_ROOT) env → use it
 *   4. Fall back to cwd (loaders will return defaults)
 */
export function resolveConfigRoot(cwd: string, pointerConfigRoot?: string): string {
	if (hasConfigFiles(cwd)) return cwd;
	if (pointerConfigRoot && hasConfigFiles(pointerConfigRoot)) return pointerConfigRoot;

	const wsRoot = process.env.OMP_WORKSPACE_ROOT ?? process.env.TASKPLANE_WORKSPACE_ROOT;
	if (wsRoot && hasConfigFiles(wsRoot)) return wsRoot;

	return cwd;
}

function mergeProjectOverrides(config: MissionProjectConfig, overrides: Partial<MissionProjectConfig>): void {
	if (overrides.taskRunner) {
		deepMerge(config.taskRunner as Record<string, any>, overrides.taskRunner as Record<string, any>);
	}
	if (overrides.orchestrator) {
		deepMerge(config.orchestrator as Record<string, any>, overrides.orchestrator as Record<string, any>);
	}
	if (overrides.workspace) {
		if (!config.workspace || typeof config.workspace !== "object") {
			config.workspace = {} as MissionProjectConfig["workspace"];
		}
		deepMerge(config.workspace as Record<string, any>, overrides.workspace as Record<string, any>);
	}
}

function migrateProjectOverrides(overrides: Partial<MissionProjectConfig>, configRoot: string): boolean {
	if (_projectMigrationDone) return false;

	let migrated = false;
	const orchestratorCore = overrides.orchestrator?.orchestrator as Record<string, unknown> | undefined;
	if (orchestratorCore && hasOwn(orchestratorCore, "tmuxPrefix")) {
		const currentPrefix = orchestratorCore.sessionPrefix;
		const isDefault = currentPrefix === undefined || currentPrefix === "orch";
		if (isDefault) {
			(orchestratorCore as any).sessionPrefix = orchestratorCore.tmuxPrefix;
		}
		delete orchestratorCore.tmuxPrefix;
		logger.warn("[missioncontrol] Auto-migrated: orchestrator.orchestrator.tmuxPrefix → sessionPrefix");
		migrated = true;
	}
	if (orchestratorCore?.spawnMode === "tmux") {
		(orchestratorCore as any).spawnMode = "subprocess";
		logger.warn('[missioncontrol] Auto-migrated: orchestrator.orchestrator.spawnMode "tmux" → "subprocess"');
		migrated = true;
	}

	const workerConfig = overrides.taskRunner?.worker as Record<string, unknown> | undefined;
	if (workerConfig?.spawnMode === "tmux") {
		(workerConfig as any).spawnMode = "subprocess";
		logger.warn('[missioncontrol] Auto-migrated: taskRunner.worker.spawnMode "tmux" → "subprocess"');
		migrated = true;
	}

	if (migrated) {
		try {
			const jsonPath = resolveConfigFilePath(configRoot, PROJECT_CONFIG_FILENAME);
			if (existsSync(jsonPath)) {
				const raw = JSON.parse(readFileSync(jsonPath, "utf-8"));
				if (raw.orchestrator?.orchestrator?.tmuxPrefix !== undefined) {
					const rawPrefix = raw.orchestrator.orchestrator.sessionPrefix;
					if (rawPrefix === undefined || rawPrefix === "orch") {
						raw.orchestrator.orchestrator.sessionPrefix = raw.orchestrator.orchestrator.tmuxPrefix;
					}
					delete raw.orchestrator.orchestrator.tmuxPrefix;
				}
				if (raw.orchestrator?.orchestrator?.spawnMode === "tmux") {
					raw.orchestrator.orchestrator.spawnMode = "subprocess";
				}
				if (raw.taskRunner?.worker?.spawnMode === "tmux") {
					raw.taskRunner.worker.spawnMode = "subprocess";
				}

				const tmpPath = `${jsonPath}.migration-tmp`;
				writeFileSync(tmpPath, `${JSON.stringify(raw, null, 2)}\n`);
				renameSync(tmpPath, jsonPath);
				logger.warn(`[missioncontrol] Config file updated: ${jsonPath}`);
			}
		} catch (err) {
			logger.warn(
				`[missioncontrol] Warning: could not persist config migration to disk: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	_projectMigrationDone = true;
	return migrated;
}

export function loadProjectOverrides(configRoot: string): Partial<MissionProjectConfig> {
	const jsonOverrides = loadJsonConfig(configRoot);
	if (jsonOverrides !== null) {
		return jsonOverrides;
	}

	const taskRunner = loadTaskRunnerYaml(configRoot);
	const orchestrator = loadOrchestratorYaml(configRoot);
	const workspace = loadWorkspaceYaml(configRoot);

	const overrides: Partial<MissionProjectConfig> = {};
	if (Object.keys(taskRunner).length > 0) overrides.taskRunner = taskRunner as TaskRunnerSection;
	if (Object.keys(orchestrator).length > 0) overrides.orchestrator = orchestrator as OrchestratorSection;
	if (workspace) overrides.workspace = workspace;
	return overrides;
}

/**
 * Load the unified project configuration.
 *
 * Layered precedence:
 *   1. Schema defaults
 *   2. Global preferences (`<userAgentDir>/missioncontrol/preferences.json`)
 *   3. Project overrides (`.omp/mission.json` or YAML fallback)
 */
export function loadProjectConfig(cwd: string, pointerConfigRoot?: string): MissionProjectConfig {
	const configRoot = resolveConfigRoot(cwd, pointerConfigRoot);
	const config = deepClone(DEFAULT_PROJECT_CONFIG);

	const prefs = loadGlobalPreferences();
	applyGlobalPreferences(config, prefs);

	const overrides = loadProjectOverrides(configRoot);
	_projectMigrationDone = false;
	migrateProjectOverrides(overrides, configRoot);
	mergeProjectOverrides(config, overrides);

	normalizeInheritanceAliases(config);
	return config;
}

/**
 * Load project overrides merged with schema defaults, without applying
 * global preferences. Used by settings write-back code paths that must
 * avoid embedding global baseline values into project config.
 */
export function loadLayer1Config(cwd: string, pointerConfigRoot?: string): MissionProjectConfig {
	const configRoot = resolveConfigRoot(cwd, pointerConfigRoot);
	const config = deepClone(DEFAULT_PROJECT_CONFIG);
	const overrides = loadProjectOverrides(configRoot);

	_projectMigrationDone = false;
	migrateProjectOverrides(overrides, configRoot);
	mergeProjectOverrides(config, overrides);

	normalizeInheritanceAliases(config);
	return config;
}

// ── Pointer Resolution for Task-Runner ───────────────────────────────

let _pointerWarningLogged = false;

/**
 * Resolve the workspace pointer for config and agent path redirection.
 * Returns null in repo mode (OMP_WORKSPACE_ROOT not set).
 */
export function resolveTaskRunnerPointer(): PointerResolution | null {
	const wsRoot = process.env.OMP_WORKSPACE_ROOT ?? process.env.TASKPLANE_WORKSPACE_ROOT;
	if (!wsRoot) return null;
	try {
		const wsConfig = loadWorkspaceConfig(wsRoot);
		const result = resolvePointer(wsRoot, wsConfig);
		if (result?.warning && !_pointerWarningLogged) {
			_pointerWarningLogged = true;
			logger.warn(`[missioncontrol] pointer: ${result.warning}`);
		}
		return result;
	} catch {
		return null;
	}
}

/** @internal */
export function _resetPointerWarning(): void {
	_pointerWarningLogged = false;
}

// ── Backward-Compatible Adapters ─────────────────────────────────────
//
// Convert unified camelCase MissionProjectConfig back to the snake_case
// legacy shapes (`OrchestratorConfig`, `TaskRunnerConfig`) expected by the
// engine and task-runner consumers.

/**
 * Adapter: produce the legacy `OrchestratorConfig` (snake_case) from unified config.
 *
 * Uses explicit field mapping instead of generic recursive key conversion
 * to preserve record/dictionary keys verbatim (e.g., sizeWeights S/M/L,
 * preWarm.commands keys, etc.).
 */
export function toOrchestratorConfig(config: MissionProjectConfig): OrchestratorConfig {
	const o = config.orchestrator;
	return {
		orchestrator: {
			max_lanes: o.orchestrator.maxLanes,
			worktree_location: o.orchestrator.worktreeLocation,
			worktree_prefix: o.orchestrator.worktreePrefix,
			batch_id_format: o.orchestrator.batchIdFormat,
			spawn_mode: o.orchestrator.spawnMode,
			sessionPrefix: o.orchestrator.sessionPrefix,
			operator_id: o.orchestrator.operatorId,
			integration: o.orchestrator.integration,
		},
		dependencies: {
			source: o.dependencies.source,
			cache: o.dependencies.cache,
		},
		assignment: {
			strategy: o.assignment.strategy,
			size_weights: { ...o.assignment.sizeWeights },
		},
		pre_warm: {
			auto_detect: o.preWarm.autoDetect,
			commands: { ...o.preWarm.commands },
			always: [...o.preWarm.always],
		},
		merge: {
			model: o.merge.model,
			tools: o.merge.tools,
			thinking: o.merge.thinking,
			verify: [...o.merge.verify],
			order: o.merge.order,
			timeout_minutes: o.merge.timeoutMinutes ?? 90,
		},
		failure: {
			on_task_failure: o.failure.onTaskFailure,
			on_merge_failure: o.failure.onMergeFailure,
			stall_timeout: o.failure.stallTimeout,
			max_worker_minutes: o.failure.maxWorkerMinutes,
			abort_grace_period: o.failure.abortGracePeriod,
		},
		monitoring: {
			poll_interval: o.monitoring.pollInterval,
		},
		verification: {
			enabled: o.verification.enabled,
			mode: o.verification.mode,
			flaky_reruns: o.verification.flakyReruns,
		},
	};
}

/**
 * Adapter: produce the legacy `TaskRunnerConfig` (snake_case subset) from unified config.
 *
 * Special handling for `repoId`: whitespace-only values are treated as undefined,
 * and non-empty values are trimmed — matching the original YAML loader behavior.
 */
export function toTaskRunnerConfig(config: MissionProjectConfig): TaskRunnerConfig {
	const taskAreas: Record<string, TaskArea> = {};
	for (const [name, area] of Object.entries(config.taskRunner.taskAreas)) {
		const ta: TaskArea = {
			path: area.path,
			prefix: area.prefix,
			context: area.context,
		};
		if (area.repoId && typeof area.repoId === "string" && area.repoId.trim()) {
			ta.repoId = area.repoId.trim();
		}
		taskAreas[name] = ta;
	}

	const testingCommands = config.taskRunner.testing?.commands;
	const hasTestingCommands = testingCommands && Object.keys(testingCommands).length > 0;

	return {
		task_areas: taskAreas,
		reference_docs: { ...config.taskRunner.referenceDocs },
		...(hasTestingCommands ? { testing_commands: { ...testingCommands } } : {}),
		model_fallback: config.taskRunner.modelFallback ?? "inherit",
		reviewer: {
			model: config.taskRunner.reviewer.model,
			thinking: config.taskRunner.reviewer.thinking,
			tools: config.taskRunner.reviewer.tools,
		},
	};
}

/**
 * Adapter: produce the legacy task-runner `TaskConfig` (snake_case) from unified config.
 *
 * The task-runner extension has its own `TaskConfig` interface with snake_case
 * keys. This adapter maps the unified shape back to that contract.
 */
export function toTaskConfig(config: MissionProjectConfig): {
	project: { name: string; description: string };
	paths: { tasks: string; architecture?: string };
	testing: { commands: Record<string, string> };
	standards: { docs: string[]; rules: string[] };
	standards_overrides: Record<string, { docs?: string[]; rules?: string[] }>;
	task_areas: Record<string, { path: string; [key: string]: unknown }>;
	worker: { model: string; tools: string; thinking: string; spawn_mode?: "subprocess" };
	reviewer: { model: string; tools: string; thinking: string };
	context: {
		worker_context_window: number;
		warn_percent: number;
		kill_percent: number;
		max_worker_iterations: number;
		max_review_cycles: number;
		no_progress_limit: number;
		max_worker_minutes?: number;
	};
	quality_gate: {
		enabled: boolean;
		review_model: string;
		max_review_cycles: number;
		max_fix_cycles: number;
		pass_threshold: "no_critical" | "no_important" | "all_clear";
	};
} {
	const tr = config.taskRunner;

	const stdOverrides: Record<string, { docs?: string[]; rules?: string[] }> = {};
	for (const [key, val] of Object.entries(tr.standardsOverrides)) {
		stdOverrides[key] = { docs: val.docs, rules: val.rules };
	}

	const taskAreas: Record<string, { path: string; [key: string]: unknown }> = {};
	for (const [key, val] of Object.entries(tr.taskAreas)) {
		const entry: { path: string; [key: string]: unknown } = {
			path: val.path,
			prefix: val.prefix,
			context: val.context,
		};
		if (val.repoId) entry.repo_id = val.repoId;
		taskAreas[key] = entry;
	}

	return {
		project: { ...tr.project },
		paths: { ...tr.paths },
		testing: { commands: { ...tr.testing.commands } },
		standards: { docs: [...tr.standards.docs], rules: [...tr.standards.rules] },
		standards_overrides: stdOverrides,
		task_areas: taskAreas,
		worker: {
			model: tr.worker.model,
			tools: tr.worker.tools,
			thinking: tr.worker.thinking,
			spawn_mode: tr.worker.spawnMode,
		},
		reviewer: { model: tr.reviewer.model, tools: tr.reviewer.tools, thinking: tr.reviewer.thinking },
		context: {
			worker_context_window: tr.context.workerContextWindow,
			warn_percent: tr.context.warnPercent,
			kill_percent: tr.context.killPercent,
			max_worker_iterations: tr.context.maxWorkerIterations,
			max_review_cycles: tr.context.maxReviewCycles,
			no_progress_limit: tr.context.noProgressLimit,
			max_worker_minutes: tr.context.maxWorkerMinutes,
		},
		quality_gate: {
			enabled: tr.qualityGate.enabled,
			review_model: tr.qualityGate.reviewModel,
			max_review_cycles: tr.qualityGate.maxReviewCycles,
			max_fix_cycles: tr.qualityGate.maxFixCycles,
			pass_threshold: tr.qualityGate.passThreshold,
		},
	};
}
