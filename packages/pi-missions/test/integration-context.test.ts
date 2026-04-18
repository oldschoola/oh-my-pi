/**
 * Unit tests for `resolveIntegrationContext` — drives the pure fan-in
 * logic behind `/mission-integrate` (state → CLI arg → branch scan) plus
 * all the gate checks (phase, legacy merge, missing branch, detached
 * HEAD, branch safety).
 *
 * Deps are injected via plain closures so no git/FS touches happen.
 */

import { describe, expect, test } from "bun:test";

import type { IntegrateArgs } from "../src/missioncontrol/extension-args";
import { resolveIntegrationContext } from "../src/missioncontrol/integration-context";
import type { IntegrationDeps, PersistedBatchState } from "../src/missioncontrol/types";
import { StateFileError } from "../src/missioncontrol/types";

const DEFAULT_ARGS: IntegrateArgs = { mode: "ff", force: false };

function makeState(overrides: Partial<PersistedBatchState> = {}): PersistedBatchState {
	return {
		phase: "completed",
		batchId: "batch-1",
		baseBranch: "main",
		orchBranch: "orch/batch-1",
		lanes: [],
		tasks: [],
		wavePlan: [],
		...overrides,
	};
}

function makeDeps(overrides: Partial<IntegrationDeps> = {}): IntegrationDeps {
	return {
		loadBatchState: () => null,
		getCurrentBranch: () => "main",
		listOrchBranches: () => [],
		orchBranchExists: () => true,
		...overrides,
	};
}

describe("resolveIntegrationContext", () => {
	test("loaded completed state: returns full context, no notices", () => {
		const state = makeState();
		const result = resolveIntegrationContext(DEFAULT_ARGS, makeDeps({ loadBatchState: () => state }));
		expect(result).toEqual({
			orchBranch: "orch/batch-1",
			baseBranch: "main",
			batchId: "batch-1",
			currentBranch: "main",
			notices: [],
		});
	});

	test("phase gate: rejects non-completed batch with info severity and /mission-status hint", () => {
		const state = makeState({ phase: "executing" });
		const result = resolveIntegrationContext(DEFAULT_ARGS, makeDeps({ loadBatchState: () => state }));
		expect("error" in result && result.severity).toBe("info");
		expect("error" in result && result.error).toContain('"executing"');
		expect("error" in result && result.error).toContain("/mission-status");
	});

	test("legacy merge mode: completed batch with empty orchBranch → info rejection", () => {
		const state = makeState({ orchBranch: "" });
		const result = resolveIntegrationContext(DEFAULT_ARGS, makeDeps({ loadBatchState: () => state }));
		expect("error" in result && result.severity).toBe("info");
		expect("error" in result && result.error).toContain("legacy merge mode");
		expect("error" in result && result.error).toContain("main");
	});

	test("state I/O error with no CLI arg → error rejection", () => {
		const deps = makeDeps({
			loadBatchState: () => {
				throw new StateFileError("STATE_FILE_IO_ERROR", "EACCES");
			},
		});
		const result = resolveIntegrationContext(DEFAULT_ARGS, deps);
		expect("error" in result && result.severity).toBe("error");
		expect("error" in result && result.error).toContain("Could not read batch state file");
		expect("error" in result && result.error).toContain("/mission-integrate <mission-branch>");
	});

	test("state parse error with CLI arg fallback → notice + resolved context", () => {
		const deps = makeDeps({
			loadBatchState: () => {
				throw new StateFileError("STATE_FILE_PARSE_ERROR", "unexpected token");
			},
			orchBranchExists: b => b === "orch/fallback",
		});
		const args: IntegrateArgs = { mode: "ff", force: false, orchBranchArg: "orch/fallback" };
		const result = resolveIntegrationContext(args, deps);
		expect("orchBranch" in result).toBe(true);
		if ("orchBranch" in result) {
			expect(result.orchBranch).toBe("orch/fallback");
			expect(result.baseBranch).toBe("main");
			expect(result.notices[0]).toContain("invalid JSON");
		}
	});

	test("state schema error message tagged as invalid schema", () => {
		const deps = makeDeps({
			loadBatchState: () => {
				throw new StateFileError("STATE_SCHEMA_INVALID", "missing field");
			},
		});
		const result = resolveIntegrationContext(DEFAULT_ARGS, deps);
		expect("error" in result && result.error).toContain("invalid schema");
	});

	test("unexpected non-StateFileError bubbles through as 'Unexpected error'", () => {
		const deps = makeDeps({
			loadBatchState: () => {
				throw new Error("boom");
			},
		});
		const result = resolveIntegrationContext(DEFAULT_ARGS, deps);
		expect("error" in result && result.error).toContain("Unexpected error loading batch state");
	});

	test("CLI arg overrides loaded state orchBranch", () => {
		const state = makeState();
		const args: IntegrateArgs = { mode: "ff", force: false, orchBranchArg: "orch/override" };
		const deps = makeDeps({
			loadBatchState: () => state,
			orchBranchExists: b => b === "orch/override",
		});
		const result = resolveIntegrationContext(args, deps);
		expect("orchBranch" in result && result.orchBranch).toBe("orch/override");
	});

	test("scan fallback single candidate → auto-detect with notice", () => {
		const deps = makeDeps({ listOrchBranches: () => ["orch/only"] });
		const result = resolveIntegrationContext(DEFAULT_ARGS, deps);
		expect("orchBranch" in result).toBe(true);
		if ("orchBranch" in result) {
			expect(result.orchBranch).toBe("orch/only");
			expect(result.notices[0]).toContain("Auto-detected mission branch");
		}
	});

	test("scan fallback zero candidates → error with /mission hint", () => {
		const result = resolveIntegrationContext(DEFAULT_ARGS, makeDeps({ listOrchBranches: () => [] }));
		expect("error" in result && result.severity).toBe("error");
		expect("error" in result && result.error).toContain("no mission branches exist");
		expect("error" in result && result.error).toContain("Run /mission first");
	});

	test("scan fallback multiple candidates → error lists all", () => {
		const deps = makeDeps({ listOrchBranches: () => ["orch/a", "orch/b", "orch/c"] });
		const result = resolveIntegrationContext(DEFAULT_ARGS, deps);
		expect("error" in result && result.severity).toBe("error");
		expect("error" in result && result.error).toContain("orch/a");
		expect("error" in result && result.error).toContain("orch/b");
		expect("error" in result && result.error).toContain("orch/c");
	});

	test("branch does not exist locally → error", () => {
		const args: IntegrateArgs = { mode: "ff", force: false, orchBranchArg: "orch/ghost" };
		const deps = makeDeps({ orchBranchExists: () => false });
		const result = resolveIntegrationContext(args, deps);
		expect("error" in result && result.error).toContain('"orch/ghost" does not exist');
	});

	test("detached HEAD → error", () => {
		const args: IntegrateArgs = { mode: "ff", force: false, orchBranchArg: "orch/ok" };
		const deps = makeDeps({ getCurrentBranch: () => null });
		const result = resolveIntegrationContext(args, deps);
		expect("error" in result && result.error).toContain("HEAD is detached");
	});

	test("baseBranch defaults to currentBranch when state absent", () => {
		const args: IntegrateArgs = { mode: "ff", force: false, orchBranchArg: "orch/x" };
		const deps = makeDeps({ getCurrentBranch: () => "develop" });
		const result = resolveIntegrationContext(args, deps);
		expect("baseBranch" in result && result.baseBranch).toBe("develop");
	});

	test("branch safety: mismatched current/base rejects without --force", () => {
		const state = makeState({ baseBranch: "main" });
		const deps = makeDeps({ loadBatchState: () => state, getCurrentBranch: () => "feat/x" });
		const result = resolveIntegrationContext(DEFAULT_ARGS, deps);
		expect("error" in result && result.error).toContain("started from main");
		expect("error" in result && result.error).toContain("you're on feat/x");
		expect("error" in result && result.error).toContain("--force");
	});

	test("branch safety: --force bypasses mismatch", () => {
		const state = makeState({ baseBranch: "main" });
		const deps = makeDeps({ loadBatchState: () => state, getCurrentBranch: () => "feat/x" });
		const args: IntegrateArgs = { mode: "ff", force: true };
		const result = resolveIntegrationContext(args, deps);
		expect("orchBranch" in result).toBe(true);
		if ("orchBranch" in result) {
			expect(result.currentBranch).toBe("feat/x");
			expect(result.baseBranch).toBe("main");
		}
	});
});
