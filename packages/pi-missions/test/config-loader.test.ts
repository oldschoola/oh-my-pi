import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import {
	_resetMigrationGuard,
	_resetPointerWarning,
	applyGlobalPreferences,
	CONFIG_VERSION,
	ConfigLoadError,
	DEFAULT_PROJECT_CONFIG,
	hasConfigFiles,
	loadGlobalPreferences,
	loadGlobalPreferencesWithMeta,
	loadProjectConfig,
	loadProjectOverrides,
	resolveConfigRoot,
	resolveGlobalPreferencesPath,
} from "../src/missioncontrol";

function makeTmpRoot(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function writeOmpFile(root: string, filename: string, content: string): void {
	const ompDir = join(root, ".omp");
	mkdirSync(ompDir, { recursive: true });
	writeFileSync(join(ompDir, filename), content, "utf-8");
}

let savedAgentDir: string | undefined;
let savedWorkspaceRoot: string | undefined;
let savedLegacyWorkspaceRoot: string | undefined;
let tmpAgentDir: string;

beforeEach(() => {
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	savedWorkspaceRoot = process.env.OMP_WORKSPACE_ROOT;
	savedLegacyWorkspaceRoot = process.env.TASKPLANE_WORKSPACE_ROOT;
	delete process.env.OMP_WORKSPACE_ROOT;
	delete process.env.TASKPLANE_WORKSPACE_ROOT;
	tmpAgentDir = makeTmpRoot("mc-agentdir");
	setAgentDir(tmpAgentDir);
	_resetMigrationGuard();
	_resetPointerWarning();
});

afterEach(() => {
	rmSync(tmpAgentDir, { recursive: true, force: true });
	if (savedAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		setAgentDir(savedAgentDir);
	}
	if (savedWorkspaceRoot === undefined) {
		delete process.env.OMP_WORKSPACE_ROOT;
	} else {
		process.env.OMP_WORKSPACE_ROOT = savedWorkspaceRoot;
	}
	if (savedLegacyWorkspaceRoot === undefined) {
		delete process.env.TASKPLANE_WORKSPACE_ROOT;
	} else {
		process.env.TASKPLANE_WORKSPACE_ROOT = savedLegacyWorkspaceRoot;
	}
});

describe("resolveGlobalPreferencesPath", () => {
	test("points at <agentDir>/missioncontrol/preferences.json", () => {
		const path = resolveGlobalPreferencesPath().replace(/\\/g, "/");
		expect(path).toContain("/missioncontrol/preferences.json");
		expect(path.startsWith(tmpAgentDir.replace(/\\/g, "/"))).toBe(true);
	});
});

describe("loadGlobalPreferencesWithMeta", () => {
	test("bootstraps when preferences file missing", () => {
		const result = loadGlobalPreferencesWithMeta();
		expect(result.wasBootstrapped).toBe(true);
		expect(result.preferences.initAgentDefaults).toBeDefined();
		expect(result.preferences.initAgentDefaults?.workerThinking).toBe("high");
	});

	test("re-bootstraps on empty file", () => {
		const prefsPath = resolveGlobalPreferencesPath();
		mkdirSync(join(prefsPath, ".."), { recursive: true });
		writeFileSync(prefsPath, "", "utf-8");
		const result = loadGlobalPreferencesWithMeta();
		expect(result.wasBootstrapped).toBe(true);
	});

	test("re-bootstraps on malformed JSON", () => {
		const prefsPath = resolveGlobalPreferencesPath();
		mkdirSync(join(prefsPath, ".."), { recursive: true });
		writeFileSync(prefsPath, "{not json", "utf-8");
		const result = loadGlobalPreferencesWithMeta();
		expect(result.wasBootstrapped).toBe(true);
	});

	test("reads allowlisted preferences without bootstrap", () => {
		const prefsPath = resolveGlobalPreferencesPath();
		mkdirSync(join(prefsPath, ".."), { recursive: true });
		writeFileSync(
			prefsPath,
			JSON.stringify({ workerModel: "sonnet-4", reviewerModel: "opus-4", unknownField: "ignored" }),
			"utf-8",
		);
		const result = loadGlobalPreferencesWithMeta();
		expect(result.wasBootstrapped).toBe(false);
		expect(result.preferences.workerModel).toBe("sonnet-4");
		expect(result.preferences.reviewerModel).toBe("opus-4");
	});

	test("loadGlobalPreferences returns preferences only", () => {
		const prefsPath = resolveGlobalPreferencesPath();
		mkdirSync(join(prefsPath, ".."), { recursive: true });
		writeFileSync(prefsPath, JSON.stringify({ workerModel: "sonnet-4" }), "utf-8");
		const prefs = loadGlobalPreferences();
		expect(prefs.workerModel).toBe("sonnet-4");
	});
});

describe("applyGlobalPreferences", () => {
	test("maps flat aliases onto nested sections", () => {
		const config = structuredClone(DEFAULT_PROJECT_CONFIG);
		applyGlobalPreferences(config, {
			operatorId: "james",
			sessionPrefix: "mc",
			workerModel: "sonnet-4",
			reviewerModel: "opus-4",
			mergeModel: "haiku-4",
			mergeThinking: "off",
			supervisorModel: "opus-4",
		});
		expect(config.orchestrator.orchestrator.operatorId).toBe("james");
		expect(config.orchestrator.orchestrator.sessionPrefix).toBe("mc");
		expect(config.taskRunner.worker.model).toBe("sonnet-4");
		expect(config.taskRunner.reviewer.model).toBe("opus-4");
		expect(config.orchestrator.merge.model).toBe("haiku-4");
		expect(config.orchestrator.merge.thinking).toBe("off");
		expect(config.orchestrator.supervisor.model).toBe("opus-4");
	});

	test("ignores empty-string overrides", () => {
		const config = structuredClone(DEFAULT_PROJECT_CONFIG);
		applyGlobalPreferences(config, { workerModel: "", operatorId: "" });
		expect(config.taskRunner.worker.model).toBe("");
		expect(config.orchestrator.orchestrator.operatorId).toBe("");
	});

	test("coerces legacy tmux spawnMode to subprocess", () => {
		const config = structuredClone(DEFAULT_PROJECT_CONFIG);
		applyGlobalPreferences(config, {
			spawnMode: "tmux" as unknown as "subprocess",
		});
		expect(config.orchestrator.orchestrator.spawnMode).toBe("subprocess");
	});
});

describe("hasConfigFiles", () => {
	test("detects mission.json under .omp/", () => {
		const root = makeTmpRoot("mc-has");
		try {
			writeOmpFile(root, "mission.json", `{"configVersion":${CONFIG_VERSION}}`);
			expect(hasConfigFiles(root)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("detects task-runner.yaml at project root", () => {
		const root = makeTmpRoot("mc-has");
		try {
			writeFileSync(join(root, "task-runner.yaml"), "worker:\n  model: sonnet\n", "utf-8");
			expect(hasConfigFiles(root)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("returns false for directory with only workspace yaml", () => {
		const root = makeTmpRoot("mc-has");
		try {
			writeOmpFile(root, "mission-workspace.yaml", "mode: repo\n");
			expect(hasConfigFiles(root)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("returns false when no config files exist", () => {
		const root = makeTmpRoot("mc-has");
		try {
			expect(hasConfigFiles(root)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("resolveConfigRoot", () => {
	test("returns cwd when cwd has config", () => {
		const cwd = makeTmpRoot("mc-rcr-cwd");
		const pointerRoot = makeTmpRoot("mc-rcr-ptr");
		try {
			writeOmpFile(cwd, "mission.json", `{"configVersion":${CONFIG_VERSION}}`);
			writeOmpFile(pointerRoot, "mission.json", `{"configVersion":${CONFIG_VERSION}}`);
			expect(resolveConfigRoot(cwd, pointerRoot)).toBe(cwd);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(pointerRoot, { recursive: true, force: true });
		}
	});

	test("falls through to pointer when cwd empty", () => {
		const cwd = makeTmpRoot("mc-rcr-cwd");
		const pointerRoot = makeTmpRoot("mc-rcr-ptr");
		try {
			writeOmpFile(pointerRoot, "mission.json", `{"configVersion":${CONFIG_VERSION}}`);
			expect(resolveConfigRoot(cwd, pointerRoot)).toBe(pointerRoot);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(pointerRoot, { recursive: true, force: true });
		}
	});

	test("falls through to OMP_WORKSPACE_ROOT env", () => {
		const cwd = makeTmpRoot("mc-rcr-cwd");
		const wsRoot = makeTmpRoot("mc-rcr-ws");
		try {
			writeOmpFile(wsRoot, "mission.json", `{"configVersion":${CONFIG_VERSION}}`);
			process.env.OMP_WORKSPACE_ROOT = wsRoot;
			expect(resolveConfigRoot(cwd)).toBe(wsRoot);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(wsRoot, { recursive: true, force: true });
		}
	});

	test("accepts legacy TASKPLANE_WORKSPACE_ROOT", () => {
		const cwd = makeTmpRoot("mc-rcr-cwd");
		const wsRoot = makeTmpRoot("mc-rcr-ws");
		try {
			writeOmpFile(wsRoot, "mission.json", `{"configVersion":${CONFIG_VERSION}}`);
			process.env.TASKPLANE_WORKSPACE_ROOT = wsRoot;
			expect(resolveConfigRoot(cwd)).toBe(wsRoot);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(wsRoot, { recursive: true, force: true });
		}
	});

	test("returns cwd as fallback when no config anywhere", () => {
		const cwd = makeTmpRoot("mc-rcr-cwd");
		try {
			expect(resolveConfigRoot(cwd)).toBe(cwd);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("loadProjectOverrides", () => {
	test("reads JSON when mission.json present", () => {
		const root = makeTmpRoot("mc-lpo");
		try {
			writeOmpFile(
				root,
				"mission.json",
				JSON.stringify({
					configVersion: CONFIG_VERSION,
					taskRunner: { worker: { model: "sonnet-4" } },
				}),
			);
			const overrides = loadProjectOverrides(root);
			expect(overrides.taskRunner?.worker?.model).toBe("sonnet-4");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("throws ConfigLoadError on malformed JSON", () => {
		const root = makeTmpRoot("mc-lpo");
		try {
			writeOmpFile(root, "mission.json", "{not: json}");
			expect(() => loadProjectOverrides(root)).toThrow(ConfigLoadError);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("throws CONFIG_VERSION_MISSING when configVersion absent", () => {
		const root = makeTmpRoot("mc-lpo");
		try {
			writeOmpFile(root, "mission.json", JSON.stringify({ taskRunner: {} }));
			try {
				loadProjectOverrides(root);
				throw new Error("expected throw");
			} catch (e) {
				expect(e).toBeInstanceOf(ConfigLoadError);
				expect((e as ConfigLoadError).code).toBe("CONFIG_VERSION_MISSING");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("throws CONFIG_VERSION_UNSUPPORTED on mismatch", () => {
		const root = makeTmpRoot("mc-lpo");
		try {
			writeOmpFile(root, "mission.json", JSON.stringify({ configVersion: 99 }));
			try {
				loadProjectOverrides(root);
				throw new Error("expected throw");
			} catch (e) {
				expect(e).toBeInstanceOf(ConfigLoadError);
				expect((e as ConfigLoadError).code).toBe("CONFIG_VERSION_UNSUPPORTED");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("falls back to YAML when JSON absent", () => {
		const root = makeTmpRoot("mc-lpo");
		try {
			writeOmpFile(root, "task-runner.yaml", "worker:\n  model: sonnet-4\n");
			const overrides = loadProjectOverrides(root);
			expect(overrides.taskRunner?.worker?.model).toBe("sonnet-4");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("returns empty overrides when nothing present", () => {
		const root = makeTmpRoot("mc-lpo");
		try {
			const overrides = loadProjectOverrides(root);
			expect(Object.keys(overrides).length).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("loadProjectConfig", () => {
	test("returns deep clone of defaults when no config + no prefs", () => {
		const root = makeTmpRoot("mc-lpc");
		try {
			const config = loadProjectConfig(root);
			expect(config.configVersion).toBe(CONFIG_VERSION);
			expect(config).not.toBe(DEFAULT_PROJECT_CONFIG);
			expect(config.taskRunner).not.toBe(DEFAULT_PROJECT_CONFIG.taskRunner);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("applies project overrides on top of defaults", () => {
		const root = makeTmpRoot("mc-lpc");
		try {
			writeOmpFile(
				root,
				"mission.json",
				JSON.stringify({
					configVersion: CONFIG_VERSION,
					taskRunner: { worker: { model: "project-model" } },
				}),
			);
			const config = loadProjectConfig(root);
			expect(config.taskRunner.worker.model).toBe("project-model");
			expect(config.taskRunner.worker.tools).toBe(DEFAULT_PROJECT_CONFIG.taskRunner.worker.tools);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("layers global prefs then project overrides (project wins)", () => {
		const root = makeTmpRoot("mc-lpc");
		try {
			const prefsPath = resolveGlobalPreferencesPath();
			mkdirSync(join(prefsPath, ".."), { recursive: true });
			writeFileSync(prefsPath, JSON.stringify({ workerModel: "global-model" }), "utf-8");
			writeOmpFile(
				root,
				"mission.json",
				JSON.stringify({
					configVersion: CONFIG_VERSION,
					taskRunner: { worker: { model: "project-model" } },
				}),
			);
			const config = loadProjectConfig(root);
			expect(config.taskRunner.worker.model).toBe("project-model");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("applies global prefs when no project overrides", () => {
		const root = makeTmpRoot("mc-lpc");
		try {
			const prefsPath = resolveGlobalPreferencesPath();
			mkdirSync(join(prefsPath, ".."), { recursive: true });
			writeFileSync(prefsPath, JSON.stringify({ workerModel: "global-model" }), "utf-8");
			const config = loadProjectConfig(root);
			expect(config.taskRunner.worker.model).toBe("global-model");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
