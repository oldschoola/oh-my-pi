import { describe, expect, test } from "bun:test";

import type { ParsedTask } from "../src/missioncontrol/discovery";
import { applyFileScopeAffinity, buildDependencyGraph, computeWaves, validateGraph } from "../src/missioncontrol/waves";

function mkTask(taskId: string, dependencies: string[] = [], fileScope?: string[]): ParsedTask {
	const t: ParsedTask = {
		taskId,
		taskName: taskId.toLowerCase(),
		folderPath: `/repo/tasks/${taskId}`,
		promptPath: `/repo/tasks/${taskId}/PROMPT.md`,
		prompt: "",
		dependencies,
		size: "M",
	};
	if (fileScope) t.fileScope = fileScope;
	return t;
}

function mkPending(tasks: ParsedTask[]): Map<string, ParsedTask> {
	const map = new Map<string, ParsedTask>();
	for (const t of tasks) map.set(t.taskId, t);
	return map;
}

describe("buildDependencyGraph", () => {
	test("empty pending map returns empty graph", () => {
		const g = buildDependencyGraph(new Map(), new Set());
		expect(g.nodes.size).toBe(0);
		expect(g.dependencies.size).toBe(0);
		expect(g.dependents.size).toBe(0);
	});

	test("isolated tasks create nodes with empty adjacency", () => {
		const g = buildDependencyGraph(mkPending([mkTask("T-1"), mkTask("T-2")]), new Set());
		expect([...g.nodes].sort()).toEqual(["T-1", "T-2"]);
		expect(g.dependencies.get("T-1")).toEqual([]);
		expect(g.dependents.get("T-2")).toEqual([]);
	});

	test("pending→pending dependency creates forward + reverse edges", () => {
		const g = buildDependencyGraph(mkPending([mkTask("T-1"), mkTask("T-2", ["T-1"])]), new Set());
		expect(g.dependencies.get("T-2")).toEqual(["T-1"]);
		expect(g.dependents.get("T-1")).toEqual(["T-2"]);
	});

	test("completed-only dependency is pre-satisfied (no edge)", () => {
		const g = buildDependencyGraph(mkPending([mkTask("T-2", ["T-1"])]), new Set(["T-1"]));
		expect(g.dependencies.get("T-2")).toEqual([]);
		expect(g.nodes.has("T-1")).toBe(false);
	});

	test("duplicate dependency reference dedupes via edge set", () => {
		const g = buildDependencyGraph(mkPending([mkTask("T-1"), mkTask("T-2", ["T-1", "T-1"])]), new Set());
		expect(g.dependencies.get("T-2")).toEqual(["T-1"]);
		expect(g.dependents.get("T-1")).toEqual(["T-2"]);
	});
});

describe("validateGraph", () => {
	test("valid linear chain has no errors", () => {
		const pending = mkPending([mkTask("T-1"), mkTask("T-2", ["T-1"]), mkTask("T-3", ["T-2"])]);
		const graph = buildDependencyGraph(pending, new Set());
		const result = validateGraph(graph, pending, new Set());
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test("self-edge produces DEP_UNRESOLVED", () => {
		const pending = mkPending([mkTask("T-1", ["T-1"])]);
		const graph = buildDependencyGraph(pending, new Set());
		const result = validateGraph(graph, pending, new Set());
		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.message.includes("self-dependency"))).toBe(true);
	});

	test("duplicate dep target produces DEP_UNRESOLVED", () => {
		const pending = mkPending([mkTask("T-1"), mkTask("T-2", ["T-1", "T-1"])]);
		const graph = buildDependencyGraph(pending, new Set());
		const result = validateGraph(graph, pending, new Set());
		expect(result.errors.some(e => e.message.includes("duplicate dependency"))).toBe(true);
	});

	test("missing target (not pending, not completed) produces DEP_UNRESOLVED", () => {
		const pending = mkPending([mkTask("T-1", ["T-99"])]);
		const graph = buildDependencyGraph(pending, new Set());
		const result = validateGraph(graph, pending, new Set());
		expect(result.errors.some(e => e.message.includes("T-99"))).toBe(true);
	});

	test("completed target is resolved (no error)", () => {
		const pending = mkPending([mkTask("T-2", ["T-1"])]);
		const graph = buildDependencyGraph(pending, new Set(["T-1"]));
		const result = validateGraph(graph, pending, new Set(["T-1"]));
		expect(result.valid).toBe(true);
	});

	test("two-node cycle is detected", () => {
		const pending = mkPending([mkTask("T-1", ["T-2"]), mkTask("T-2", ["T-1"])]);
		const graph = buildDependencyGraph(pending, new Set());
		const result = validateGraph(graph, pending, new Set());
		expect(result.valid).toBe(false);
		const cycleErr = result.errors.find(e => e.message.includes("Circular dependency"));
		expect(cycleErr).toBeDefined();
		expect(cycleErr?.message).toContain("→");
	});

	test("three-node cycle detected with full path", () => {
		const pending = mkPending([mkTask("T-1", ["T-3"]), mkTask("T-2", ["T-1"]), mkTask("T-3", ["T-2"])]);
		const graph = buildDependencyGraph(pending, new Set());
		const result = validateGraph(graph, pending, new Set());
		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.message.includes("Circular dependency"))).toBe(true);
	});
});

describe("computeWaves", () => {
	test("empty graph produces empty wave list", () => {
		const graph = buildDependencyGraph(new Map(), new Set());
		const { waves, errors } = computeWaves(graph, new Set(), new Map());
		expect(waves).toEqual([]);
		expect(errors).toHaveLength(0);
	});

	test("all-independent tasks form one wave", () => {
		const pending = mkPending([mkTask("T-2"), mkTask("T-1"), mkTask("T-3")]);
		const graph = buildDependencyGraph(pending, new Set());
		const { waves, errors } = computeWaves(graph, new Set(), pending);
		expect(errors).toHaveLength(0);
		expect(waves).toEqual([["T-1", "T-2", "T-3"]]);
	});

	test("linear chain produces one task per wave in order", () => {
		const pending = mkPending([mkTask("T-3", ["T-2"]), mkTask("T-2", ["T-1"]), mkTask("T-1")]);
		const graph = buildDependencyGraph(pending, new Set());
		const { waves, errors } = computeWaves(graph, new Set(), pending);
		expect(errors).toHaveLength(0);
		expect(waves).toEqual([["T-1"], ["T-2"], ["T-3"]]);
	});

	test("diamond: A → B,C → D", () => {
		const pending = mkPending([mkTask("A"), mkTask("B", ["A"]), mkTask("C", ["A"]), mkTask("D", ["B", "C"])]);
		const graph = buildDependencyGraph(pending, new Set());
		const { waves, errors } = computeWaves(graph, new Set(), pending);
		expect(errors).toHaveLength(0);
		expect(waves).toEqual([["A"], ["B", "C"], ["D"]]);
	});

	test("cycle produces DEP_UNRESOLVED error", () => {
		const pending = mkPending([mkTask("T-1", ["T-2"]), mkTask("T-2", ["T-1"])]);
		const graph = buildDependencyGraph(pending, new Set());
		const { errors } = computeWaves(graph, new Set(), pending);
		expect(errors.some(e => e.message.includes("possible cycle"))).toBe(true);
	});

	test("completed deps are treated as pre-satisfied", () => {
		const pending = mkPending([mkTask("T-2", ["T-1"])]);
		const graph = buildDependencyGraph(pending, new Set(["T-1"]));
		const { waves, errors } = computeWaves(graph, new Set(["T-1"]), pending);
		expect(errors).toHaveLength(0);
		expect(waves).toEqual([["T-2"]]);
	});

	test("within wave, task IDs are sorted alphabetically", () => {
		const pending = mkPending([mkTask("Z-1"), mkTask("A-1"), mkTask("M-1")]);
		const graph = buildDependencyGraph(pending, new Set());
		const { waves } = computeWaves(graph, new Set(), pending);
		expect(waves[0]).toEqual(["A-1", "M-1", "Z-1"]);
	});
});

describe("applyFileScopeAffinity", () => {
	test("empty input returns empty list", () => {
		expect(applyFileScopeAffinity([], new Map())).toEqual([]);
	});

	test("tasks with no file scope are each their own group", () => {
		const pending = mkPending([mkTask("T-1"), mkTask("T-2")]);
		const groups = applyFileScopeAffinity(["T-1", "T-2"], pending);
		expect(groups).toEqual([["T-1"], ["T-2"]]);
	});

	test("tasks with disjoint file scopes are independent groups", () => {
		const pending = mkPending([mkTask("T-1", [], ["src/api/**"]), mkTask("T-2", [], ["src/web/**"])]);
		const groups = applyFileScopeAffinity(["T-1", "T-2"], pending);
		expect(groups).toEqual([["T-1"], ["T-2"]]);
	});

	test("tasks with overlapping globs merge into one group", () => {
		const pending = mkPending([mkTask("T-1", [], ["src/api/**"]), mkTask("T-2", [], ["src/api/users.ts"])]);
		const groups = applyFileScopeAffinity(["T-1", "T-2"], pending);
		expect(groups).toEqual([["T-1", "T-2"]]);
	});

	test("transitive overlap A~B, B~C forms single group", () => {
		const pending = mkPending([
			mkTask("T-A", [], ["src/mod/a.ts"]),
			mkTask("T-B", [], ["src/mod/**"]),
			mkTask("T-C", [], ["src/mod/c.ts"]),
		]);
		const groups = applyFileScopeAffinity(["T-A", "T-B", "T-C"], pending);
		expect(groups).toEqual([["T-A", "T-B", "T-C"]]);
	});

	test("groups sorted by their first (sorted) task ID", () => {
		const pending = mkPending([
			mkTask("B-1", [], ["b/**"]),
			mkTask("B-2", [], ["b/file.ts"]),
			mkTask("A-1", [], ["a/**"]),
		]);
		const groups = applyFileScopeAffinity(["B-1", "B-2", "A-1"], pending);
		expect(groups).toEqual([["A-1"], ["B-1", "B-2"]]);
	});
});
