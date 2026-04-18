/**
 * Tests for supervisor template helpers ported from taskplane
 * `extensions/taskplane/supervisor.ts:1924-2072`.
 *
 * Covers `resolveBaseTemplatePath`, `parseSupervisorTemplate`,
 * `loadSupervisorTemplate`, `replaceTemplateVars`, `buildGuardrailsSection`,
 * and `buildAutonomyDescription`.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildAutonomyDescription,
	buildGuardrailsSection,
	loadSupervisorTemplate,
	parseSupervisorTemplate,
	replaceTemplateVars,
	resolveBaseTemplatePath,
} from "../src/missioncontrol";

function sandbox(label: string): string {
	return mkdtempSync(join(tmpdir(), `omp-supervisor-tpl-${label}-`));
}

describe("resolveBaseTemplatePath", () => {
	test("points at the shipped templates/agents directory", () => {
		const p = resolveBaseTemplatePath("supervisor");
		expect(p.endsWith("templates/agents/supervisor.md") || p.endsWith("templates\\agents\\supervisor.md")).toBe(true);
	});
});

describe("parseSupervisorTemplate", () => {
	test("returns null when file does not exist", () => {
		const dir = sandbox("no-exist");
		try {
			expect(parseSupervisorTemplate(join(dir, "missing.md"))).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns null when file has no frontmatter block", () => {
		const dir = sandbox("no-fm");
		try {
			const p = join(dir, "plain.md");
			writeFileSync(p, "body without frontmatter", "utf-8");
			expect(parseSupervisorTemplate(p)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("parses key/value pairs and trims body", () => {
		const dir = sandbox("fm-kv");
		try {
			const p = join(dir, "t.md");
			writeFileSync(p, "---\nname: supervisor\nstandalone: false\n---\n   body text   \n", "utf-8");
			const r = parseSupervisorTemplate(p);
			expect(r?.fm.name).toBe("supervisor");
			expect(r?.fm.standalone).toBe("false");
			expect(r?.body).toBe("body text");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("skips commented-out frontmatter keys", () => {
		const dir = sandbox("fm-comment");
		try {
			const p = join(dir, "t.md");
			writeFileSync(p, "---\nreal: yes\n#ignored: still-ignored\n---\nbody\n", "utf-8");
			const r = parseSupervisorTemplate(p);
			expect(r?.fm.real).toBe("yes");
			expect(r?.fm["#ignored"]).toBeUndefined();
			expect(r?.fm.ignored).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("normalizes CRLF line endings", () => {
		const dir = sandbox("crlf");
		try {
			const p = join(dir, "t.md");
			writeFileSync(p, "---\r\nkey: v\r\n---\r\nbody\r\n", "utf-8");
			const r = parseSupervisorTemplate(p);
			expect(r?.fm.key).toBe("v");
			expect(r?.body).toBe("body");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("loadSupervisorTemplate", () => {
	test("loads base template from shipped templates/agents dir", () => {
		const dir = sandbox("base-only");
		try {
			const out = loadSupervisorTemplate("supervisor", dir);
			expect(typeof out).toBe("string");
			expect((out ?? "").length).toBeGreaterThan(10);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("local template with standalone: true replaces base entirely", () => {
		const dir = sandbox("standalone");
		try {
			mkdirSync(join(dir, ".omp", "agents"), { recursive: true });
			writeFileSync(join(dir, ".omp", "agents", "supervisor.md"), "---\nstandalone: true\n---\nOVERRIDE\n", "utf-8");
			expect(loadSupervisorTemplate("supervisor", dir)).toBe("OVERRIDE");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("composes base + local when local is not standalone", () => {
		const dir = sandbox("compose");
		try {
			mkdirSync(join(dir, ".omp", "agents"), { recursive: true });
			writeFileSync(join(dir, ".omp", "agents", "supervisor.md"), "---\nnote: project\n---\nPROJECT BLOCK", "utf-8");
			const out = loadSupervisorTemplate("supervisor", dir);
			expect(out).toContain("## Project-Specific Guidance");
			expect(out).toContain("PROJECT BLOCK");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("localName lets a base template reuse the same local override", () => {
		const dir = sandbox("local-name");
		try {
			mkdirSync(join(dir, ".omp", "agents"), { recursive: true });
			writeFileSync(join(dir, ".omp", "agents", "supervisor.md"), "---\nstandalone: true\n---\nSHARED", "utf-8");
			expect(loadSupervisorTemplate("supervisor-routing", dir, "supervisor")).toBe("SHARED");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns null when neither base nor local exists", () => {
		const dir = sandbox("no-tpl");
		try {
			expect(loadSupervisorTemplate("does-not-exist", dir)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("replaceTemplateVars", () => {
	test("replaces known placeholders", () => {
		expect(replaceTemplateVars("hello {{name}}", { name: "world" })).toBe("hello world");
	});

	test("leaves unknown placeholders intact", () => {
		expect(replaceTemplateVars("{{known}} vs {{unknown}}", { known: "v" })).toBe("v vs {{unknown}}");
	});

	test("handles multiple placeholders including repeats", () => {
		expect(replaceTemplateVars("{{a}}-{{a}}-{{b}}", { a: "x", b: "y" })).toBe("x-x-y");
	});
});

describe("buildGuardrailsSection", () => {
	test("supervised mode contains auto integration permissions and confirmation note", () => {
		const out = buildGuardrailsSection("supervised");
		expect(out).toContain("mode: supervised");
		expect(out).toContain("gh pr create");
		expect(out).toContain("ask the operator for confirmation");
	});

	test("auto mode announces direct execution", () => {
		const out = buildGuardrailsSection("auto");
		expect(out).toContain("mode: auto");
		expect(out).toContain("Execute integration directly");
	});

	test("manual (anything else) forbids git push and PR creation", () => {
		const out = buildGuardrailsSection("manual");
		expect(out).toContain("Never `git push`");
		expect(out).toContain("Never create PRs or GitHub releases");
		expect(out).not.toContain("Integration Permissions");
	});

	test("references .omp batch-state path (not legacy .pi)", () => {
		expect(buildGuardrailsSection("supervised")).toContain(".omp/batch-state.json");
		expect(buildGuardrailsSection("manual")).toContain(".omp/batch-state.json");
	});
});

describe("buildAutonomyDescription", () => {
	test.each([
		["interactive", "INTERACTIVE"],
		["supervised", "SUPERVISED"],
		["autonomous", "AUTONOMOUS"],
	])("%s → contains %s marker", (label, marker) => {
		expect(buildAutonomyDescription(label)).toContain(marker);
	});

	test("unknown label returns empty string", () => {
		expect(buildAutonomyDescription("unknown")).toBe("");
	});
});
