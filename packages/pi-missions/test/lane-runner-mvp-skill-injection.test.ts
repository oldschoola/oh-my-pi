/**
 * Fix A: MVP `buildTaskPrompt` must inject the "Relevant skills" block
 * into every prompt sent through `startLaneRunner` → `runTask` →
 * `spawnAgent`. Exercises the real `listAvailableSkills` + resolver
 * chain by seeding a skill on disk and asserting the rendered prompt
 * mentions the matching `skill://<name>` URI.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTaskPrompt } from "../src/missioncontrol";

let sandbox: string;

function writeSkill(name: string, description: string, tags?: string[]): void {
	const root = join(sandbox, ".omp", "skills", name);
	mkdirSync(root, { recursive: true });
	const tagsLine = tags ? `tags: ${tags.join(", ")}\n` : "";
	writeFileSync(
		join(root, "SKILL.md"),
		["---", `name: ${name}`, "version: 1.0.0", `description: ${description}`, `${tagsLine}---`, "", "body", ""].join(
			"\n",
		),
		"utf-8",
	);
}

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-mvp-skill-inject-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

describe("buildTaskPrompt (MVP lane-runner)", () => {
	test("injects relevant skills matched by taskId keyword fallback", async () => {
		writeSkill("mission-control", "Handle multi-lane orchestrated batches");
		writeSkill("agent-browser", "Browser automation CLI");

		const prompt = await buildTaskPrompt("mission-control", { cwd: sandbox });

		expect(prompt).toContain("Mission task: mission-control");
		expect(prompt).toContain("Write a .DONE file");
		expect(prompt).toContain("Relevant skills for this feature:");
		expect(prompt).toContain("skill://mission-control");
		expect(prompt).not.toContain("skill://agent-browser");
		expect(prompt).toContain('Read each via `read "skill://<name>"`');
	});

	test("returns the bare task body when no skills match", async () => {
		writeSkill("linear", "Manage issues in Linear");

		const prompt = await buildTaskPrompt("compile-binary", { cwd: sandbox });

		expect(prompt).toContain("Mission task: compile-binary");
		expect(prompt).not.toContain("Relevant skills for this feature:");
		expect(prompt).not.toContain("skill://");
	});

	test("returns the bare task body when no skills are available", async () => {
		const prompt = await buildTaskPrompt("solo-task", { cwd: sandbox });

		expect(prompt).toContain("Mission task: solo-task");
		expect(prompt).not.toContain("Relevant skills for this feature:");
	});
});
