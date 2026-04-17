/**
 * Unit tests for resolveTaskRouting — ported from taskplane discovery.ts:1431-1600.
 *
 * Covers the 4-stage precedence chain (prompt → area → file-scope → default),
 * strict routing, explicit segment DAG validation, unknown repo detection,
 * and step-segment placeholder resolution with "Did you mean" suggestions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	DiscoveryResult,
	ParsedTask,
	StepSegmentMapping,
	TaskArea,
	WorkspaceConfig,
	WorkspaceRepoConfig,
} from "../src/missioncontrol";
import { resolveTaskRouting, SEGMENT_FALLBACK_REPO_PLACEHOLDER } from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-routing-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function repos(...ids: string[]): Map<string, WorkspaceRepoConfig> {
	const m = new Map<string, WorkspaceRepoConfig>();
	for (const id of ids) m.set(id, { id, path: `/dummy/${id}` });
	return m;
}

function config(opts: {
	repos: Map<string, WorkspaceRepoConfig>;
	defaultRepo?: string;
	strict?: boolean;
}): WorkspaceConfig {
	return {
		mode: "workspace",
		repos: opts.repos,
		routing: {
			tasksRoot: "tasks",
			defaultRepo: opts.defaultRepo ?? "",
			taskPacketRepo: "api",
			strict: opts.strict,
		},
		configPath: "/dummy/workspace.yaml",
	};
}

function task(overrides: Partial<ParsedTask> & { taskId: string }): ParsedTask {
	const { taskId, ...rest } = overrides;
	return {
		taskId,
		taskName: taskId,
		folderPath: join(sandbox, taskId),
		promptPath: join(sandbox, taskId, "PROMPT.md"),
		prompt: `# Task: ${taskId} - seed\n`,
		dependencies: [],
		size: "M",
		...rest,
	};
}

function registry(...tasks: ParsedTask[]): DiscoveryResult {
	const pending = new Map<string, ParsedTask>();
	for (const t of tasks) pending.set(t.taskId, t);
	return { pending, completed: new Set(), errors: [] };
}

function area(overrides: Partial<TaskArea> = {}): TaskArea {
	return { path: "tasks/api", prefix: "TA", context: "test", ...overrides };
}

describe("resolveTaskRouting — precedence chain", () => {
	test("precedence 1: task.promptRepoId wins", () => {
		const t = task({ taskId: "TA-001", promptRepoId: "api", areaName: "api" });
		const errors = resolveTaskRouting(
			registry(t),
			{ api: area({ repoId: "web" }) },
			config({ repos: repos("api", "web"), defaultRepo: "web" }),
		);
		expect(errors).toEqual([]);
		expect(t.resolvedRepoId).toBe("api");
	});

	test("precedence 2: taskArea.repoId used when no prompt-declared repo", () => {
		const t = task({ taskId: "TA-002", areaName: "api" });
		resolveTaskRouting(
			registry(t),
			{ api: area({ repoId: "web" }) },
			config({ repos: repos("api", "web"), defaultRepo: "api" }),
		);
		expect(t.resolvedRepoId).toBe("web");
	});

	test("precedence 3: file scope majority vote picks the repo", () => {
		const t = task({
			taskId: "TA-003",
			areaName: "api",
			fileScope: ["web-client/src/a.ts", "web-client/src/b.ts", "api/x.ts"],
		});
		resolveTaskRouting(
			registry(t),
			{ api: area() },
			config({ repos: repos("api", "web-client"), defaultRepo: "api" }),
		);
		expect(t.resolvedRepoId).toBe("web-client");
	});

	test("precedence 4: workspace defaultRepo used when nothing else matches", () => {
		const t = task({ taskId: "TA-004", areaName: "api" });
		resolveTaskRouting(registry(t), { api: area() }, config({ repos: repos("api", "web"), defaultRepo: "api" }));
		expect(t.resolvedRepoId).toBe("api");
	});
});

describe("resolveTaskRouting — validation errors", () => {
	test("TASK_REPO_UNRESOLVED when nothing resolves and no default", () => {
		const t = task({ taskId: "TA-010", areaName: "api" });
		const errors = resolveTaskRouting(registry(t), { api: area() }, config({ repos: repos("api", "web") }));
		expect(errors[0]?.code).toBe("TASK_REPO_UNRESOLVED");
	});

	test("TASK_REPO_UNKNOWN when resolved ID is not in workspace repos", () => {
		const t = task({ taskId: "TA-011", promptRepoId: "ghost", areaName: "api" });
		const errors = resolveTaskRouting(
			registry(t),
			{ api: area() },
			config({ repos: repos("api", "web"), defaultRepo: "api" }),
		);
		expect(errors[0]?.code).toBe("TASK_REPO_UNKNOWN");
		expect(errors[0]?.message).toContain("ghost");
		expect(errors[0]?.message).toContain("via prompt");
	});

	test("TASK_ROUTING_STRICT when strict mode set and no promptRepoId", () => {
		const t = task({ taskId: "TA-012", areaName: "api" });
		const errors = resolveTaskRouting(
			registry(t),
			{ api: area({ repoId: "api" }) },
			config({ repos: repos("api"), defaultRepo: "api", strict: true }),
		);
		expect(errors[0]?.code).toBe("TASK_ROUTING_STRICT");
	});

	test("SEGMENT_REPO_UNKNOWN when explicitSegmentDag references unknown repo", () => {
		const t = task({
			taskId: "TA-013",
			areaName: "api",
			explicitSegmentDag: { repoIds: ["api", "ghost"], edges: [] },
		});
		const errors = resolveTaskRouting(
			registry(t),
			{ api: area() },
			config({ repos: repos("api"), defaultRepo: "api" }),
		);
		const err = errors.find(e => e.code === "SEGMENT_REPO_UNKNOWN");
		expect(err?.message).toContain("ghost");
	});
});

describe("resolveTaskRouting — step-segment resolution", () => {
	function stepMap(segments: { repoId: string; checkboxes: string[] }[]): StepSegmentMapping[] {
		return [{ stepNumber: 1, stepName: "seed", segments }];
	}

	test("replaces placeholder segments with resolved primary repoId", () => {
		const t = task({
			taskId: "TA-020",
			promptRepoId: "api",
			areaName: "api",
			stepSegmentMap: stepMap([{ repoId: SEGMENT_FALLBACK_REPO_PLACEHOLDER, checkboxes: ["step A"] }]),
		});
		const errors = resolveTaskRouting(
			registry(t),
			{ api: area() },
			config({ repos: repos("api", "web"), defaultRepo: "api" }),
		);
		expect(errors).toEqual([]);
		expect(t.stepSegmentMap?.[0]?.segments[0]?.repoId).toBe("api");
	});

	test("SEGMENT_STEP_REPO_INVALID when segment references unknown repo + suggests match", () => {
		const t = task({
			taskId: "TA-021",
			promptRepoId: "api",
			areaName: "api",
			stepSegmentMap: stepMap([{ repoId: "web-clien", checkboxes: ["step A"] }]),
		});
		const errors = resolveTaskRouting(
			registry(t),
			{ api: area() },
			config({ repos: repos("api", "web-client"), defaultRepo: "api" }),
		);
		const err = errors.find(e => e.code === "SEGMENT_STEP_REPO_INVALID");
		expect(err?.message).toContain("web-clien");
		expect(err?.message).toContain("Did you mean: web-client");
	});

	test("valid explicit segment repos are kept unchanged", () => {
		const t = task({
			taskId: "TA-022",
			promptRepoId: "api",
			areaName: "api",
			stepSegmentMap: stepMap([{ repoId: "web", checkboxes: ["s"] }]),
		});
		const errors = resolveTaskRouting(
			registry(t),
			{ api: area() },
			config({ repos: repos("api", "web"), defaultRepo: "api" }),
		);
		expect(errors).toEqual([]);
		expect(t.stepSegmentMap?.[0]?.segments[0]?.repoId).toBe("web");
	});
});
