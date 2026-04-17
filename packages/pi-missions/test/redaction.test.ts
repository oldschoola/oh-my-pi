import { describe, expect, test } from "bun:test";
import { MAX_TOOL_ARG_LENGTH, redactEvent, redactString, redactSummary, redactValue } from "../src/telemetry/redaction";

describe("redactString", () => {
	test("redacts Bearer tokens", () => {
		const input = "Authorization: Bearer sk-ant-abc123DEF456ghi789";
		const out = redactString(input);
		expect(out).toBe("Authorization: Bearer [REDACTED]");
	});

	test("redacts sk- API keys", () => {
		const input = "api_key=sk-ant-abcdefghij1234567890";
		const out = redactString(input);
		expect(out.includes("[REDACTED]")).toBe(true);
		expect(out.includes("abcdefghij1234567890")).toBe(false);
	});

	test("redacts key- prefix", () => {
		const input = "key-ABCDEF0123456789ABCDEF";
		const out = redactString(input);
		expect(out).toBe("[REDACTED]");
	});

	test("redacts token- prefix", () => {
		const input = "token-ABCDEF0123456789ABCDEF";
		const out = redactString(input);
		expect(out).toBe("[REDACTED]");
	});

	test("leaves normal strings untouched", () => {
		expect(redactString("hello world")).toBe("hello world");
	});
});

describe("redactValue", () => {
	test("redacts env-like secret keys on objects", () => {
		const input = {
			ANTHROPIC_API_KEY: "sk-ant-actualsecretvalue123",
			OPENAI_TOKEN: "literally-any-string",
			DB_SECRET: "shh",
			NORMAL_VAR: "visible",
		};
		const out = redactValue(input) as Record<string, string>;
		expect(out.ANTHROPIC_API_KEY).toBe("[REDACTED]");
		expect(out.OPENAI_TOKEN).toBe("[REDACTED]");
		expect(out.DB_SECRET).toBe("[REDACTED]");
		expect(out.NORMAL_VAR).toBe("visible");
	});

	test("truncates strings over 500 chars", () => {
		const input = "a".repeat(600);
		const out = redactValue(input) as string;
		expect(out.length).toBeLessThan(600);
		expect(out.endsWith("…[truncated]")).toBe(true);
		expect(out.startsWith("a".repeat(MAX_TOOL_ARG_LENGTH))).toBe(true);
	});

	test("recurses into arrays", () => {
		const input = ["plain", { API_KEY: "sekrit" }];
		const out = redactValue(input) as unknown[];
		expect(out[0]).toBe("plain");
		expect((out[1] as { API_KEY: string }).API_KEY).toBe("[REDACTED]");
	});

	test("preserves null/undefined", () => {
		expect(redactValue(null)).toBe(null);
		expect(redactValue(undefined)).toBe(undefined);
	});
});

describe("redactEvent", () => {
	test("redacts args, result, error fields", () => {
		const event = {
			type: "tool_execution_start",
			args: { token: "Bearer sk-abc1234567890ABCDEF" },
			result: { env: { ANTHROPIC_API_KEY: "sk-live-xxxxxxxxxxxxxxxx" } },
			error: "call failed: sk-ant-aaaaaaaaaaaaaaaa",
		};
		const out = redactEvent(event);
		const argsToken = (out.args as { token: string }).token;
		expect(argsToken.includes("[REDACTED]")).toBe(true);
		const resultKey = (out.result as { env: { ANTHROPIC_API_KEY: string } }).env.ANTHROPIC_API_KEY;
		expect(resultKey).toBe("[REDACTED]");
		expect(out.error).toContain("[REDACTED]");
	});

	test("passes null/undefined through", () => {
		expect(redactEvent(null)).toBe(null);
		expect(redactEvent(undefined)).toBe(undefined);
	});
});

describe("redactSummary", () => {
	test("redacts retries error strings", () => {
		const summary = {
			exitCode: 1,
			retries: [
				{ attempt: 1, error: "Bearer sk-ant-abcdef0123456789" },
				{ attempt: 2, error: "no secret here" },
			],
		};
		const out = redactSummary(summary);
		expect(out.retries?.[0]?.error).toBe("Bearer [REDACTED]");
		expect(out.retries?.[1]?.error).toBe("no secret here");
	});

	test("truncates and redacts lastToolCall", () => {
		const long = `sk-ant-${"b".repeat(600)}`;
		const out = redactSummary({ lastToolCall: long });
		expect((out.lastToolCall as string).endsWith("…[truncated]")).toBe(true);
		expect((out.lastToolCall as string).includes("[REDACTED]")).toBe(true);
	});

	test("leaves non-string error untouched", () => {
		const out = redactSummary({ error: null as unknown });
		expect(out.error).toBeNull();
	});
});
