/**
 * Unified project configuration schema for MissionControl.
 *
 * Ported from taskplane's `config-schema.ts`. Describes the shape of
 * `.omp/mission.json` — the JSON-first config that merges the legacy
 * task-runner + task-orchestrator YAML files into a single typed surface.
 *
 * Renames vs taskplane:
 *   `TaskplaneConfig`         → `MissionProjectConfig`
 *   `.pi/taskplane-config.json` → `.omp/mission.json`
 *   `GLOBAL_PREFERENCES_SUBDIR = "taskplane"` → `"missioncontrol"`
 *
 * `MissionProjectConfig` is distinct from `MissionControlConfig` in
 * `./types.ts`: the former describes persisted project configuration
 * (what lives on disk), the latter the simple runtime engine tuning knobs
 * the MVP uses.
 *
 * Key naming policy:
 * - JSON uses camelCase (e.g., `maxLanes`, `workerContextWindow`)
 * - YAML fallback loader maps snake_case keys to camelCase equivalents
 * - The runtime config object always uses the interfaces defined here
 */

// ── Config Version ───────────────────────────────────────────────────

/** Current config schema version. */
export const CONFIG_VERSION = 1;

// ── Canonical Config Path ────────────────────────────────────────────

/**
 * Canonical filename for the unified JSON config.
 * Resolved relative to project root: `.omp/mission.json`
 */
export const PROJECT_CONFIG_FILENAME = "mission.json";

// ── Task Runner Section Interfaces ───────────────────────────────────

/** Project metadata */
export interface ProjectMetadataConfig {
	name: string;
	description: string;
}

/** Path metadata for the project */
export interface PathsConfig {
	tasks: string;
	architecture?: string;
}

/** Verification commands available to agents/reviewers */
export interface TestingConfig {
	commands: Record<string, string>;
}

/** Coding standards for agent context */
export interface StandardsConfig {
	docs: string[];
	rules: string[];
}

/** Per-area standards override */
export interface StandardsOverride {
	docs?: string[];
	rules?: string[];
}

/** Worker agent configuration */
export interface WorkerConfig {
	model: string;
	tools: string;
	thinking: string;
	/** Optional spawn mode override (Runtime V2 subprocess-only). */
	spawnMode?: "subprocess";
}

/** Reviewer agent configuration */
export interface ReviewerConfig {
	model: string;
	tools: string;
	thinking: string;
}

/** Context/resource limits for task execution */
export interface ContextConfig {
	/** Context window size used for worker context pressure tracking.
	 *  Set to 0 (default) for auto-detection from the pi model registry. */
	workerContextWindow: number;
	warnPercent: number;
	killPercent: number;
	maxWorkerIterations: number;
	maxReviewCycles: number;
	noProgressLimit: number;
	maxWorkerMinutes?: number;
}

/** Task area definition */
export interface TaskAreaConfig {
	path: string;
	prefix: string;
	context: string;
	repoId?: string;
}

/** Self-documentation target definition */
export interface SelfDocTarget {
	[key: string]: string;
}

/**
 * Severity threshold for quality gate pass decisions.
 *
 * - `no_critical`: PASS if no critical findings
 * - `no_important`: PASS if no critical and fewer than 3 important findings
 * - `all_clear`: PASS only if zero findings of any severity
 */
export type PassThreshold = "no_critical" | "no_important" | "all_clear";

/**
 * Model fallback behavior when a configured agent model becomes unavailable.
 *
 * - `"inherit"`: Fall back to the session model and retry.
 * - `"fail"`: Fail immediately.
 */
export type ModelFallbackMode = "inherit" | "fail";

/** Quality gate configuration — opt-in post-completion review */
export interface QualityGateConfig {
	enabled: boolean;
	reviewModel: string;
	maxReviewCycles: number;
	maxFixCycles: number;
	passThreshold: PassThreshold;
}

// ── Task Runner Combined Section ─────────────────────────────────────

/** All task-runner settings, previously from `.pi/task-runner.yaml`. */
export interface TaskRunnerSection {
	project: ProjectMetadataConfig;
	paths: PathsConfig;
	testing: TestingConfig;
	standards: StandardsConfig;
	standardsOverrides: Record<string, StandardsOverride>;
	worker: WorkerConfig;
	reviewer: ReviewerConfig;
	context: ContextConfig;
	taskAreas: Record<string, TaskAreaConfig>;
	referenceDocs: Record<string, string>;
	neverLoad: string[];
	selfDocTargets: Record<string, string>;
	protectedDocs: string[];
	qualityGate: QualityGateConfig;
	modelFallback: ModelFallbackMode;
}

// ── Orchestrator Section Interfaces ──────────────────────────────────

/** Core orchestrator settings */
export interface OrchestratorCoreConfig {
	maxLanes: number;
	worktreeLocation: "sibling" | "subdirectory";
	worktreePrefix: string;
	batchIdFormat: "timestamp" | "sequential";
	spawnMode: "subprocess";
	sessionPrefix: string;
	operatorId: string;
	/**
	 * How completed batches are integrated.
	 * - manual: user runs /mission-integrate
	 * - supervised: supervisor proposes plan, asks confirmation
	 * - auto: supervisor executes without asking
	 */
	integration: "manual" | "supervised" | "auto";
}

/** Dependency resolution settings */
export interface DependenciesConfig {
	source: "prompt" | "agent";
	cache: boolean;
}

/** Lane assignment settings */
export interface AssignmentConfig {
	strategy: "affinity-first" | "round-robin" | "load-balanced";
	sizeWeights: Record<string, number>;
}

/** Pre-warm settings */
export interface PreWarmConfig {
	autoDetect: boolean;
	commands: Record<string, string>;
	always: string[];
}

/** Merge settings */
export interface MergeConfig {
	model: string;
	tools: string;
	thinking: string;
	verify: string[];
	order: "fewest-files-first" | "sequential";
	timeoutMinutes?: number;
}

/** Failure policy settings */
export interface FailureConfig {
	onTaskFailure: "skip-dependents" | "stop-wave" | "stop-all";
	onMergeFailure: "pause" | "abort";
	stallTimeout: number;
	maxWorkerMinutes: number;
	abortGracePeriod: number;
}

/** Monitoring settings */
export interface MonitoringConfig {
	pollInterval: number;
}

/** Verification baseline fingerprinting settings. */
export interface VerificationConfig {
	/** Enable verification baseline fingerprinting. */
	enabled: boolean;
	/**
	 * Verification mode controlling behavior when baseline is unavailable.
	 *
	 * - "strict": Baseline capture failure triggers a merge failure.
	 * - "permissive": Logs a warning and continues without verification.
	 */
	mode: "strict" | "permissive";
	/**
	 * Number of flaky re-runs when new failures are detected.
	 *
	 * Set to 0 to disable flaky re-runs (any new failure immediately blocks).
	 */
	flakyReruns: number;
}

// ── Orchestrator Combined Section ────────────────────────────────────

/** Supervisor agent settings. */
export interface SupervisorSectionConfig {
	model: string;
	autonomy: "interactive" | "supervised" | "autonomous";
}

/** All orchestrator settings, previously from `.pi/task-orchestrator.yaml`. */
export interface OrchestratorSection {
	orchestrator: OrchestratorCoreConfig;
	dependencies: DependenciesConfig;
	assignment: AssignmentConfig;
	preWarm: PreWarmConfig;
	merge: MergeConfig;
	failure: FailureConfig;
	monitoring: MonitoringConfig;
	verification: VerificationConfig;
	supervisor: SupervisorSectionConfig;
}

// ── Workspace Section Interfaces ─────────────────────────────────────

/** Workspace repo definition (JSON config shape). */
export interface WorkspaceRepoSectionConfig {
	path: string;
	defaultBranch?: string;
}

/** Workspace routing definition (JSON config shape). */
export interface WorkspaceRoutingSectionConfig {
	tasksRoot: string;
	defaultRepo: string;
	taskPacketRepo: string;
	strict?: boolean;
}

/** Optional workspace section in mission.json. */
export interface WorkspaceSectionConfig {
	repos: Record<string, WorkspaceRepoSectionConfig>;
	routing: WorkspaceRoutingSectionConfig;
}

// ── Unified Config ───────────────────────────────────────────────────

/**
 * Unified project configuration — the single source of truth.
 *
 * This is the runtime config object produced by `loadProjectConfig()`.
 * File: `.omp/mission.json`
 *
 * Example JSON structure:
 * ```json
 * {
 *   "configVersion": 1,
 *   "taskRunner": { ... },
 *   "orchestrator": { ... }
 * }
 * ```
 *
 * Note: distinct from `MissionControlConfig` in `./types.ts`. The latter is
 * the simple runtime-engine tuning knob set used by the MVP engine surface.
 */
export interface MissionProjectConfig {
	configVersion: number;
	taskRunner: TaskRunnerSection;
	orchestrator: OrchestratorSection;
	workspace?: WorkspaceSectionConfig;
}

// ── Global Preferences (Layer 2) ─────────────────────────────────────

/**
 * Global preferences — personal settings stored per-user.
 *
 * File: `<agentDir>/missioncontrol/preferences.json`
 *
 * Overrides project config (Layer 1) for user-scoped settings only. The
 * merge is allowlist-based: only the fields defined here can be overridden
 * by global preferences. Unknown keys are silently ignored.
 */
export interface InitAgentDefaultsPreferences {
	workerModel?: string;
	reviewerModel?: string;
	mergeModel?: string;
	workerThinking?: string;
	reviewerThinking?: string;
	mergeThinking?: string;
}

export type DeepPartial<T> =
	T extends Array<infer U> ? Array<DeepPartial<U>> : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export interface GlobalPreferences {
	taskRunner?: DeepPartial<TaskRunnerSection>;
	orchestrator?: DeepPartial<OrchestratorSection>;
	workspace?: DeepPartial<WorkspaceSectionConfig>;

	/** Legacy flat aliases (backward compatibility). */
	operatorId?: string;
	sessionPrefix?: string;
	spawnMode?: "subprocess";
	workerModel?: string;
	reviewerModel?: string;
	mergeModel?: string;
	mergeThinking?: string;
	supervisorModel?: string;

	/** Preferences-only values (stored globally, not merged into runtime config). */
	dashboardPort?: number;
	initAgentDefaults?: InitAgentDefaultsPreferences;
}

/** Default (empty) global preferences — all fields undefined means "no override". */
export const DEFAULT_GLOBAL_PREFERENCES: GlobalPreferences = {};

/**
 * Seed values used when first bootstrapping preferences.json.
 *
 * Kept separate from DEFAULT_GLOBAL_PREFERENCES so runtime fallback semantics
 * remain "no override", while first-install scaffolding can provide
 * user-friendly init defaults.
 */
export const DEFAULT_BOOTSTRAP_GLOBAL_PREFERENCES: GlobalPreferences = {
	initAgentDefaults: {
		workerModel: "",
		reviewerModel: "",
		mergeModel: "",
		workerThinking: "high",
		reviewerThinking: "high",
		mergeThinking: "high",
	},
};

/** Canonical filename for global preferences. */
export const GLOBAL_PREFERENCES_FILENAME = "preferences.json";

/** Subdirectory under the agent dir for MissionControl preferences. */
export const GLOBAL_PREFERENCES_SUBDIR = "missioncontrol";

// ── Defaults ─────────────────────────────────────────────────────────

/** Default task runner section values */
export const DEFAULT_TASK_RUNNER_SECTION: TaskRunnerSection = {
	project: { name: "Project", description: "" },
	paths: { tasks: "docs/task-management" },
	testing: { commands: {} },
	standards: { docs: [], rules: [] },
	standardsOverrides: {},
	worker: { model: "", tools: "read,write,edit,bash,grep,find,ls", thinking: "" },
	reviewer: { model: "", tools: "read,bash,grep,find,ls", thinking: "on" },
	context: {
		workerContextWindow: 0,
		warnPercent: 85,
		killPercent: 95,
		maxWorkerIterations: 20,
		maxReviewCycles: 2,
		noProgressLimit: 3,
	},
	taskAreas: {},
	referenceDocs: {},
	neverLoad: [],
	selfDocTargets: {},
	protectedDocs: [],
	qualityGate: {
		enabled: false,
		reviewModel: "",
		maxReviewCycles: 2,
		maxFixCycles: 1,
		passThreshold: "no_critical",
	},
	modelFallback: "inherit",
};

/** Default orchestrator section values */
export const DEFAULT_ORCHESTRATOR_SECTION: OrchestratorSection = {
	orchestrator: {
		maxLanes: 3,
		worktreeLocation: "subdirectory",
		worktreePrefix: "mission-wt",
		batchIdFormat: "timestamp",
		spawnMode: "subprocess",
		sessionPrefix: "mission",
		operatorId: "",
		integration: "manual",
	},
	dependencies: {
		source: "prompt",
		cache: true,
	},
	assignment: {
		strategy: "affinity-first",
		sizeWeights: { S: 1, M: 2, L: 4 },
	},
	preWarm: {
		autoDetect: false,
		commands: {},
		always: [],
	},
	merge: {
		model: "",
		tools: "read,write,edit,bash,grep,find,ls",
		thinking: "off",
		verify: [],
		order: "fewest-files-first",
		timeoutMinutes: 90,
	},
	failure: {
		onTaskFailure: "skip-dependents",
		onMergeFailure: "pause",
		stallTimeout: 60,
		maxWorkerMinutes: 120,
		abortGracePeriod: 60,
	},
	monitoring: {
		pollInterval: 5,
	},
	verification: {
		enabled: false,
		mode: "permissive",
		flakyReruns: 1,
	},
	supervisor: {
		model: "",
		autonomy: "supervised",
	},
};

/** Default unified config */
export const DEFAULT_PROJECT_CONFIG: MissionProjectConfig = {
	configVersion: CONFIG_VERSION,
	taskRunner: DEFAULT_TASK_RUNNER_SECTION,
	orchestrator: DEFAULT_ORCHESTRATOR_SECTION,
};
