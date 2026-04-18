/**
 * Unit tests for dependency cache I/O — loadAreaDependencyCache,
 * writeAreaDependencyCache, applyDependenciesFromCache.
 *
 * Uses `os.tmpdir()` + `fs.mkdtempSync` for an isolated sandbox per test.
 * Exercises: nonexistent file, malformed JSON, missing `tasks` field,
 * write→read round trip, and mutation of pending tasks filtered by area.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveryResult, ParsedTask } from "../src/missioncontrol";
import { applyDependenciesFromCache, loadAreaDependencyCache, writeAreaDependencyCache } from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-depcache-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function parsedTask(taskId: string, folder: string, deps: string[] = []): ParsedTask {
	return {
		taskId,
		taskName: taskId.toLowerCase(),
		folderPath: folder,
		taskFolder: folder,
		promptPath: join(folder, "PROMPT.md"),
		prompt: "",
		dependencies: deps,
		size: "M",
	};
}

describe("loadAreaDependencyCache", () => {
	test("returns null when file is missing", () => {
		expect(loadAreaDependencyCache(sandbox)).toBeNull();
	});

	test("returns null when file is malformed JSON", () => {
		writeFileSync(join(sandbox, "dependencies.json"), "not-json{", "utf-8");
		expect(loadAreaDependencyCache(sandbox)).toBeNull();
	});

	test("returns null when required `tasks` field is missing", () => {
		writeFileSync(join(sandbox, "dependencies.json"), JSON.stringify({ version: 1 }), "utf-8");
		expect(loadAreaDependencyCache(sandbox)).toBeNull();
	});

	test("returns parsed payload when file is well-formed", () => {
		const payload = { version: 1, generatedAt: "t", source: "prompt", tasks: { "T-001": ["T-000"] } };
		writeFileSync(join(sandbox, "dependencies.json"), JSON.stringify(payload), "utf-8");
		const out = loadAreaDependencyCache(sandbox);
		expect(out).not.toBeNull();
		expect(out?.tasks["T-001"]).toEqual(["T-000"]);
	});
});

describe("writeAreaDependencyCache", () => {
	test("writes a deterministic payload with `prompt` source", () => {
		const pending = new Map<string, ParsedTask>();
		pending.set("T-001", parsedTask("T-001", sandbox, ["to-000"]));
		writeAreaDependencyCache(sandbox, pending, "prompt");

		const path = join(sandbox, "dependencies.json");
		expect(existsSync(path)).toBe(true);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.version).toBe(1);
		expect(parsed.source).toBe("prompt");
		expect(parsed.tasks["T-001"]).toEqual(["TO-000"]);
	});

	test("excludes tasks outside the area path", () => {
		const inside = join(sandbox, "inside-task");
		const outside = mkdtempSync(join(tmpdir(), "omp-other-"));
		mkdirSync(inside, { recursive: true });
		try {
			const pending = new Map<string, ParsedTask>();
			pending.set("IN-001", parsedTask("IN-001", inside));
			pending.set("OUT-001", parsedTask("OUT-001", outside));
			writeAreaDependencyCache(sandbox, pending, "agent");

			const parsed = JSON.parse(readFileSync(join(sandbox, "dependencies.json"), "utf-8"));
			expect(Object.keys(parsed.tasks)).toEqual(["IN-001"]);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("round-trips through loadAreaDependencyCache", () => {
		const pending = new Map<string, ParsedTask>();
		pending.set("R-001", parsedTask("R-001", sandbox, ["R-000"]));
		writeAreaDependencyCache(sandbox, pending, "prompt");
		const loaded = loadAreaDependencyCache(sandbox);
		expect(loaded?.tasks["R-001"]).toEqual(["R-000"]);
	});
});

describe("applyDependenciesFromCache", () => {
	function discovery(tasks: ParsedTask[]): DiscoveryResult {
		const pending = new Map<string, ParsedTask>();
		for (const t of tasks) pending.set(t.taskId, t);
		return { pending, completed: new Set(), errors: [] };
	}

	test("returns { applied: false } when no cache exists", () => {
		const result = applyDependenciesFromCache(discovery([]), [sandbox]);
		expect(result.applied).toBe(false);
	});

	test("overwrites dependencies on tasks inside the area", () => {
		const taskFolder = join(sandbox, "T-001");
		mkdirSync(taskFolder, { recursive: true });
		// Seed cache with CACHED-DEP, then run discovery with STALE — apply should replace.
		const seedPending = new Map<string, ParsedTask>();
		seedPending.set("T-001", parsedTask("T-001", taskFolder, ["CACHED-DEP"]));
		writeAreaDependencyCache(sandbox, seedPending, "agent");

		const disc = discovery([parsedTask("T-001", taskFolder, ["STALE"])]);
		const out = applyDependenciesFromCache(disc, [sandbox]);
		expect(out.applied).toBe(true);
		expect(disc.pending.get("T-001")?.dependencies).toEqual(["CACHED-DEP"]);
	});

	test("leaves tasks outside the area unchanged", () => {
		const insideFolder = join(sandbox, "in");
		mkdirSync(insideFolder, { recursive: true });
		const outsideSandbox = mkdtempSync(join(tmpdir(), "omp-outside-"));
		try {
			const insideTask = parsedTask("IN-001", insideFolder, ["ORIG-IN"]);
			const outsideTask = parsedTask("OUT-001", outsideSandbox, ["ORIG-OUT"]);
			const pending = new Map<string, ParsedTask>();
			pending.set(insideTask.taskId, insideTask);
			pending.set(outsideTask.taskId, outsideTask);
			writeAreaDependencyCache(sandbox, pending, "prompt");

			const disc = discovery([
				parsedTask("IN-001", insideFolder, []),
				parsedTask("OUT-001", outsideSandbox, ["ORIG-OUT"]),
			]);
			const out = applyDependenciesFromCache(disc, [sandbox]);
			expect(out.applied).toBe(true);
			expect(disc.pending.get("IN-001")?.dependencies).toEqual(["ORIG-IN"]);
			expect(disc.pending.get("OUT-001")?.dependencies).toEqual(["ORIG-OUT"]);
		} finally {
			rmSync(outsideSandbox, { recursive: true, force: true });
		}
	});

	test("skips tasks when cache has no entry for them", () => {
		const taskFolder = join(sandbox, "T-001");
		mkdirSync(taskFolder, { recursive: true });
		const pending = new Map<string, ParsedTask>();
		// Cache payload includes only T-001
		pending.set("T-001", parsedTask("T-001", taskFolder, ["T-000"]));
		writeAreaDependencyCache(sandbox, pending, "prompt");

		// Discovery has both T-001 and T-999 — only T-001 should update.
		const disc = discovery([parsedTask("T-001", taskFolder, ["STALE"]), parsedTask("T-999", taskFolder, ["KEEP"])]);
		applyDependenciesFromCache(disc, [sandbox]);
		expect(disc.pending.get("T-001")?.dependencies).toEqual(["T-000"]);
		expect(disc.pending.get("T-999")?.dependencies).toEqual(["KEEP"]);
	});
});
