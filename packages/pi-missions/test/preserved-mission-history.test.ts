/**
 * Integration tests for `withPreservedMissionHistory` — verifies that
 * `.omp/mission-history.json` is snapshotted before and restored after
 * the wrapped operation, across success/failure paths.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { missionHistoryPath } from "../src/missioncontrol/adapter";
import { withPreservedMissionHistory } from "../src/missioncontrol/post-integration";

let root = "";
let historyFile = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mc-history-"));
	historyFile = missionHistoryPath(root);
	mkdirSync(join(root, ".omp"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("withPreservedMissionHistory", () => {
	test("restores snapshot after operation mutates the file", () => {
		writeFileSync(historyFile, `{"version":1,"before":true}`);
		withPreservedMissionHistory(root, () => {
			writeFileSync(historyFile, `{"version":1,"clobbered":true}`);
		});
		expect(readFileSync(historyFile, "utf-8")).toBe(`{"version":1,"before":true}`);
	});

	test("restores snapshot even when operation throws", () => {
		writeFileSync(historyFile, "original");
		expect(() =>
			withPreservedMissionHistory(root, () => {
				writeFileSync(historyFile, "clobbered");
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(readFileSync(historyFile, "utf-8")).toBe("original");
	});

	test("restores snapshot when operation deletes the file", () => {
		writeFileSync(historyFile, "original");
		withPreservedMissionHistory(root, () => {
			unlinkSync(historyFile);
		});
		expect(readFileSync(historyFile, "utf-8")).toBe("original");
	});

	test("restores snapshot when operation removes the parent directory", () => {
		writeFileSync(historyFile, "persistent");
		withPreservedMissionHistory(root, () => {
			rmSync(join(root, ".omp"), { recursive: true, force: true });
		});
		expect(existsSync(historyFile)).toBe(true);
		expect(readFileSync(historyFile, "utf-8")).toBe("persistent");
	});

	test("no-op when history file did not exist before operation", () => {
		expect(existsSync(historyFile)).toBe(false);
		withPreservedMissionHistory(root, () => {
			writeFileSync(historyFile, "created-during-op");
		});
		expect(readFileSync(historyFile, "utf-8")).toBe("created-during-op");
	});

	test("returns the operation's return value", () => {
		const result = withPreservedMissionHistory(root, () => 42);
		expect(result).toBe(42);
	});

	test("returns value and restores atomically in one call", () => {
		writeFileSync(historyFile, "orig");
		const result = withPreservedMissionHistory(root, () => {
			writeFileSync(historyFile, "temp");
			return "ok";
		});
		expect(result).toBe("ok");
		expect(readFileSync(historyFile, "utf-8")).toBe("orig");
	});
});
