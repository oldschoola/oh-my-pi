/**
 * Unit tests for policy classifier + enforcement (Track I).
 */

import { describe, expect, test } from "bun:test";

import type { MissionPolicy } from "../src/missioncontrol";
import {
	classifyToolCall,
	DEFAULT_MISSION_POLICY,
	DEFAULT_RISK_TABLE,
	DESTRUCTIVE_BASH_PATTERNS,
	evaluateToolCall,
	mergePolicy,
} from "../src/missioncontrol";

function policy(overrides: Partial<MissionPolicy> = {}): MissionPolicy {
	return { ...DEFAULT_MISSION_POLICY, ...overrides };
}

describe("classifyToolCall", () => {
	test("read-only tools classify as safe", () => {
		expect(classifyToolCall("read", {})).toBe("safe");
		expect(classifyToolCall("grep", {})).toBe("safe");
		expect(classifyToolCall("orch_read_knowledge", {})).toBe("safe");
		expect(classifyToolCall("orch_status", {})).toBe("safe");
	});

	test("write / edit / knowledge-mutation tools classify as privileged", () => {
		expect(classifyToolCall("write", {})).toBe("privileged");
		expect(classifyToolCall("edit", {})).toBe("privileged");
		expect(classifyToolCall("orch_write_knowledge_entry", {})).toBe("privileged");
		expect(classifyToolCall("orch_set_role_model", {})).toBe("privileged");
	});

	test("abort / integrate / force_merge classify as destructive", () => {
		expect(classifyToolCall("orch_abort", {})).toBe("destructive");
		expect(classifyToolCall("orch_integrate", {})).toBe("destructive");
		expect(classifyToolCall("orch_force_merge", {})).toBe("destructive");
	});

	test("unknown tool falls back to privileged", () => {
		expect(classifyToolCall("obscure_unknown_tool", {})).toBe("privileged");
	});

	test("bash promotes to destructive on risky patterns", () => {
		expect(classifyToolCall("bash", { command: "rm -rf /tmp/x" })).toBe("destructive");
		expect(classifyToolCall("bash", { command: "git push --force origin main" })).toBe("destructive");
		expect(classifyToolCall("bash", { command: "DROP TABLE users;" })).toBe("destructive");
		expect(classifyToolCall("bash", { command: "git reset --hard HEAD~10" })).toBe("destructive");
	});

	test("bash remains destructive-by-default even on benign commands", () => {
		// bash is always destructive in the default table.
		expect(classifyToolCall("bash", { command: "ls -la" })).toBe("destructive");
	});

	test("custom risk table overrides defaults", () => {
		const custom = { bash: "privileged" } as Record<string, "privileged">;
		expect(classifyToolCall("bash", { command: "ls" }, custom)).toBe("privileged");
		// Pattern still promotes to destructive.
		expect(classifyToolCall("bash", { command: "rm -rf /" }, custom)).toBe("destructive");
	});

	test("bash command extracted from various arg shapes", () => {
		expect(classifyToolCall("bash", { cmd: "rm -rf /" })).toBe("destructive");
		expect(classifyToolCall("bash", { script: "rm -rf /" })).toBe("destructive");
		expect(classifyToolCall("bash", { args: ["rm", "-rf", "/"] })).toBe("destructive");
	});

	test("DESTRUCTIVE_BASH_PATTERNS is non-empty and all entries fire", () => {
		expect(DESTRUCTIVE_BASH_PATTERNS.length).toBeGreaterThan(0);
		for (const p of DESTRUCTIVE_BASH_PATTERNS) {
			expect(classifyToolCall("bash", { command: `prefix ${p} suffix` })).toBe("destructive");
		}
	});

	test("DEFAULT_RISK_TABLE covers every orch_* tool we register", () => {
		// sanity: a sampling of important orch_* tools should be present.
		expect(DEFAULT_RISK_TABLE.orch_write_validation_contract).toBeDefined();
		expect(DEFAULT_RISK_TABLE.orch_create_milestone).toBeDefined();
		expect(DEFAULT_RISK_TABLE.orch_set_role_model).toBeDefined();
	});
});

describe("mergePolicy", () => {
	test("undefined partial returns defaults by reference", () => {
		expect(mergePolicy()).toBe(DEFAULT_MISSION_POLICY);
	});

	test("merges each field independently", () => {
		const p = mergePolicy({ approval: "privileged", secretScanner: "block" });
		expect(p.approval).toBe("privileged");
		expect(p.secretScanner).toBe("block");
		expect(p.deniedTools).toEqual([]);
		expect(p.allowedTools).toEqual([]);
	});

	test("respects explicit empty arrays", () => {
		const p = mergePolicy({ deniedTools: [] });
		expect(p.deniedTools).toEqual([]);
	});
});

describe("evaluateToolCall", () => {
	test("default policy allows safe tools", () => {
		const d = evaluateToolCall("read", {});
		expect(d.action).toBe("allow");
		expect(d.risk).toBe("safe");
	});

	test("default policy requires approval for destructive tools", () => {
		const d = evaluateToolCall("orch_abort", {});
		expect(d.action).toBe("approve");
		expect(d.risk).toBe("destructive");
	});

	test("default policy allows privileged tools without approval", () => {
		const d = evaluateToolCall("write", {});
		expect(d.action).toBe("allow");
		expect(d.risk).toBe("privileged");
	});

	test("approval=all forces approval on every non-deny call", () => {
		const d = evaluateToolCall("read", {}, policy({ approval: "all" }));
		expect(d.action).toBe("approve");
	});

	test("approval=privileged gates both privileged + destructive", () => {
		const d1 = evaluateToolCall("write", {}, policy({ approval: "privileged" }));
		expect(d1.action).toBe("approve");
		const d2 = evaluateToolCall("orch_abort", {}, policy({ approval: "privileged" }));
		expect(d2.action).toBe("approve");
		const d3 = evaluateToolCall("read", {}, policy({ approval: "privileged" }));
		expect(d3.action).toBe("allow");
	});

	test("approval=never always allows (matching classification still reported)", () => {
		const d = evaluateToolCall("orch_abort", {}, policy({ approval: "never" }));
		expect(d.action).toBe("allow");
		expect(d.risk).toBe("destructive");
	});

	test("deniedTools takes priority over classification", () => {
		const d = evaluateToolCall("read", {}, policy({ deniedTools: ["read"] }));
		expect(d.action).toBe("deny");
		expect(d.reason).toContain("deny-list");
	});

	test("non-empty allowedTools rejects anything outside", () => {
		const d = evaluateToolCall("read", {}, policy({ allowedTools: ["write"] }));
		expect(d.action).toBe("deny");
		expect(d.reason).toContain("allow-list");
	});

	test("allowedTools permits listed tools", () => {
		const d = evaluateToolCall("write", {}, policy({ allowedTools: ["write"] }));
		expect(d.action).toBe("allow");
	});

	test("bash deniedBashPatterns fire before approval check", () => {
		const d = evaluateToolCall(
			"bash",
			{ command: "npm publish --force" },
			policy({ deniedBashPatterns: ["npm publish"] }),
		);
		expect(d.action).toBe("deny");
		expect(d.reason).toContain("npm publish");
	});

	test("bash deniedBashPatterns are case-insensitive", () => {
		const d = evaluateToolCall("bash", { command: "CURL http://evil" }, policy({ deniedBashPatterns: ["curl"] }));
		expect(d.action).toBe("deny");
	});
});
