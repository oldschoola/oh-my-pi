/**
 * Quality Gate — structured post-completion review types and verdict evaluation.
 *
 * Ported verbatim from taskplane/extensions/taskplane/quality-gate.ts.
 * Only swaps: `spawnSync("git", …)` → `runGit(…)` from `./git` for
 * consistency with the rest of MissionControl, and `maxBuffer` on the
 * big diff call dropped (execFileSync defaults are sufficient for the
 * diff truncation we apply anyway).
 *
 * Verdict rules (from taskplane roadmap Phase 5a):
 * - Any `critical` finding → NEEDS_FIXES
 * - 3+ `important` findings → NEEDS_FIXES (threshold `no_important`)
 * - Only `suggestion` findings → PASS (unless threshold `all_clear`)
 * - Any `status_mismatch` category → NEEDS_FIXES
 *
 * Fail-open behavior: malformed or missing verdict JSON → PASS
 * (prevents quality gate bugs from blocking task completion)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PassThreshold } from "./config-schema";
import { runGit } from "./git";

// ── Verdict Interfaces ───────────────────────────────────────────────

export type FindingSeverity = "critical" | "important" | "suggestion";

export type FindingCategory =
	| "missing_requirement"
	| "incorrect_implementation"
	| "incomplete_work"
	| "status_mismatch";

export interface ReviewFinding {
	severity: FindingSeverity;
	category: FindingCategory;
	description: string;
	file: string;
	remediation: string;
}

export interface StatusReconciliation {
	checkbox: string;
	actualState: "done" | "not_done" | "partial";
	evidence: string;
}

export interface ReviewVerdict {
	verdict: "PASS" | "NEEDS_FIXES";
	confidence: "high" | "medium" | "low";
	summary: string;
	findings: ReviewFinding[];
	statusReconciliation: StatusReconciliation[];
}

// ── Verdict Evaluation ───────────────────────────────────────────────

export interface VerdictFailReason {
	rule: "critical_finding" | "important_threshold" | "status_mismatch" | "verdict_says_needs_fixes";
	detail: string;
}

export interface VerdictEvaluation {
	pass: boolean;
	failReasons: VerdictFailReason[];
}

/**
 * Apply verdict rules to determine pass/fail based on findings and threshold.
 *
 * Rules applied in order:
 * 1. Any finding with category `status_mismatch` → NEEDS_FIXES
 * 2. Any finding with severity `critical` → NEEDS_FIXES
 * 3. Threshold-dependent important finding count check
 * 4. If verdict itself says NEEDS_FIXES → respect it
 */
export function applyVerdictRules(verdict: ReviewVerdict, threshold: PassThreshold): VerdictEvaluation {
	const failReasons: VerdictFailReason[] = [];

	const statusMismatches = verdict.findings.filter(f => f.category === "status_mismatch");
	if (statusMismatches.length > 0) {
		failReasons.push({
			rule: "status_mismatch",
			detail: `${statusMismatches.length} status mismatch(es) found — checked boxes don't match actual work`,
		});
	}

	const criticals = verdict.findings.filter(f => f.severity === "critical");
	if (criticals.length > 0) {
		failReasons.push({
			rule: "critical_finding",
			detail: `${criticals.length} critical finding(s)`,
		});
	}

	const importants = verdict.findings.filter(f => f.severity === "important");

	if (threshold === "no_important" && importants.length >= 3) {
		failReasons.push({
			rule: "important_threshold",
			detail: `${importants.length} important findings (threshold: fewer than 3 required for pass)`,
		});
	}

	if (threshold === "all_clear" && verdict.findings.length > 0) {
		if (importants.length > 0 && failReasons.every(r => r.rule !== "important_threshold")) {
			failReasons.push({
				rule: "important_threshold",
				detail: `${importants.length} important finding(s) (all_clear threshold: zero findings required)`,
			});
		}
	}

	if (verdict.verdict === "NEEDS_FIXES" && failReasons.length === 0) {
		failReasons.push({
			rule: "verdict_says_needs_fixes",
			detail: `Review agent verdict: NEEDS_FIXES — ${verdict.summary}`,
		});
	}

	if (threshold === "all_clear" && failReasons.length === 0 && verdict.findings.length > 0) {
		const suggestions = verdict.findings.filter(f => f.severity === "suggestion");
		if (suggestions.length > 0) {
			failReasons.push({
				rule: "important_threshold",
				detail: `${suggestions.length} suggestion(s) found (all_clear threshold: zero findings required)`,
			});
		}
	}

	return {
		pass: failReasons.length === 0,
		failReasons,
	};
}

// ── Verdict Parsing ──────────────────────────────────────────────────

const FAIL_OPEN_VERDICT: ReviewVerdict = {
	verdict: "PASS",
	confidence: "low",
	summary: "Verdict could not be parsed — fail-open policy applied",
	findings: [],
	statusReconciliation: [],
};

/**
 * Parse a JSON string into a ReviewVerdict, with fail-open behavior.
 *
 * If the input is missing, empty, or malformed JSON, returns a PASS verdict
 * (fail-open) to prevent quality gate bugs from blocking task completion.
 */
export function parseVerdict(jsonString: string | undefined | null): ReviewVerdict {
	if (!jsonString || jsonString.trim() === "") {
		return { ...FAIL_OPEN_VERDICT, summary: "No verdict provided — fail-open policy applied" };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(jsonString);
	} catch {
		return { ...FAIL_OPEN_VERDICT, summary: "Malformed JSON in verdict — fail-open policy applied" };
	}

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ...FAIL_OPEN_VERDICT, summary: "Verdict is not a JSON object — fail-open policy applied" };
	}

	const obj = raw as Record<string, unknown>;

	const verdict = obj.verdict;
	if (verdict !== "PASS" && verdict !== "NEEDS_FIXES") {
		return {
			...FAIL_OPEN_VERDICT,
			summary: `Invalid verdict value "${String(verdict)}" — fail-open policy applied`,
		};
	}

	const validConfidence = ["high", "medium", "low"];
	const confidence = validConfidence.includes(obj.confidence as string)
		? (obj.confidence as "high" | "medium" | "low")
		: "medium";

	const summary = typeof obj.summary === "string" ? obj.summary : "";
	const findings = validateFindings(obj.findings);
	const statusReconciliation = validateReconciliations(obj.statusReconciliation);

	return { verdict, confidence, summary, findings, statusReconciliation };
}

const VALID_SEVERITIES: FindingSeverity[] = ["critical", "important", "suggestion"];
const VALID_CATEGORIES: FindingCategory[] = [
	"missing_requirement",
	"incorrect_implementation",
	"incomplete_work",
	"status_mismatch",
];
const VALID_STATES = ["done", "not_done", "partial"];

function validateFindings(raw: unknown): ReviewFinding[] {
	if (!Array.isArray(raw)) return [];

	const validated: ReviewFinding[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const f = item as Record<string, unknown>;

		if (!VALID_SEVERITIES.includes(f.severity as FindingSeverity)) continue;
		if (!VALID_CATEGORIES.includes(f.category as FindingCategory)) continue;
		if (typeof f.description !== "string" || f.description.trim() === "") continue;

		validated.push({
			severity: f.severity as FindingSeverity,
			category: f.category as FindingCategory,
			description: f.description as string,
			file: typeof f.file === "string" ? f.file : "",
			remediation: typeof f.remediation === "string" ? f.remediation : "",
		});
	}

	return validated;
}

function validateReconciliations(raw: unknown): StatusReconciliation[] {
	if (!Array.isArray(raw)) return [];

	const validated: StatusReconciliation[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const r = item as Record<string, unknown>;

		if (typeof r.checkbox !== "string" || r.checkbox.trim() === "") continue;
		if (!VALID_STATES.includes(r.actualState as string)) continue;

		validated.push({
			checkbox: r.checkbox as string,
			actualState: r.actualState as "done" | "not_done" | "partial",
			evidence: typeof r.evidence === "string" ? r.evidence : "",
		});
	}

	return validated;
}

// ── Quality Gate Review Prompt ───────────────────────────────────────

export interface QualityGateContext {
	taskFolder: string;
	promptPath: string;
	taskId: string;
	projectName: string;
	passThreshold: PassThreshold;
}

export const VERDICT_FILENAME = "REVIEW_VERDICT.json";

/**
 * Compute a robust diff range for the task's git changes.
 */
function computeDiffBase(cwd: string): string {
	for (const ref of ["main", "origin/main", "master", "origin/master"]) {
		const result = runGit(["merge-base", "HEAD", ref], cwd);
		if (result.ok && result.stdout) return result.stdout;
	}

	const countResult = runGit(["rev-list", "--count", "HEAD"], cwd);
	if (countResult.ok) {
		const count = Number.parseInt(countResult.stdout, 10);
		if (count > 1) {
			const n = Math.min(count - 1, 50);
			return `HEAD~${n}`;
		}
	}

	return "";
}

/**
 * Build the git diff for the entire task.
 */
function buildGitDiff(cwd: string): { diff: string; fileList: string } {
	try {
		const base = computeDiffBase(cwd);
		if (!base) {
			return {
				diff: "(git diff unavailable — could not determine base)",
				fileList: "(file list unavailable)",
			};
		}

		const range = `${base}..HEAD`;

		const fileListResult = runGit(["diff", "--name-only", range], cwd);
		const fileList = fileListResult.ok ? fileListResult.stdout : "";

		const diffResult = runGit(["diff", range], cwd);
		const diff = diffResult.ok ? diffResult.stdout : "(git diff unavailable)";

		return { diff, fileList };
	} catch {
		return { diff: "(git diff failed)", fileList: "(file list unavailable)" };
	}
}

function buildThresholdRules(threshold: PassThreshold): string[] {
	const rules: string[] = [];

	rules.push(
		`- **NEEDS_FIXES** if any finding has category \`status_mismatch\` (checkbox claims work is done but it isn't)`,
	);
	rules.push(`- **NEEDS_FIXES** if any finding has severity \`critical\``);

	switch (threshold) {
		case "no_critical":
			rules.push(
				`- **PASS** even if there are \`important\` or \`suggestion\` findings (threshold: \`no_critical\`)`,
			);
			break;
		case "no_important":
			rules.push(`- **NEEDS_FIXES** if 3 or more findings have severity \`important\``);
			rules.push(`- **PASS** if only \`suggestion\`-level findings remain`);
			break;
		case "all_clear":
			rules.push(`- **NEEDS_FIXES** if ANY findings exist (including \`suggestion\`-level)`);
			break;
	}

	rules.push(`- **PASS** if no findings at all`);
	rules.push(``);

	return rules;
}

export function generateQualityGatePrompt(context: QualityGateContext, cwd: string): string {
	const statusPath = join(context.taskFolder, "STATUS.md");
	const verdictPath = join(context.taskFolder, VERDICT_FILENAME);

	let promptContent = "(PROMPT.md not found)";
	try {
		if (existsSync(context.promptPath)) {
			promptContent = readFileSync(context.promptPath, "utf-8");
		}
	} catch {
		/* fail-open: proceed without */
	}

	let statusContent = "(STATUS.md not found)";
	try {
		if (existsSync(statusPath)) {
			statusContent = readFileSync(statusPath, "utf-8");
		}
	} catch {
		/* fail-open: proceed without */
	}

	const { diff, fileList } = buildGitDiff(cwd);

	const maxDiffLen = 100 * 1024;
	const truncatedDiff =
		diff.length > maxDiffLen ? `${diff.slice(0, maxDiffLen)}\n\n... (diff truncated at 100KB) ...` : diff;

	return [
		`# Quality Gate Review`,
		``,
		`You are performing a structured post-completion quality gate review for task **${context.taskId}** in project **${context.projectName}**.`,
		``,
		`Your job is to verify that the task was completed correctly by comparing the PROMPT requirements against the actual code changes and STATUS.md progress claims.`,
		``,
		`## Task Requirements (PROMPT.md)`,
		``,
		`\`\`\`markdown`,
		promptContent,
		`\`\`\``,
		``,
		`## Declared Progress (STATUS.md)`,
		``,
		`\`\`\`markdown`,
		statusContent,
		`\`\`\``,
		``,
		`## Changed Files`,
		``,
		`\`\`\``,
		fileList,
		`\`\`\``,
		``,
		`## Git Diff`,
		``,
		`\`\`\`diff`,
		truncatedDiff,
		`\`\`\``,
		``,
		`## Instructions`,
		``,
		`1. **Read the PROMPT.md requirements** carefully — identify every deliverable and acceptance criterion.`,
		`2. **Cross-check STATUS.md checkboxes** — verify each checked item actually has corresponding code/test changes in the diff.`,
		`3. **Review the git diff** — look for missing implementations, incorrect logic, incomplete work.`,
		`4. **Use tools** to read actual source files if the diff is unclear.`,
		`5. **Produce your verdict** as a JSON object written to the file specified below.`,
		``,
		`## Verdict Rules`,
		``,
		`Report ALL findings you discover with accurate severities. The runtime will`,
		`apply the configured pass threshold (\`${context.passThreshold}\`) to decide pass/fail.`,
		``,
		`Use these rules to determine your verdict:`,
		...buildThresholdRules(context.passThreshold),
		``,
		`## Output Format`,
		``,
		`Write a JSON file to: \`${verdictPath}\``,
		``,
		`The JSON must conform to this schema:`,
		``,
		`\`\`\`json`,
		`{`,
		`  "verdict": "PASS" | "NEEDS_FIXES",`,
		`  "confidence": "high" | "medium" | "low",`,
		`  "summary": "Brief overall assessment",`,
		`  "findings": [`,
		`    {`,
		`      "severity": "critical" | "important" | "suggestion",`,
		`      "category": "missing_requirement" | "incorrect_implementation" | "incomplete_work" | "status_mismatch",`,
		`      "description": "What is wrong",`,
		`      "file": "path/to/file.ts",`,
		`      "remediation": "Specific fix instruction"`,
		`    }`,
		`  ],`,
		`  "statusReconciliation": [`,
		`    {`,
		`      "checkbox": "Original checkbox text",`,
		`      "actualState": "done" | "not_done" | "partial",`,
		`      "evidence": "How you verified"`,
		`    }`,
		`  ]`,
		`}`,
		`\`\`\``,
		``,
		`**IMPORTANT:** Write ONLY valid JSON to the verdict file. No markdown, no explanation — just the JSON object.`,
		``,
	].join("\n");
}

// ── Quality Gate Result ──────────────────────────────────────────────

export interface QualityGateResult {
	passed: boolean;
	verdict: ReviewVerdict;
	evaluation: VerdictEvaluation;
	cyclesUsed: number;
	skipped: boolean;
}

/**
 * Read and evaluate the quality gate verdict file from the task folder.
 *
 * Handles all fail-open paths:
 * - Missing verdict file → synthetic PASS
 * - Malformed JSON → synthetic PASS
 * - Invalid verdict structure → synthetic PASS
 */
export function readAndEvaluateVerdict(
	taskFolder: string,
	passThreshold: PassThreshold,
): { verdict: ReviewVerdict; evaluation: VerdictEvaluation } {
	const verdictPath = join(taskFolder, VERDICT_FILENAME);

	let rawJson: string | null = null;
	try {
		if (existsSync(verdictPath)) {
			rawJson = readFileSync(verdictPath, "utf-8");
		}
	} catch {
		// File read error → fail-open
	}

	const verdict = parseVerdict(rawJson);
	const evaluation = applyVerdictRules(verdict, passThreshold);

	return { verdict, evaluation };
}

// ── STATUS.md Reconciliation ─────────────────────────────────────────

export interface ReconciliationResult {
	changed: number;
	alreadyCorrect: number;
	unmatched: number;
	actions: ReconciliationAction[];
}

export interface ReconciliationAction {
	checkbox: string;
	outcome: "checked" | "unchecked" | "no_change" | "unmatched";
	reason: string;
}

/**
 * Normalize checkbox text for fuzzy matching.
 */
function normalizeCheckboxText(text: string): string {
	return text
		.replace(/\*\*|__|``|`/g, "")
		.replace(/\s+/g, " ")
		.replace(/^\s*[-*•]\s*/, "")
		.trim()
		.toLowerCase();
}

/**
 * Apply statusReconciliation entries to STATUS.md checkboxes.
 */
export function applyStatusReconciliation(
	statusPath: string,
	reconciliations: StatusReconciliation[],
): ReconciliationResult {
	const result: ReconciliationResult = {
		changed: 0,
		alreadyCorrect: 0,
		unmatched: 0,
		actions: [],
	};

	if (!reconciliations || reconciliations.length === 0) {
		return result;
	}

	let content: string;
	try {
		if (!existsSync(statusPath)) {
			for (const r of reconciliations) {
				result.unmatched++;
				result.actions.push({ checkbox: r.checkbox, outcome: "unmatched", reason: "STATUS.md not found" });
			}
			return result;
		}
		content = readFileSync(statusPath, "utf-8");
	} catch {
		for (const r of reconciliations) {
			result.unmatched++;
			result.actions.push({ checkbox: r.checkbox, outcome: "unmatched", reason: "STATUS.md unreadable" });
		}
		return result;
	}

	const lines = content.split("\n");
	const checkboxRegex = /^(\s*-\s*\[)([ xX])(\]\s*)(.*)/;

	const consumed = new Set<number>();

	for (const recon of reconciliations) {
		const normalizedRecon = normalizeCheckboxText(recon.checkbox);
		if (!normalizedRecon) {
			result.unmatched++;
			result.actions.push({
				checkbox: recon.checkbox,
				outcome: "unmatched",
				reason: "Empty checkbox text after normalization",
			});
			continue;
		}

		let matchedIdx = -1;
		for (let i = 0; i < lines.length; i++) {
			if (consumed.has(i)) continue;
			const cbMatch = lines[i].match(checkboxRegex);
			if (!cbMatch) continue;

			const lineText = normalizeCheckboxText(cbMatch[4]);
			if (lineText === normalizedRecon || lineText.includes(normalizedRecon) || normalizedRecon.includes(lineText)) {
				matchedIdx = i;
				break;
			}
		}

		if (matchedIdx === -1) {
			result.unmatched++;
			result.actions.push({
				checkbox: recon.checkbox,
				outcome: "unmatched",
				reason: "No matching checkbox found in STATUS.md",
			});
			continue;
		}

		consumed.add(matchedIdx);
		const cbMatch = lines[matchedIdx].match(checkboxRegex);
		if (!cbMatch) continue;
		const currentlyChecked = cbMatch[2].toLowerCase() === "x";
		const currentText = cbMatch[4];

		const shouldBeChecked = recon.actualState === "done";

		if (shouldBeChecked && currentlyChecked) {
			result.alreadyCorrect++;
			result.actions.push({ checkbox: recon.checkbox, outcome: "no_change", reason: "Already checked (done)" });
		} else if (!shouldBeChecked && !currentlyChecked) {
			if (recon.actualState === "partial" && !currentText.includes("(partial)")) {
				lines[matchedIdx] = `${cbMatch[1]} ${cbMatch[3]}${currentText} (partial)`;
				result.changed++;
				result.actions.push({
					checkbox: recon.checkbox,
					outcome: "unchecked",
					reason: "Added (partial) annotation",
				});
			} else {
				result.alreadyCorrect++;
				result.actions.push({
					checkbox: recon.checkbox,
					outcome: "no_change",
					reason: `Already unchecked (${recon.actualState})`,
				});
			}
		} else if (shouldBeChecked && !currentlyChecked) {
			lines[matchedIdx] = `${cbMatch[1]}x${cbMatch[3]}${currentText}`;
			result.changed++;
			result.actions.push({
				checkbox: recon.checkbox,
				outcome: "checked",
				reason: "Work done but box was unchecked",
			});
		} else {
			const annotation = recon.actualState === "partial" ? " (partial)" : "";
			const cleanText = currentText.replace(/\s*\(partial\)\s*$/, "");
			lines[matchedIdx] = `${cbMatch[1]} ${cbMatch[3]}${cleanText}${annotation}`;
			result.changed++;
			const outcomeReason =
				recon.actualState === "partial" ? "Unchecked — work partially done" : "Unchecked — work not done";
			result.actions.push({ checkbox: recon.checkbox, outcome: "unchecked", reason: outcomeReason });
		}
	}

	if (result.changed > 0) {
		try {
			writeFileSync(statusPath, lines.join("\n"), "utf-8");
		} catch {
			for (const action of result.actions) {
				if (action.outcome === "checked" || action.outcome === "unchecked") {
					action.outcome = "unmatched";
					action.reason += " (write failed)";
					result.changed--;
					result.unmatched++;
				}
			}
		}
	}

	return result;
}

// ── Remediation: Feedback & Fix Agent Prompt ─────────────────────────

export const FEEDBACK_FILENAME = "REVIEW_FEEDBACK.md";

/**
 * Generate a deterministic REVIEW_FEEDBACK.md from a NEEDS_FIXES verdict.
 *
 * Includes blocking findings based on the configured pass threshold:
 * - `no_critical` / `no_important`: critical + important findings only
 * - `all_clear`: critical + important + suggestion findings (all are blocking)
 */
export function generateFeedbackMd(
	verdict: ReviewVerdict,
	cycleNum: number,
	maxCycles: number,
	passThreshold: PassThreshold = "no_critical",
): string {
	const criticals = verdict.findings.filter(f => f.severity === "critical");
	const importants = verdict.findings.filter(f => f.severity === "important");
	const suggestions = verdict.findings.filter(f => f.severity === "suggestion");
	const mismatches = verdict.statusReconciliation.filter(r => r.actualState !== "done");

	const includeSuggestions = passThreshold === "all_clear";

	const blockingLabel = includeSuggestions ? "critical, important, and suggestion" : "critical and important";

	const lines: string[] = [
		`# Review Feedback — Cycle ${cycleNum}/${maxCycles}`,
		``,
		`**Verdict:** NEEDS_FIXES`,
		`**Confidence:** ${verdict.confidence}`,
		`**Summary:** ${verdict.summary}`,
		`**Pass Threshold:** \`${passThreshold}\``,
		``,
		`> This file was generated by the quality gate. Address all ${blockingLabel}`,
		`> findings below, then the review will re-run automatically.`,
		``,
	];

	if (criticals.length > 0) {
		lines.push(`## Critical Findings (${criticals.length})`);
		lines.push(``);
		for (let i = 0; i < criticals.length; i++) {
			const f = criticals[i];
			lines.push(`### C${i + 1}: ${f.description}`);
			lines.push(``);
			lines.push(`- **Category:** ${f.category}`);
			if (f.file) lines.push(`- **File:** \`${f.file}\``);
			if (f.remediation) lines.push(`- **Remediation:** ${f.remediation}`);
			lines.push(``);
		}
	}

	if (importants.length > 0) {
		lines.push(`## Important Findings (${importants.length})`);
		lines.push(``);
		for (let i = 0; i < importants.length; i++) {
			const f = importants[i];
			lines.push(`### I${i + 1}: ${f.description}`);
			lines.push(``);
			lines.push(`- **Category:** ${f.category}`);
			if (f.file) lines.push(`- **File:** \`${f.file}\``);
			if (f.remediation) lines.push(`- **Remediation:** ${f.remediation}`);
			lines.push(``);
		}
	}

	if (includeSuggestions && suggestions.length > 0) {
		lines.push(`## Suggestion Findings (${suggestions.length})`);
		lines.push(``);
		lines.push(`> Under \`all_clear\` threshold, suggestions are also blocking.`);
		lines.push(``);
		for (let i = 0; i < suggestions.length; i++) {
			const f = suggestions[i];
			lines.push(`### S${i + 1}: ${f.description}`);
			lines.push(``);
			lines.push(`- **Category:** ${f.category}`);
			if (f.file) lines.push(`- **File:** \`${f.file}\``);
			if (f.remediation) lines.push(`- **Remediation:** ${f.remediation}`);
			lines.push(``);
		}
	}

	if (mismatches.length > 0) {
		lines.push(`## STATUS.md Reconciliation Issues (${mismatches.length})`);
		lines.push(``);
		for (const r of mismatches) {
			lines.push(`- **Checkbox:** ${r.checkbox}`);
			lines.push(`  - **Actual state:** ${r.actualState}`);
			if (r.evidence) lines.push(`  - **Evidence:** ${r.evidence}`);
		}
		lines.push(``);
	}

	const totalBlocking =
		criticals.length + importants.length + (includeSuggestions ? suggestions.length : 0) + mismatches.length;

	if (totalBlocking === 0) {
		lines.push(`## No blocking findings`);
		lines.push(``);
		lines.push(
			`The review returned NEEDS_FIXES but no blocking findings were extracted for threshold \`${passThreshold}\`.`,
		);
		lines.push(`This may indicate a threshold or verdict-rule mismatch. Review the REVIEW_VERDICT.json for details.`);
		lines.push(``);
	}

	return lines.join("\n");
}

/**
 * Build the prompt for the fix agent that addresses quality gate findings.
 */
export function buildFixAgentPrompt(context: QualityGateContext, feedbackContent: string, cycleNum: number): string {
	const statusPath = join(context.taskFolder, "STATUS.md");

	let statusContent = "(STATUS.md not found)";
	try {
		if (existsSync(statusPath)) {
			statusContent = readFileSync(statusPath, "utf-8");
		}
	} catch {
		/* proceed without */
	}

	let promptContent = "(PROMPT.md not found)";
	try {
		if (existsSync(context.promptPath)) {
			promptContent = readFileSync(context.promptPath, "utf-8");
		}
	} catch {
		/* proceed without */
	}

	return [
		`# Quality Gate Remediation — Fix Cycle ${cycleNum}`,
		``,
		`You are a fix agent addressing quality gate findings for task **${context.taskId}**.`,
		``,
		`The quality gate review found issues that must be fixed before the task can be marked complete.`,
		`Your job is to make targeted, minimal fixes to address the critical and important findings below.`,
		``,
		`## Rules`,
		``,
		`1. **Read REVIEW_FEEDBACK.md** below — it lists the blocking findings with specific remediation instructions.`,
		`2. **Fix each finding** — make the minimal code change needed. Do NOT refactor unrelated code.`,
		`3. **Commit your fixes** with message: \`fix(${context.taskId}): address quality gate findings (cycle ${cycleNum})\``,
		`4. **Update STATUS.md** if any checkbox states were flagged as incorrect in the reconciliation section.`,
		`5. **Do NOT create .DONE** — the quality gate will re-run automatically after you exit.`,
		``,
		`## Task Context`,
		``,
		`- **Task folder:** ${context.taskFolder}/`,
		`- **PROMPT:** ${context.promptPath}`,
		`- **STATUS:** ${statusPath}`,
		``,
		`## Review Feedback`,
		``,
		`\`\`\`markdown`,
		feedbackContent,
		`\`\`\``,
		``,
		`## Original Task Requirements (PROMPT.md)`,
		``,
		`\`\`\`markdown`,
		promptContent,
		`\`\`\``,
		``,
		`## Current STATUS.md`,
		``,
		`\`\`\`markdown`,
		statusContent,
		`\`\`\``,
		``,
		`**IMPORTANT:** Focus only on fixing the blocking findings. Do not expand scope or create .DONE.`,
		``,
	].join("\n");
}
