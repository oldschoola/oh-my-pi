/**
 * Track E2: `## Skills:` metadata parsing in `parsePromptForOrchestrator`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePromptForOrchestrator } from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-skills-parse-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function writePrompt(folderName: string, content: string): { taskFolder: string; promptPath: string } {
	const taskFolder = join(sandbox, folderName);
	mkdirSync(taskFolder, { recursive: true });
	const promptPath = join(taskFolder, "PROMPT.md");
	writeFileSync(promptPath, content, "utf-8");
	return { taskFolder, promptPath };
}

describe("parsePromptForOrchestrator — skills metadata", () => {
	test("extracts comma-separated skill names", () => {
		const { taskFolder, promptPath } = writePrompt(
			"F-001-hello",
			"# Task: F-001 - Hello\n## Skills: mission-control, caveman\n",
		);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.skillsNeeded).toEqual(["mission-control", "caveman"]);
	});

	test("tolerates whitespace-only separation", () => {
		const { taskFolder, promptPath } = writePrompt(
			"F-001-hello",
			"# Task: F-001 - Hello\n## Skills: skill-a  skill-b   skill-c\n",
		);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.skillsNeeded).toEqual(["skill-a", "skill-b", "skill-c"]);
	});

	test("normalises case to lowercase", () => {
		const { taskFolder, promptPath } = writePrompt(
			"F-001-hello",
			"# Task: F-001 - Hello\n## Skills: Mission-Control, CAVEMAN\n",
		);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.skillsNeeded).toEqual(["mission-control", "caveman"]);
	});

	test("drops malformed tokens silently", () => {
		const { taskFolder, promptPath } = writePrompt(
			"F-001-hello",
			"# Task: F-001 - Hello\n## Skills: mission-control, !bad!, _also_bad_, caveman\n",
		);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.skillsNeeded).toEqual(["mission-control", "caveman"]);
	});

	test("deduplicates repeated skill names", () => {
		const { taskFolder, promptPath } = writePrompt("F-001-hello", "# Task: F-001 - Hello\n## Skills: a, a, b\n");
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.skillsNeeded).toEqual(["a", "b"]);
	});

	test("leaves skillsNeeded undefined when heading absent", () => {
		const { taskFolder, promptPath } = writePrompt("F-001-plain", "# Task: F-001 - plain\n");
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.skillsNeeded).toBeUndefined();
	});

	test("coexists with milestone + fulfills metadata without interference", () => {
		const { taskFolder, promptPath } = writePrompt(
			"F-001-hello",
			[
				"# Task: F-001 - Hello",
				"",
				"## Milestone: M-001",
				"## Fulfills: VA-001, VA-002",
				"## Skills: mission-control",
				"## Parent Feature: F-100",
				"",
			].join("\n"),
		);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.milestoneId).toBe("M-001");
		expect(result.task?.fulfillsAssertionIds).toEqual(["VA-001", "VA-002"]);
		expect(result.task?.skillsNeeded).toEqual(["mission-control"]);
		expect(result.task?.parentFeatureId).toBe("F-100");
	});
});
