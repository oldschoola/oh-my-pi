import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StandardsConfig } from "../src/missioncontrol/config-schema";
import {
	appendTableRow,
	type CoreParsedTask,
	displayName,
	extractVerdict,
	generateReviewRequest,
	generateStatusMd,
	isLowRiskStep,
	isStepComplete,
	logExecution,
	logReview,
	parsePromptMd,
	parseStatusMd,
	resolveStandards,
	type StepInfo,
	sanitizeSteeringContent,
	updateStatusField,
	updateStepStatus,
} from "../src/missioncontrol/task-executor-core";

// ── parsePromptMd ────────────────────────────────────────────────────

describe("parsePromptMd", () => {
	test("extracts task id, name, review level, size, steps", () => {
		const content = [
			"# TP-001 - Port quality gate",
			"",
			"## Review Level: 2",
			"",
			"**Size:** L",
			"",
			"## Context to Read First",
			"",
			"- `src/foo.ts`",
			"- `docs/bar.md`",
			"",
			"## Plan",
			"",
			"### Step 1: Wire imports",
			"- [ ] add import",
			"- [x] verify",
			"",
			"### Step 2: Ship it",
			"- [ ] deploy",
			"",
		].join("\n");

		const promptPath = "/proj/tasks/TP-001/PROMPT.md";
		const parsed: CoreParsedTask = parsePromptMd(content, promptPath);

		expect(parsed.taskId).toBe("TP-001");
		expect(parsed.taskName).toBe("Port quality gate");
		expect(parsed.reviewLevel).toBe(2);
		expect(parsed.size).toBe("L");
		expect(parsed.steps.length).toBe(2);
		expect(parsed.steps[0].checkboxes.length).toBe(2);
		expect(parsed.steps[0].totalChecked).toBe(1);
		expect(parsed.steps[0].totalItems).toBe(2);
		expect(parsed.contextDocs).toEqual(["src/foo.ts", "docs/bar.md"]);
	});

	test("falls back to folder name when no title match", () => {
		const parsed = parsePromptMd("no title here", "/proj/tasks/abc-42/PROMPT.md");
		expect(parsed.taskId).toBe("abc-42");
		expect(parsed.taskName).toBe("abc-42");
	});

	test("defaults size to M when missing", () => {
		const parsed = parsePromptMd("# TP-002 - X", "/p/PROMPT.md");
		expect(parsed.size).toBe("M");
	});
});

// ── parseStatusMd ────────────────────────────────────────────────────

describe("parseStatusMd", () => {
	test("extracts steps, review counter, iteration, checkboxes", () => {
		const content = [
			"# Status",
			"",
			"**Review Counter:** 3",
			"**Iteration:** 7",
			"",
			"### Step 1: first",
			"**Status:** ✅ Complete",
			"- [x] a",
			"- [x] b",
			"",
			"### Step 2: second",
			"**Status:** 🟨 In Progress",
			"- [x] c",
			"- [ ] d",
			"",
		].join("\n");

		const parsed = parseStatusMd(content);
		expect(parsed.reviewCounter).toBe(3);
		expect(parsed.iteration).toBe(7);
		expect(parsed.steps.length).toBe(2);
		expect(parsed.steps[0].status).toBe("complete");
		expect(parsed.steps[0].totalChecked).toBe(2);
		expect(parsed.steps[1].status).toBe("in-progress");
		expect(parsed.steps[1].totalChecked).toBe(1);
		expect(parsed.steps[1].totalItems).toBe(2);
	});
});

// ── generateStatusMd ─────────────────────────────────────────────────

describe("generateStatusMd", () => {
	test("produces STATUS.md containing task id, steps, section tables", () => {
		const step: StepInfo = {
			number: 1,
			name: "Do thing",
			status: "not-started",
			checkboxes: [{ text: "write code", checked: false }],
			totalChecked: 0,
			totalItems: 1,
		};
		const md = generateStatusMd({
			taskId: "T-99",
			taskName: "demo",
			reviewLevel: 1,
			size: "S",
			steps: [step],
		});
		expect(md).toContain("# T-99: demo");
		expect(md).toContain("**Size:** S");
		expect(md).toContain("### Step 1: Do thing");
		expect(md).toContain("## Execution Log");
		expect(md).toContain("## Reviews");
		expect(md).toContain("## Blockers");
	});
});

// ── STATUS.md mutation ───────────────────────────────────────────────

describe("STATUS.md mutation helpers", () => {
	function setup(content: string): string {
		const tmp = mkdtempSync(join(tmpdir(), "tec-"));
		const statusPath = join(tmp, "STATUS.md");
		writeFileSync(statusPath, content, "utf-8");
		return statusPath;
	}

	test("updateStatusField replaces existing field", () => {
		const path = setup("**Status:** 🔵 Ready\n");
		try {
			updateStatusField(path, "Status", "✅ Done");
			expect(readFileSync(path, "utf-8")).toContain("**Status:** ✅ Done");
		} finally {
			rmSync(path, { recursive: false, force: true });
		}
	});

	test("updateStepStatus flips step status", () => {
		const path = setup("### Step 2: x\n**Status:** ⬜ Not Started\n");
		try {
			updateStepStatus(path, 2, "complete");
			expect(readFileSync(path, "utf-8")).toContain("**Status:** ✅ Complete");
		} finally {
			rmSync(path, { recursive: false, force: true });
		}
	});

	test("appendTableRow inserts under named section", () => {
		const content = [
			"## Execution Log",
			"",
			"| Timestamp | Action | Outcome |",
			"|-----------|--------|---------|",
			"| 2026-01-01 | staged | ok |",
			"",
			"---",
			"",
		].join("\n");
		const path = setup(content);
		try {
			appendTableRow(path, "Execution Log", "| 2026-01-02 | run | ok |");
			const after = readFileSync(path, "utf-8");
			expect(after).toContain("| 2026-01-02 | run | ok |");
			const newRowIdx = after.indexOf("| 2026-01-02 | run | ok |");
			const stagedIdx = after.indexOf("| 2026-01-01 | staged | ok |");
			const sectionCloseIdx = after.indexOf("\n---\n", after.indexOf("Execution Log"));
			expect(stagedIdx).toBeLessThan(newRowIdx);
			expect(newRowIdx).toBeLessThan(sectionCloseIdx);
		} finally {
			rmSync(path, { recursive: false, force: true });
		}
	});

	test("logExecution appends a timestamped row", () => {
		const path = setup("## Execution Log\n\n| A | B | C |\n|---|---|---|\n");
		try {
			logExecution(path, "act", "outcome");
			const after = readFileSync(path, "utf-8");
			expect(after).toMatch(/\| \d{4}-\d{2}-\d{2} \d{2}:\d{2} \| act \| outcome \|/);
		} finally {
			rmSync(path, { recursive: false, force: true });
		}
	});

	test("logReview appends a review row", () => {
		const path = setup("## Reviews\n\n| # | Type | Step | Verdict | File |\n|---|---|---|---|---|\n");
		try {
			logReview(path, "1", "plan", 2, "APPROVE", "rev.md");
			const after = readFileSync(path, "utf-8");
			expect(after).toContain("| 1 | plan | Step 2 | APPROVE | rev.md |");
		} finally {
			rmSync(path, { recursive: false, force: true });
		}
	});
});

// ── sanitizeSteeringContent ──────────────────────────────────────────

describe("sanitizeSteeringContent", () => {
	test("collapses newlines and escapes pipes", () => {
		expect(sanitizeSteeringContent("a\nb|c")).toBe("a / b\\|c");
	});

	test("truncates over 200 chars", () => {
		const out = sanitizeSteeringContent("x".repeat(300));
		expect(out.length).toBe(200);
		expect(out.endsWith("...")).toBe(true);
	});
});

// ── isStepComplete / isLowRiskStep ───────────────────────────────────

describe("isStepComplete", () => {
	test("explicit complete status → true", () => {
		const s: StepInfo = {
			number: 1,
			name: "x",
			status: "complete",
			checkboxes: [],
			totalChecked: 0,
			totalItems: 0,
		};
		expect(isStepComplete(s)).toBe(true);
	});

	test("all checkboxes checked → true", () => {
		const s: StepInfo = {
			number: 1,
			name: "x",
			status: "not-started",
			checkboxes: [{ text: "a", checked: true }],
			totalChecked: 1,
			totalItems: 1,
		};
		expect(isStepComplete(s)).toBe(true);
	});

	test("empty checkboxes + not-started → false", () => {
		const s: StepInfo = {
			number: 1,
			name: "x",
			status: "not-started",
			checkboxes: [],
			totalChecked: 0,
			totalItems: 0,
		};
		expect(isStepComplete(s)).toBe(false);
	});

	test("undefined → false", () => {
		expect(isStepComplete(undefined)).toBe(false);
	});
});

describe("isLowRiskStep", () => {
	test("first and last steps are low risk", () => {
		expect(isLowRiskStep(0, 5)).toBe(true);
		expect(isLowRiskStep(4, 5)).toBe(true);
	});
	test("middle step not low risk", () => {
		expect(isLowRiskStep(2, 5)).toBe(false);
	});
	test("zero steps → false", () => {
		expect(isLowRiskStep(0, 0)).toBe(false);
	});
});

// ── extractVerdict ───────────────────────────────────────────────────

describe("extractVerdict", () => {
	test("standard header APPROVE", () => {
		expect(extractVerdict("### Verdict: APPROVE\nLooks good")).toBe("APPROVE");
	});
	test("standard header REVISE lowercase input", () => {
		expect(extractVerdict("## verdict: revise")).toBe("REVISE");
	});
	test("non-standard 'changes requested'", () => {
		expect(extractVerdict("I have changes requested on line 5")).toBe("REVISE");
	});
	test("non-standard 'rethink'", () => {
		expect(extractVerdict("Please rethink the architecture")).toBe("RETHINK");
	});
	test("UNKNOWN fallback", () => {
		expect(extractVerdict("plain commentary")).toBe("UNKNOWN");
	});
	test("'cannot approve' does not trigger APPROVE", () => {
		expect(extractVerdict("i cannot approve this")).toBe("UNKNOWN");
	});
});

// ── resolveStandards ─────────────────────────────────────────────────

describe("resolveStandards", () => {
	const globalStandards: StandardsConfig = {
		docs: ["docs/global.md"],
		rules: ["no any"],
	};

	test("no area match → global standards", () => {
		const result = resolveStandards(globalStandards, {}, {}, "/proj/foo/task");
		expect(result).toEqual(globalStandards);
	});

	test("area match with override applied", () => {
		const result = resolveStandards(
			globalStandards,
			{ backend: { docs: ["docs/backend.md"] } },
			{ backend: { path: "backend/" } },
			"/proj/backend/auth",
		);
		expect(result.docs).toEqual(["docs/backend.md"]);
		expect(result.rules).toEqual(["no any"]);
	});

	test("area match without override returns global", () => {
		const result = resolveStandards(globalStandards, {}, { backend: { path: "backend/" } }, "/proj/backend/auth");
		expect(result).toEqual(globalStandards);
	});

	test("windows-style path normalized", () => {
		const result = resolveStandards(
			globalStandards,
			{ frontend: { rules: ["prefer-const"] } },
			{ frontend: { path: "frontend/" } },
			"C:\\proj\\frontend\\ui",
		);
		expect(result.rules).toEqual(["prefer-const"]);
	});
});

// ── generateReviewRequest ────────────────────────────────────────────

describe("generateReviewRequest", () => {
	const standards: StandardsConfig = {
		docs: ["docs/a.md", "docs/b.md"],
		rules: ["rule one", "rule two"],
	};

	test("plan review includes prompt/status paths and standards", () => {
		const md = generateReviewRequest("plan", 3, "write tests", "/p/PROMPT.md", "/p", "demo", standards, "/out.md");
		expect(md).toContain("Plan Review");
		expect(md).toContain("Step 3: write tests");
		expect(md).toContain("/p/PROMPT.md");
		expect(md).toContain("docs/a.md");
		expect(md).toContain("rule one");
		expect(md).toContain("/out.md");
	});

	test("code review uses baseline diff commands when baseline provided", () => {
		const md = generateReviewRequest("code", 2, "impl", "/p/PROMPT.md", "/p", "demo", standards, "/out.md", "abc123");
		expect(md).toContain("git diff abc123..HEAD --name-only");
		expect(md).toContain("Step baseline commit:** abc123");
	});

	test("code review without baseline falls back to plain git diff", () => {
		const md = generateReviewRequest("code", 1, "impl", "/p/PROMPT.md", "/p", "demo", standards, "/out.md");
		expect(md).toContain("git diff --name-only");
		expect(md).not.toContain("Step baseline commit:");
	});
});

// ── displayName ──────────────────────────────────────────────────────

describe("displayName", () => {
	test("kebab-case → Title Case", () => {
		expect(displayName("my-fancy-task")).toBe("My Fancy Task");
	});
	test("single word capitalized", () => {
		expect(displayName("word")).toBe("Word");
	});
	test("empty string → empty string", () => {
		expect(displayName("")).toBe("");
	});
});
