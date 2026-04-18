/**
 * Unit tests for `validateSegmentExpansionRequestAtBoundary` +
 * `processSegmentExpansionRequestAtBoundary` in `missioncontrol/engine-expansion.ts`.
 *
 * Covers the full accept/reject chain: boundary mismatch, terminal status,
 * placement, duplicate requestId, repo validation (workspace + repo mode),
 * duplicate repoIds, edge-endpoint scope (anchor + completed segments), and
 * cycle detection. Also verifies `processSegmentExpansionRequestAtBoundary`
 * mutates `knownRequestIds` only on success.
 */

import { describe, expect, test } from "bun:test";

import {
	processSegmentExpansionRequestAtBoundary,
	validateSegmentExpansionRequestAtBoundary,
} from "../src/missioncontrol/engine-expansion";
import type {
	PendingSegmentExpansionRequest,
	SegmentExpansionEdge,
	SegmentFrontierTaskState,
	SegmentId,
	SegmentLifecycleStatus,
	TaskSegmentNode,
	WorkspaceConfig,
	WorkspaceRepoConfig,
} from "../src/missioncontrol/types";

function segmentId(taskId: string, repoId: string): SegmentId {
	return `${taskId}::${repoId}` as SegmentId;
}

function node(taskId: string, repoId: string, order: number): TaskSegmentNode {
	return { segmentId: segmentId(taskId, repoId), taskId, repoId, order };
}

function makeFrontier(overrides: Partial<SegmentFrontierTaskState> = {}): SegmentFrontierTaskState {
	const defaultSegments = [node("TP-001", "api", 0), node("TP-001", "web", 1)];
	return {
		taskId: "TP-001",
		orderedSegments: defaultSegments,
		nextSegmentIndex: 0,
		statusBySegmentId: new Map<string, SegmentLifecycleStatus>([
			[segmentId("TP-001", "api"), "pending"],
			[segmentId("TP-001", "web"), "pending"],
		]),
		dependsOnBySegmentId: new Map(),
		terminalStatus: "pending",
		...overrides,
	};
}

function makeRequest(opts: {
	requestId?: string;
	taskId?: string;
	from?: SegmentId;
	repos?: string[];
	edges?: SegmentExpansionEdge[];
	placement?: "after-current" | "end" | string;
}): PendingSegmentExpansionRequest {
	return {
		filePath: "/tmp/fake.json",
		request: {
			requestId: opts.requestId ?? "exp-001",
			taskId: opts.taskId ?? "TP-001",
			fromSegmentId: opts.from ?? segmentId("TP-001", "api"),
			requestedRepoIds: opts.repos ?? ["mobile"],
			rationale: "test expansion",
			placement: (opts.placement ?? "after-current") as "after-current" | "end",
			edges: opts.edges ?? [],
			timestamp: 1_700_000_000_000,
		},
	};
}

function makeWorkspace(repoIds: string[]): WorkspaceConfig {
	const repos = new Map<string, WorkspaceRepoConfig>();
	for (const id of repoIds) {
		repos.set(id, { id, path: `/tmp/${id}` });
	}
	return {
		mode: "workspace",
		repos,
		routing: {
			tasksRoot: "/tmp/tasks",
			defaultRepo: repoIds[0] ?? "default",
			taskPacketRepo: repoIds[0] ?? "default",
		},
		configPath: "/tmp/workspace.json",
	};
}

describe("validateSegmentExpansionRequestAtBoundary", () => {
	test("accepts a well-formed request at the active boundary", () => {
		const req = makeRequest({ repos: ["mobile"] });
		const workspace = makeWorkspace(["api", "web", "mobile"]);
		expect(
			validateSegmentExpansionRequestAtBoundary(
				req,
				"TP-001",
				segmentId("TP-001", "api"),
				makeFrontier(),
				workspace,
				new Set(),
			),
		).toBeNull();
	});

	test("rejects when request taskId differs from boundary taskId", () => {
		const req = makeRequest({ taskId: "TP-999" });
		const result = validateSegmentExpansionRequestAtBoundary(
			req,
			"TP-001",
			segmentId("TP-001", "api"),
			makeFrontier(),
			makeWorkspace(["api", "mobile"]),
			new Set(),
		);
		expect(result).toBe("request does not match the active segment boundary");
	});

	test("rejects when request fromSegmentId differs from active boundary segmentId", () => {
		const req = makeRequest({ from: segmentId("TP-001", "web") });
		const result = validateSegmentExpansionRequestAtBoundary(
			req,
			"TP-001",
			segmentId("TP-001", "api"),
			makeFrontier(),
			makeWorkspace(["api", "web", "mobile"]),
			new Set(),
		);
		expect(result).toBe("request does not match the active segment boundary");
	});

	test("rejects when the task is in a terminal state", () => {
		const frontier = makeFrontier({ terminalStatus: "succeeded" });
		const req = makeRequest({});
		const result = validateSegmentExpansionRequestAtBoundary(
			req,
			"TP-001",
			segmentId("TP-001", "api"),
			frontier,
			makeWorkspace(["api", "mobile"]),
			new Set(),
		);
		expect(result).toBe("task is already in terminal state");
	});

	test("rejects unsupported placement values", () => {
		const req = makeRequest({ placement: "middle" });
		const result = validateSegmentExpansionRequestAtBoundary(
			req,
			"TP-001",
			segmentId("TP-001", "api"),
			makeFrontier(),
			makeWorkspace(["api", "mobile"]),
			new Set(),
		);
		expect(result).toBe('unsupported placement "middle"');
	});

	test("rejects already-processed requestId", () => {
		const req = makeRequest({ requestId: "exp-seen" });
		const result = validateSegmentExpansionRequestAtBoundary(
			req,
			"TP-001",
			segmentId("TP-001", "api"),
			makeFrontier(),
			makeWorkspace(["api", "mobile"]),
			new Set(["exp-seen"]),
		);
		expect(result).toBe('requestId "exp-seen" already processed');
	});

	test("rejects unknown repoId in workspace mode", () => {
		const req = makeRequest({ repos: ["not-a-repo"] });
		const result = validateSegmentExpansionRequestAtBoundary(
			req,
			"TP-001",
			segmentId("TP-001", "api"),
			makeFrontier(),
			makeWorkspace(["api", "web"]),
			new Set(),
		);
		expect(result).toBe('unknown repoId "not-a-repo"');
	});

	test("accepts 'default' repo in repo mode (no workspaceConfig)", () => {
		const frontier = makeFrontier({
			orderedSegments: [node("TP-001", "default", 0)],
			statusBySegmentId: new Map<string, SegmentLifecycleStatus>([[segmentId("TP-001", "default"), "pending"]]),
		});
		const req = makeRequest({ from: segmentId("TP-001", "default"), repos: ["default"] });
		const result = validateSegmentExpansionRequestAtBoundary(
			req,
			"TP-001",
			segmentId("TP-001", "default"),
			frontier,
			null,
			new Set(),
		);
		expect(result).toBeNull();
	});

	test("rejects non-default repoIds in repo mode (no workspaceConfig)", () => {
		const req = makeRequest({ repos: ["mobile"] });
		const result = validateSegmentExpansionRequestAtBoundary(
			req,
			"TP-001",
			segmentId("TP-001", "api"),
			makeFrontier(),
			null,
			new Set(),
		);
		expect(result).toBe('repo expansion requires workspace mode (unknown repoId "mobile")');
	});

	test("rejects duplicate repoIds in requestedRepoIds", () => {
		const req = makeRequest({ repos: ["mobile", "mobile"] });
		const result = validateSegmentExpansionRequestAtBoundary(
			req,
			"TP-001",
			segmentId("TP-001", "api"),
			makeFrontier(),
			makeWorkspace(["api", "mobile"]),
			new Set(),
		);
		expect(result).toBe("duplicate repoIds in requestedRepoIds");
	});

	test("accepts edges referencing the anchor segment's repo (TP-145)", () => {
		const req = makeRequest({
			repos: ["mobile"],
			edges: [{ from: "api", to: "mobile" }], // anchor repo = "api"
		});
		const result = validateSegmentExpansionRequestAtBoundary(
			req,
			"TP-001",
			segmentId("TP-001", "api"),
			makeFrontier(),
			makeWorkspace(["api", "web", "mobile"]),
			new Set(),
		);
		expect(result).toBeNull();
	});

	test("accepts edges referencing completed segments' repos", () => {
		const frontier = makeFrontier({
			orderedSegments: [node("TP-001", "shared", 0), node("TP-001", "api", 1)],
			statusBySegmentId: new Map<string, SegmentLifecycleStatus>([
				[segmentId("TP-001", "shared"), "succeeded"],
				[segmentId("TP-001", "api"), "pending"],
			]),
		});
		const req = makeRequest({
			repos: ["mobile"],
			edges: [{ from: "shared", to: "mobile" }],
		});
		const result = validateSegmentExpansionRequestAtBoundary(
			req,
			"TP-001",
			segmentId("TP-001", "api"),
			frontier,
			makeWorkspace(["api", "shared", "mobile"]),
			new Set(),
		);
		expect(result).toBeNull();
	});

	test("rejects edges whose endpoints are outside requestedRepoIds/anchor/completed", () => {
		const req = makeRequest({
			repos: ["mobile"],
			edges: [{ from: "other", to: "mobile" }], // "other" is unknown
		});
		const result = validateSegmentExpansionRequestAtBoundary(
			req,
			"TP-001",
			segmentId("TP-001", "api"),
			makeFrontier(),
			makeWorkspace(["api", "other", "mobile"]),
			new Set(),
		);
		expect(result).toBe("edge references a repo outside requestedRepoIds and known segments");
	});

	test("rejects request whose edges form a cycle", () => {
		const req = makeRequest({
			repos: ["mobile", "shared"],
			edges: [
				{ from: "mobile", to: "shared" },
				{ from: "shared", to: "mobile" },
			],
		});
		const result = validateSegmentExpansionRequestAtBoundary(
			req,
			"TP-001",
			segmentId("TP-001", "api"),
			makeFrontier(),
			makeWorkspace(["api", "mobile", "shared"]),
			new Set(),
		);
		expect(result).toBe("expansion request introduces a cycle in requested edges");
	});
});

describe("processSegmentExpansionRequestAtBoundary", () => {
	test("returns ok:true and adds requestId to knownRequestIds on success", () => {
		const req = makeRequest({ requestId: "exp-new", repos: ["mobile"] });
		const known = new Set<string>();
		const result = processSegmentExpansionRequestAtBoundary(
			"batch-1",
			"TP-001",
			segmentId("TP-001", "api"),
			"agent-1",
			req,
			makeFrontier(),
			makeWorkspace(["api", "mobile"]),
			known,
		);
		expect(result).toEqual({ ok: true });
		expect(known.has("exp-new")).toBe(true);
	});

	test("returns ok:false with validation reason and does NOT mutate knownRequestIds on failure", () => {
		const req = makeRequest({ requestId: "exp-bad", placement: "middle" });
		const known = new Set<string>();
		const result = processSegmentExpansionRequestAtBoundary(
			"batch-1",
			"TP-001",
			segmentId("TP-001", "api"),
			"agent-1",
			req,
			makeFrontier(),
			makeWorkspace(["api", "mobile"]),
			known,
		);
		expect(result).toEqual({ ok: false, reason: 'unsupported placement "middle"' });
		expect(known.size).toBe(0);
	});

	test("returns ok:false when requestId has already been processed", () => {
		const req = makeRequest({ requestId: "exp-dup", repos: ["mobile"] });
		const known = new Set<string>(["exp-dup"]);
		const result = processSegmentExpansionRequestAtBoundary(
			"batch-1",
			"TP-001",
			segmentId("TP-001", "api"),
			"agent-1",
			req,
			makeFrontier(),
			makeWorkspace(["api", "mobile"]),
			known,
		);
		expect(result).toEqual({ ok: false, reason: 'requestId "exp-dup" already processed' });
		expect(known.size).toBe(1);
	});
});
