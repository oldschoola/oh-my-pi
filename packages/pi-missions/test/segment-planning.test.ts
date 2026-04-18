import { describe, expect, test } from "bun:test";

import type { ParsedTask } from "../src/missioncontrol/discovery";
import type { PromptSegmentDagMetadata } from "../src/missioncontrol/types";
import { buildSegmentPlanForTask, buildTaskSegmentPlans, inferTaskRepoOrder } from "../src/missioncontrol/waves";

function mkTask(opts: {
	taskId: string;
	dependencies?: string[];
	fileScope?: string[];
	resolvedRepoId?: string;
	explicitSegmentDag?: PromptSegmentDagMetadata;
}): ParsedTask {
	const t: ParsedTask = {
		taskId: opts.taskId,
		taskName: opts.taskId.toLowerCase(),
		folderPath: `/repo/tasks/${opts.taskId}`,
		promptPath: `/repo/tasks/${opts.taskId}/PROMPT.md`,
		prompt: "",
		dependencies: opts.dependencies ?? [],
		size: "M",
	};
	if (opts.fileScope) t.fileScope = opts.fileScope;
	if (opts.resolvedRepoId) t.resolvedRepoId = opts.resolvedRepoId;
	if (opts.explicitSegmentDag) t.explicitSegmentDag = opts.explicitSegmentDag;
	return t;
}

function mkPending(tasks: ParsedTask[]): Map<string, ParsedTask> {
	return new Map(tasks.map(t => [t.taskId, t]));
}

describe("inferTaskRepoOrder", () => {
	test("no signal → default singleton with fallback flag", () => {
		const task = mkTask({ taskId: "T-1" });
		const result = inferTaskRepoOrder(task, mkPending([task]), new Set());
		expect(result.usedFallback).toBe(true);
		expect(result.repoIds).toEqual(["default"]);
	});

	test("no signal but resolvedRepoId → singleton with that repoId", () => {
		const task = mkTask({ taskId: "T-1", resolvedRepoId: "web" });
		const result = inferTaskRepoOrder(task, mkPending([task]), new Set());
		expect(result.usedFallback).toBe(true);
		expect(result.repoIds).toEqual(["web"]);
	});

	test("file scope repo prefix counts as primary signal (requires known repos)", () => {
		const task = mkTask({ taskId: "T-1", fileScope: ["web/src/index.ts"] });
		const result = inferTaskRepoOrder(task, mkPending([task]), new Set(["web"]));
		expect(result.usedFallback).toBe(false);
		expect(result.repoIds).toEqual(["web"]);
	});

	test("file scope is ignored when knownRepoIds is empty (repo-mode guard)", () => {
		const task = mkTask({ taskId: "T-1", fileScope: ["web/src/index.ts"] });
		const result = inferTaskRepoOrder(task, mkPending([task]), new Set());
		expect(result.usedFallback).toBe(true);
		expect(result.repoIds).toEqual(["default"]);
	});

	test("dependency repo contributes to ordering", () => {
		const depTask = mkTask({ taskId: "T-DEP", resolvedRepoId: "api" });
		const task = mkTask({ taskId: "T-1", dependencies: ["T-DEP"], resolvedRepoId: "web" });
		const pending = mkPending([task, depTask]);
		const result = inferTaskRepoOrder(task, pending, new Set(["api", "web"]));
		expect(result.usedFallback).toBe(false);
		expect(result.repoIds).toEqual(["api", "web"]);
	});

	test("first-appearance order preserved across multi-signal mix", () => {
		const depTask = mkTask({ taskId: "T-DEP", resolvedRepoId: "db" });
		const task = mkTask({
			taskId: "T-1",
			fileScope: ["web/index.ts", "api/handler.ts"],
			dependencies: ["T-DEP"],
		});
		const pending = mkPending([task, depTask]);
		const result = inferTaskRepoOrder(task, pending, new Set(["web", "api", "db"]));
		expect(result.usedFallback).toBe(false);
		expect(result.repoIds).toEqual(["web", "api", "db"]);
	});

	test("duplicate file scope entries don't produce duplicate repos", () => {
		const task = mkTask({ taskId: "T-1", fileScope: ["web/a.ts", "web/b.ts"] });
		const result = inferTaskRepoOrder(task, mkPending([task]), new Set(["web"]));
		expect(result.repoIds).toEqual(["web"]);
	});

	test("unknown repo prefix is rejected (requireKnown filter)", () => {
		const task = mkTask({ taskId: "T-1", fileScope: ["bogus/file.ts"] });
		const result = inferTaskRepoOrder(task, mkPending([task]), new Set(["web"]));
		expect(result.usedFallback).toBe(true);
		expect(result.repoIds).toEqual(["default"]);
	});
});

describe("buildSegmentPlanForTask", () => {
	test("explicit DAG takes precedence with mode explicit-dag", () => {
		const task = mkTask({
			taskId: "T-1",
			explicitSegmentDag: {
				repoIds: ["web", "api"],
				edges: [{ fromRepoId: "web", toRepoId: "api" }],
			},
		});
		const plan = buildSegmentPlanForTask(task, mkPending([task]), new Set(["web", "api"]));
		expect(plan.mode).toBe("explicit-dag");
		expect(plan.segments.map(s => s.repoId)).toEqual(["web", "api"]);
		expect(plan.edges).toHaveLength(1);
		expect(plan.edges[0]?.provenance).toBe("explicit");
		expect(plan.edges[0]?.reason).toBe("prompt:segment-dag");
	});

	test("no signal → repo-singleton mode with one segment, no edges", () => {
		const task = mkTask({ taskId: "T-1" });
		const plan = buildSegmentPlanForTask(task, mkPending([task]), new Set());
		expect(plan.mode).toBe("repo-singleton");
		expect(plan.segments).toHaveLength(1);
		expect(plan.segments[0]?.repoId).toBe("default");
		expect(plan.edges).toHaveLength(0);
	});

	test("inferred multi-repo → linear chain with inferred edges", () => {
		const task = mkTask({ taskId: "T-1", fileScope: ["web/x.ts", "api/y.ts"] });
		const plan = buildSegmentPlanForTask(task, mkPending([task]), new Set(["web", "api"]));
		expect(plan.mode).toBe("inferred-sequential");
		expect(plan.segments.map(s => s.repoId)).toEqual(["web", "api"]);
		expect(plan.edges).toHaveLength(1);
		expect(plan.edges[0]?.provenance).toBe("inferred");
		expect(plan.edges[0]?.reason).toBe("inferred:first-appearance-linear-chain");
	});

	test("segment IDs use taskId::repoId format", () => {
		const task = mkTask({ taskId: "T-1", fileScope: ["web/x.ts"] });
		const plan = buildSegmentPlanForTask(task, mkPending([task]), new Set(["web"]));
		expect(plan.segments[0]?.segmentId).toBe("T-1::web");
	});
});

describe("buildTaskSegmentPlans", () => {
	test("builds a plan for each pending task in sorted order", () => {
		const tA = mkTask({ taskId: "T-A" });
		const tB = mkTask({ taskId: "T-B" });
		const plans = buildTaskSegmentPlans(mkPending([tB, tA]));
		expect([...plans.keys()]).toEqual(["T-A", "T-B"]);
	});

	test("uses workspaceRepoIds option to validate file scope prefixes", () => {
		const task = mkTask({ taskId: "T-1", fileScope: ["web/x.ts"] });
		const plans = buildTaskSegmentPlans(mkPending([task]), { workspaceRepoIds: ["web"] });
		const plan = plans.get("T-1");
		expect(plan?.mode).toBe("inferred-sequential");
		expect(plan?.segments.map(s => s.repoId)).toEqual(["web"]);
	});

	test("empty pending map produces empty plan map", () => {
		const plans = buildTaskSegmentPlans(new Map());
		expect(plans.size).toBe(0);
	});
});
