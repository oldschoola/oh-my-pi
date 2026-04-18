import { describe, expect, test } from "bun:test";

import type { ParsedTask } from "../src/missioncontrol/discovery";
import type { LaneAssignment } from "../src/missioncontrol/types";
import { enforceGlobalLaneCap, type GlobalLaneEntry } from "../src/missioncontrol/waves";

function mkTask(taskId: string): ParsedTask {
	return {
		taskId,
		taskName: taskId.toLowerCase(),
		folderPath: `/repo/tasks/${taskId}`,
		promptPath: `/repo/tasks/${taskId}/PROMPT.md`,
		prompt: "",
		dependencies: [],
		size: "M",
	};
}

function mkEntry(
	globalLane: number,
	localLane: number,
	repoId: string | undefined,
	taskIds: string[],
): GlobalLaneEntry {
	const assignments: LaneAssignment[] = taskIds.map(taskId => ({
		taskId,
		lane: localLane,
		task: mkTask(taskId),
		...(repoId !== undefined ? { repoId } : {}),
	}));
	return { globalLane, localLane, repoId, assignments };
}

describe("enforceGlobalLaneCap", () => {
	test("no-op when total ≤ maxLanes", () => {
		const entries: GlobalLaneEntry[] = [mkEntry(1, 1, "api", ["T-1"]), mkEntry(2, 1, "ui", ["T-2"])];
		const snapshot = structuredClone(entries);
		enforceGlobalLaneCap(entries, 5);
		expect(entries).toEqual(snapshot);
	});

	test("no-op when total exactly equals maxLanes", () => {
		const entries: GlobalLaneEntry[] = [mkEntry(1, 1, "api", ["T-1"]), mkEntry(2, 2, "api", ["T-2"])];
		const snapshot = structuredClone(entries);
		enforceGlobalLaneCap(entries, 2);
		expect(entries).toEqual(snapshot);
	});

	test("drops excess lanes from largest repo, merges assignments into its first lane", () => {
		const entries: GlobalLaneEntry[] = [
			mkEntry(1, 1, "api", ["A-1"]),
			mkEntry(2, 2, "api", ["A-2"]),
			mkEntry(3, 3, "api", ["A-3"]),
			mkEntry(4, 1, "ui", ["U-1"]),
		];
		enforceGlobalLaneCap(entries, 2);
		expect(entries).toHaveLength(2);
		// api is the heavier repo → shrinks from 3 to 1 lane. ui retains its 1 lane.
		const apiEntry = entries.find(e => e.repoId === "api");
		const uiEntry = entries.find(e => e.repoId === "ui");
		expect(apiEntry?.assignments.map(a => a.taskId).sort()).toEqual(["A-1", "A-2", "A-3"]);
		expect(uiEntry?.assignments.map(a => a.taskId)).toEqual(["U-1"]);
	});

	test("renumbers globalLane sequentially after consolidation", () => {
		const entries: GlobalLaneEntry[] = [
			mkEntry(1, 1, "api", ["A-1"]),
			mkEntry(2, 2, "api", ["A-2"]),
			mkEntry(3, 3, "api", ["A-3"]),
			mkEntry(4, 1, "ui", ["U-1"]),
		];
		enforceGlobalLaneCap(entries, 2);
		expect(entries.map(e => e.globalLane)).toEqual([1, 2]);
	});

	test("renumbered lanes are sorted by repoId alphabetically", () => {
		const entries: GlobalLaneEntry[] = [
			mkEntry(1, 1, "zzz", ["Z-1"]),
			mkEntry(2, 1, "aaa", ["A-1"]),
			mkEntry(3, 2, "aaa", ["A-2"]),
		];
		enforceGlobalLaneCap(entries, 2);
		expect(entries.map(e => e.repoId)).toEqual(["aaa", "zzz"]);
		expect(entries.map(e => e.globalLane)).toEqual([1, 2]);
	});

	test("tie-break picks repo with alphabetically-earlier id when lane counts match", () => {
		// Both repos have 2 lanes. 4 total, cap 3 → drop 1. Tie-break: alphabetical smaller key wins reduction.
		// Algorithm: `key < bestKey` wins at equal count, so "api" beats "ui" → api shrinks.
		const entries: GlobalLaneEntry[] = [
			mkEntry(1, 1, "api", ["A-1"]),
			mkEntry(2, 2, "api", ["A-2"]),
			mkEntry(3, 1, "ui", ["U-1"]),
			mkEntry(4, 2, "ui", ["U-2"]),
		];
		enforceGlobalLaneCap(entries, 3);
		const apiLanes = entries.filter(e => e.repoId === "api");
		const uiLanes = entries.filter(e => e.repoId === "ui");
		expect(apiLanes).toHaveLength(1);
		expect(uiLanes).toHaveLength(2);
		expect(apiLanes[0]?.assignments.map(a => a.taskId).sort()).toEqual(["A-1", "A-2"]);
	});

	test("stops when all repos are at 1 lane (cap cannot go lower than repo count)", () => {
		const entries: GlobalLaneEntry[] = [
			mkEntry(1, 1, "api", ["A-1"]),
			mkEntry(2, 1, "ui", ["U-1"]),
			mkEntry(3, 1, "cli", ["C-1"]),
		];
		// maxLanes=1 impossible with 3 repos.
		enforceGlobalLaneCap(entries, 1);
		expect(entries).toHaveLength(3);
		expect(entries.every(e => e.assignments.length === 1)).toBe(true);
	});

	test("empty entries array is a no-op", () => {
		const entries: GlobalLaneEntry[] = [];
		enforceGlobalLaneCap(entries, 5);
		expect(entries).toEqual([]);
	});

	test("undefined repoId groups share the same synthetic bucket", () => {
		const entries: GlobalLaneEntry[] = [
			mkEntry(1, 1, undefined, ["T-1"]),
			mkEntry(2, 2, undefined, ["T-2"]),
			mkEntry(3, 3, undefined, ["T-3"]),
		];
		enforceGlobalLaneCap(entries, 1);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.assignments.map(a => a.taskId).sort()).toEqual(["T-1", "T-2", "T-3"]);
		expect(entries[0]?.globalLane).toBe(1);
	});

	test("localLane and existing assignments on target are preserved when merging", () => {
		const entries: GlobalLaneEntry[] = [mkEntry(1, 1, "api", ["A-1", "A-2"]), mkEntry(2, 2, "api", ["A-3"])];
		enforceGlobalLaneCap(entries, 1);
		expect(entries).toHaveLength(1);
		const survivor = entries[0];
		expect(survivor?.localLane).toBe(1); // original lane 1 of api group survived
		expect(survivor?.assignments.map(a => a.taskId).sort()).toEqual(["A-1", "A-2", "A-3"]);
	});
});
