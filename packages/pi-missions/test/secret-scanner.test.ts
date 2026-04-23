/**
 * Unit tests for the secret scanner (Track I).
 */

import { describe, expect, test } from "bun:test";

import {
	BUILTIN_SECRET_PATTERNS,
	compileExtraPatterns,
	DEFAULT_MISSION_POLICY,
	evaluateTextForSecrets,
	type MissionPolicy,
	redactSecret,
	scanForSecrets,
	scanWithPolicy,
	verdictForMatches,
} from "../src/missioncontrol";

describe("BUILTIN_SECRET_PATTERNS", () => {
	test("includes the core provider patterns", () => {
		const ids = BUILTIN_SECRET_PATTERNS.map(p => p.id);
		expect(ids).toContain("aws-access-key-id");
		expect(ids).toContain("github-token");
		expect(ids).toContain("openai-api-key");
		expect(ids).toContain("anthropic-api-key");
		expect(ids).toContain("private-key-block");
		expect(ids).toContain("jwt");
	});
});

describe("scanForSecrets", () => {
	test("returns empty list for empty / non-secret text", () => {
		expect(scanForSecrets("")).toEqual([]);
		expect(scanForSecrets("hello world")).toEqual([]);
	});

	test("detects AWS access key id", () => {
		const matches = scanForSecrets("Using key AKIAIOSFODNN7EXAMPLE for dev.");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.patternId).toBe("aws-access-key-id");
		expect(matches[0]?.match).toBe("AKIAIOSFODNN7EXAMPLE");
	});

	test("detects GitHub personal access token", () => {
		const matches = scanForSecrets("export GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789AA");
		expect(matches.some(m => m.patternId === "github-token")).toBe(true);
	});

	test("detects Anthropic API key", () => {
		const matches = scanForSecrets("ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345");
		expect(matches.some(m => m.patternId === "anthropic-api-key")).toBe(true);
	});

	test("detects PEM private key block header", () => {
		const matches = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ...\n");
		expect(matches.some(m => m.patternId === "private-key-block")).toBe(true);
	});

	test("detects Slack webhook URL", () => {
		const matches = scanForSecrets("curl https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXX");
		expect(matches.some(m => m.patternId === "slack-webhook")).toBe(true);
	});

	test("detects multiple secrets in one document in document order", () => {
		const text = ["Hello.", "AKIAIOSFODNN7EXAMPLE", "and ghp_abcdefghijklmnopqrstuvwxyz0123456789AA"].join(" ");
		const matches = scanForSecrets(text);
		expect(matches.length).toBeGreaterThanOrEqual(2);
		for (let i = 1; i < matches.length; i++) {
			expect(matches[i]!.index).toBeGreaterThan(matches[i - 1]!.index);
		}
	});

	test("non-string input returns empty", () => {
		expect(scanForSecrets(null as unknown as string)).toEqual([]);
		expect(scanForSecrets(undefined as unknown as string)).toEqual([]);
	});

	test("redacted field shortens the match", () => {
		const m = scanForSecrets("AKIAIOSFODNN7EXAMPLE")[0]!;
		expect(m.redacted.length).toBeLessThan(m.match.length);
		expect(m.redacted.startsWith("AKIA")).toBe(true);
	});
});

describe("compileExtraPatterns", () => {
	test("turns valid regex strings into SecretPattern entries", () => {
		const compiled = compileExtraPatterns(["\\bcustom-[A-Z]{4}\\b"]);
		expect(compiled).toHaveLength(1);
		expect(compiled[0]?.pattern.test("here is custom-ABCD foo")).toBe(true);
	});

	test("invalid regex invokes onInvalid and is skipped", () => {
		const errs: Array<[string, unknown]> = [];
		const compiled = compileExtraPatterns(["(bad"], (p, e) => {
			errs.push([p, e]);
		});
		expect(compiled).toHaveLength(0);
		expect(errs).toHaveLength(1);
	});

	test("empty / non-string patterns are ignored", () => {
		const compiled = compileExtraPatterns(["", "   ..."]);
		expect(compiled[0]?.pattern).toBeDefined();
	});
});

describe("scanWithPolicy", () => {
	test("applies project-defined extra patterns", () => {
		const matches = scanWithPolicy("Token: INTERNAL-FOOBAR-001", {
			...DEFAULT_MISSION_POLICY,
			secretPatterns: ["\\bINTERNAL-[A-Z]+-\\d{3}\\b"],
		});
		expect(matches.some(m => m.match === "INTERNAL-FOOBAR-001")).toBe(true);
	});
});

describe("redactSecret", () => {
	test("short strings collapse to ***", () => {
		expect(redactSecret("short")).toBe("***");
	});

	test("longer strings preserve prefix + suffix", () => {
		expect(redactSecret("AKIAIOSFODNN7EXAMPLE")).toMatch(/^AKIA/);
		expect(redactSecret("AKIAIOSFODNN7EXAMPLE").endsWith("LE")).toBe(true);
	});
});

describe("verdictForMatches + evaluateTextForSecrets", () => {
	function policy(mode: MissionPolicy["secretScanner"]): MissionPolicy {
		return { ...DEFAULT_MISSION_POLICY, secretScanner: mode };
	}

	test("allow when no matches regardless of mode", () => {
		expect(verdictForMatches([], policy("warn")).action).toBe("allow");
		expect(verdictForMatches([], policy("block")).action).toBe("allow");
	});

	test("mode=off → always allow even with matches", () => {
		const v = evaluateTextForSecrets("AKIAIOSFODNN7EXAMPLE", policy("off"));
		expect(v.action).toBe("allow");
	});

	test("mode=warn with matches → warn", () => {
		const v = evaluateTextForSecrets("AKIAIOSFODNN7EXAMPLE", policy("warn"));
		expect(v.action).toBe("warn");
		expect(v.matches).toHaveLength(1);
	});

	test("mode=block with matches → block", () => {
		const v = evaluateTextForSecrets("AKIAIOSFODNN7EXAMPLE", policy("block"));
		expect(v.action).toBe("block");
	});
});
