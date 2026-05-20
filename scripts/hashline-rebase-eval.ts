/**
 * Eval harness for hashline anchor-stale auto-rebase.
 *
 * Generates a battery of realistic "model anchored against stale file" cases
 * and runs each through `applyHashlineEdits`. The wrapper script invokes this
 * twice — once on the current branch (rebase enabled) and once with apply.ts
 * reverted to upstream (rebase disabled) — and diffs the resulting JSON.
 */

import {
	applyHashlineEdits,
	computeLineHash,
	HashlineMismatchError,
	HL_EDIT_SEP,
	parseHashline,
} from "../packages/coding-agent/src/hashline";

interface Case {
	name: string;
	file: string;
	diff: string;
	/** Expected post-edit content. `undefined` if the case must reject. */
	expected: string | undefined;
	/** `true` if the anchor is stale and a rebase is required for it to land. */
	requiresRebase: boolean;
	/**
	 * Per-anchor expected content from a synthetic read snapshot. Mirrors the
	 * production `FileReadCache` map. Required for content-verified rebase;
	 * cases with `undefined` exercise the no-snapshot rejection path.
	 */
	snapshot?: ReadonlyArray<readonly [number, string]>;
}

const sep = HL_EDIT_SEP;
const pl = (text: string) => `${sep}${text}`;
const tag = (line: number, content: string) => `${line}${computeLineHash(line, content)}`;
const range = (a: string) => `${a}..${a}`;

const cases: Case[] = [];

// 1. Linter prepended 3 header lines after read.
{
	const before = ["function greet(name) {", "  return `Hi ${name}`;", "}"];
	const after = ["// header A", "// header B", "// header C", ...before];
	const anchor = tag(2, before[1]);
	cases.push({
		name: "linter prepended 3 header lines (single anchor)",
		file: after.join("\n"),
		diff: [`= ${range(anchor)}`, pl("  return `Hello, ${name}`;")].join("\n"),
		expected: [
			"// header A",
			"// header B",
			"// header C",
			"function greet(name) {",
			"  return `Hello, ${name}`;",
			"}",
		].join("\n"),
		requiresRebase: true,
		snapshot: [[2, before[1]]],
	});
}

// 2. Lines removed above target shifted it up by 3.
{
	const current = ["// target line", "E", "F"];
	const anchor = tag(4, "// target line");
	cases.push({
		name: "lines removed above shifted target up by 3",
		file: current.join("\n"),
		diff: [`= ${range(anchor)}`, pl("// REPLACED")].join("\n"),
		expected: ["// REPLACED", "E", "F"].join("\n"),
		requiresRebase: true,
		snapshot: [[4, "// target line"]],
	});
}

// 3. Multi-line range edit, both boundary anchors shifted by +5.
{
	const before = ["fn a()", "  step 1", "  step 2", "  step 3", "end"];
	const after = ["// prelude 1", "// prelude 2", "// prelude 3", "// prelude 4", "// prelude 5", ...before];
	const start = tag(2, before[1]);
	const end = tag(4, before[3]);
	cases.push({
		name: "range edit `start..end` shifted +5",
		file: after.join("\n"),
		diff: [`= ${start}..${end}`, pl("  step REPLACED")].join("\n"),
		expected: [
			"// prelude 1",
			"// prelude 2",
			"// prelude 3",
			"// prelude 4",
			"// prelude 5",
			"fn a()",
			"  step REPLACED",
			"end",
		].join("\n"),
		requiresRebase: true,
		snapshot: [
			[2, before[1]],
			[4, before[3]],
		],
	});
}

// 4. Two independent edits in one diff, each with its own delta.
{
	const file = ["aaa", "INSERT-1", "bbb", "ccc", "INSERT-2", "ddd", "eee", "fff"];
	cases.push({
		name: "two independent edits, deltas +1 and +2",
		file: file.join("\n"),
		diff: [`= ${range(tag(2, "bbb"))}`, pl("BBB"), `= ${range(tag(4, "eee"))}`, pl("EEE")].join("\n"),
		expected: ["aaa", "INSERT-1", "BBB", "ccc", "INSERT-2", "ddd", "EEE", "fff"].join("\n"),
		requiresRebase: true,
		snapshot: [
			[2, "bbb"],
			[4, "eee"],
		],
	});
}

// 5. Insert-after with drifted anchor.
{
	const file = ["aaa", "INSERTED", "bbb", "ccc"];
	cases.push({
		name: "insert-after with drifted anchor",
		file: file.join("\n"),
		diff: [`+ ${tag(2, "bbb")}`, pl("NEW")].join("\n"),
		expected: ["aaa", "INSERTED", "bbb", "NEW", "ccc"].join("\n"),
		requiresRebase: true,
		snapshot: [[2, "bbb"]],
	});
}

// 6. Insert-before with drifted anchor.
{
	const file = ["aaa", "INSERTED", "bbb", "ccc"];
	cases.push({
		name: "insert-before with drifted anchor",
		file: file.join("\n"),
		diff: [`< ${tag(2, "bbb")}`, pl("NEW")].join("\n"),
		expected: ["aaa", "INSERTED", "NEW", "bbb", "ccc"].join("\n"),
		requiresRebase: true,
		snapshot: [[2, "bbb"]],
	});
}

// 7. Large file (120 lines), anchor 100 lines deep, shifted by +20.
{
	const target = "  configValue: 42,";
	const beforeLines = Array.from({ length: 99 }, (_, i) => `  line ${i + 1}`);
	const before = [...beforeLines, target, "  trailing"];
	const after = [...Array.from({ length: 20 }, (_, i) => `  prepended ${i}`), ...before];
	const anchor = tag(100, target);
	cases.push({
		name: "large file (120 lines), anchor 100 deep, +20 shift",
		file: after.join("\n"),
		diff: [`= ${range(anchor)}`, pl("  configValue: 99,")].join("\n"),
		expected: after.map(l => (l === target ? "  configValue: 99," : l)).join("\n"),
		requiresRebase: true,
		snapshot: [[100, target]],
	});
}

// 8. Happy path — no shift. Must work without rebase.
{
	const file = ["alpha", "beta", "gamma"];
	cases.push({
		name: "no shift — control case",
		file: file.join("\n"),
		diff: [`= ${range(tag(2, "beta"))}`, pl("BETA")].join("\n"),
		expected: ["alpha", "BETA", "gamma"].join("\n"),
		requiresRebase: false,
	});
}

// 9. Ambiguous content — duplicates elsewhere. Must STILL reject (safety).
{
	const file = ["x = 1", "y = 2", "x = 1", "z = 3", "x = 1", "w = 4"];
	const collidingHash = computeLineHash(1, "x = 1");
	cases.push({
		name: "ambiguous hash with multiple matches — must reject",
		file: file.join("\n"),
		diff: [`= ${range(`4${collidingHash}`)}`, pl("REPLACED")].join("\n"),
		expected: undefined,
		requiresRebase: false,
	});
}

// 10. Target content removed entirely. Must reject (no candidate).
{
	const file = ["A", "B-CHANGED", "C"];
	const fakeHash = computeLineHash(2, "B-ORIGINAL");
	cases.push({
		name: "target content gone — must reject",
		file: file.join("\n"),
		diff: [`= ${range(`2${fakeHash}`)}`, pl("BB")].join("\n"),
		expected: undefined,
		requiresRebase: false,
	});
}

// 11. Negative delta (-3) after lines removed above.
{
	const current = ["target", "tail"];
	const anchor = tag(4, "target");
	cases.push({
		name: "negative delta (-3) after lines removed above",
		file: current.join("\n"),
		diff: [`= ${range(anchor)}`, pl("TARGET-REPLACED")].join("\n"),
		expected: ["TARGET-REPLACED", "tail"].join("\n"),
		requiresRebase: true,
		snapshot: [[4, "target"]],
	});
}

// 12. Range boundaries disagree on delta. Must reject (safety).
{
	const file = ["aaa", "INSERTED", "bbb", "xxx", "yyy", "ddd", "eee"];
	cases.push({
		name: "range boundaries disagree on delta — must reject",
		file: file.join("\n"),
		diff: [`= ${tag(2, "bbb")}..${tag(4, "ddd")}`, pl("RANGE-REPLACED")].join("\n"),
		expected: undefined,
		requiresRebase: false,
	});
}

// 13. Stale anchor matches two distinct lines. Reject (ambiguous).
{
	const file = ["aaa", "xxx", "yyy", "zzz", "TARGET", "aaa", "bbb", "TARGET"];
	const anchor = tag(2, "TARGET");
	cases.push({
		name: "stale anchor matches two distinct lines — must reject",
		file: file.join("\n"),
		diff: [`= ${range(anchor)}`, pl("TARGET-REPLACED")].join("\n"),
		expected: undefined,
		requiresRebase: false,
	});
}

// 14. Mid-file insertion above the edit region shifts content by +1.
{
	const before = ["A", "B", "C", "D", "E"];
	const after = ["A", "INSERTED-MID", "B", "C", "D", "E"];
	const anchor = tag(4, "D");
	cases.push({
		name: "mid-file insertion shifted edit region by +1",
		file: after.join("\n"),
		diff: [`= ${range(anchor)}`, pl("D-REPLACED")].join("\n"),
		expected: ["A", "INSERTED-MID", "B", "C", "D-REPLACED", "E"].join("\n"),
		requiresRebase: true,
		snapshot: [[4, "D"]],
	});
	void before;
}

// 15. Delete-only edit (no payload) with stale anchor.
{
	const file = ["// header", "alpha", "beta", "gamma"];
	const anchor = tag(2, "beta");
	cases.push({
		name: "delete-only edit with stale anchor",
		file: file.join("\n"),
		diff: [`- ${range(anchor)}`].join("\n"),
		expected: ["// header", "alpha", "gamma"].join("\n"),
		requiresRebase: true,
		snapshot: [[2, "beta"]],
	});
}

interface Outcome {
	applied: boolean;
	correct: boolean;
	warnings: string[];
	error?: string;
}

function runCase(c: Case): Outcome {
	const expectedContent = c.snapshot ? new Map(c.snapshot) : undefined;
	try {
		const result = applyHashlineEdits(c.file, parseHashline(c.diff), { expectedContent });
		if (c.expected === undefined) {
			return { applied: true, correct: false, warnings: result.warnings ?? [] };
		}
		return {
			applied: true,
			correct: result.lines === c.expected,
			warnings: result.warnings ?? [],
		};
	} catch (err) {
		if (err instanceof HashlineMismatchError) {
			return { applied: false, correct: c.expected === undefined, warnings: [], error: "mismatch" };
		}
		return {
			applied: false,
			correct: false,
			warnings: [],
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

const outcomes = cases.map(runCase);

const applied = outcomes.filter(o => o.applied).length;
const correct = outcomes.filter(o => o.correct).length;
const requiresRebase = cases.filter(c => c.requiresRebase).length;
const recoveredOfStale = outcomes
	.map((o, i) => ({ o, c: cases[i] }))
	.filter(x => x.c.requiresRebase && x.o.applied && x.o.correct).length;
const safety = cases.filter(c => c.expected === undefined);
const safetyHeld = outcomes.filter((o, i) => cases[i].expected === undefined && o.correct).length;

const report = {
	total: cases.length,
	applied,
	rejected: cases.length - applied,
	correct,
	requiresRebase,
	recoveredOfStale,
	safetyTotal: safety.length,
	safetyHeld,
	perCase: cases.map((c, i) => ({
		name: c.name,
		expectedOutcome: c.expected === undefined ? "reject" : "apply",
		requiresRebase: c.requiresRebase,
		applied: outcomes[i].applied,
		correct: outcomes[i].correct,
		warnings: outcomes[i].warnings,
		error: outcomes[i].error,
	})),
};

const outPath = process.argv[2];
if (outPath) {
	await Bun.write(outPath, JSON.stringify(report, null, 2));
	console.error(`wrote ${outPath}`);
} else {
	console.log(JSON.stringify(report, null, 2));
}
