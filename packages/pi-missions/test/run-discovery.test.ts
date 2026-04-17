/**
 * Unit tests for runDiscovery — full discovery pipeline ported from
 * taskplane discovery.ts:1613-1744.
 *
 * Covers the 7-step pipeline:
 *  1. resolveArguments → early-return on arg errors + "no valid" path
 *  2. buildTaskRegistry → duplicate ID fail-fast short-circuits steps 3–7
 *  3. Dependency source policy (prompt vs agent fallback warnings)
 *  4. resolveDependencies integration
 *  5. Dependency cache persistence (useDependencyCache)
 *  6. Task-to-repo routing (workspace mode vs repo mode placeholder → "default")
 *  7. Post-resolution SEGMENT_STEP_DUPLICATE_REPO detection
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskArea, WorkspaceConfig, WorkspaceRepoConfig } from "../src/missioncontrol";
import { runDiscovery } from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-run-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function writeTask(relDir: string, taskId: string, body = ""): string {
	const dir = join(sandbox, relDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "PROMPT.md"), `# Task: ${taskId} - seed\n${body}`, "utf-8");
	return dir;
}

function area(path: string): TaskArea {
	return { path, prefix: "TA", context: "test" };
}

function repos(...ids: string[]): Map<string, WorkspaceRepoConfig> {
	const m = new Map<string, WorkspaceRepoConfig>();
	for (const id of ids) m.set(id, { id, path: `/dummy/${id}` });
	return m;
}

function wsConfig(rm: Map<string, WorkspaceRepoConfig>, defaultRepo: string): WorkspaceConfig {
	return {
		mode: "workspace",
		repos: rm,
		routing: { tasksRoot: "tasks", defaultRepo, taskPacketRepo: defaultRepo },
		configPath: "/dummy/workspace.yaml",
	};
}

describe("runDiscovery — argument handling", () => {
	test("empty args yields UNKNOWN_ARG 'no valid'", () => {
		const result = runDiscovery("", {}, sandbox);
		expect(result.errors[0]?.code).toBe("UNKNOWN_ARG");
		expect(result.errors[0]?.message).toContain("No valid areas");
	});

	test("invalid token short-circuits before registry build", () => {
		const result = runDiscovery("nope", {}, sandbox);
		expect(result.pending.size).toBe(0);
		expect(result.errors[0]?.code).toBe("UNKNOWN_ARG");
	});
});

describe("runDiscovery — registry + duplicate fail-fast", () => {
	test("builds registry from a single area", () => {
		writeTask("api/TA-001", "TA-001");
		const result = runDiscovery("api", { api: area("api") }, sandbox);
		expect(result.pending.has("TA-001")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("duplicate task IDs halt the pipeline (no dep resolution, no routing)", () => {
		writeTask("api/TA-001", "TA-001");
		writeTask("web/TA-001", "TA-001");
		const result = runDiscovery("all", { api: area("api"), web: area("web") }, sandbox, {
			workspaceConfig: wsConfig(repos("api", "web"), "api"),
		});
		const dup = result.errors.find(e => e.code === "DUPLICATE_ID");
		expect(dup).toBeDefined();
		// Routing errors must NOT appear — pipeline halted at step 2
		expect(result.errors.some(e => e.code === "TASK_REPO_UNKNOWN")).toBe(false);
	});
});

describe("runDiscovery — dependency source policy", () => {
	test("dependencySource=agent without cache emits DEP_SOURCE_FALLBACK warning", () => {
		writeTask("api/TA-010", "TA-010");
		const result = runDiscovery("api", { api: area("api") }, sandbox, {
			dependencySource: "agent",
			useDependencyCache: true,
		});
		expect(result.errors.some(e => e.code === "DEP_SOURCE_FALLBACK")).toBe(true);
	});

	test("dependencySource=agent without useDependencyCache also falls back", () => {
		writeTask("api/TA-011", "TA-011");
		const result = runDiscovery("api", { api: area("api") }, sandbox, {
			dependencySource: "agent",
		});
		expect(result.errors.some(e => e.code === "DEP_SOURCE_FALLBACK")).toBe(true);
	});
});

describe("runDiscovery — cache persistence", () => {
	test("useDependencyCache writes a cache file under the scanned area", () => {
		writeTask("api/TA-020", "TA-020");
		runDiscovery("api", { api: area("api") }, sandbox, { useDependencyCache: true });
		const cachePath = join(sandbox, "api", "dependencies.json");
		expect(existsSync(cachePath)).toBe(true);
	});

	test("no cache written when useDependencyCache is false", () => {
		writeTask("api/TA-021", "TA-021");
		runDiscovery("api", { api: area("api") }, sandbox);
		expect(existsSync(join(sandbox, "api", "dependencies.json"))).toBe(false);
	});
});

describe("runDiscovery — routing (workspace mode)", () => {
	test("workspace mode runs resolveTaskRouting", () => {
		writeTask("api/TA-030", "TA-030");
		const result = runDiscovery("api", { api: area("api") }, sandbox, {
			workspaceConfig: wsConfig(repos("api", "web"), "api"),
		});
		const task = result.pending.get("TA-030");
		expect(task?.resolvedRepoId).toBe("api");
	});

	test("workspace mode surfaces TASK_REPO_UNKNOWN for unknown repos", () => {
		writeTask("api/TA-031", "TA-031", "\n## Execution Target\nRepo: ghost\n");
		const result = runDiscovery("api", { api: area("api") }, sandbox, {
			workspaceConfig: wsConfig(repos("api"), "api"),
		});
		expect(result.errors.some(e => e.code === "TASK_REPO_UNKNOWN")).toBe(true);
	});
});

describe("runDiscovery — repo mode step-segment normalization", () => {
	test("placeholder segments normalized to 'default' in repo mode", () => {
		const content = [
			"# Task: TA-040 - segment",
			"",
			"## Steps",
			"### Step 1: foo",
			"- [ ] item A",
			"- [ ] item B",
			"",
		].join("\n");
		const dir = writeTask("api/TA-040", "TA-040", "");
		writeFileSync(join(dir, "PROMPT.md"), content, "utf-8");
		const result = runDiscovery("api", { api: area("api") }, sandbox);
		const task = result.pending.get("TA-040");
		// No explicit markers → stepSegmentMap is undefined
		expect(task?.stepSegmentMap).toBeUndefined();
	});

	test("placeholder normalized to 'default' when explicit markers present", () => {
		const content = [
			"# Task: TA-041 - seg",
			"",
			"## Steps",
			"### Step 1: primary only",
			"- [ ] a",
			"### Step 2: with marker",
			"- [ ] preseg",
			"#### Segment: web",
			"- [ ] b",
			"",
		].join("\n");
		const dir = writeTask("api/TA-041", "TA-041", "");
		writeFileSync(join(dir, "PROMPT.md"), content, "utf-8");
		const result = runDiscovery("api", { api: area("api") }, sandbox);
		const task = result.pending.get("TA-041");
		// Step 1 placeholder → "default", Step 2 preseg → "default", Step 2 web stays
		const step1 = task?.stepSegmentMap?.[0]?.segments.map(s => s.repoId);
		expect(step1).toEqual(["default"]);
		const step2 = task?.stepSegmentMap?.[1]?.segments.map(s => s.repoId).sort();
		expect(step2).toEqual(["default", "web"].sort());
	});
});

describe("runDiscovery — post-resolution duplicate segment detection", () => {
	test("SEGMENT_STEP_DUPLICATE_REPO emitted when placeholder collides with explicit repoId", () => {
		// In workspace mode, defaultRepo=api. Pre-segment checkboxes resolve to "api",
		// and an explicit `#### Segment: api` in the same step produces a duplicate.
		const content = [
			"# Task: TA-050 - dup after resolve",
			"",
			"## Steps",
			"### Step 1: mix",
			"- [ ] preseg item",
			"#### Segment: api",
			"- [ ] api item",
			"",
		].join("\n");
		const dir = writeTask("api/TA-050", "TA-050", "");
		writeFileSync(join(dir, "PROMPT.md"), content, "utf-8");
		const result = runDiscovery("api", { api: area("api") }, sandbox, {
			workspaceConfig: wsConfig(repos("api", "web"), "api"),
		});
		expect(result.errors.some(e => e.code === "SEGMENT_STEP_DUPLICATE_REPO")).toBe(true);
	});
});
