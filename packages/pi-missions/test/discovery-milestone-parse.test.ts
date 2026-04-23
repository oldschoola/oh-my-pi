/**
 * Milestone + fulfills metadata parsing (Track A2).
 *
 * Covers parsePromptForOrchestrator's handling of:
 *   ## Milestone: M-001
 *   ## Fulfills: VA-001, VA-002
 *   ## Parent Feature: F-100
 *   ## Fix Feature: true
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePromptForOrchestrator } from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-milestone-parse-"));
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

describe("parsePromptForOrchestrator — milestone metadata", () => {
	test("extracts milestoneId from `## Milestone:` heading", () => {
		const { taskFolder, promptPath } = writePrompt("F-001-hello", "# Task: F-001 - Hello\n\n## Milestone: M-001\n");
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.milestoneId).toBe("M-001");
	});

	test("leaves milestoneId undefined when heading absent", () => {
		const { taskFolder, promptPath } = writePrompt("F-001-plain", "# Task: F-001 - plain\n");
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.milestoneId).toBeUndefined();
	});

	test("extracts fulfills assertion IDs (comma-separated)", () => {
		const { taskFolder, promptPath } = writePrompt(
			"F-001-hello",
			"# Task: F-001 - Hello\n\n## Milestone: M-001\n## Fulfills: VA-001, VA-002, VA-017\n",
		);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.fulfillsAssertionIds).toEqual(["VA-001", "VA-002", "VA-017"]);
	});

	test("tolerates whitespace-only separation in Fulfills", () => {
		const { taskFolder, promptPath } = writePrompt(
			"F-001-hello",
			"# Task: F-001 - Hello\n## Fulfills: VA-001  VA-002\n",
		);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.fulfillsAssertionIds).toEqual(["VA-001", "VA-002"]);
	});

	test("ignores malformed tokens in Fulfills", () => {
		const { taskFolder, promptPath } = writePrompt(
			"F-001-hello",
			"# Task: F-001 - Hello\n## Fulfills: VA-001, not-an-id, VA-2, VA-003\n",
		);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.fulfillsAssertionIds).toEqual(["VA-001", "VA-003"]);
	});

	test("deduplicates repeated assertion ids", () => {
		const { taskFolder, promptPath } = writePrompt(
			"F-001-hello",
			"# Task: F-001 - Hello\n## Fulfills: VA-001, VA-001, VA-002\n",
		);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.fulfillsAssertionIds).toEqual(["VA-001", "VA-002"]);
	});

	test("extracts Parent Feature + Fix Feature flags", () => {
		const { taskFolder, promptPath } = writePrompt(
			"FIX-001-001-a",
			"# Task: FIX-001-001 - Fix missing file\n\n## Milestone: M-001\n## Fulfills: VA-001\n## Parent Feature: F-100\n## Fix Feature: true\n",
		);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.parentFeatureId).toBe("F-100");
		expect(result.task?.isFixFeature).toBe(true);
	});

	test("Fix Feature absent or 'no' leaves flag unset", () => {
		const { taskFolder, promptPath } = writePrompt("F-001-plain", "# Task: F-001 - plain\n## Fix Feature: no\n");
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.isFixFeature).toBeUndefined();
	});

	test("milestone/fulfills coexist with existing metadata", () => {
		const { taskFolder, promptPath } = writePrompt(
			"F-001-hello",
			[
				"# Task: F-001 - Hello",
				"",
				"**Size:** L",
				"",
				"## Review Level: 1",
				"",
				"## Milestone: M-002",
				"",
				"## Fulfills: VA-010",
				"",
				"## Dependencies",
				"- F-000",
				"",
			].join("\n"),
		);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "core");
		expect(result.task?.size).toBe("L");
		expect(result.task?.reviewLevel).toBe(1);
		expect(result.task?.milestoneId).toBe("M-002");
		expect(result.task?.fulfillsAssertionIds).toEqual(["VA-010"]);
		expect(result.task?.dependencies).toContain("F-000");
	});
});
