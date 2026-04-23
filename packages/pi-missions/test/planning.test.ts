/**
 * Unit tests for planning helpers (Track D).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	clarificationsPath,
	draftFeature,
	finalizePlan,
	listClarifications,
	loadPlanManifest,
	parseClarifications,
	planManifestPath,
	planningDir,
	recordClarification,
	renderFeaturePrompt,
} from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-planning-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

describe("renderFeaturePrompt", () => {
	test("includes milestone + fulfills metadata", () => {
		const prompt = renderFeaturePrompt({
			cwd: sandbox,
			featureId: "F-001",
			title: "Hello world",
			milestoneId: "M-001",
			fulfillsAssertionIds: ["VA-001", "VA-002"],
			description: "Implement the hello CLI.",
		});
		expect(prompt).toContain("# Task: F-001 \u2014 Hello world");
		expect(prompt).toContain("## Milestone: M-001");
		expect(prompt).toContain("## Fulfills: VA-001, VA-002");
		expect(prompt).toContain("Implement the hello CLI.");
	});

	test("renders empty assertions placeholder when none cited", () => {
		const prompt = renderFeaturePrompt({
			cwd: sandbox,
			featureId: "F-001",
			title: "x",
			milestoneId: "M-001",
			fulfillsAssertionIds: [],
			description: "d",
		});
		expect(prompt).toContain("## Fulfills: _None");
	});

	test("file scope falls back when none provided", () => {
		const prompt = renderFeaturePrompt({
			cwd: sandbox,
			featureId: "F-001",
			title: "x",
			milestoneId: "M-001",
			fulfillsAssertionIds: ["VA-001"],
			description: "d",
		});
		expect(prompt).toContain("Determined during execution");
	});

	test("size defaults to M and respects override", () => {
		const m = renderFeaturePrompt({
			cwd: sandbox,
			featureId: "F-001",
			title: "x",
			milestoneId: "M-001",
			fulfillsAssertionIds: ["VA-001"],
			description: "d",
		});
		expect(m).toContain("**Size:** M");
		const l = renderFeaturePrompt({
			cwd: sandbox,
			featureId: "F-001",
			title: "x",
			milestoneId: "M-001",
			fulfillsAssertionIds: ["VA-001"],
			description: "d",
			size: "L",
		});
		expect(l).toContain("**Size:** L");
	});
});

describe("draftFeature", () => {
	test("creates folder + PROMPT.md", async () => {
		const result = await draftFeature({
			cwd: sandbox,
			featureId: "F-001",
			title: "First feature",
			milestoneId: "M-001",
			fulfillsAssertionIds: ["VA-001"],
			description: "Implement the first feature.",
		});
		expect(existsSync(result.promptPath)).toBe(true);
		expect(result.folderPath.endsWith("F-001-first-feature")).toBe(true);
		const content = readFileSync(result.promptPath, "utf-8");
		expect(content).toContain("## Milestone: M-001");
	});

	test("rejects invalid feature id", async () => {
		await expect(
			draftFeature({
				cwd: sandbox,
				featureId: "f001",
				title: "x",
				milestoneId: "M-001",
				fulfillsAssertionIds: [],
				description: "d",
			}),
		).rejects.toThrow(/Invalid feature id/);
	});

	test("rejects empty title / description / milestoneId", async () => {
		await expect(
			draftFeature({
				cwd: sandbox,
				featureId: "F-001",
				title: "",
				milestoneId: "M-001",
				fulfillsAssertionIds: [],
				description: "d",
			}),
		).rejects.toThrow(/title is required/);
		await expect(
			draftFeature({
				cwd: sandbox,
				featureId: "F-001",
				title: "x",
				milestoneId: "",
				fulfillsAssertionIds: [],
				description: "d",
			}),
		).rejects.toThrow(/milestoneId/);
		await expect(
			draftFeature({
				cwd: sandbox,
				featureId: "F-001",
				title: "x",
				milestoneId: "M-001",
				fulfillsAssertionIds: [],
				description: "  ",
			}),
		).rejects.toThrow(/description/);
	});

	test("refuses to overwrite an existing PROMPT.md", async () => {
		await draftFeature({
			cwd: sandbox,
			featureId: "F-001",
			title: "x",
			milestoneId: "M-001",
			fulfillsAssertionIds: ["VA-001"],
			description: "d",
		});
		await expect(
			draftFeature({
				cwd: sandbox,
				featureId: "F-001",
				title: "x",
				milestoneId: "M-001",
				fulfillsAssertionIds: ["VA-001"],
				description: "d",
			}),
		).rejects.toThrow(/already has a PROMPT.md/);
	});
});

describe("recordClarification + listClarifications", () => {
	test("creates clarifications file with auto-generated id", async () => {
		const id = await recordClarification(sandbox, "Should we use SQLite or Postgres?");
		expect(id).toMatch(/^CLR-\d{3}$/);
		expect(existsSync(clarificationsPath(sandbox))).toBe(true);
		const list = await listClarifications(sandbox);
		expect(list).toHaveLength(1);
		expect(list[0]?.question).toBe("Should we use SQLite or Postgres?");
	});

	test("auto-increments id for subsequent entries", async () => {
		const id1 = await recordClarification(sandbox, "Q1");
		const id2 = await recordClarification(sandbox, "Q2");
		expect(id2).not.toBe(id1);
		expect(Number.parseInt(id2.split("-")[1] ?? "0", 10)).toBe(Number.parseInt(id1.split("-")[1] ?? "0", 10) + 1);
	});

	test("preserves context when supplied", async () => {
		await recordClarification(sandbox, "Q?", { context: "after the auth section" });
		const list = await listClarifications(sandbox);
		expect(list[0]?.context).toBe("after the auth section");
	});

	test("rejects empty question", async () => {
		await expect(recordClarification(sandbox, "  ")).rejects.toThrow(/required/);
	});

	test("listClarifications returns [] when file absent", async () => {
		expect(await listClarifications(sandbox)).toEqual([]);
	});

	test("parseClarifications surfaces answers when present", () => {
		const text = [
			"# Planning Clarifications",
			"",
			"## CLR-001 \u2014 2026-04-22T10:00:00.000Z",
			"",
			"**Q:** Use Sqlite?",
			"",
			"**A (2026-04-22T10:30:00.000Z):** Yes, SQLite via bun:sqlite.",
			"",
		].join("\n");
		const parsed = parseClarifications(text);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.answer).toBe("Yes, SQLite via bun:sqlite.");
	});
});

describe("finalizePlan + loadPlanManifest", () => {
	test("writes awaiting-approval manifest by default", async () => {
		const m = await finalizePlan({
			cwd: sandbox,
			missionId: "batch-1",
			milestoneIds: ["M-001"],
			featureIds: ["F-001", "F-002"],
		});
		expect(m.status).toBe("awaiting-approval");
		expect(existsSync(planManifestPath(sandbox))).toBe(true);
	});

	test("requires non-empty milestone + feature lists", async () => {
		await expect(
			finalizePlan({ cwd: sandbox, missionId: "b", milestoneIds: [], featureIds: ["F-001"] }),
		).rejects.toThrow(/milestone id/);
		await expect(
			finalizePlan({ cwd: sandbox, missionId: "b", milestoneIds: ["M-001"], featureIds: [] }),
		).rejects.toThrow(/feature id/);
	});

	test("approved status records approver + timestamp", async () => {
		const m = await finalizePlan({
			cwd: sandbox,
			missionId: "batch-1",
			milestoneIds: ["M-001"],
			featureIds: ["F-001"],
			status: "approved",
			approvedBy: "alice",
		});
		expect(m.status).toBe("approved");
		expect(m.approvedBy).toBe("alice");
		expect(m.approvedAt).toBeDefined();
	});

	test("preserves createdAt across re-finalizations", async () => {
		let clock = new Date("2026-04-22T10:00:00.000Z");
		const first = await finalizePlan({
			cwd: sandbox,
			missionId: "batch-1",
			milestoneIds: ["M-001"],
			featureIds: ["F-001"],
			now: () => clock,
		});
		clock = new Date("2026-04-22T10:05:00.000Z");
		const second = await finalizePlan({
			cwd: sandbox,
			missionId: "batch-1",
			milestoneIds: ["M-001", "M-002"],
			featureIds: ["F-001", "F-002"],
			now: () => clock,
		});
		expect(second.createdAt).toBe(first.createdAt);
		expect(second.updatedAt).not.toBe(first.updatedAt);
		expect(second.milestoneIds).toEqual(["M-001", "M-002"]);
	});

	test("loadPlanManifest returns null when absent", async () => {
		expect(await loadPlanManifest(sandbox)).toBeNull();
	});

	test("loadPlanManifest round-trips finalised manifest", async () => {
		await finalizePlan({
			cwd: sandbox,
			missionId: "batch-1",
			milestoneIds: ["M-001"],
			featureIds: ["F-001"],
		});
		const loaded = await loadPlanManifest(sandbox);
		expect(loaded?.missionId).toBe("batch-1");
		expect(loaded?.featureIds).toEqual(["F-001"]);
	});
});

describe("planningDir", () => {
	test("resolves under <missionsDir>/planning/", () => {
		expect(planningDir(sandbox).endsWith("planning")).toBe(true);
	});
});
