import { describe, expect, test } from "bun:test";
import { parseWorkflowScript } from "../../src/tools/workflow/workflow";

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
		expect(() => parseWorkflowScript("export const meta = { name: `demo_${id}`, description: 'desc' }")).toThrow(
			/template interpolation not allowed/,
		);
	});

	test("rejects nondeterministic APIs", () => {
		expect(() =>
			parseWorkflowScript("export const meta = { name: 'demo', description: 'desc' }\nreturn Date.now()"),
		).toThrow(/must be deterministic/);
		expect(() =>
			parseWorkflowScript("export const meta = { name: 'demo', description: 'desc' }\nreturn Math.random()"),
		).toThrow(/must be deterministic/);
		expect(() =>
			parseWorkflowScript("export const meta = { name: 'demo', description: 'desc' }\nreturn new Date()"),
		).toThrow(/must be deterministic/);
	});
});
