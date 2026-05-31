import { describe, expect, test } from "bun:test";
import { WorkflowAgent } from "../../src/tools/workflow/agent";
import { renderWorkflowLines } from "../../src/tools/workflow/display";
import { parseWorkflowScript, runWorkflow } from "../../src/tools/workflow/workflow";

const validScript = `export const meta = {
  name: 'demo_workflow',
  description: 'A useful workflow',
  whenToUse: 'When testing parser behavior',
  phases: [{ title: 'Scan', detail: 'Collect inputs', model: 'default' }]
}

phase('Scan')
return { ok: true }
`;

describe("parseWorkflowScript", () => {
	test("accepts literal workflow metadata", () => {
		const parsed = parseWorkflowScript(validScript);
		expect(parsed.meta.name).toBe("demo_workflow");
		expect(parsed.meta.description).toBe("A useful workflow");
		expect(parsed.meta.phases).toEqual([{ title: "Scan", detail: "Collect inputs", model: "default" }]);
		expect(parsed.body).toContain("phase('Scan')");
		expect(parsed.body).not.toContain("export const meta");
	});

	test("accepts static template literals", () => {
		const parsed = parseWorkflowScript("export const meta = { name: `demo`, description: `static` }\nreturn true");
		expect(parsed.meta.name).toBe("demo");
		expect(parsed.meta.description).toBe("static");
	});

	test("requires meta export first", () => {
		expect(() =>
			parseWorkflowScript("const x = 1\nexport const meta = { name: 'demo', description: 'desc' }"),
		).toThrow(/must be the first statement/);
	});

	test("requires name and description", () => {
		expect(() => parseWorkflowScript("export const meta = { name: 'demo' }")).toThrow(/meta.description/);
		expect(() => parseWorkflowScript("export const meta = { description: 'desc' }")).toThrow(/meta.name/);
	});

	test("rejects non-literal metadata", () => {
		expect(() => parseWorkflowScript("export const meta = { name: makeName(), description: 'desc' }")).toThrow(
			/non-literal node type.*CallExpression/,
		);
		expect(() =>
			parseWorkflowScript("const name = 'demo'; export const meta = { name, description: 'desc' }"),
		).toThrow(/must be the first statement/);
		expect(() => parseWorkflowScript("export const meta = { name: name, description: 'desc' }")).toThrow(
			/non-literal node type.*Identifier/,
		);
	});

	test("rejects object hazards", () => {
		expect(() => parseWorkflowScript("export const meta = { ...base, name: 'demo', description: 'desc' }")).toThrow(
			/spread not allowed/,
		);
		expect(() => parseWorkflowScript("export const meta = { ['name']: 'demo', description: 'desc' }")).toThrow(
			/computed keys not allowed/,
		);
		expect(() =>
			parseWorkflowScript("export const meta = { __proto__: {}, name: 'demo', description: 'desc' }"),
		).toThrow(/reserved key name/);
		expect(() =>
			parseWorkflowScript("export const meta = { get name() { return 'demo' }, description: 'desc' }"),
		).toThrow(/methods\/accessors not allowed/);
	});

	test("rejects array hazards", () => {
		expect(() =>
			parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: [,,] }"),
		).toThrow(/sparse arrays not allowed/);
		expect(() =>
			parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: [...items] }"),
		).toThrow(/spread not allowed/);
	});

	test("rejects template interpolation", () => {
		const interpolation = "export const meta = { name: `demo_$" + "{id}`, description: 'desc' }";
		expect(() => parseWorkflowScript(interpolation)).toThrow(/template interpolation not allowed/);
	});

	test("rejects nondeterministic APIs", () => {
		for (const body of [
			"return Date()",
			"return Date.now()",
			"return Date['now']()",
			"return Math.random()",
			"return Math['random']()",
			"return globalThis.Date()",
			"return globalThis.Math.random()",
			"return new Date()",
		]) {
			expect(() =>
				parseWorkflowScript(`export const meta = { name: 'demo', description: 'desc' }\n${body}`),
			).toThrow(/must be deterministic/);
		}
	});

	test("rejects synchronous loops before they can run after awaits", () => {
		expect(() =>
			parseWorkflowScript("export const meta = { name: 'demo', description: 'desc' }\nwhile (true) {}"),
		).toThrow(/cannot use synchronous loops/);
		expect(() =>
			parseWorkflowScript(
				"export const meta = { name: 'demo', description: 'desc' }\nawait agent('ok')\nwhile (true) {}",
			),
		).toThrow(/cannot use synchronous loops/);
	});
});

describe("runWorkflow", () => {
	const script = (body: string) => `export const meta = { name: 'runtime_demo', description: 'desc' }\n${body}`;

	test("reports intentional null agent results as success", async () => {
		const events: Array<{ failed: boolean; result: unknown }> = [];
		const result = await runWorkflow(script("return await agent('return null')"), {
			agent: { run: async () => null },
			onAgentEnd: event => events.push({ failed: event.failed, result: event.result }),
		});

		expect(result.result).toBeNull();
		expect(events).toEqual([{ failed: false, result: null }]);
	});

	test("rejects unsupported per-agent options instead of silently prompting", async () => {
		const events: Array<{ failed: boolean; error?: string }> = [];
		const result = await runWorkflow(script("return await agent('x', { model: 'slow' })"), {
			agent: {
				run: async () => {
					throw new Error("agent should not run");
				},
			},
			onAgentEnd: event => events.push({ failed: event.failed, error: event.error }),
		});

		expect(result.result).toBeNull();
		expect(events[0]).toEqual({ failed: true, error: 'agent() option "model" is not supported by workflow' });
	});

	test("does not expose host process through constructors", async () => {
		await expect(
			runWorkflow(script("return Object.constructor('return process')()"), {
				agent: { run: async () => "unused" },
				scriptTimeoutMs: 100,
			}),
		).rejects.toThrow(/Code generation from strings disallowed|not defined/);
		await expect(
			runWorkflow(script("return budget.constructor.constructor('return process')()"), {
				agent: { run: async () => "unused" },
				scriptTimeoutMs: 100,
			}),
		).rejects.toThrow(/undefined|null/);
	});
});

describe("runWorkflow parallel/pipeline slot results", () => {
	const script = (body: string) => `export const meta = { name: 'slot_demo', description: 'desc' }\n${body}`;

	test("parallel surfaces per-slot failures as {ok:false,error} and preserves null as a valid value", async () => {
		const result = await runWorkflow(
			script(`return await parallel([
				() => null,
				async () => { throw new Error('boom'); },
				() => 'fine',
			])`),
			{ agent: { run: async () => "unused" } },
		);

		expect(result.result).toEqual([
			{ ok: true, value: null },
			{ ok: false, error: "boom" },
			{ ok: true, value: "fine" },
		]);
	});

	test("pipeline surfaces per-slot failures as {ok:false,error} and preserves null as a valid value", async () => {
		const result = await runWorkflow(
			script(`return await pipeline([1, 2, 3], (n) => {
				if (n === 1) return null;
				if (n === 2) throw new Error('two-bad');
				return n * 10;
			})`),
			{ agent: { run: async () => "unused" } },
		);

		expect(result.result).toEqual([
			{ ok: true, value: null },
			{ ok: false, error: "two-bad" },
			{ ok: true, value: 30 },
		]);
	});
});

describe("WorkflowAgent structured_output schema validation", () => {
	test("rejects with typed Error when options.schema is invalid (boolean false rejects all)", async () => {
		const agent = new WorkflowAgent();
		await expect(agent.run("hello", { schema: false })).rejects.toThrow(/Invalid structured_output schema/);
	});

	test("workflow agent() catches the schema error as a slot failure without crashing the script", async () => {
		const events: Array<{ failed: boolean; error?: string }> = [];
		const agent = new WorkflowAgent();
		const result = await runWorkflow(
			`export const meta = { name: 'schema_runtime', description: 'desc' }\nreturn await agent('x', { schema: false })`,
			{
				agent,
				onAgentEnd: event => events.push({ failed: event.failed, error: event.error }),
			},
		);

		expect(result.result).toBeNull();
		expect(events[0]?.failed).toBe(true);
		expect(events[0]?.error).toMatch(/Invalid structured_output schema/);
	});
});

describe("renderWorkflowLines", () => {
	test("sanitizes log lines before rendering", () => {
		const [line] = renderWorkflowLines({
			name: "demo",
			phases: [],
			logs: ["a\t".repeat(80)],
			agents: [],
			agentCount: 0,
			runningCount: 0,
			doneCount: 0,
			errorCount: 0,
		}).slice(-1);

		expect(line).not.toContain("\t");
		expect(line.length).toBeLessThanOrEqual(120);
	});
});
