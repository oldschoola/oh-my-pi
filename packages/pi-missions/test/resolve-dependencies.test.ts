/**
 * Unit tests for findDependencyCandidates + resolveDependencies — the
 * cross-area dep resolver ported from taskplane discovery.ts:1251-1408.
 *
 * Covers:
 *  - Candidate scanning: qualified vs unqualified, archive vs active,
 *    status (complete via .DONE), multi-area aggregation, area filter
 *  - resolveDependencies: registry-satisfied unqualified, registry-satisfied
 *    area-qualified, filesystem-complete promotion, DEP_UNRESOLVED,
 *    DEP_AMBIGUOUS (unqualified multi-match + qualified multi-match),
 *    DEP_PENDING with hint text
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveryResult, ParsedTask, TaskArea } from "../src/missioncontrol";
import {
	buildTaskRegistry,
	findDependencyCandidates,
	parseDependencyReference,
	resolveDependencies,
} from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-deps-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function area(path: string): TaskArea {
	return { path, prefix: "TA", context: "test" };
}

function writeTask(relDir: string, taskId: string, extra = ""): string {
	const dir = join(sandbox, relDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "PROMPT.md"), `# Task: ${taskId} - seed\n${extra}`, "utf-8");
	return dir;
}

function markDone(dir: string): void {
	writeFileSync(join(dir, ".DONE"), "", "utf-8");
}

describe("findDependencyCandidates", () => {
	test("returns empty when no areas configured", () => {
		const candidates = findDependencyCandidates(parseDependencyReference("TA-001"), {}, sandbox);
		expect(candidates).toEqual([]);
	});

	test("finds a matching active task in a single area", () => {
		const dir = writeTask("api/TA-001-seed", "TA-001");
		const candidates = findDependencyCandidates(parseDependencyReference("TA-001"), { api: area("api") }, sandbox);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toEqual({ areaName: "api", path: dir, status: "pending" });
	});

	test("marks .DONE folders as complete", () => {
		const dir = writeTask("api/TA-002-done", "TA-002");
		markDone(dir);
		const candidates = findDependencyCandidates(parseDependencyReference("TA-002"), { api: area("api") }, sandbox);
		expect(candidates[0]?.status).toBe("complete");
	});

	test("area-qualified ref skips non-matching areas", () => {
		writeTask("api/TA-003", "TA-003");
		writeTask("web/TA-003", "TA-003");
		const candidates = findDependencyCandidates(
			parseDependencyReference("web/TA-003"),
			{ api: area("api"), web: area("web") },
			sandbox,
		);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.areaName).toBe("web");
	});

	test("unqualified ref aggregates candidates across multiple areas", () => {
		writeTask("api/TA-004", "TA-004");
		writeTask("web/TA-004", "TA-004");
		const candidates = findDependencyCandidates(
			parseDependencyReference("TA-004"),
			{ api: area("api"), web: area("web") },
			sandbox,
		);
		expect(candidates.map(c => c.areaName).sort()).toEqual(["api", "web"]);
	});

	test("archive folders are only returned when .DONE present", () => {
		const dir = join(sandbox, "api", "archive", "TA-005-wip");
		mkdirSync(dir, { recursive: true });
		// No .DONE → still returned but status=pending
		const pending = findDependencyCandidates(parseDependencyReference("TA-005"), { api: area("api") }, sandbox);
		expect(pending[0]?.status).toBe("pending");

		markDone(dir);
		const complete = findDependencyCandidates(parseDependencyReference("TA-005"), { api: area("api") }, sandbox);
		expect(complete[0]?.status).toBe("complete");
	});

	test("active entry named 'archive' is skipped (reserved folder name)", () => {
		mkdirSync(join(sandbox, "api", "archive"), { recursive: true });
		const candidates = findDependencyCandidates(parseDependencyReference("TA-006"), { api: area("api") }, sandbox);
		expect(candidates).toEqual([]);
	});

	test("missing area directory is silently skipped", () => {
		const candidates = findDependencyCandidates(parseDependencyReference("TA-007"), { api: area("api") }, sandbox);
		expect(candidates).toEqual([]);
	});
});

describe("resolveDependencies", () => {
	function makeRegistry(tasks: ParsedTask[]): DiscoveryResult {
		const pending = new Map<string, ParsedTask>();
		for (const t of tasks) pending.set(t.taskId, t);
		return { pending, completed: new Set(), errors: [] };
	}

	function taskStub(taskId: string, deps: string[], areaName = "api"): ParsedTask {
		return {
			taskId,
			taskName: taskId,
			folderPath: join(sandbox, areaName, taskId),
			promptPath: join(sandbox, areaName, taskId, "PROMPT.md"),
			prompt: `# Task: ${taskId} - seed\n`,
			dependencies: deps,
			size: "M",
			areaName,
		};
	}

	test("unqualified dep resolved in-registry yields no errors", () => {
		const registry = makeRegistry([taskStub("TA-001", []), taskStub("TA-002", ["TA-001"])]);
		const errors = resolveDependencies(registry, { api: area("api") }, sandbox);
		expect(errors).toEqual([]);
	});

	test("unqualified dep already in completed set yields no errors", () => {
		const registry = makeRegistry([taskStub("TA-002", ["TA-001"])]);
		registry.completed.add("TA-001");
		const errors = resolveDependencies(registry, { api: area("api") }, sandbox);
		expect(errors).toEqual([]);
	});

	test("area-qualified dep resolved in-registry by matching area yields no errors", () => {
		const registry = makeRegistry([taskStub("TA-001", [], "api"), taskStub("TA-002", ["api/TA-001"], "api")]);
		const errors = resolveDependencies(registry, { api: area("api") }, sandbox);
		expect(errors).toEqual([]);
	});

	test("dep missing from everywhere yields DEP_UNRESOLVED", () => {
		const registry = makeRegistry([taskStub("TA-002", ["TA-999"])]);
		const errors = resolveDependencies(registry, { api: area("api") }, sandbox);
		expect(errors[0]?.code).toBe("DEP_UNRESOLVED");
		expect(errors[0]?.message).toContain("TA-999");
	});

	test("dep found complete on filesystem is added to completed set", () => {
		const done = writeTask("api/TA-001-done", "TA-001");
		markDone(done);
		const registry = makeRegistry([taskStub("TA-002", ["TA-001"])]);
		const errors = resolveDependencies(registry, { api: area("api") }, sandbox);
		expect(errors).toEqual([]);
		expect(registry.completed.has("TA-001")).toBe(true);
	});

	test("unqualified dep with multi-area matches yields DEP_AMBIGUOUS", () => {
		writeTask("api/TA-001-seed", "TA-001");
		writeTask("web/TA-001-seed", "TA-001");
		const registry = makeRegistry([taskStub("TA-002", ["TA-001"], "api")]);
		const errors = resolveDependencies(registry, { api: area("api"), web: area("web") }, sandbox);
		const ambiguous = errors.find(e => e.code === "DEP_AMBIGUOUS");
		expect(ambiguous?.message).toContain("multiple tasks match across areas");
	});

	test("qualified dep pending in another area yields DEP_PENDING with hint", () => {
		writeTask("web/TA-050-seed", "TA-050");
		const registry = makeRegistry([taskStub("TA-002", ["web/TA-050"], "api")]);
		const errors = resolveDependencies(registry, { api: area("api"), web: area("web") }, sandbox);
		const pending = errors.find(e => e.code === "DEP_PENDING");
		expect(pending?.message).toContain('pending in "web"');
		expect(pending?.message).toContain("/mission web");
	});

	test("qualified dep with duplicate folders in same area yields DEP_AMBIGUOUS", () => {
		writeTask("api/TA-070-one", "TA-070");
		writeTask("api/TA-070-two", "TA-070");
		const registry = makeRegistry([taskStub("TA-002", ["api/TA-070"], "web")]);
		const errors = resolveDependencies(registry, { api: area("api"), web: area("web") }, sandbox);
		const ambiguous = errors.find(e => e.code === "DEP_AMBIGUOUS");
		expect(ambiguous?.message).toContain("Resolve duplicate task IDs");
	});

	test("integration: uses buildTaskRegistry output as input", () => {
		const doneDir = writeTask("api/TA-001-done", "TA-001");
		markDone(doneDir);
		writeTask("api/TA-002-seed", "TA-002", "\n## Dependencies\n- TA-001\n");
		const registry = buildTaskRegistry([join(sandbox, "api")], [], { api: area("api") }, sandbox);
		const errors = resolveDependencies(registry, { api: area("api") }, sandbox);
		expect(errors).toEqual([]);
		expect(registry.completed.has("TA-001")).toBe(true);
		expect(registry.pending.has("TA-002")).toBe(true);
	});
});
