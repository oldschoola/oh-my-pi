/**
 * Track E2: skill resolution + prompt block builder.
 *
 * Pure-helper tests; no filesystem. The lane-runner injection path
 * (real listAvailableSkills + actual prompt mutation) is exercised in
 * the lane-runner integration suites; this file pins the resolution
 * rules and the rendered block format that downstream callers depend
 * on.
 */

import { describe, expect, test } from "bun:test";

import {
	buildSkillPromptBlock,
	resolveTaskSkills,
	type SkillEntry,
	type TaskSkillContext,
} from "../src/missioncontrol";

function skill(overrides: Partial<SkillEntry> & { name: string }): SkillEntry {
	return {
		name: overrides.name,
		version: overrides.version ?? "1.0.0",
		description: overrides.description ?? `${overrides.name} skill`,
		origin: overrides.origin ?? "promoted",
		folderPath: overrides.folderPath ?? `/skills/${overrides.name}`,
		skillPath: overrides.skillPath ?? `/skills/${overrides.name}/SKILL.md`,
		...(overrides.tools ? { tools: overrides.tools } : {}),
		...(overrides.tags ? { tags: overrides.tags } : {}),
	};
}

function task(overrides: Partial<TaskSkillContext> = {}): TaskSkillContext {
	return overrides;
}

describe("resolveTaskSkills — explicit skillsNeeded", () => {
	const catalog: SkillEntry[] = [
		skill({ name: "mission-control" }),
		skill({ name: "caveman" }),
		skill({ name: "agent-browser" }),
	];

	test("returns exact-name matches in declared order", () => {
		const out = resolveTaskSkills(catalog, task({ skillsNeeded: ["caveman", "mission-control"] }));
		expect(out.map(s => s.name)).toEqual(["caveman", "mission-control"]);
	});

	test("drops unknown names silently", () => {
		const out = resolveTaskSkills(catalog, task({ skillsNeeded: ["caveman", "non-existent"] }));
		expect(out.map(s => s.name)).toEqual(["caveman"]);
	});

	test("dedupes repeated names", () => {
		const out = resolveTaskSkills(catalog, task({ skillsNeeded: ["caveman", "caveman"] }));
		expect(out.map(s => s.name)).toEqual(["caveman"]);
	});

	test("ignores keyword tokens when skillsNeeded is set", () => {
		const out = resolveTaskSkills(
			catalog,
			task({
				skillsNeeded: ["mission-control"],
				taskName: "agent-browser tour",
				prompt: "Use the agent-browser skill heavily.",
			}),
		);
		expect(out.map(s => s.name)).toEqual(["mission-control"]);
	});
});

describe("resolveTaskSkills — keyword fallback", () => {
	const catalog: SkillEntry[] = [
		skill({ name: "mission-control", description: "Multi-lane mission orchestration" }),
		skill({ name: "frontend-design", description: "Frontend design patterns" }),
		skill({ name: "linear", tags: ["issue-tracking", "project"] }),
	];

	test("matches against taskName tokens", () => {
		const out = resolveTaskSkills(catalog, task({ taskName: "Frontend redesign" }));
		expect(out.map(s => s.name)).toEqual(["frontend-design"]);
	});

	test("matches against fulfillsAssertionIds", () => {
		// VA tokens are unlikely to match any skill, exercising the empty
		// fallback when no skill matches.
		const out = resolveTaskSkills(catalog, task({ fulfillsAssertionIds: ["VA-100"] }));
		expect(out).toEqual([]);
	});

	test("matches against first sentence of prompt", () => {
		const out = resolveTaskSkills(
			catalog,
			task({ prompt: "Track issue progress in Linear. Then return to coding." }),
		);
		expect(out.map(s => s.name)).toEqual(["linear"]);
	});

	test("returns [] when no tokens match", () => {
		const out = resolveTaskSkills(catalog, task({ taskName: "Random unrelated thing" }));
		expect(out).toEqual([]);
	});

	test("returns [] when task has no usable tokens", () => {
		const out = resolveTaskSkills(catalog, task({}));
		expect(out).toEqual([]);
	});

	test("empty skillsNeeded array falls back to keyword matching", () => {
		const out = resolveTaskSkills(catalog, task({ skillsNeeded: [], taskName: "Frontend redesign" }));
		expect(out.map(s => s.name)).toEqual(["frontend-design"]);
	});
});

describe("buildSkillPromptBlock", () => {
	test("returns [] for empty skill list", () => {
		expect(buildSkillPromptBlock([])).toEqual([]);
	});

	test("renders one bullet per skill with skill:// URL + origin + description", () => {
		const lines = buildSkillPromptBlock([
			skill({ name: "mission-control", description: "Multi-lane orchestration" }),
			skill({ name: "caveman", origin: "draft", description: "Caveman speak mode" }),
		]);
		expect(lines).toContain("Relevant skills for this feature:");
		expect(lines).toContain("- skill://mission-control (promoted) — Multi-lane orchestration");
		expect(lines).toContain("- skill://caveman (draft) — Caveman speak mode");
		expect(lines.at(-1)).toContain('Read each via `read "skill://<name>"`');
	});

	test("trims description whitespace", () => {
		const lines = buildSkillPromptBlock([skill({ name: "x", description: "   y   " })]);
		expect(lines).toContain("- skill://x (promoted) — y");
	});
});
