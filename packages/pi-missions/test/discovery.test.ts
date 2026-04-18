import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	discoverTasks,
	extractTaskIdFromFolderName,
	extractTaskName,
	normalizeDependencyReference,
	parseDependencies,
	parseDependencyReference,
} from "../src/missioncontrol/discovery";

describe("discovery.extractTaskIdFromFolderName", () => {
	test("extracts PREFIX-NNN", () => {
		expect(extractTaskIdFromFolderName("TO-014-accrual-engine")).toBe("TO-014");
		expect(extractTaskIdFromFolderName("COMP-006-widget")).toBe("COMP-006");
	});
	test("returns null on mismatch", () => {
		expect(extractTaskIdFromFolderName("plain-folder")).toBeNull();
		expect(extractTaskIdFromFolderName("")).toBeNull();
	});
});

describe("discovery.parseDependencyReference", () => {
	test("plain task id", () => {
		expect(parseDependencyReference("TO-001")).toEqual({ raw: "TO-001", taskId: "TO-001" });
	});
	test("qualified area/task", () => {
		expect(parseDependencyReference("api/TO-001")).toEqual({
			raw: "api/TO-001",
			areaName: "api",
			taskId: "TO-001",
		});
	});
	test("lowercases areaName, uppercases taskId", () => {
		const parsed = parseDependencyReference("API/to-001");
		expect(parsed.areaName).toBe("api");
		expect(parsed.taskId).toBe("TO-001");
	});
});

describe("discovery.normalizeDependencyReference", () => {
	test("qualified retains area", () => {
		expect(normalizeDependencyReference("api/TO-001")).toBe("api/TO-001");
	});
	test("unqualified stays bare", () => {
		expect(normalizeDependencyReference("TO-002")).toBe("TO-002");
	});
});

describe("discovery.parseDependencies", () => {
	test("extracts from bulleted list", () => {
		const md = ["# Task", "", "## Dependencies", "- TO-001", "- api/TO-002", "", "## Steps", "1. do it"].join("\n");
		expect(parseDependencies(md)).toEqual(["TO-001", "api/TO-002"]);
	});
	test("dedups", () => {
		const md = "## Dependencies\n- TO-001\n- TO-001\n";
		expect(parseDependencies(md)).toEqual(["TO-001"]);
	});
	test("empty when no header", () => {
		expect(parseDependencies("# No deps section")).toEqual([]);
	});
});

describe("discovery.extractTaskName", () => {
	test("uses first heading", () => {
		expect(extractTaskName("# Fancy Name\n\nbody", "TO-001")).toBe("Fancy Name");
	});
	test("falls back on missing heading", () => {
		expect(extractTaskName("no heading", "TO-001")).toBe("TO-001");
	});
});

describe("discovery.discoverTasks", () => {
	test("scans folders and reads PROMPT.md", () => {
		const root = join(tmpdir(), `mc-discovery-${Date.now()}`);
		mkdirSync(root, { recursive: true });
		try {
			mkdirSync(join(root, "TO-001-first"));
			writeFileSync(join(root, "TO-001-first", "PROMPT.md"), "# First\n\n## Dependencies\n- TO-002\n");
			mkdirSync(join(root, "TO-002-second"));
			writeFileSync(join(root, "TO-002-second", "PROMPT.md"), "# Second\n");
			mkdirSync(join(root, "not-a-task"));

			const tasks = discoverTasks(root);
			expect(tasks).toHaveLength(2);
			expect(tasks[0]?.taskId).toBe("TO-001");
			expect(tasks[0]?.taskName).toBe("First");
			expect(tasks[0]?.dependencies).toEqual(["TO-002"]);
			expect(tasks[1]?.taskId).toBe("TO-002");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("empty on missing dir", () => {
		expect(discoverTasks(join(tmpdir(), "does-not-exist-xyz"))).toEqual([]);
	});
});
