import { describe, expect, test } from "bun:test";
import {
	deduplicateFingerprints,
	diffFingerprints,
	fingerprintKey,
	normalizeFilePath,
	normalizeMessage,
	parseTestOutput,
	parseVitestOutput,
	type TestFingerprint,
} from "../src/missioncontrol/verification";

describe("verification.normalizeMessage", () => {
	test("strips ANSI colors", () => {
		const raw = "\u001b[31mRed text\u001b[0m — error";
		expect(normalizeMessage(raw)).toBe("Red text — error");
	});
	test("backslash → forward slash", () => {
		expect(normalizeMessage("C:\\path\\to\\file.ts")).toBe("C:/path/to/file.ts");
	});
	test("strips durations", () => {
		expect(normalizeMessage("failed (42ms) with error")).toBe("failed with error");
	});
	test("strips ISO timestamps", () => {
		expect(normalizeMessage("2026-03-20T12:34:56.789Z happened")).toBe("happened");
	});
	test("collapses whitespace", () => {
		expect(normalizeMessage("a\n\n\tb   c")).toBe("a b c");
	});
	test("truncates at 512 chars", () => {
		const long = "x".repeat(600);
		expect(normalizeMessage(long).length).toBe(512);
	});
});

describe("verification.normalizeFilePath", () => {
	test("backslash → forward slash", () => {
		expect(normalizeFilePath("a\\b\\c.ts")).toBe("a/b/c.ts");
	});
});

describe("verification.fingerprintKey", () => {
	test("joins fields by null byte", () => {
		const fp: TestFingerprint = {
			commandId: "test",
			file: "a.ts",
			case: "does thing",
			kind: "assertion_error",
			messageNorm: "expected 1 got 2",
		};
		expect(fingerprintKey(fp)).toBe("test\0a.ts\0does thing\0assertion_error\0expected 1 got 2");
	});
});

describe("verification.parseTestOutput", () => {
	test("command_error fingerprint on spawn error", () => {
		const fps = parseTestOutput({
			commandId: "test",
			exitCode: -1,
			stdout: "",
			stderr: "",
			durationMs: 0,
			error: "Command timed out",
		});
		expect(fps).toHaveLength(1);
		expect(fps[0]?.kind).toBe("command_error");
	});
	test("empty on exit 0", () => {
		const fps = parseTestOutput({
			commandId: "test",
			exitCode: 0,
			stdout: "",
			stderr: "",
			durationMs: 0,
			error: null,
		});
		expect(fps).toHaveLength(0);
	});
	test("fallback on non-zero exit with no parseable JSON", () => {
		const fps = parseTestOutput({
			commandId: "test",
			exitCode: 1,
			stdout: "garbage output",
			stderr: "stderr text",
			durationMs: 0,
			error: null,
		});
		expect(fps).toHaveLength(1);
		expect(fps[0]?.kind).toBe("command_error");
		expect(fps[0]?.messageNorm).toBe("stderr text");
	});
});

describe("verification.parseVitestOutput", () => {
	test("extracts failed assertions", () => {
		const json = JSON.stringify({
			testResults: [
				{
					name: "a.test.ts",
					status: "failed",
					assertionResults: [
						{ fullName: "does thing", status: "failed", failureMessages: ["expected 1 got 2"] },
						{ fullName: "passes", status: "passed", failureMessages: [] },
					],
				},
			],
		});
		const fps = parseVitestOutput("test", json);
		expect(fps).toHaveLength(1);
		expect(fps?.[0]?.case).toBe("does thing");
		expect(fps?.[0]?.kind).toBe("assertion_error");
	});
	test("suite-level failure with no assertions", () => {
		const json = JSON.stringify({
			testResults: [{ name: "a.test.ts", status: "failed", message: "import error", assertionResults: [] }],
		});
		const fps = parseVitestOutput("test", json);
		expect(fps).toHaveLength(1);
		expect(fps?.[0]?.case).toBe("<suite>");
		expect(fps?.[0]?.kind).toBe("runtime_error");
	});
	test("returns null on unparseable", () => {
		expect(parseVitestOutput("test", "not json")).toBeNull();
	});
});

describe("verification.diffFingerprints", () => {
	const mk = (file: string, msg: string): TestFingerprint => ({
		commandId: "test",
		file,
		case: "c",
		kind: "assertion_error",
		messageNorm: msg,
	});
	test("splits new/preExisting/fixed", () => {
		const baseline = [mk("a.ts", "old"), mk("b.ts", "still broken")];
		const post = [mk("b.ts", "still broken"), mk("c.ts", "new break")];
		const diff = diffFingerprints(baseline, post);
		expect(diff.newFailures.map(f => f.file)).toEqual(["c.ts"]);
		expect(diff.preExisting.map(f => f.file)).toEqual(["b.ts"]);
		expect(diff.fixed.map(f => f.file)).toEqual(["a.ts"]);
	});
	test("deduplicates inputs", () => {
		const dup = mk("a.ts", "m");
		expect(deduplicateFingerprints([dup, dup, dup])).toHaveLength(1);
	});
});
