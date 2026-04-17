import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalizePath,
	loadWorkspaceConfig,
	POINTER_FILENAME,
	pointerFilePath,
	resolvePointer,
	WORKSPACE_CONFIG_FILENAME,
	WorkspaceConfigError,
	workspaceConfigPath,
} from "../src/missioncontrol";

function makeRoot(): string {
	return mkdtempSync(join(tmpdir(), "mc-workspace-"));
}

function initGit(dir: string): void {
	execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
}

function writeYaml(root: string, content: string): string {
	const file = workspaceConfigPath(root);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, content);
	return file;
}

describe("workspace constants + helpers", () => {
	test("filenames are renamed to mission-*", () => {
		expect(POINTER_FILENAME).toBe("mission-pointer.json");
		expect(WORKSPACE_CONFIG_FILENAME).toBe("mission-workspace.yaml");
	});

	test("config + pointer paths live under .omp/", () => {
		const root = makeRoot();
		try {
			expect(workspaceConfigPath(root).replace(/\\/g, "/")).toContain("/.omp/mission-workspace.yaml");
			expect(pointerFilePath(root).replace(/\\/g, "/")).toContain("/.omp/mission-pointer.json");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("canonicalizePath normalizes + lowercases", () => {
		const root = makeRoot();
		try {
			const p = canonicalizePath("foo/Bar", root);
			expect(p).toMatch(/\/foo\/bar$/);
			expect(p).not.toContain("\\");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("loadWorkspaceConfig", () => {
	test("returns null when no config file (repo mode signal)", () => {
		const root = makeRoot();
		try {
			expect(loadWorkspaceConfig(root)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("throws WORKSPACE_FILE_PARSE_ERROR on invalid YAML", () => {
		const root = makeRoot();
		try {
			writeYaml(root, ":\n  : : broken yaml: [");
			expect(() => loadWorkspaceConfig(root)).toThrow(WorkspaceConfigError);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("throws WORKSPACE_SCHEMA_INVALID when top-level is not a mapping", () => {
		const root = makeRoot();
		try {
			writeYaml(root, "- not a map");
			try {
				loadWorkspaceConfig(root);
				expect.unreachable("should throw");
			} catch (err) {
				const e = err as WorkspaceConfigError;
				expect(e).toBeInstanceOf(WorkspaceConfigError);
				expect(e.code).toBe("WORKSPACE_SCHEMA_INVALID");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("throws WORKSPACE_MISSING_REPOS on empty repos map", () => {
		const root = makeRoot();
		try {
			writeYaml(root, "repos: {}\nrouting:\n  tasks_root: .\n  default_repo: x\n");
			try {
				loadWorkspaceConfig(root);
				expect.unreachable("should throw");
			} catch (err) {
				const e = err as WorkspaceConfigError;
				expect(e.code).toBe("WORKSPACE_MISSING_REPOS");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("throws WORKSPACE_REPO_PATH_NOT_FOUND when repo path missing on disk", () => {
		const root = makeRoot();
		try {
			writeYaml(root, "repos:\n  api:\n    path: ./nonexistent\nrouting:\n  tasks_root: .\n  default_repo: api\n");
			try {
				loadWorkspaceConfig(root);
				expect.unreachable("should throw");
			} catch (err) {
				const e = err as WorkspaceConfigError;
				expect(e.code).toBe("WORKSPACE_REPO_PATH_NOT_FOUND");
				expect(e.repoId).toBe("api");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("throws WORKSPACE_REPO_NOT_GIT when path exists but is not a git repo", () => {
		const root = makeRoot();
		try {
			const apiDir = join(root, "api");
			mkdirSync(apiDir);
			const tasksDir = join(root, "tasks");
			mkdirSync(tasksDir);
			writeYaml(root, "repos:\n  api:\n    path: ./api\nrouting:\n  tasks_root: ./tasks\n  default_repo: api\n");
			try {
				loadWorkspaceConfig(root);
				expect.unreachable("should throw");
			} catch (err) {
				const e = err as WorkspaceConfigError;
				expect(e.code).toBe("WORKSPACE_REPO_NOT_GIT");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("loads a valid workspace config with one repo + default routing", () => {
		const root = makeRoot();
		try {
			const apiDir = join(root, "api");
			mkdirSync(apiDir);
			initGit(apiDir);
			const tasksDir = join(apiDir, "tasks");
			mkdirSync(tasksDir);
			writeYaml(
				root,
				"repos:\n  api:\n    path: ./api\nrouting:\n  tasks_root: ./api/tasks\n  default_repo: api\n  task_packet_repo: api\n",
			);
			const cfg = loadWorkspaceConfig(root);
			expect(cfg).not.toBeNull();
			expect(cfg?.mode).toBe("workspace");
			expect(cfg?.repos.has("api")).toBe(true);
			expect(cfg?.routing.defaultRepo).toBe("api");
			expect(cfg?.routing.taskPacketRepo).toBe("api");
			expect(cfg?.routing.strict).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("routing.strict rejects null explicitly (no fail-open)", () => {
		const root = makeRoot();
		try {
			const apiDir = join(root, "api");
			mkdirSync(apiDir);
			initGit(apiDir);
			const tasksDir = join(apiDir, "tasks");
			mkdirSync(tasksDir);
			writeYaml(
				root,
				"repos:\n  api:\n    path: ./api\nrouting:\n  tasks_root: ./api/tasks\n  default_repo: api\n  task_packet_repo: api\n  strict: null\n",
			);
			try {
				loadWorkspaceConfig(root);
				expect.unreachable("should throw");
			} catch (err) {
				const e = err as WorkspaceConfigError;
				expect(e.code).toBe("WORKSPACE_SCHEMA_INVALID");
				expect(e.message).toContain("routing.strict");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("tasks_root outside packet repo fails validation", () => {
		const root = makeRoot();
		try {
			const apiDir = join(root, "api");
			mkdirSync(apiDir);
			initGit(apiDir);
			const tasksDir = join(root, "tasks-outside");
			mkdirSync(tasksDir);
			writeYaml(
				root,
				"repos:\n  api:\n    path: ./api\nrouting:\n  tasks_root: ./tasks-outside\n  default_repo: api\n  task_packet_repo: api\n",
			);
			try {
				loadWorkspaceConfig(root);
				expect.unreachable("should throw");
			} catch (err) {
				const e = err as WorkspaceConfigError;
				expect(e.code).toBe("WORKSPACE_TASKS_ROOT_OUTSIDE_PACKET_REPO");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("resolvePointer", () => {
	test("returns null in repo mode (workspaceConfig === null)", () => {
		const root = makeRoot();
		try {
			expect(resolvePointer(root, null)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("fallback when pointer file absent (used=false, warning set)", () => {
		const root = makeRoot();
		try {
			const apiDir = join(root, "api");
			mkdirSync(apiDir);
			initGit(apiDir);
			const tasksDir = join(apiDir, "tasks");
			mkdirSync(tasksDir);
			writeYaml(
				root,
				"repos:\n  api:\n    path: ./api\nrouting:\n  tasks_root: ./api/tasks\n  default_repo: api\n  task_packet_repo: api\n",
			);
			const cfg = loadWorkspaceConfig(root)!;
			const pr = resolvePointer(root, cfg);
			expect(pr?.used).toBe(false);
			expect(pr?.warning).toContain("Pointer file not found");
			expect(pr?.configRoot.replace(/\\/g, "/")).toContain("/.omp");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects pointer with path traversal in config_path", () => {
		const root = makeRoot();
		try {
			const apiDir = join(root, "api");
			mkdirSync(apiDir);
			initGit(apiDir);
			const tasksDir = join(apiDir, "tasks");
			mkdirSync(tasksDir);
			writeYaml(
				root,
				"repos:\n  api:\n    path: ./api\nrouting:\n  tasks_root: ./api/tasks\n  default_repo: api\n  task_packet_repo: api\n",
			);
			const cfg = loadWorkspaceConfig(root)!;
			mkdirSync(join(root, ".omp"), { recursive: true });
			writeFileSync(pointerFilePath(root), JSON.stringify({ config_repo: "api", config_path: "../escape" }));
			const pr = resolvePointer(root, cfg);
			expect(pr?.used).toBe(false);
			expect(pr?.warning).toContain("path traversal");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("resolves valid pointer into configRoot + agentRoot", () => {
		const root = makeRoot();
		try {
			const apiDir = join(root, "api");
			mkdirSync(apiDir);
			initGit(apiDir);
			const tasksDir = join(apiDir, "tasks");
			mkdirSync(tasksDir);
			const cfgInside = join(apiDir, "config");
			mkdirSync(cfgInside);
			writeYaml(
				root,
				"repos:\n  api:\n    path: ./api\nrouting:\n  tasks_root: ./api/tasks\n  default_repo: api\n  task_packet_repo: api\n",
			);
			const cfg = loadWorkspaceConfig(root)!;
			mkdirSync(join(root, ".omp"), { recursive: true });
			writeFileSync(pointerFilePath(root), JSON.stringify({ config_repo: "api", config_path: "config" }));
			const pr = resolvePointer(root, cfg);
			expect(pr?.used).toBe(true);
			expect(pr?.configRoot.replace(/\\/g, "/")).toMatch(/\/api\/config$/);
			expect(pr?.agentRoot.replace(/\\/g, "/")).toMatch(/\/api\/config\/agents$/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects pointer referencing unknown repo", () => {
		const root = makeRoot();
		try {
			const apiDir = join(root, "api");
			mkdirSync(apiDir);
			initGit(apiDir);
			const tasksDir = join(apiDir, "tasks");
			mkdirSync(tasksDir);
			writeYaml(
				root,
				"repos:\n  api:\n    path: ./api\nrouting:\n  tasks_root: ./api/tasks\n  default_repo: api\n  task_packet_repo: api\n",
			);
			const cfg = loadWorkspaceConfig(root)!;
			mkdirSync(join(root, ".omp"), { recursive: true });
			writeFileSync(pointerFilePath(root), JSON.stringify({ config_repo: "ghost", config_path: "config" }));
			const pr = resolvePointer(root, cfg);
			expect(pr?.used).toBe(false);
			expect(pr?.warning).toContain("not found in workspace repos");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
