/**
 * Tests for agent-def loader ported from taskplane
 * `extensions/taskplane/execution.ts:2309-2468`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadAgentDef,
	loadBaseAgentPrompt,
	loadLocalAgentPrompt,
	parseAgentFile,
	projectDir,
	resetPointerWarning,
	resolveAgentPointerRoot,
} from "../src/missioncontrol";

function sandbox(label: string): string {
	return mkdtempSync(join(tmpdir(), `omp-agent-def-${label}-`));
}

describe("parseAgentFile", () => {
	test("returns null when file does not exist", () => {
		const dir = sandbox("missing");
		try {
			expect(parseAgentFile(join(dir, "nope.md"))).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("body-only file returns empty fm with trimmed body", () => {
		const dir = sandbox("body-only");
		try {
			const p = join(dir, "agent.md");
			writeFileSync(p, "  just body text, no frontmatter  \n", "utf-8");
			const got = parseAgentFile(p);
			expect(got).not.toBeNull();
			expect(got?.fm).toEqual({});
			expect(got?.body).toBe("just body text, no frontmatter");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("parses frontmatter kv pairs + body", () => {
		const dir = sandbox("kv");
		try {
			const p = join(dir, "agent.md");
			writeFileSync(p, "---\ntools: read,grep\nmodel: claude-sonnet\n---\n\nHello world.\n", "utf-8");
			const got = parseAgentFile(p);
			expect(got?.fm).toEqual({ tools: "read,grep", model: "claude-sonnet" });
			expect(got?.body).toBe("Hello world.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("handles standalone: true frontmatter flag", () => {
		const dir = sandbox("standalone");
		try {
			const p = join(dir, "agent.md");
			writeFileSync(p, "---\nstandalone: true\ntools: read\n---\nBody only please.", "utf-8");
			const got = parseAgentFile(p);
			expect(got?.fm.standalone).toBe("true");
			expect(got?.fm.tools).toBe("read");
			expect(got?.body).toBe("Body only please.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("loadBaseAgentPrompt", () => {
	test("returns shipped template body for a real agent name", () => {
		// The pi-missions package ships templates; use an existing one.
		const body = loadBaseAgentPrompt("task-worker");
		expect(typeof body).toBe("string");
	});

	test("returns empty string when template is missing", () => {
		const body = loadBaseAgentPrompt("nonexistent-agent-xyz");
		expect(body).toBe("");
	});
});

describe("loadLocalAgentPrompt", () => {
	test("returns empty string when no local override exists", () => {
		const dir = sandbox("no-local");
		try {
			const body = loadLocalAgentPrompt(dir, "task-worker");
			expect(body).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("prefers .omp/agents/<name>.md over agents/<name>.md", () => {
		const dir = sandbox("priority");
		try {
			mkdirSync(join(projectDir(dir), "agents"), { recursive: true });
			mkdirSync(join(dir, "agents"), { recursive: true });
			writeFileSync(join(projectDir(dir), "agents", "task-worker.md"), "from-omp", "utf-8");
			writeFileSync(join(dir, "agents", "task-worker.md"), "from-cwd", "utf-8");
			expect(loadLocalAgentPrompt(dir, "task-worker")).toBe("from-omp");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("falls back to <cwd>/agents/<name>.md", () => {
		const dir = sandbox("fallback");
		try {
			mkdirSync(join(dir, "agents"), { recursive: true });
			writeFileSync(join(dir, "agents", "task-worker.md"), "from-cwd", "utf-8");
			expect(loadLocalAgentPrompt(dir, "task-worker")).toBe("from-cwd");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("standalone: true returns body only", () => {
		const dir = sandbox("standalone-local");
		try {
			mkdirSync(join(projectDir(dir), "agents"), { recursive: true });
			writeFileSync(
				join(projectDir(dir), "agents", "task-worker.md"),
				"---\nstandalone: true\n---\nlocal-only body",
				"utf-8",
			);
			expect(loadLocalAgentPrompt(dir, "task-worker")).toBe("local-only body");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveAgentPointerRoot", () => {
	const savedWs = process.env.OMP_WORKSPACE_ROOT;
	const savedLegacy = process.env.TASKPLANE_WORKSPACE_ROOT;

	beforeEach(() => {
		delete process.env.OMP_WORKSPACE_ROOT;
		delete process.env.TASKPLANE_WORKSPACE_ROOT;
		resetPointerWarning();
	});

	afterEach(() => {
		if (savedWs) process.env.OMP_WORKSPACE_ROOT = savedWs;
		else delete process.env.OMP_WORKSPACE_ROOT;
		if (savedLegacy) process.env.TASKPLANE_WORKSPACE_ROOT = savedLegacy;
		else delete process.env.TASKPLANE_WORKSPACE_ROOT;
	});

	test("returns null in repo mode (no workspace env)", () => {
		expect(resolveAgentPointerRoot()).toBeNull();
	});
});

describe("loadAgentDef", () => {
	test("returns null when neither base nor local files exist", () => {
		const dir = sandbox("null");
		try {
			expect(loadAgentDef(dir, "nonexistent-agent-xyz")).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("standalone local short-circuits base composition", () => {
		const dir = sandbox("standalone-compose");
		try {
			mkdirSync(join(projectDir(dir), "agents"), { recursive: true });
			writeFileSync(
				join(projectDir(dir), "agents", "task-worker.md"),
				"---\nstandalone: true\ntools: read,grep\nmodel: my-model\n---\nsolo prompt",
				"utf-8",
			);
			const def = loadAgentDef(dir, "task-worker");
			expect(def).not.toBeNull();
			expect(def?.systemPrompt).toBe("solo prompt");
			expect(def?.tools).toBe("read,grep");
			expect(def?.model).toBe("my-model");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("standalone without tools/model uses safe defaults", () => {
		const dir = sandbox("standalone-defaults");
		try {
			mkdirSync(join(projectDir(dir), "agents"), { recursive: true });
			writeFileSync(join(projectDir(dir), "agents", "task-worker.md"), "---\nstandalone: true\n---\nbody", "utf-8");
			const def = loadAgentDef(dir, "task-worker");
			expect(def?.tools).toBe("read,grep,find,ls");
			expect(def?.model).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("composes base template + local override", () => {
		const dir = sandbox("compose");
		try {
			mkdirSync(join(projectDir(dir), "agents"), { recursive: true });
			writeFileSync(join(projectDir(dir), "agents", "task-worker.md"), "local guidance text", "utf-8");
			const def = loadAgentDef(dir, "task-worker");
			expect(def).not.toBeNull();
			expect(def?.systemPrompt).toContain("## Project-Specific Guidance");
			expect(def?.systemPrompt).toContain("local guidance text");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns base-only definition when no local override exists", () => {
		const dir = sandbox("base-only");
		try {
			const def = loadAgentDef(dir, "task-worker");
			expect(def).not.toBeNull();
			expect(def?.systemPrompt.length).toBeGreaterThan(0);
			expect(def?.systemPrompt).not.toContain("## Project-Specific Guidance");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
