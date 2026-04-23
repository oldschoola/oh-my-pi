/**
 * Unit tests for mission skill discovery + draft lifecycle (Track E).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createSkillDraft,
	discardSkillDraft,
	findMatchingSkills,
	listAvailableSkills,
	listDraftSkills,
	listPromotedSkills,
	loadSkillContent,
	normaliseSkillName,
	parseSkillFrontMatter,
	promoteSkillDraft,
	type SkillEntry,
	skillDir,
	skillDraftDir,
	skillDraftsRoot,
	skillsRoot,
} from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-skills-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function seedSkill(cwd: string, name: string, content: string, kind: "promoted" | "draft" = "promoted"): void {
	const dir = kind === "promoted" ? skillDir(cwd, name) : skillDraftDir(cwd, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
}

function skillMd(opts: {
	name: string;
	description?: string;
	version?: string;
	tools?: string;
	tags?: string;
}): string {
	const front = ["---", `name: ${opts.name}`];
	if (opts.version) front.push(`version: ${opts.version}`);
	if (opts.description) front.push(`description: ${opts.description}`);
	if (opts.tools) front.push(`tools: ${opts.tools}`);
	if (opts.tags) front.push(`tags: ${opts.tags}`);
	front.push("---");
	return `${front.join("\n")}\n\nbody\n`;
}

describe("normaliseSkillName", () => {
	test("lowercases and hyphenates", () => {
		expect(normaliseSkillName("My Skill Name!")).toBe("my-skill-name");
	});

	test("drops leading/trailing separators", () => {
		expect(normaliseSkillName("   foo   ")).toBe("foo");
		expect(normaliseSkillName("--a--")).toBe("a");
	});
});

describe("parseSkillFrontMatter", () => {
	test("returns null when no front-matter", () => {
		expect(parseSkillFrontMatter("plain body")).toBeNull();
	});

	test("parses basic key/value pairs", () => {
		const front = parseSkillFrontMatter("---\nname: foo\nversion: 1.0.0\ndescription: does x\n---\n\nbody\n");
		expect(front).toEqual({ name: "foo", version: "1.0.0", description: "does x" });
	});

	test("skips malformed lines", () => {
		const front = parseSkillFrontMatter("---\nname: foo\n!bad\n---\n");
		expect(front?.name).toBe("foo");
	});
});

describe("skillsRoot / skillDraftsRoot", () => {
	test("resolves under <projectDir>/skills/", () => {
		expect(skillsRoot(sandbox).endsWith("skills")).toBe(true);
		expect(skillDraftsRoot(sandbox)).toBe(join(skillsRoot(sandbox), "drafts"));
	});
});

describe("listPromotedSkills + listDraftSkills", () => {
	test("empty when directories absent", async () => {
		expect(await listPromotedSkills(sandbox)).toEqual([]);
		expect(await listDraftSkills(sandbox)).toEqual([]);
	});

	test("discovers promoted skills", async () => {
		seedSkill(sandbox, "alpha", skillMd({ name: "alpha", description: "alpha skill" }));
		seedSkill(sandbox, "beta", skillMd({ name: "beta", description: "beta skill", version: "2.0.0" }));
		const entries = await listPromotedSkills(sandbox);
		expect(entries.map(e => e.name)).toEqual(["alpha", "beta"]);
		expect(entries[1]?.version).toBe("2.0.0");
		expect(entries.every(e => e.origin === "promoted")).toBe(true);
	});

	test("excludes the drafts/ subfolder from promoted list", async () => {
		seedSkill(sandbox, "draft-1", skillMd({ name: "draft-1", description: "d" }), "draft");
		seedSkill(sandbox, "alpha", skillMd({ name: "alpha", description: "a" }));
		const promoted = await listPromotedSkills(sandbox);
		expect(promoted.map(e => e.name)).toEqual(["alpha"]);
	});

	test("skips folders with invalid names", async () => {
		const bad = join(skillsRoot(sandbox), "Bad Name");
		mkdirSync(bad, { recursive: true });
		writeFileSync(join(bad, "SKILL.md"), skillMd({ name: "bad name", description: "x" }), "utf-8");
		const entries = await listPromotedSkills(sandbox);
		expect(entries).toEqual([]);
	});

	test("skips folders without SKILL.md", async () => {
		const dir = skillDir(sandbox, "empty");
		mkdirSync(dir, { recursive: true });
		expect(await listPromotedSkills(sandbox)).toEqual([]);
	});

	test("parses tags as comma-separated list", async () => {
		seedSkill(sandbox, "multi", skillMd({ name: "multi", description: "x", tags: "auth, ui, perf" }));
		const [entry] = await listPromotedSkills(sandbox);
		expect(entry?.tags).toEqual(["auth", "ui", "perf"]);
	});
});

describe("listAvailableSkills", () => {
	test("returns promoted entries before drafts", async () => {
		seedSkill(sandbox, "a-prom", skillMd({ name: "a-prom", description: "p" }));
		seedSkill(sandbox, "b-draft", skillMd({ name: "b-draft", description: "d" }), "draft");
		const all = await listAvailableSkills(sandbox);
		expect(all.map(e => e.origin)).toEqual(["promoted", "draft"]);
	});
});

describe("findMatchingSkills", () => {
	const skills: SkillEntry[] = [
		{
			name: "auth-helper",
			description: "Handles login + token refresh",
			version: "",
			origin: "promoted",
			folderPath: "",
			skillPath: "",
			tags: ["auth"],
		},
		{
			name: "render-ui",
			description: "Renders the React UI shell",
			version: "",
			origin: "promoted",
			folderPath: "",
			skillPath: "",
		},
	];

	test("empty tokens returns empty", () => {
		expect(findMatchingSkills(skills, [])).toEqual([]);
	});

	test("matches on name substring", () => {
		expect(findMatchingSkills(skills, ["auth"])?.[0]?.name).toBe("auth-helper");
	});

	test("matches on description substring", () => {
		expect(findMatchingSkills(skills, ["react ui"])?.[0]?.name).toBe("render-ui");
	});

	test("matches on tag", () => {
		expect(findMatchingSkills(skills, ["auth"])?.[0]?.name).toBe("auth-helper");
	});

	test("case-insensitive match", () => {
		expect(findMatchingSkills(skills, ["AUTH"])).toHaveLength(1);
	});

	test("returns multiple skills when token matches several", () => {
		const skillsExt = [
			...skills,
			{ ...skills[0]!, name: "auth-session", description: "session helper", tags: ["auth"] } satisfies SkillEntry,
		];
		expect(findMatchingSkills(skillsExt, ["auth"]).length).toBeGreaterThanOrEqual(2);
	});
});

describe("loadSkillContent", () => {
	test("returns null when absent", async () => {
		expect(await loadSkillContent(sandbox, "missing")).toBeNull();
	});

	test("returns promoted content", async () => {
		seedSkill(sandbox, "alpha", skillMd({ name: "alpha", description: "a" }));
		const content = await loadSkillContent(sandbox, "alpha");
		expect(content).toContain("name: alpha");
	});

	test("falls through to draft when promoted absent", async () => {
		seedSkill(sandbox, "only-draft", skillMd({ name: "only-draft", description: "d" }), "draft");
		const content = await loadSkillContent(sandbox, "only-draft");
		expect(content).toContain("name: only-draft");
	});
});

describe("createSkillDraft", () => {
	test("creates SKILL.md with provided metadata", async () => {
		const entry = await createSkillDraft({
			cwd: sandbox,
			name: "new-draft",
			description: "One-line description.",
			version: "0.1.0",
			tools: "read,write",
			tags: ["scope", "demo"],
			body: "Extended body.",
		});
		expect(entry.origin).toBe("draft");
		expect(existsSync(entry.skillPath)).toBe(true);
		const content = require("node:fs").readFileSync(entry.skillPath, "utf-8") as string;
		expect(content).toContain("name: new-draft");
		expect(content).toContain("version: 0.1.0");
		expect(content).toContain("tools: read,write");
		expect(content).toContain("tags: scope, demo");
		expect(content).toContain("Extended body.");
	});

	test("rejects invalid names", async () => {
		await expect(createSkillDraft({ cwd: sandbox, name: "Bad Name", description: "d" })).rejects.toThrow(
			/Invalid skill name/,
		);
	});

	test("rejects empty description", async () => {
		await expect(createSkillDraft({ cwd: sandbox, name: "valid", description: "   " })).rejects.toThrow(
			/description/,
		);
	});

	test("rejects duplicate draft", async () => {
		await createSkillDraft({ cwd: sandbox, name: "dup", description: "x" });
		await expect(createSkillDraft({ cwd: sandbox, name: "dup", description: "y" })).rejects.toThrow(/already exists/);
	});

	test("rejects when a promoted skill of the same name exists", async () => {
		seedSkill(sandbox, "promoted", skillMd({ name: "promoted", description: "p" }));
		await expect(createSkillDraft({ cwd: sandbox, name: "promoted", description: "x" })).rejects.toThrow(
			/promoted skill/,
		);
	});
});

describe("promoteSkillDraft", () => {
	test("moves draft to promoted folder", async () => {
		const draft = await createSkillDraft({ cwd: sandbox, name: "to-promote", description: "d" });
		expect(existsSync(draft.folderPath)).toBe(true);
		const entry = await promoteSkillDraft(sandbox, "to-promote");
		expect(entry.origin).toBe("promoted");
		expect(existsSync(draft.folderPath)).toBe(false);
		expect(existsSync(entry.folderPath)).toBe(true);
	});

	test("throws when draft absent", async () => {
		await expect(promoteSkillDraft(sandbox, "missing")).rejects.toThrow(/not found/);
	});

	test("throws when promoted already exists", async () => {
		seedSkill(sandbox, "conflict", skillMd({ name: "conflict", description: "p" }));
		await createSkillDraft({ cwd: sandbox, name: "conflict", description: "d" }).catch(() => null);
		const draftFolder = skillDraftDir(sandbox, "conflict");
		mkdirSync(draftFolder, { recursive: true });
		writeFileSync(join(draftFolder, "SKILL.md"), skillMd({ name: "conflict", description: "d" }), "utf-8");
		await expect(promoteSkillDraft(sandbox, "conflict")).rejects.toThrow(/Cannot promote/);
	});
});

describe("discardSkillDraft", () => {
	test("deletes draft directory", async () => {
		await createSkillDraft({ cwd: sandbox, name: "gone", description: "d" });
		expect(existsSync(skillDraftDir(sandbox, "gone"))).toBe(true);
		expect(await discardSkillDraft(sandbox, "gone")).toBe(true);
		expect(existsSync(skillDraftDir(sandbox, "gone"))).toBe(false);
	});

	test("returns false when draft absent (idempotent)", async () => {
		expect(await discardSkillDraft(sandbox, "missing")).toBe(false);
	});

	test("rejects invalid name", async () => {
		await expect(discardSkillDraft(sandbox, "Bad Name")).rejects.toThrow(/Invalid/);
	});
});
