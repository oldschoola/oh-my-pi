import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyStatusReconciliation,
	applyVerdictRules,
	buildFixAgentPrompt,
	FEEDBACK_FILENAME,
	generateFeedbackMd,
	generateQualityGatePrompt,
	parseVerdict,
	type QualityGateContext,
	type ReviewFinding,
	type ReviewVerdict,
	readAndEvaluateVerdict,
	type StatusReconciliation,
	VERDICT_FILENAME,
} from "../src/missioncontrol/quality-gate";

function makeVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
	return {
		verdict: "PASS",
		confidence: "high",
		summary: "all good",
		findings: [],
		statusReconciliation: [],
		...overrides,
	};
}

function finding(
	severity: ReviewFinding["severity"],
	category: ReviewFinding["category"] = "incomplete_work",
): ReviewFinding {
	return {
		severity,
		category,
		description: `${severity} finding`,
		file: "src/foo.ts",
		remediation: "fix it",
	};
}

// ── applyVerdictRules ────────────────────────────────────────────────

describe("applyVerdictRules — no_critical threshold", () => {
	test("passes with no findings", () => {
		const result = applyVerdictRules(makeVerdict(), "no_critical");
		expect(result.pass).toBe(true);
		expect(result.failReasons).toEqual([]);
	});

	test("passes with important findings below threshold", () => {
		const v = makeVerdict({ findings: [finding("important"), finding("important")] });
		const result = applyVerdictRules(v, "no_critical");
		expect(result.pass).toBe(true);
	});

	test("passes with many suggestions", () => {
		const v = makeVerdict({ findings: Array.from({ length: 10 }, () => finding("suggestion")) });
		const result = applyVerdictRules(v, "no_critical");
		expect(result.pass).toBe(true);
	});

	test("fails with any critical finding", () => {
		const v = makeVerdict({ findings: [finding("critical")] });
		const result = applyVerdictRules(v, "no_critical");
		expect(result.pass).toBe(false);
		expect(result.failReasons[0].rule).toBe("critical_finding");
	});

	test("fails with status_mismatch category", () => {
		const v = makeVerdict({ findings: [finding("important", "status_mismatch")] });
		const result = applyVerdictRules(v, "no_critical");
		expect(result.pass).toBe(false);
		expect(result.failReasons[0].rule).toBe("status_mismatch");
	});
});

describe("applyVerdictRules — no_important threshold", () => {
	test("passes with 2 important findings", () => {
		const v = makeVerdict({ findings: [finding("important"), finding("important")] });
		expect(applyVerdictRules(v, "no_important").pass).toBe(true);
	});

	test("fails at exactly 3 important findings", () => {
		const v = makeVerdict({ findings: [finding("important"), finding("important"), finding("important")] });
		const result = applyVerdictRules(v, "no_important");
		expect(result.pass).toBe(false);
		expect(result.failReasons[0].rule).toBe("important_threshold");
	});
});

describe("applyVerdictRules — all_clear threshold", () => {
	test("passes with zero findings", () => {
		expect(applyVerdictRules(makeVerdict(), "all_clear").pass).toBe(true);
	});

	test("fails with a single suggestion", () => {
		const v = makeVerdict({ findings: [finding("suggestion")] });
		expect(applyVerdictRules(v, "all_clear").pass).toBe(false);
	});

	test("fails with a single important finding", () => {
		const v = makeVerdict({ findings: [finding("important")] });
		expect(applyVerdictRules(v, "all_clear").pass).toBe(false);
	});
});

describe("applyVerdictRules — verdict says NEEDS_FIXES", () => {
	test("respects NEEDS_FIXES even without findings", () => {
		const v = makeVerdict({ verdict: "NEEDS_FIXES", summary: "something fishy" });
		const result = applyVerdictRules(v, "no_critical");
		expect(result.pass).toBe(false);
		expect(result.failReasons[0].rule).toBe("verdict_says_needs_fixes");
	});

	test("critical rule takes precedence over verdict-says rule", () => {
		const v = makeVerdict({ verdict: "NEEDS_FIXES", findings: [finding("critical")] });
		const result = applyVerdictRules(v, "no_critical");
		expect(result.failReasons.some(r => r.rule === "critical_finding")).toBe(true);
		expect(result.failReasons.some(r => r.rule === "verdict_says_needs_fixes")).toBe(false);
	});
});

// ── parseVerdict (fail-open) ─────────────────────────────────────────

describe("parseVerdict — fail-open policy", () => {
	test("empty string → PASS fail-open", () => {
		const v = parseVerdict("");
		expect(v.verdict).toBe("PASS");
		expect(v.confidence).toBe("low");
	});

	test("null → PASS fail-open", () => {
		expect(parseVerdict(null).verdict).toBe("PASS");
	});

	test("malformed JSON → PASS fail-open", () => {
		const v = parseVerdict("{not json");
		expect(v.verdict).toBe("PASS");
		expect(v.summary).toContain("Malformed JSON");
	});

	test("non-object JSON → PASS fail-open", () => {
		expect(parseVerdict("[1,2,3]").verdict).toBe("PASS");
		expect(parseVerdict("42").verdict).toBe("PASS");
	});

	test("invalid verdict value → PASS fail-open", () => {
		expect(parseVerdict(JSON.stringify({ verdict: "MAYBE" })).verdict).toBe("PASS");
	});

	test("valid PASS round-trip", () => {
		const input = {
			verdict: "PASS",
			confidence: "high",
			summary: "ok",
			findings: [],
			statusReconciliation: [],
		};
		const v = parseVerdict(JSON.stringify(input));
		expect(v.verdict).toBe("PASS");
		expect(v.confidence).toBe("high");
	});

	test("valid NEEDS_FIXES with findings", () => {
		const input = {
			verdict: "NEEDS_FIXES",
			confidence: "medium",
			summary: "issues",
			findings: [
				{
					severity: "critical",
					category: "missing_requirement",
					description: "missing feature",
					file: "a.ts",
					remediation: "add it",
				},
			],
			statusReconciliation: [],
		};
		const v = parseVerdict(JSON.stringify(input));
		expect(v.verdict).toBe("NEEDS_FIXES");
		expect(v.findings.length).toBe(1);
		expect(v.findings[0].severity).toBe("critical");
	});

	test("skips invalid findings", () => {
		const input = {
			verdict: "PASS",
			confidence: "high",
			summary: "",
			findings: [
				{ severity: "bogus", category: "missing_requirement", description: "x" },
				{ severity: "critical", category: "invalid_cat", description: "x" },
				{ severity: "critical", category: "missing_requirement", description: "" },
				{ severity: "critical", category: "missing_requirement", description: "valid" },
			],
			statusReconciliation: [],
		};
		const v = parseVerdict(JSON.stringify(input));
		expect(v.findings.length).toBe(1);
		expect(v.findings[0].description).toBe("valid");
	});
});

// ── readAndEvaluateVerdict (file I/O) ────────────────────────────────

describe("readAndEvaluateVerdict", () => {
	test("missing file → fail-open PASS", () => {
		const tmp = mkdtempSync(join(tmpdir(), "qg-read-"));
		try {
			const result = readAndEvaluateVerdict(tmp, "no_critical");
			expect(result.verdict.verdict).toBe("PASS");
			expect(result.evaluation.pass).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("malformed file → fail-open PASS", () => {
		const tmp = mkdtempSync(join(tmpdir(), "qg-read-"));
		try {
			writeFileSync(join(tmp, VERDICT_FILENAME), "{garbage", "utf-8");
			const result = readAndEvaluateVerdict(tmp, "no_critical");
			expect(result.verdict.verdict).toBe("PASS");
			expect(result.evaluation.pass).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("valid NEEDS_FIXES verdict → evaluation fails", () => {
		const tmp = mkdtempSync(join(tmpdir(), "qg-read-"));
		try {
			const verdict = {
				verdict: "NEEDS_FIXES",
				confidence: "high",
				summary: "broken",
				findings: [
					{
						severity: "critical",
						category: "incorrect_implementation",
						description: "wrong",
						file: "a.ts",
						remediation: "fix",
					},
				],
				statusReconciliation: [],
			};
			writeFileSync(join(tmp, VERDICT_FILENAME), JSON.stringify(verdict), "utf-8");
			const result = readAndEvaluateVerdict(tmp, "no_critical");
			expect(result.evaluation.pass).toBe(false);
			expect(result.verdict.findings.length).toBe(1);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ── generateQualityGatePrompt ────────────────────────────────────────

describe("generateQualityGatePrompt", () => {
	test("produces threshold-aware prompt mentioning VERDICT_FILENAME", () => {
		const tmp = mkdtempSync(join(tmpdir(), "qg-prompt-"));
		try {
			const ctx: QualityGateContext = {
				taskFolder: tmp,
				promptPath: join(tmp, "PROMPT.md"),
				taskId: "T-001",
				projectName: "demo",
				passThreshold: "no_critical",
			};
			writeFileSync(ctx.promptPath, "# goal\n", "utf-8");
			writeFileSync(join(tmp, "STATUS.md"), "- [ ] do thing\n", "utf-8");

			const prompt = generateQualityGatePrompt(ctx, tmp);
			expect(prompt).toContain(VERDICT_FILENAME);
			expect(prompt).toContain("T-001");
			expect(prompt).toContain("no_critical");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("all_clear threshold gets stricter language", () => {
		const tmp = mkdtempSync(join(tmpdir(), "qg-prompt-"));
		try {
			const ctx: QualityGateContext = {
				taskFolder: tmp,
				promptPath: join(tmp, "PROMPT.md"),
				taskId: "T-002",
				projectName: "demo",
				passThreshold: "all_clear",
			};
			writeFileSync(ctx.promptPath, "x", "utf-8");
			const prompt = generateQualityGatePrompt(ctx, tmp);
			expect(prompt).toContain("all_clear");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ── applyStatusReconciliation ────────────────────────────────────────

describe("applyStatusReconciliation", () => {
	function setup(statusContent: string): string {
		const tmp = mkdtempSync(join(tmpdir(), "qg-recon-"));
		writeFileSync(join(tmp, "STATUS.md"), statusContent, "utf-8");
		return tmp;
	}

	test("checks unchecked box when work is done", () => {
		const tmp = setup("- [ ] write the feature\n- [ ] add tests\n");
		try {
			const recons: StatusReconciliation[] = [
				{ checkbox: "write the feature", actualState: "done", evidence: "commit abc" },
			];
			const result = applyStatusReconciliation(join(tmp, "STATUS.md"), recons);
			expect(result.changed).toBe(1);
			expect(result.actions[0].outcome).toBe("checked");
			const after = readFileSync(join(tmp, "STATUS.md"), "utf-8");
			expect(after).toContain("- [x] write the feature");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("unchecks checked box when work is not done", () => {
		const tmp = setup("- [x] write the feature\n");
		try {
			const recons: StatusReconciliation[] = [
				{ checkbox: "write the feature", actualState: "not_done", evidence: "no impl" },
			];
			const result = applyStatusReconciliation(join(tmp, "STATUS.md"), recons);
			expect(result.changed).toBe(1);
			expect(result.actions[0].outcome).toBe("unchecked");
			const after = readFileSync(join(tmp, "STATUS.md"), "utf-8");
			expect(after).toContain("- [ ] write the feature");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("adds (partial) annotation for partial state", () => {
		const tmp = setup("- [x] write the feature\n");
		try {
			const recons: StatusReconciliation[] = [
				{ checkbox: "write the feature", actualState: "partial", evidence: "half done" },
			];
			const result = applyStatusReconciliation(join(tmp, "STATUS.md"), recons);
			expect(result.changed).toBe(1);
			const after = readFileSync(join(tmp, "STATUS.md"), "utf-8");
			expect(after).toContain("(partial)");
			expect(after).toContain("- [ ]");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("already correct → no change", () => {
		const tmp = setup("- [x] write the feature\n");
		try {
			const recons: StatusReconciliation[] = [
				{ checkbox: "write the feature", actualState: "done", evidence: "yes" },
			];
			const result = applyStatusReconciliation(join(tmp, "STATUS.md"), recons);
			expect(result.alreadyCorrect).toBe(1);
			expect(result.changed).toBe(0);
			expect(result.actions[0].outcome).toBe("no_change");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("unmatched checkbox recorded", () => {
		const tmp = setup("- [ ] write the feature\n");
		try {
			const recons: StatusReconciliation[] = [
				{ checkbox: "something else entirely", actualState: "done", evidence: "" },
			];
			const result = applyStatusReconciliation(join(tmp, "STATUS.md"), recons);
			expect(result.unmatched).toBe(1);
			expect(result.actions[0].outcome).toBe("unmatched");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("missing STATUS.md → all unmatched", () => {
		const tmp = mkdtempSync(join(tmpdir(), "qg-recon-"));
		try {
			const recons: StatusReconciliation[] = [
				{ checkbox: "a", actualState: "done", evidence: "" },
				{ checkbox: "b", actualState: "done", evidence: "" },
			];
			const result = applyStatusReconciliation(join(tmp, "STATUS.md"), recons);
			expect(result.unmatched).toBe(2);
			expect(result.actions.every(a => a.outcome === "unmatched")).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("empty reconciliations → noop", () => {
		const tmp = setup("- [x] anything\n");
		try {
			const result = applyStatusReconciliation(join(tmp, "STATUS.md"), []);
			expect(result.changed).toBe(0);
			expect(result.alreadyCorrect).toBe(0);
			expect(result.unmatched).toBe(0);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("fuzzy match via normalization (markdown formatting stripped)", () => {
		const tmp = setup("- [ ] **write** the `feature`\n");
		try {
			const recons: StatusReconciliation[] = [{ checkbox: "write the feature", actualState: "done", evidence: "" }];
			const result = applyStatusReconciliation(join(tmp, "STATUS.md"), recons);
			expect(result.changed).toBe(1);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ── generateFeedbackMd ───────────────────────────────────────────────

describe("generateFeedbackMd", () => {
	test("includes critical and important sections for no_critical threshold", () => {
		const v = makeVerdict({
			verdict: "NEEDS_FIXES",
			summary: "issues",
			findings: [finding("critical"), finding("important"), finding("suggestion")],
		});
		const md = generateFeedbackMd(v, 1, 3, "no_critical");
		expect(md).toContain("Critical Findings (1)");
		expect(md).toContain("Important Findings (1)");
		expect(md).not.toContain("Suggestion Findings");
		expect(md).toContain("Cycle 1/3");
	});

	test("all_clear threshold includes suggestions as blocking", () => {
		const v = makeVerdict({
			verdict: "NEEDS_FIXES",
			summary: "issues",
			findings: [finding("suggestion")],
		});
		const md = generateFeedbackMd(v, 2, 5, "all_clear");
		expect(md).toContain("Suggestion Findings (1)");
		expect(md).toContain("all_clear");
	});

	test("status reconciliation section emitted for non-done entries", () => {
		const v = makeVerdict({
			verdict: "NEEDS_FIXES",
			statusReconciliation: [{ checkbox: "add tests", actualState: "not_done", evidence: "no test file" }],
		});
		const md = generateFeedbackMd(v, 1, 3, "no_critical");
		expect(md).toContain("STATUS.md Reconciliation Issues");
		expect(md).toContain("add tests");
	});

	test("no blocking findings note when verdict is NEEDS_FIXES but nothing blocking", () => {
		const v = makeVerdict({ verdict: "NEEDS_FIXES", summary: "vibes" });
		const md = generateFeedbackMd(v, 1, 3, "no_critical");
		expect(md).toContain("No blocking findings");
	});
});

// ── buildFixAgentPrompt ──────────────────────────────────────────────

describe("buildFixAgentPrompt", () => {
	test("embeds feedback and PROMPT/STATUS content", () => {
		const tmp = mkdtempSync(join(tmpdir(), "qg-fix-"));
		try {
			writeFileSync(join(tmp, "PROMPT.md"), "# task goal\nDo X.\n", "utf-8");
			writeFileSync(join(tmp, "STATUS.md"), "- [ ] do X\n", "utf-8");

			const ctx: QualityGateContext = {
				taskFolder: tmp,
				promptPath: join(tmp, "PROMPT.md"),
				taskId: "T-042",
				projectName: "demo",
				passThreshold: "no_critical",
			};
			const prompt = buildFixAgentPrompt(ctx, "# feedback\n- fix this", 2);

			expect(prompt).toContain("Fix Cycle 2");
			expect(prompt).toContain("T-042");
			expect(prompt).toContain("# task goal");
			expect(prompt).toContain("- [ ] do X");
			expect(prompt).toContain("# feedback");
			expect(prompt).toContain("fix(T-042): address quality gate findings (cycle 2)");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("tolerates missing PROMPT.md and STATUS.md", () => {
		const tmp = mkdtempSync(join(tmpdir(), "qg-fix-"));
		try {
			const ctx: QualityGateContext = {
				taskFolder: tmp,
				promptPath: join(tmp, "PROMPT.md"),
				taskId: "T-missing",
				projectName: "demo",
				passThreshold: "no_critical",
			};
			const prompt = buildFixAgentPrompt(ctx, "x", 1);
			expect(prompt).toContain("(PROMPT.md not found)");
			expect(prompt).toContain("(STATUS.md not found)");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ── FEEDBACK_FILENAME constant ───────────────────────────────────────

describe("constants", () => {
	test("FEEDBACK_FILENAME stable", () => {
		expect(FEEDBACK_FILENAME).toBe("REVIEW_FEEDBACK.md");
	});
	test("VERDICT_FILENAME stable", () => {
		expect(VERDICT_FILENAME).toBe("REVIEW_VERDICT.json");
	});
});
