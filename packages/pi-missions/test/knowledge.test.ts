/**
 * Unit tests for the shared knowledge library (Track F).
 *
 * Covers appendKnowledgeEntry, readKnowledgeEntries, parseKnowledgeText,
 * summariseKnowledge, ingestValidatorLessons, knowledgePath, and file-level
 * structure preservation across multiple appends.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	appendKnowledgeEntry,
	ingestValidatorLessons,
	KNOWLEDGE_FILENAME,
	KNOWLEDGE_GLOBAL_SCOPE,
	knowledgePath,
	parseKnowledgeText,
	readKnowledgeEntries,
	summariseKnowledge,
} from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-knowledge-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

async function readFile(cwd: string): Promise<string> {
	return Bun.file(knowledgePath(cwd)).text();
}

describe("knowledgePath", () => {
	test("resolves to knowledge.md under the project agent dir", () => {
		const p = knowledgePath(sandbox);
		expect(p.endsWith(KNOWLEDGE_FILENAME)).toBe(true);
		expect(p.startsWith(sandbox)).toBe(true);
	});
});

describe("appendKnowledgeEntry", () => {
	test("creates a new file with header + section on first write", async () => {
		await appendKnowledgeEntry(sandbox, {
			scope: "M-001",
			timestamp: "2026-04-22T10:00:00.000Z",
			author: "scrutiny",
			body: "Workers skipped STATUS.md updates.",
		});
		const text = await readFile(sandbox);
		expect(text).toContain("# Mission Knowledge Library");
		expect(text).toContain("## M-001");
		expect(text).toContain("- 2026-04-22T10:00:00.000Z — scrutiny: Workers skipped STATUS.md updates.");
	});

	test("renders title as `## scope — title`", async () => {
		await appendKnowledgeEntry(sandbox, {
			scope: "M-002",
			timestamp: "2026-04-22T11:00:00.000Z",
			author: "planner",
			body: "The SSR bundle exceeds budget.",
			title: "Performance",
		});
		const text = await readFile(sandbox);
		expect(text).toContain("## M-002 — Performance");
	});

	test("appends to an existing section rather than creating duplicates", async () => {
		await appendKnowledgeEntry(sandbox, {
			scope: "M-001",
			timestamp: "2026-04-22T10:00:00.000Z",
			author: "scrutiny",
			body: "first",
		});
		await appendKnowledgeEntry(sandbox, {
			scope: "M-001",
			timestamp: "2026-04-22T10:05:00.000Z",
			author: "scrutiny",
			body: "second",
		});
		const text = await readFile(sandbox);
		const headingCount = (text.match(/^## M-001\s*$/gm) ?? []).length;
		expect(headingCount).toBe(1);
		expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
	});

	test("creates distinct sections for different scopes", async () => {
		await appendKnowledgeEntry(sandbox, {
			scope: "M-001",
			timestamp: "2026-04-22T10:00:00.000Z",
			author: "a",
			body: "m1",
		});
		await appendKnowledgeEntry(sandbox, {
			scope: "M-002",
			timestamp: "2026-04-22T10:10:00.000Z",
			author: "a",
			body: "m2",
		});
		await appendKnowledgeEntry(sandbox, {
			scope: KNOWLEDGE_GLOBAL_SCOPE,
			timestamp: "2026-04-22T10:20:00.000Z",
			author: "a",
			body: "global",
		});
		const text = await readFile(sandbox);
		expect(text).toContain("## M-001");
		expect(text).toContain("## M-002");
		expect(text).toContain("## (project)");
	});

	test("collapses multi-line body onto one bullet", async () => {
		await appendKnowledgeEntry(sandbox, {
			scope: "M-001",
			timestamp: "2026-04-22T10:00:00.000Z",
			author: "worker",
			body: "line one\nline two",
		});
		const text = await readFile(sandbox);
		expect(text).toContain("line one line two");
		// Body must not introduce an extra `-` bullet break.
		expect((text.match(/^- /gm) ?? []).length).toBe(1);
	});

	test("treats scope titles with whitespace robustly", async () => {
		await appendKnowledgeEntry(sandbox, {
			scope: "  M-005  ",
			timestamp: "2026-04-22T10:00:00.000Z",
			author: "p",
			body: "x",
		});
		const text = await readFile(sandbox);
		expect(text).toContain("## M-005");
	});

	test("creates parent directory on first write", async () => {
		expect(existsSync(knowledgePath(sandbox))).toBe(false);
		await appendKnowledgeEntry(sandbox, {
			scope: "M-001",
			timestamp: "t",
			author: "a",
			body: "b",
		});
		expect(existsSync(knowledgePath(sandbox))).toBe(true);
	});
});

describe("readKnowledgeEntries + parseKnowledgeText", () => {
	test("returns [] when file absent", async () => {
		const entries = await readKnowledgeEntries(sandbox);
		expect(entries).toEqual([]);
	});

	test("round-trips the bullets appended via appendKnowledgeEntry", async () => {
		await appendKnowledgeEntry(sandbox, {
			scope: "M-001",
			timestamp: "2026-04-22T10:00:00.000Z",
			author: "scrutiny",
			body: "alpha",
		});
		await appendKnowledgeEntry(sandbox, {
			scope: "M-002",
			timestamp: "2026-04-22T11:00:00.000Z",
			author: "planner",
			body: "beta",
			title: "Design",
		});
		const entries = await readKnowledgeEntries(sandbox);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			scope: "M-001",
			timestamp: "2026-04-22T10:00:00.000Z",
			author: "scrutiny",
			body: "alpha",
		});
		expect(entries[1]).toMatchObject({
			scope: "M-002",
			title: "Design",
			author: "planner",
			body: "beta",
		});
	});

	test("parseKnowledgeText skips bullets missing a preceding heading", () => {
		const entries = parseKnowledgeText(
			[
				"# Mission Knowledge Library",
				"",
				"- 2026-04-22T10:00:00.000Z — lone: orphan bullet",
				"",
				"## M-003",
				"- 2026-04-22T10:05:00.000Z — valid: kept",
			].join("\n"),
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.body).toBe("kept");
	});

	test("parseKnowledgeText tolerates blank lines + extra indentation", () => {
		const entries = parseKnowledgeText(
			["# Mission Knowledge Library", "", "## M-004", "", "  - 2026-04-22T10:00:00.000Z — p: body", ""].join("\n"),
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.author).toBe("p");
	});
});

describe("summariseKnowledge", () => {
	test("returns empty-library message when file is absent", async () => {
		expect(await summariseKnowledge(sandbox)).toMatch(/No knowledge entries/);
	});

	test("scopes output to matching milestone plus project-global entries", async () => {
		await appendKnowledgeEntry(sandbox, {
			scope: "M-001",
			timestamp: "2026-04-22T10:00:00.000Z",
			author: "s",
			body: "m1-body",
		});
		await appendKnowledgeEntry(sandbox, {
			scope: "M-002",
			timestamp: "2026-04-22T11:00:00.000Z",
			author: "s",
			body: "m2-body",
		});
		await appendKnowledgeEntry(sandbox, {
			scope: KNOWLEDGE_GLOBAL_SCOPE,
			timestamp: "2026-04-22T12:00:00.000Z",
			author: "s",
			body: "cross-body",
		});
		const out = await summariseKnowledge(sandbox, "M-001");
		expect(out).toContain("m1-body");
		expect(out).toContain("cross-body");
		expect(out).not.toContain("m2-body");
	});

	test("limits entries (newest first)", async () => {
		for (let i = 0; i < 5; i++) {
			await appendKnowledgeEntry(sandbox, {
				scope: "M-001",
				timestamp: `2026-04-22T10:0${i}:00.000Z`,
				author: "s",
				body: `body-${i}`,
			});
		}
		const out = await summariseKnowledge(sandbox, "M-001", 2);
		// Newest first → body-4, body-3
		expect(out).toContain("body-4");
		expect(out).toContain("body-3");
		expect(out).not.toContain("body-2");
	});
});

describe("ingestValidatorLessons", () => {
	test("appends one entry per non-empty lesson", async () => {
		const count = await ingestValidatorLessons(
			sandbox,
			"M-007",
			"scrutiny-validator",
			["pattern A observed", "", "   ", "pattern B observed"],
			1700000000000,
		);
		expect(count).toBe(2);
		const entries = await readKnowledgeEntries(sandbox);
		expect(entries).toHaveLength(2);
		expect(entries.every(e => e.scope === "M-007")).toBe(true);
		expect(entries.every(e => e.author === "scrutiny-validator")).toBe(true);
		expect(entries.map(e => e.body)).toEqual(["pattern A observed", "pattern B observed"]);
	});

	test("is a no-op for an empty lessons array", async () => {
		const count = await ingestValidatorLessons(sandbox, "M-001", "user-testing", []);
		expect(count).toBe(0);
		const entries = await readKnowledgeEntries(sandbox);
		expect(entries).toEqual([]);
	});

	test("uses the provided clock for timestamp generation", async () => {
		await ingestValidatorLessons(sandbox, "M-001", "a", ["test"], 1700000000000);
		const entries = await readKnowledgeEntries(sandbox);
		expect(entries[0]?.timestamp).toBe(new Date(1700000000000).toISOString());
	});
});
