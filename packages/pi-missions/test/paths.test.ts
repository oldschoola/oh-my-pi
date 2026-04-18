import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	packageFileExists,
	packageRoot,
	resolveAgentTemplate,
	resolvePackageFile,
	resolveTaskTemplate,
} from "../src/missioncontrol/paths";

describe("missioncontrol.paths", () => {
	test("packageRoot resolves to the pi-missions package directory", () => {
		const root = packageRoot();
		expect(existsSync(root)).toBe(true);
		// package.json must be directly under the root.
		expect(existsSync(join(root, "package.json"))).toBe(true);
		expect(root).toMatch(/pi-missions$/);
	});

	test("resolvePackageFile joins against the package root", () => {
		expect(resolvePackageFile("package.json")).toBe(join(packageRoot(), "package.json"));
	});

	test("packageFileExists matches existsSync against the package root", () => {
		expect(packageFileExists("package.json")).toBe(true);
		expect(packageFileExists("does-not-exist.xyz")).toBe(false);
	});

	test("resolveAgentTemplate points at templates/agents/{name}.md", () => {
		const path = resolveAgentTemplate("task-worker");
		expect(
			path.endsWith("templates/agents/task-worker.md") || path.endsWith("templates\\agents\\task-worker.md"),
		).toBe(true);
		expect(existsSync(path)).toBe(true);
	});

	test("resolveTaskTemplate points at templates/tasks/{name}.md", () => {
		const path = resolveTaskTemplate("CONTEXT");
		expect(path.endsWith("templates/tasks/CONTEXT.md") || path.endsWith("templates\\tasks\\CONTEXT.md")).toBe(true);
	});
});
