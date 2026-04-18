/**
 * Workspace configuration loading and validation.
 *
 * Ported from taskplane/extensions/taskplane/workspace.ts (pure subset —
 * `buildExecutionContext` + `validateTaskAreasWithinTasksRoot` deferred
 * until the Runtime V2 orchestrator/task-runner config modules land).
 *
 * Renames vs taskplane:
 *   `.pi/` directories         → `projectDir(workspaceRoot)` (`.omp/`)
 *   `taskplane-workspace.yaml` → `mission-workspace.yaml`
 *   `taskplane-pointer.json`   → `mission-pointer.json`
 *   `[taskplane]` log prefixes → `[missioncontrol]`
 *
 * Detects workspace mode by checking for `.omp/mission-workspace.yaml`.
 * When the file is present, it must be valid — invalid files are fatal.
 * When absent, `loadWorkspaceConfig()` returns null (repo mode).
 *
 * Validation order (deterministic, fail-fast):
 *  1. File existence check    → absent = repo mode (return null)
 *  2. File read               → WORKSPACE_FILE_READ_ERROR
 *  3. YAML parse              → WORKSPACE_FILE_PARSE_ERROR
 *  4. Top-level schema        → WORKSPACE_SCHEMA_INVALID
 *  5. repos map non-empty     → WORKSPACE_MISSING_REPOS
 *  6. Per-repo validation:
 *     a. path present          → WORKSPACE_REPO_PATH_MISSING
 *     b. path exists on disk   → WORKSPACE_REPO_PATH_NOT_FOUND
 *     c. path is git repo root → WORKSPACE_REPO_NOT_GIT
 *  7. Duplicate repo paths    → WORKSPACE_DUPLICATE_REPO_PATH
 *  8. routing.tasks_root      → WORKSPACE_MISSING_TASKS_ROOT / _NOT_FOUND
 *  9. routing.default_repo    → WORKSPACE_MISSING_DEFAULT_REPO / _NOT_FOUND
 * 10. routing.task_packet_repo → compat fallback to default_repo or _NOT_FOUND
 * 11. tasks_root inside packet repo → WORKSPACE_TASKS_ROOT_OUTSIDE_PACKET_REPO
 * 12. routing.strict must be boolean if present → WORKSPACE_SCHEMA_INVALID
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse as yamlParse } from "yaml";

import { logger, projectDir } from "./adapter";
import { runGit } from "./git";
import {
	POINTER_FILENAME,
	type PointerResolution,
	WORKSPACE_CONFIG_FILENAME,
	type WorkspaceConfig,
	WorkspaceConfigError,
	type WorkspaceRepoConfig,
	type WorkspaceRoutingConfig,
} from "./types";

// ── Path helpers (exported for tests + callers) ──────────────────────

export function workspaceConfigPath(workspaceRoot: string): string {
	return join(projectDir(workspaceRoot), WORKSPACE_CONFIG_FILENAME);
}

export function pointerFilePath(workspaceRoot: string): string {
	return join(projectDir(workspaceRoot), POINTER_FILENAME);
}

// ── Path Canonicalization ────────────────────────────────────────────

/**
 * Canonicalize a filesystem path for comparison (lowercased, forward-slash).
 * Expands Windows 8.3 short names + symlinks when the path exists.
 */
export function canonicalizePath(p: string, base: string): string {
	const resolved = resolve(base, p);
	let expanded: string;
	try {
		expanded = realpathSync.native(resolved);
	} catch {
		expanded = resolved;
	}
	return expanded.replace(/\\/g, "/").toLowerCase();
}

/** Resolve absolute path preserving case (for display/storage). */
function resolveAbsolutePath(p: string, base: string): string {
	const resolved = resolve(base, p);
	try {
		return realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

/** True when `childPath` is the same as `parentPath` or nested inside it. */
function isPathWithinContainer(childPath: string, parentPath: string): boolean {
	const child = canonicalizePath(childPath, "");
	const parent = canonicalizePath(parentPath, "");
	return child === parent || child.startsWith(`${parent}/`);
}

// ── Pointer Resolution ───────────────────────────────────────────────

/**
 * Resolve the workspace pointer file to find config and agent roots.
 *
 * Repo mode (workspaceConfig === null) → returns null (pointer ignored).
 * Workspace mode → reads pointer, validates, resolves. All failures are
 * non-fatal: fallback paths are `<projectDir>/` and `<projectDir>/agents/`.
 */
export function resolvePointer(
	workspaceRoot: string,
	workspaceConfig: WorkspaceConfig | null,
): PointerResolution | null {
	if (workspaceConfig === null) {
		return null;
	}

	const fallbackConfigRoot = projectDir(workspaceRoot);
	const fallbackAgentRoot = join(projectDir(workspaceRoot), "agents");

	const filePath = pointerFilePath(workspaceRoot);

	if (!existsSync(filePath)) {
		return {
			used: false,
			configRoot: fallbackConfigRoot,
			agentRoot: fallbackAgentRoot,
			warning: `Pointer file not found: ${filePath}. Run 'omp mission init' to create it.`,
		};
	}

	let rawContent: string;
	try {
		rawContent = readFileSync(filePath, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			used: false,
			configRoot: fallbackConfigRoot,
			agentRoot: fallbackAgentRoot,
			warning: `Cannot read pointer file ${filePath}: ${msg}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawContent);
	} catch {
		return {
			used: false,
			configRoot: fallbackConfigRoot,
			agentRoot: fallbackAgentRoot,
			warning: `Pointer file ${filePath} contains invalid JSON.`,
		};
	}

	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {
			used: false,
			configRoot: fallbackConfigRoot,
			agentRoot: fallbackAgentRoot,
			warning: `Pointer file ${filePath} must be a JSON object.`,
		};
	}

	const doc = parsed as Record<string, unknown>;
	const configRepo = doc.config_repo;
	const configPath = doc.config_path;

	if (!configRepo || typeof configRepo !== "string" || configRepo.trim() === "") {
		return {
			used: false,
			configRoot: fallbackConfigRoot,
			agentRoot: fallbackAgentRoot,
			warning: `Pointer file ${filePath} is missing required field 'config_repo'.`,
		};
	}

	if (!configPath || typeof configPath !== "string" || configPath.trim() === "") {
		return {
			used: false,
			configRoot: fallbackConfigRoot,
			agentRoot: fallbackAgentRoot,
			warning: `Pointer file ${filePath} is missing required field 'config_path'.`,
		};
	}

	const normalizedConfigPath = configPath.trim().replace(/\\/g, "/");

	if (isAbsolute(normalizedConfigPath) || isAbsolute(configPath.trim())) {
		return {
			used: false,
			configRoot: fallbackConfigRoot,
			agentRoot: fallbackAgentRoot,
			warning: `Pointer file ${filePath} has invalid config_path '${configPath}' (absolute paths not allowed).`,
		};
	}

	if (
		normalizedConfigPath.startsWith("..") ||
		normalizedConfigPath.includes("/../") ||
		normalizedConfigPath.endsWith("/..")
	) {
		return {
			used: false,
			configRoot: fallbackConfigRoot,
			agentRoot: fallbackAgentRoot,
			warning: `Pointer file ${filePath} has invalid config_path '${configPath}' (path traversal not allowed).`,
		};
	}

	const repoId = configRepo.trim();
	const repoConfig = workspaceConfig.repos.get(repoId);
	if (!repoConfig) {
		const available = Array.from(workspaceConfig.repos.keys()).join(", ");
		return {
			used: false,
			configRoot: fallbackConfigRoot,
			agentRoot: fallbackAgentRoot,
			warning: `Pointer file ${filePath}: config_repo '${repoId}' not found in workspace repos. Available repos: ${available}`,
		};
	}

	const resolvedConfigRoot = resolve(repoConfig.path, normalizedConfigPath);

	const rel = relative(repoConfig.path, resolvedConfigRoot);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		return {
			used: false,
			configRoot: fallbackConfigRoot,
			agentRoot: fallbackAgentRoot,
			warning: `Pointer file ${filePath} has invalid config_path '${configPath}' (resolved path escapes config repo root).`,
		};
	}

	const resolvedAgentRoot = resolve(resolvedConfigRoot, "agents");

	return {
		used: true,
		configRoot: resolvedConfigRoot,
		agentRoot: resolvedAgentRoot,
	};
}

// ── Workspace Config Loading ─────────────────────────────────────────

/**
 * Load and validate workspace configuration from `.omp/mission-workspace.yaml`.
 *
 *   No config file          → null (repo mode, non-fatal).
 *   Config present + valid  → WorkspaceConfig.
 *   Config present + broken → throw WorkspaceConfigError (fatal).
 */
export function loadWorkspaceConfig(workspaceRoot: string): WorkspaceConfig | null {
	const configFile = workspaceConfigPath(workspaceRoot);

	if (!existsSync(configFile)) {
		return null;
	}

	let rawContent: string;
	try {
		rawContent = readFileSync(configFile, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new WorkspaceConfigError(
			"WORKSPACE_FILE_READ_ERROR",
			`Cannot read workspace config file: ${msg}`,
			undefined,
			configFile,
		);
	}

	let parsed: unknown;
	try {
		parsed = yamlParse(rawContent);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new WorkspaceConfigError(
			"WORKSPACE_FILE_PARSE_ERROR",
			`Invalid YAML in workspace config: ${msg}`,
			undefined,
			configFile,
		);
	}

	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new WorkspaceConfigError(
			"WORKSPACE_SCHEMA_INVALID",
			"Workspace config must be a YAML mapping (object), not a scalar or sequence.",
			undefined,
			configFile,
		);
	}
	const doc = parsed as Record<string, unknown>;

	if (!doc.repos || typeof doc.repos !== "object" || Array.isArray(doc.repos)) {
		throw new WorkspaceConfigError(
			"WORKSPACE_SCHEMA_INVALID",
			"Workspace config must contain a 'repos' mapping.",
			undefined,
			configFile,
		);
	}
	if (!doc.routing || typeof doc.routing !== "object" || Array.isArray(doc.routing)) {
		throw new WorkspaceConfigError(
			"WORKSPACE_SCHEMA_INVALID",
			"Workspace config must contain a 'routing' mapping.",
			undefined,
			configFile,
		);
	}

	const rawRepos = doc.repos as Record<string, unknown>;
	const repoKeys = Object.keys(rawRepos).sort();
	if (repoKeys.length === 0) {
		throw new WorkspaceConfigError(
			"WORKSPACE_MISSING_REPOS",
			"Workspace config must define at least one repo under 'repos'.",
			undefined,
			configFile,
		);
	}

	const repos = new Map<string, WorkspaceRepoConfig>();
	const normalizedPaths = new Map<string, string>();

	for (const repoId of repoKeys) {
		const rawRepo = rawRepos[repoId];
		if (rawRepo == null || typeof rawRepo !== "object" || Array.isArray(rawRepo)) {
			throw new WorkspaceConfigError(
				"WORKSPACE_SCHEMA_INVALID",
				`Repo '${repoId}' must be a YAML mapping with at least a 'path' field.`,
				repoId,
				configFile,
			);
		}
		const repoEntry = rawRepo as Record<string, unknown>;

		const rawPath = repoEntry.path;
		if (!rawPath || typeof rawPath !== "string" || rawPath.trim() === "") {
			throw new WorkspaceConfigError(
				"WORKSPACE_REPO_PATH_MISSING",
				`Repo '${repoId}' is missing a 'path' field.`,
				repoId,
				configFile,
			);
		}

		const absolutePath = resolveAbsolutePath(rawPath.trim(), workspaceRoot);
		const normalizedPath = canonicalizePath(rawPath.trim(), workspaceRoot);
		if (!existsSync(absolutePath)) {
			throw new WorkspaceConfigError(
				"WORKSPACE_REPO_PATH_NOT_FOUND",
				`Repo '${repoId}' path does not exist: ${absolutePath}`,
				repoId,
				absolutePath,
			);
		}

		const gitDirCheck = runGit(["rev-parse", "--git-dir"], absolutePath);
		if (!gitDirCheck.ok) {
			throw new WorkspaceConfigError(
				"WORKSPACE_REPO_NOT_GIT",
				`Repo '${repoId}' path is not a git repository: ${absolutePath}`,
				repoId,
				absolutePath,
			);
		}
		const toplevelCheck = runGit(["rev-parse", "--show-toplevel"], absolutePath);
		if (toplevelCheck.ok) {
			const toplevelNormalized = canonicalizePath(toplevelCheck.stdout.trim(), "");
			if (toplevelNormalized !== normalizedPath) {
				throw new WorkspaceConfigError(
					"WORKSPACE_REPO_NOT_GIT",
					`Repo '${repoId}' path is a subdirectory of a git repo, not the repo root. Expected root: ${toplevelCheck.stdout.trim()}, got: ${absolutePath}`,
					repoId,
					absolutePath,
				);
			}
		}

		if (normalizedPaths.has(normalizedPath)) {
			throw new WorkspaceConfigError(
				"WORKSPACE_DUPLICATE_REPO_PATH",
				`Repos '${normalizedPaths.get(normalizedPath)}' and '${repoId}' share the same path: ${absolutePath}`,
				repoId,
				absolutePath,
			);
		}
		normalizedPaths.set(normalizedPath, repoId);

		const defaultBranch =
			typeof repoEntry.default_branch === "string" && repoEntry.default_branch.trim()
				? repoEntry.default_branch.trim()
				: undefined;

		repos.set(repoId, {
			id: repoId,
			path: absolutePath,
			defaultBranch,
		});
	}

	const rawRouting = doc.routing as Record<string, unknown>;

	const rawTasksRoot = rawRouting.tasks_root;
	if (!rawTasksRoot || typeof rawTasksRoot !== "string" || rawTasksRoot.trim() === "") {
		throw new WorkspaceConfigError(
			"WORKSPACE_MISSING_TASKS_ROOT",
			"Workspace config 'routing.tasks_root' is missing or empty.",
			undefined,
			configFile,
		);
	}

	const tasksRootAbsolute = resolveAbsolutePath(rawTasksRoot.trim(), workspaceRoot);
	if (!existsSync(tasksRootAbsolute)) {
		throw new WorkspaceConfigError(
			"WORKSPACE_TASKS_ROOT_NOT_FOUND",
			`routing.tasks_root path does not exist: ${tasksRootAbsolute}`,
			undefined,
			tasksRootAbsolute,
		);
	}

	const rawDefaultRepo = rawRouting.default_repo;
	if (!rawDefaultRepo || typeof rawDefaultRepo !== "string" || rawDefaultRepo.trim() === "") {
		throw new WorkspaceConfigError(
			"WORKSPACE_MISSING_DEFAULT_REPO",
			"Workspace config 'routing.default_repo' is missing or empty.",
			undefined,
			configFile,
		);
	}

	const defaultRepoId = rawDefaultRepo.trim();
	if (!repos.has(defaultRepoId)) {
		throw new WorkspaceConfigError(
			"WORKSPACE_DEFAULT_REPO_NOT_FOUND",
			`routing.default_repo '${defaultRepoId}' does not match any repo ID. Available repos: ${Array.from(repos.keys()).join(", ")}`,
			undefined,
			configFile,
		);
	}

	const hasTaskPacketRepo = Object.hasOwn(rawRouting, "task_packet_repo");
	const rawTaskPacketRepo = rawRouting.task_packet_repo;
	let taskPacketRepoId = defaultRepoId;

	if (hasTaskPacketRepo) {
		if (typeof rawTaskPacketRepo !== "string" || rawTaskPacketRepo.trim() === "") {
			throw new WorkspaceConfigError(
				"WORKSPACE_SCHEMA_INVALID",
				"Workspace config 'routing.task_packet_repo' must be a non-empty string when provided.",
				undefined,
				configFile,
			);
		}
		taskPacketRepoId = rawTaskPacketRepo.trim();
	} else {
		logger.warn(
			`[missioncontrol] workspace compatibility: 'routing.task_packet_repo' is missing in ${configFile}; defaulting to routing.default_repo ('${defaultRepoId}'). Add 'routing.task_packet_repo' explicitly.`,
		);
	}

	if (!repos.has(taskPacketRepoId)) {
		throw new WorkspaceConfigError(
			"WORKSPACE_TASK_PACKET_REPO_NOT_FOUND",
			`routing.task_packet_repo '${taskPacketRepoId}' does not match any repo ID. Available repos: ${Array.from(repos.keys()).join(", ")}`,
			undefined,
			configFile,
		);
	}

	const packetRepoPath = repos.get(taskPacketRepoId)!.path;
	if (!isPathWithinContainer(tasksRootAbsolute, packetRepoPath)) {
		throw new WorkspaceConfigError(
			"WORKSPACE_TASKS_ROOT_OUTSIDE_PACKET_REPO",
			`routing.tasks_root '${tasksRootAbsolute}' must be inside packet-home repo '${taskPacketRepoId}' (${packetRepoPath}). Update routing.tasks_root or routing.task_packet_repo.`,
			undefined,
			tasksRootAbsolute,
		);
	}

	const rawStrict = rawRouting.strict;
	if (rawStrict !== undefined) {
		if (rawStrict === null || typeof rawStrict !== "boolean") {
			throw new WorkspaceConfigError(
				"WORKSPACE_SCHEMA_INVALID",
				`routing.strict must be a boolean (true/false)${rawStrict === null ? ", got null (use true or false explicitly)" : `, got ${typeof rawStrict}: ${JSON.stringify(rawStrict)}`}`,
				undefined,
				configFile,
			);
		}
	}
	const strict = rawStrict === true;

	const routing: WorkspaceRoutingConfig = {
		tasksRoot: tasksRootAbsolute,
		defaultRepo: defaultRepoId,
		taskPacketRepo: taskPacketRepoId,
		...(strict ? { strict: true } : {}),
	};

	return {
		mode: "workspace",
		repos,
		routing,
		configPath: configFile,
	};
}
