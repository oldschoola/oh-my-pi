/**
 * Unit tests for parsePromptForOrchestrator — the full PROMPT.md metadata
 * parser ported from taskplane discovery.ts:587-813.
 *
 * Uses a tmpdir sandbox: writes PROMPT.md files + invokes the parser against
 * the real file path so readFileSync/resolve behave naturally.
 *
 * Covers:
 *  - Missing file → PARSE_MALFORMED
 *  - Missing/malformed taskId → PARSE_MISSING_ID
 *  - Heading extracts taskId + taskName; folder-name fallback kicks in otherwise
 *  - Default reviewLevel=2, size="M" when absent
 *  - Explicit review level + size upcasing
 *  - Dependency patterns (None, labeled, bullet, inline)
 *  - Execution Target section + inline Repo fallback + invalid → dropped
 *  - File Scope extraction (bullets, backticks, comments skipped)
 *  - Segment DAG parse error propagates as top-level error
 *  - Step-segment duplicate error fails the task
 *  - stepSegmentMap only populated when explicit `#### Segment:` markers present
 *  - Non-fatal segment warnings surface via `warnings`
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parsePromptForOrchestrator } from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-parseprompt-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function writePrompt(folderName: string, content: string): { taskFolder: string; promptPath: string } {
	const taskFolder = join(sandbox, folderName);
	const fs = require("node:fs") as typeof import("node:fs");
	fs.mkdirSync(taskFolder, { recursive: true });
	const promptPath = join(taskFolder, "PROMPT.md");
	writeFileSync(promptPath, content, "utf-8");
	return { taskFolder, promptPath };
}

describe("parsePromptForOrchestrator — required fields", () => {
	test("returns PARSE_MALFORMED when PROMPT.md is missing", () => {
		const taskFolder = join(sandbox, "TASK-001-missing");
		const fs = require("node:fs") as typeof import("node:fs");
		fs.mkdirSync(taskFolder, { recursive: true });
		const promptPath = join(taskFolder, "PROMPT.md");
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "api");
		expect(result.task).toBeNull();
		expect(result.error?.code).toBe("PARSE_MALFORMED");
	});

	test("returns PARSE_MISSING_ID when neither heading nor folder name has an ID", () => {
		const { taskFolder, promptPath } = writePrompt("unnumbered", "# Task: something\n");
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "api");
		expect(result.task).toBeNull();
		expect(result.error?.code).toBe("PARSE_MISSING_ID");
	});

	test("extracts taskId + taskName from `# Task:` heading", () => {
		const { taskFolder, promptPath } = writePrompt("ignored-folder", "# Task: COMP-006 - Pay Bands Implementation\n");
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "hr");
		expect(result.task?.taskId).toBe("COMP-006");
		expect(result.task?.taskName).toBe("Pay Bands Implementation");
		expect(result.error).toBeNull();
	});

	test("falls back to folder name when heading is absent", () => {
		const { taskFolder, promptPath } = writePrompt("TO-014-accrual-engine", "No heading here.\n");
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "hr");
		expect(result.task?.taskId).toBe("TO-014");
		expect(result.task?.taskName).toBe("TO-014-accrual-engine");
	});

	test("em dash in heading is tolerated", () => {
		const { taskFolder, promptPath } = writePrompt("TS-004", "# Task: TS-004 — Launch\n");
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "infra");
		expect(result.task?.taskId).toBe("TS-004");
		expect(result.task?.taskName).toBe("Launch");
	});
});

describe("parsePromptForOrchestrator — defaults & optional fields", () => {
	test('defaults reviewLevel=2 and size="M"', () => {
		const { taskFolder, promptPath } = writePrompt("TA-001", "# Task: TA-001 - plain\n");
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "api");
		expect(result.task?.reviewLevel).toBe(2);
		expect(result.task?.size).toBe("M");
	});

	test("parses explicit review level", () => {
		const content = "# Task: TA-001 - A\n## Review Level: 1 (Plan Only)\n";
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "api");
		expect(result.task?.reviewLevel).toBe(1);
	});

	test("uppercases size marker", () => {
		const content = "# Task: TA-001 - A\n**Size:** s\n";
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "api");
		expect(result.task?.size).toBe("S");
	});

	test("empty fileScope + dependencies when sections absent", () => {
		const { taskFolder, promptPath } = writePrompt("TA-001", "# Task: TA-001 - plain\n");
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "api");
		expect(result.task?.fileScope).toEqual([]);
		expect(result.task?.dependencies).toEqual([]);
	});
});

describe("parsePromptForOrchestrator — dependencies", () => {
	test("None variants yield empty dependencies", () => {
		const content = "# Task: TA-001 - A\n## Dependencies\n**None**\n";
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "api");
		expect(result.task?.dependencies).toEqual([]);
	});

	test("labeled `**Requires:** <ID>` dependencies are captured", () => {
		const content = "# Task: TA-001 - A\n## Dependencies\n**Requires:** COMP-005 (pay data)\n";
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "api");
		expect(result.task?.dependencies).toContain("COMP-005");
	});

	test("bullet dependencies are captured with qualified areas preserved", () => {
		const content = [
			"# Task: TA-001 - A",
			"## Dependencies",
			"- **time-off/TO-014** — accrual engine",
			"- COMP-005 (pay bands)",
			"",
		].join("\n");
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "api");
		expect(result.task?.dependencies).toContain("time-off/TO-014");
		expect(result.task?.dependencies).toContain("COMP-005");
	});

	test("inline dependency references are captured when labeled/bullet patterns miss", () => {
		const content = ["# Task: TA-001 - A", "## Dependencies", "Depends on COMP-009 for setup.", ""].join("\n");
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "api");
		expect(result.task?.dependencies).toContain("COMP-009");
	});
});

describe("parsePromptForOrchestrator — routing & file scope", () => {
	test("extracts promptRepoId from `## Execution Target` section", () => {
		const content = ["# Task: TA-001 - A", "## Execution Target", "**Repo:** api", ""].join("\n");
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "api");
		expect(result.task?.promptRepoId).toBe("api");
	});

	test("falls back to inline `**Workspace:** <id>` when Execution Target absent", () => {
		const content = "# Task: TA-001 - A\n**Workspace:** web-client\n";
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "api");
		expect(result.task?.promptRepoId).toBe("web-client");
	});

	test("invalid repo ID is dropped silently", () => {
		const content = "# Task: TA-001 - A\n**Repo:** BAD_ID\n";
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "api");
		expect(result.task?.promptRepoId).toBeUndefined();
	});

	test("extracts file scope bullets (with and without backticks)", () => {
		const content = [
			"# Task: TA-001 - A",
			"## File Scope",
			"- extensions/task-orchestrator.ts",
			"- `api-service/src/health.js`",
			"",
		].join("\n");
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "api");
		expect(result.task?.fileScope).toEqual(["extensions/task-orchestrator.ts", "api-service/src/health.js"]);
	});
});

describe("parsePromptForOrchestrator — segment metadata", () => {
	test("propagates Segment DAG parse error as top-level failure", () => {
		const content = ["# Task: TA-001 - A", "## Segment DAG", "Repos:", "- api", "Edges:", "- api -> api", ""].join(
			"\n",
		);
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "area");
		expect(result.task).toBeNull();
		expect(result.error?.code).toBe("SEGMENT_DAG_INVALID");
	});

	test("captures valid Segment DAG into explicitSegmentDag", () => {
		const content = [
			"# Task: TA-001 - A",
			"## Segment DAG",
			"Repos:",
			"- api",
			"- web-client",
			"Edges:",
			"- api -> web-client",
			"",
		].join("\n");
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "area");
		expect(result.task?.explicitSegmentDag?.repoIds).toEqual(["api", "web-client"]);
		expect(result.task?.explicitSegmentDag?.edges).toEqual([{ fromRepoId: "api", toRepoId: "web-client" }]);
	});

	test("duplicate segment repoId inside a step fails the task", () => {
		const content = [
			"# Task: TA-001 - A",
			"## Steps",
			"### Step 1: dup",
			"#### Segment: api",
			"- [ ] one",
			"#### Segment: api",
			"- [ ] two",
			"",
		].join("\n");
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "area");
		expect(result.task).toBeNull();
		expect(result.error?.code).toBe("SEGMENT_STEP_DUPLICATE_REPO");
	});

	test("stepSegmentMap is undefined when no explicit `#### Segment:` markers", () => {
		const content = ["# Task: TA-001 - A", "## Steps", "### Step 1: plain", "- [ ] bullet", ""].join("\n");
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "area");
		expect(result.task?.stepSegmentMap).toBeUndefined();
	});

	test("stepSegmentMap is populated when explicit markers exist", () => {
		const content = ["# Task: TA-001 - A", "## Steps", "### Step 1: wire", "#### Segment: api", "- [ ] one", ""].join(
			"\n",
		);
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "area");
		expect(result.task?.stepSegmentMap).toHaveLength(1);
		expect(result.task?.stepSegmentMap?.[0]?.segments[0]?.repoId).toBe("api");
	});

	test("non-fatal segment warnings surface via `warnings`", () => {
		const content = ["# Task: TA-001 - A", "## Steps", "### Step 1: empty", "#### Segment: api", "", ""].join("\n");
		const { taskFolder, promptPath } = writePrompt("TA-001", content);
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "area");
		expect(result.task).not.toBeNull();
		const warn = result.warnings?.find(w => w.code === "SEGMENT_STEP_EMPTY");
		expect(warn).toBeDefined();
	});
});

describe("parsePromptForOrchestrator — paths", () => {
	test("folderPath, taskFolder, and promptPath are absolute resolved paths", () => {
		const { taskFolder, promptPath } = writePrompt("TA-001", "# Task: TA-001 - A\n");
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "area");
		expect(result.task?.folderPath).toBe(resolve(taskFolder));
		expect(result.task?.taskFolder).toBe(resolve(taskFolder));
		expect(result.task?.promptPath).toBe(resolve(promptPath));
	});

	test("areaName is surfaced on the parsed task", () => {
		const { taskFolder, promptPath } = writePrompt("TA-001", "# Task: TA-001 - A\n");
		const result = parsePromptForOrchestrator(promptPath, taskFolder, "my-area");
		expect(result.task?.areaName).toBe("my-area");
	});
});
