/**
 * Unit tests for `upsertPendingExpandedSegmentRecords` +
 * `collectProcessedSegmentExpansionRequestIds` — persistence side of
 * dynamic segment expansion.
 */

import { describe, expect, test } from "bun:test";

import type { ParsedTask } from "../src/missioncontrol/discovery";
import {
	collectProcessedSegmentExpansionRequestIds,
	upsertPendingExpandedSegmentRecords,
} from "../src/missioncontrol/engine-expansion";
import {
	buildSegmentId,
	type MissionBatchRuntimeState,
	type PersistedRepairRecord,
	type PersistedSegmentRecord,
	type ResilienceState,
	type SegmentFrontierTaskState,
	type SegmentId,
	type SegmentLifecycleStatus,
	type TaskSegmentNode,
} from "../src/missioncontrol/types";

function node(taskId: string, repoId: string, order: number, sequence?: number): TaskSegmentNode {
	return {
		segmentId: buildSegmentId(taskId, repoId, sequence),
		taskId,
		repoId,
		order,
	};
}

function makeFrontier(
	orderedSegments: TaskSegmentNode[],
	dependsOn: Array<[string, string[]]>,
	statuses: Array<[string, SegmentLifecycleStatus]> = [],
): SegmentFrontierTaskState {
	const statusBySegmentId = new Map<string, SegmentLifecycleStatus>();
	for (const seg of orderedSegments) statusBySegmentId.set(seg.segmentId, "pending");
	for (const [id, st] of statuses) statusBySegmentId.set(id, st);
	return {
		taskId: orderedSegments[0]?.taskId ?? "TP-000",
		orderedSegments,
		nextSegmentIndex: 0,
		statusBySegmentId,
		dependsOnBySegmentId: new Map(dependsOn),
		terminalStatus: "pending",
	};
}

function makeTask(taskId: string): ParsedTask {
	return {
		taskId,
		taskName: taskId,
		folderPath: "/tmp",
		promptPath: "/tmp/PROMPT.md",
		prompt: "",
		dependencies: [],
		size: "M",
	} as unknown as ParsedTask;
}

function makeBatch(existing: PersistedSegmentRecord[] | undefined = undefined): MissionBatchRuntimeState {
	return {
		segments: existing,
	} as unknown as MissionBatchRuntimeState;
}

function persistedRecord(
	overrides: Partial<PersistedSegmentRecord> & { segmentId: string; taskId: string; repoId: string },
): PersistedSegmentRecord {
	return {
		status: "pending",
		laneId: "",
		sessionName: "",
		worktreePath: "",
		branch: "",
		startedAt: null,
		endedAt: null,
		retries: 0,
		exitReason: "Segment pending",
		dependsOnSegmentIds: [],
		...overrides,
	};
}

describe("upsertPendingExpandedSegmentRecords", () => {
	test("inserts fresh records for newly inserted pending segments with fallback branch + expansion metadata", () => {
		const a = node("TP-001", "alpha", 0);
		const b = node("TP-001", "beta", 1);
		const frontier = makeFrontier(
			[a, b],
			[
				[a.segmentId, []],
				[b.segmentId, [a.segmentId]],
			],
		);
		const batch = makeBatch();
		const changed = upsertPendingExpandedSegmentRecords(
			batch,
			makeTask("TP-001"),
			frontier,
			[b.segmentId],
			a.segmentId,
			"exp-42",
			"task/lane-1",
		);
		expect(changed).toBe(true);
		expect(batch.segments?.length).toBe(1);
		const inserted = batch.segments?.[0];
		expect(inserted?.segmentId).toBe(b.segmentId);
		expect(inserted?.branch).toBe("task/lane-1");
		expect(inserted?.expandedFrom).toBe(a.segmentId);
		expect(inserted?.expansionRequestId).toBe("exp-42");
		expect(inserted?.dependsOnSegmentIds).toEqual([a.segmentId]);
	});

	test("updates existing pending record's dependsOnSegmentIds without overwriting lane metadata", () => {
		const a = node("TP-001", "alpha", 0);
		const b = node("TP-001", "beta", 1);
		const c = node("TP-001", "gamma", 2);
		const frontier = makeFrontier(
			[a, b, c],
			[
				[a.segmentId, []],
				[b.segmentId, [a.segmentId]],
				[c.segmentId, [a.segmentId, b.segmentId]],
			],
		);
		const existing = persistedRecord({
			segmentId: c.segmentId,
			taskId: "TP-001",
			repoId: "gamma",
			laneId: "lane-2",
			sessionName: "TP-001-lane-2",
			worktreePath: "/tmp/worktree",
			branch: "task/original",
			dependsOnSegmentIds: [a.segmentId],
		});
		const batch = makeBatch([existing]);
		const changed = upsertPendingExpandedSegmentRecords(
			batch,
			makeTask("TP-001"),
			frontier,
			[b.segmentId],
			a.segmentId,
			"exp-7",
			"task/fallback",
		);
		expect(changed).toBe(true);
		const updated = batch.segments?.find(r => r.segmentId === c.segmentId);
		expect(updated?.laneId).toBe("lane-2");
		expect(updated?.sessionName).toBe("TP-001-lane-2");
		expect(updated?.worktreePath).toBe("/tmp/worktree");
		expect(updated?.branch).toBe("task/original");
		expect(updated?.dependsOnSegmentIds).toEqual([a.segmentId, b.segmentId]);
		expect(updated?.expandedFrom).toBeUndefined();
		expect(updated?.expansionRequestId).toBeUndefined();
	});

	test("skips non-pending segments and segments with no existing record outside the inserted set", () => {
		const a = node("TP-001", "alpha", 0);
		const b = node("TP-001", "beta", 1);
		const frontier = makeFrontier(
			[a, b],
			[
				[a.segmentId, []],
				[b.segmentId, [a.segmentId]],
			],
			[[a.segmentId, "succeeded"]],
		);
		const batch = makeBatch();
		const changed = upsertPendingExpandedSegmentRecords(
			batch,
			makeTask("TP-001"),
			frontier,
			[],
			a.segmentId,
			"exp-99",
			"task/fallback",
		);
		expect(changed).toBe(false);
		expect(batch.segments?.length).toBe(0);
	});

	test("returns false when no pending segments remain", () => {
		const a = node("TP-001", "alpha", 0);
		const frontier = makeFrontier([a], [[a.segmentId, []]], [[a.segmentId, "succeeded"]]);
		const batch = makeBatch();
		const changed = upsertPendingExpandedSegmentRecords(
			batch,
			makeTask("TP-001"),
			frontier,
			[],
			a.segmentId,
			"exp-1",
			"task/x",
		);
		expect(changed).toBe(false);
	});

	test("returns false when existing record already matches desired shape", () => {
		const a = node("TP-001", "alpha", 0);
		const frontier = makeFrontier([a], [[a.segmentId, []]]);
		const existing = persistedRecord({
			segmentId: a.segmentId,
			taskId: "TP-001",
			repoId: "alpha",
			laneId: "lane-1",
			sessionName: "s",
			worktreePath: "/wt",
			branch: "task/lane-1",
			dependsOnSegmentIds: [],
		});
		const batch = makeBatch([existing]);
		const changed = upsertPendingExpandedSegmentRecords(
			batch,
			makeTask("TP-001"),
			frontier,
			[],
			"src" as SegmentId,
			"exp-id",
			"task/fallback",
		);
		expect(changed).toBe(false);
	});

	test("auto-initializes batch.segments when missing", () => {
		const a = node("TP-001", "alpha", 0);
		const frontier = makeFrontier([a], [[a.segmentId, []]]);
		const batch: MissionBatchRuntimeState = {} as MissionBatchRuntimeState;
		upsertPendingExpandedSegmentRecords(
			batch,
			makeTask("TP-001"),
			frontier,
			[a.segmentId],
			"src",
			"exp-1",
			"task/init",
		);
		expect(Array.isArray(batch.segments)).toBe(true);
		expect(batch.segments?.length).toBe(1);
	});
});

describe("collectProcessedSegmentExpansionRequestIds", () => {
	function makeResilience(history: PersistedRepairRecord[]): ResilienceState {
		return {
			resumeForced: false,
			retryCountByScope: {},
			lastFailureClass: null,
			repairHistory: history,
		};
	}
	function makeRepair(id: string, strategy: string): PersistedRepairRecord {
		return {
			id,
			strategy,
			status: "succeeded",
		} as PersistedRepairRecord;
	}

	test("returns empty Set when resilience is undefined", () => {
		expect(collectProcessedSegmentExpansionRequestIds({ resilience: undefined }).size).toBe(0);
	});

	test("returns empty Set when repairHistory is empty", () => {
		expect(collectProcessedSegmentExpansionRequestIds({ resilience: makeResilience([]) }).size).toBe(0);
	});

	test("collects only segment-expansion-request entries' ids", () => {
		const history = [
			makeRepair("exp-1", "segment-expansion-request"),
			makeRepair("worktree-a", "stale-worktree-cleanup"),
			makeRepair("exp-2", "segment-expansion-request"),
		];
		const result = collectProcessedSegmentExpansionRequestIds({ resilience: makeResilience(history) });
		expect(result.size).toBe(2);
		expect(result.has("exp-1")).toBe(true);
		expect(result.has("exp-2")).toBe(true);
		expect(result.has("worktree-a")).toBe(false);
	});

	test("ignores unrelated strategies entirely", () => {
		const history = [makeRepair("x", "lane-reset"), makeRepair("y", "backoff")];
		expect(collectProcessedSegmentExpansionRequestIds({ resilience: makeResilience(history) }).size).toBe(0);
	});
});
