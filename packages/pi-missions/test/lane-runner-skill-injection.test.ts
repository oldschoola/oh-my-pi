/**
 * Track E2: lane-runner worker prompt injection for skills.
 *
 * Exercises the full resolution path the lane-runner takes — real
 * `listAvailableSkills` reading actual SKILL.md files plus
 * `resolveTaskSkills` + `buildSkillPromptBlock`. Asserts the rendered
 * block mentions the correct `skill://<name>` URIs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSkillPromptBlock, listAvailableSkills, resolveTaskSkills } from "../src/missioncontrol";

let sandbox: string;

function writeSkill(name: string, description: string, opts: { draft?: boolean; tags?: string[] } = {}): void {
	const root = opts.draft ? join(sandbox, ".omp", "skills", "drafts", name) : join(sandbox, ".omp", "skills", name);
	mkdirSync(root, { recursive: true });
	const tagsLine = opts.tags ? `tags: ${opts.tags.join(", ")}\n` : "";
	writeFileSync(
		join(root, "SKILL.md"),
		["---", `name: ${name}`, "version: 1.0.0", `description: ${description}`, `${tagsLine}---`, "", "body", ""].join(
			"\n",
		),
		"utf-8",
	);
}

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-lane-skill-inject-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

describe("lane-runner skill injection (E2E via listAvailableSkills)", () => {
	test("explicit ## Skills: names resolve via exact match and emit prompt block", async () => {
		writeSkill("mission-control", "Handle multi-lane orchestrated batches");
		writeSkill("caveman", "Ultra-compressed communication mode");
		writeSkill("agent-browser", "Browser automation CLI", { tags: ["automation"] });

		const available = await listAvailableSkills(sandbox);
		expect(available.map(s => s.name)).toEqual(["agent-browser", "caveman", "mission-control"]);

		const resolved = resolveTaskSkills(available, {
			taskName: "Unrelated feature name",
			skillsNeeded: ["mission-control", "caveman"],
		});
		expect(resolved.map(s => s.name)).toEqual(["mission-control", "caveman"]);

		const lines = buildSkillPromptBlock(resolved);
		expect(lines.some(l => l.includes("skill://mission-control"))).toBe(true);
		expect(lines.some(l => l.includes("skill://caveman"))).toBe(true);
		expect(lines.some(l => l.includes("skill://agent-browser"))).toBe(false);
		expect(lines.at(-1)).toContain('`read "skill://<name>"`');
	});

	test("auto-match keyword fallback when skillsNeeded is absent", async () => {
		writeSkill("frontend-design", "Frontend design patterns for web UI");
		writeSkill("linear", "Manage issues in Linear");

		const available = await listAvailableSkills(sandbox);
		const resolved = resolveTaskSkills(available, {
			taskName: "Refactor frontend dashboard",
			fulfillsAssertionIds: ["VA-200"],
		});
		expect(resolved.map(s => s.name)).toContain("frontend-design");
	});

	test("empty catalogue produces no prompt block", async () => {
		const available = await listAvailableSkills(sandbox);
		expect(available).toEqual([]);
		expect(buildSkillPromptBlock(resolveTaskSkills(available, { taskName: "foo" }))).toEqual([]);
	});

	test("draft skills are surfaced with origin label", async () => {
		writeSkill("exp-a", "Experimental helper", { draft: true });
		const available = await listAvailableSkills(sandbox);
		expect(available).toHaveLength(1);
		expect(available[0]?.origin).toBe("draft");
		const lines = buildSkillPromptBlock(resolveTaskSkills(available, { skillsNeeded: ["exp-a"] }));
		expect(lines.some(l => l.includes("(draft)"))).toBe(true);
	});
});
