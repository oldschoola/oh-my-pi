/**
 * Unit tests for `formatDiscoveryResults` — pure taskplane port.
 *
 * Covers:
 *  - empty result: header + zero counts, no Pending Tasks block
 *  - pending tasks grouped by area, deterministic sort (area asc, task asc)
 *  - dependency suffix rendered only when dependencies present
 *  - repo suffix rendered only when resolvedRepoId set
 *  - fatal vs warning split driven by FATAL_DISCOVERY_CODES
 *  - DUPLICATE_ID / DEP_UNRESOLVED classified fatal, PARSE_MALFORMED warning
 */

import { describe, expect, test } from "bun:test";
import type { DependencyRef, DiscoveryError, DiscoveryResult, ParsedTask } from "../src/missioncontrol";
import { formatDiscoveryResults } from "../src/missioncontrol";

function task(
	taskId: string,
	opts: Partial<Pick<ParsedTask, "taskName" | "size" | "dependencies" | "areaName" | "resolvedRepoId">> = {},
): ParsedTask {
	return {
		taskId,
		taskName: opts.taskName ?? taskId.toLowerCase(),
		folderPath: "",
		promptPath: "",
		prompt: "",
		dependencies: opts.dependencies ?? [],
		size: opts.size ?? "M",
		areaName: opts.areaName,
		resolvedRepoId: opts.resolvedRepoId,
	};
}

function result(pending: ParsedTask[] = [], completed: string[] = [], errors: DiscoveryError[] = []): DiscoveryResult {
	const pendingMap = new Map<string, ParsedTask>();
	for (const t of pending) pendingMap.set(t.taskId, t);
	return { pending: pendingMap, completed: new Set(completed), errors };
}

describe("formatDiscoveryResults — header", () => {
	test("empty result renders header + zero counts", () => {
		const out = formatDiscoveryResults(result());
		expect(out).toContain("📋 Discovery Results");
		expect(out).toContain("Pending tasks:   0");
		expect(out).toContain("Completed tasks: 0");
		expect(out).not.toContain("Pending Tasks:");
		expect(out).not.toContain("Errors:");
		expect(out).not.toContain("Warnings:");
	});

	test("renders completed count", () => {
		const out = formatDiscoveryResults(result([], ["T1", "T2", "T3"]));
		expect(out).toContain("Completed tasks: 3");
	});
});

describe("formatDiscoveryResults — pending tasks", () => {
	test("groups tasks by area and sorts areas alphabetically", () => {
		const out = formatDiscoveryResults(
			result([task("Z-001", { areaName: "zeta" }), task("A-001", { areaName: "alpha" })]),
		);
		const idxAlpha = out.indexOf("alpha:");
		const idxZeta = out.indexOf("zeta:");
		expect(idxAlpha).toBeGreaterThan(-1);
		expect(idxZeta).toBeGreaterThan(-1);
		expect(idxAlpha).toBeLessThan(idxZeta);
	});

	test("sorts tasks within an area by taskId", () => {
		const out = formatDiscoveryResults(
			result([
				task("API-003", { areaName: "api" }),
				task("API-001", { areaName: "api" }),
				task("API-002", { areaName: "api" }),
			]),
		);
		const i1 = out.indexOf("API-001");
		const i2 = out.indexOf("API-002");
		const i3 = out.indexOf("API-003");
		expect(i1).toBeLessThan(i2);
		expect(i2).toBeLessThan(i3);
	});

	test("renders size tag + task name", () => {
		const out = formatDiscoveryResults(
			result([task("T-001", { areaName: "api", size: "L", taskName: "add login" })]),
		);
		expect(out).toContain("T-001 [L] add login");
	});

	test("appends 'depends on' suffix when deps present", () => {
		const out = formatDiscoveryResults(
			result([task("T-002", { areaName: "api", dependencies: ["T-001", "T-009"] })]),
		);
		expect(out).toContain("→ depends on: T-001, T-009");
	});

	test("omits deps suffix when no dependencies", () => {
		const out = formatDiscoveryResults(result([task("T-001", { areaName: "api" })]));
		expect(out).not.toContain("→ depends on:");
	});

	test("appends repo suffix when resolvedRepoId set", () => {
		const out = formatDiscoveryResults(result([task("T-001", { areaName: "api", resolvedRepoId: "web" })]));
		expect(out).toContain("→ repo: web");
	});

	test("omits repo suffix when resolvedRepoId missing", () => {
		const out = formatDiscoveryResults(result([task("T-001", { areaName: "api" })]));
		expect(out).not.toContain("→ repo:");
	});

	test("tasks without areaName fall into a blank-area bucket", () => {
		const out = formatDiscoveryResults(result([task("T-001")]));
		expect(out).toContain("Pending Tasks:");
		expect(out).toContain("T-001");
	});
});

describe("formatDiscoveryResults — errors", () => {
	const fatal: DiscoveryError = {
		code: "DUPLICATE_ID",
		message: "Task T-001 defined twice",
		taskId: "T-001",
	};
	const warn: DiscoveryError = {
		code: "PARSE_MALFORMED",
		message: "malformed dep reference",
		taskId: "T-002",
	};

	test("renders fatal errors under ❌ Errors with bracketed code", () => {
		const out = formatDiscoveryResults(result([], [], [fatal]));
		expect(out).toContain("❌ Errors:");
		expect(out).toContain("[DUPLICATE_ID] Task T-001 defined twice");
		expect(out).not.toContain("⚠️  Warnings:");
	});

	test("renders non-fatal under ⚠️  Warnings", () => {
		const out = formatDiscoveryResults(result([], [], [warn]));
		expect(out).toContain("⚠️  Warnings:");
		expect(out).toContain("[PARSE_MALFORMED] malformed dep reference");
		expect(out).not.toContain("❌ Errors:");
	});

	test("splits mixed errors into both sections", () => {
		const out = formatDiscoveryResults(result([], [], [fatal, warn]));
		const errIdx = out.indexOf("❌ Errors:");
		const warnIdx = out.indexOf("⚠️  Warnings:");
		expect(errIdx).toBeGreaterThan(-1);
		expect(warnIdx).toBeGreaterThan(errIdx);
	});

	test("DEP_UNRESOLVED classified fatal", () => {
		const out = formatDiscoveryResults(
			result([], [], [{ code: "DEP_UNRESOLVED", message: "missing dep", taskId: "T-001" }]),
		);
		expect(out).toContain("❌ Errors:");
		expect(out).toContain("[DEP_UNRESOLVED]");
	});

	// Guard against unused import warnings in reviewers: exercise DependencyRef type
	test("DependencyRef shape sanity", () => {
		const ref: DependencyRef = { taskId: "T-001", raw: "T-001" };
		expect(ref.taskId).toBe("T-001");
	});
});
