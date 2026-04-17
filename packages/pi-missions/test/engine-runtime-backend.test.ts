/**
 * Unit tests for `selectRuntimeBackend` — TP-105 scope guard.
 *
 * TP-108/TP-109 forced `backend` to `"v2"` unconditionally, so the assertions
 * focus on the auxiliary flags (single-task, repo-mode, direct-PROMPT target).
 */

import { describe, expect, test } from "bun:test";

import { selectRuntimeBackend } from "../src/missioncontrol/execution";
import type { WorkspaceConfig, WorkspaceMode, WorkspaceRoutingConfig } from "../src/missioncontrol/types";

function makeWorkspaceConfig(mode: WorkspaceMode = "workspace"): WorkspaceConfig {
	const routing: WorkspaceRoutingConfig = {
		tasksRoot: "packets",
		defaultRepo: "primary",
		taskPacketRepo: "primary",
		strict: false,
	};
	return {
		mode,
		repos: new Map(),
		routing,
		configPath: "/tmp/.omp/mission.json",
	};
}

describe("selectRuntimeBackend", () => {
	test("single-task single-wave in repo mode with PROMPT.md arg: all flags true", () => {
		const sel = selectRuntimeBackend("packets/foo/PROMPT.md", [["TP-001"]]);
		expect(sel.backend).toBe("v2");
		expect(sel.isSingleTask).toBe(true);
		expect(sel.isRepoMode).toBe(true);
		expect(sel.isDirectPromptTarget).toBe(true);
	});

	test("backend is always 'v2' (TP-108/TP-109)", () => {
		const sel = selectRuntimeBackend("all", [["TP-001"], ["TP-002"]], makeWorkspaceConfig());
		expect(sel.backend).toBe("v2");
	});

	test("workspace mode: isRepoMode is false", () => {
		const sel = selectRuntimeBackend("all", [["TP-001"]], makeWorkspaceConfig());
		expect(sel.isRepoMode).toBe(false);
	});

	test("multi-wave: isSingleTask is false", () => {
		const sel = selectRuntimeBackend("all", [["TP-001"], ["TP-002"]]);
		expect(sel.isSingleTask).toBe(false);
	});

	test("multi-task in one wave: isSingleTask is false", () => {
		const sel = selectRuntimeBackend("all", [["TP-001", "TP-002"]]);
		expect(sel.isSingleTask).toBe(false);
	});

	test("empty waves: isSingleTask is false", () => {
		const sel = selectRuntimeBackend("all", []);
		expect(sel.isSingleTask).toBe(false);
	});

	test("empty args: isDirectPromptTarget is false", () => {
		const sel = selectRuntimeBackend("", [["TP-001"]]);
		expect(sel.isDirectPromptTarget).toBe(false);
	});

	test("multi-token args: isDirectPromptTarget is false even when one is PROMPT.md", () => {
		const sel = selectRuntimeBackend("areas/a packets/b/PROMPT.md", [["TP-001"]]);
		expect(sel.isDirectPromptTarget).toBe(false);
	});

	test("case-insensitive PROMPT.md match", () => {
		const sel = selectRuntimeBackend("pkts/foo/prompt.MD", [["TP-001"]]);
		expect(sel.isDirectPromptTarget).toBe(true);
	});

	test("whitespace normalization around single PROMPT.md arg", () => {
		const sel = selectRuntimeBackend("   pkts/foo/PROMPT.md   ", [["TP-001"]]);
		expect(sel.isDirectPromptTarget).toBe(true);
	});

	test("non-PROMPT arg is not a direct target", () => {
		const sel = selectRuntimeBackend("all", [["TP-001"]]);
		expect(sel.isDirectPromptTarget).toBe(false);
	});

	test("null workspaceConfig is treated as repo mode", () => {
		const sel = selectRuntimeBackend("all", [["TP-001"]], null);
		expect(sel.isRepoMode).toBe(true);
	});
});
