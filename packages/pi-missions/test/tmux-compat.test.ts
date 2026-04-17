/**
 * Tests for `missioncontrol/tmux-compat.ts`.
 *
 * Pure normalizer: verify field copy, idempotence, legacy-key deletion,
 * and that canonical laneSessionId wins when both fields are present.
 */

import { describe, expect, test } from "bun:test";

import {
	type LaneSessionAliasTarget,
	normalizeLaneSessionAlias,
	readLaneSessionAliases,
} from "../src/missioncontrol/tmux-compat";

describe("readLaneSessionAliases", () => {
	test("returns both fields unchanged", () => {
		const target: LaneSessionAliasTarget = {
			laneSessionId: "mission-lane-1",
			tmuxSessionName: "legacy-session",
		};
		expect(readLaneSessionAliases(target)).toEqual({
			laneSessionId: "mission-lane-1",
			tmuxSessionName: "legacy-session",
		});
	});

	test("returns undefined for missing fields", () => {
		const snapshot = readLaneSessionAliases({});
		expect(snapshot).toEqual({ laneSessionId: undefined, tmuxSessionName: undefined });
	});

	test("does not mutate the target", () => {
		const target: LaneSessionAliasTarget = { tmuxSessionName: "legacy" };
		readLaneSessionAliases(target);
		expect(target).toEqual({ tmuxSessionName: "legacy" });
	});
});

describe("normalizeLaneSessionAlias", () => {
	test("copies legacy tmuxSessionName into laneSessionId", () => {
		const target: LaneSessionAliasTarget = { tmuxSessionName: "legacy-session" };
		normalizeLaneSessionAlias(target);
		expect(target.laneSessionId).toBe("legacy-session");
		expect("tmuxSessionName" in target).toBe(false);
	});

	test("prefers existing laneSessionId over legacy field", () => {
		const target: LaneSessionAliasTarget = {
			laneSessionId: "mission-lane-1",
			tmuxSessionName: "legacy-session",
		};
		normalizeLaneSessionAlias(target);
		expect(target.laneSessionId).toBe("mission-lane-1");
		expect("tmuxSessionName" in target).toBe(false);
	});

	test("is idempotent after initial migration", () => {
		const target: LaneSessionAliasTarget = { tmuxSessionName: "legacy-session" };
		normalizeLaneSessionAlias(target);
		normalizeLaneSessionAlias(target);
		expect(target).toEqual({ laneSessionId: "legacy-session" });
	});

	test("no-op when neither field set", () => {
		const target: LaneSessionAliasTarget = {};
		normalizeLaneSessionAlias(target);
		expect(target).toEqual({});
	});

	test("does not coerce non-string legacy field", () => {
		const target: LaneSessionAliasTarget = { tmuxSessionName: 42 };
		normalizeLaneSessionAlias(target);
		expect(target.laneSessionId).toBeUndefined();
		expect("tmuxSessionName" in target).toBe(false);
	});

	test("drops legacy key even when laneSessionId already set", () => {
		const target: LaneSessionAliasTarget = {
			laneSessionId: "mission-lane-5",
			tmuxSessionName: "legacy",
		};
		normalizeLaneSessionAlias(target);
		expect("tmuxSessionName" in target).toBe(false);
		expect(target.laneSessionId).toBe("mission-lane-5");
	});
});
