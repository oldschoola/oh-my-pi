import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../../src/registry/agent-registry";

interface KnowledgeFixture {
	cwd: string;
	memoryRoot: string;
	agentDir: string;
	cleanupRoot: string;
}

const SAMPLE_DOC = `---
id: kd_demo
title: Demo
summary: Frontmatter summary line
---
# Demo

## Summary
Body summary section content.

<!-- omp:body:start -->
This is the body region.
Second body line.
<!-- omp:body:end -->
`;

const MARKER_LESS_DOC = `---
id: kd_legacy
title: Legacy
---
# Legacy

Plain markdown body without markers.
`;

async function withKnowledgeFixture(fn: (fixture: KnowledgeFixture) => Promise<void>): Promise<void> {
	const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-protocol-"));
	const previousAgentDir = getAgentDir();
	try {
		const agentDir = path.join(cleanupRoot, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		const cwd = path.join(cleanupRoot, "project");
		await fs.mkdir(cwd, { recursive: true });
		setAgentDir(agentDir);
		const memoryRoot = getMemoryRoot(agentDir, cwd);
		await fs.mkdir(memoryRoot, { recursive: true });
		AgentRegistry.global().register({
			id: "test-main",
			displayName: "test",
			kind: "main",
			session: {
				sessionManager: {
					getCwd: () => cwd,
					getArtifactsDir: () => null,
					getSessionId: () => "test",
				},
			} as unknown as AgentSession,
			sessionFile: null,
		});
		await fn({ cwd, memoryRoot, agentDir, cleanupRoot });
	} finally {
		setAgentDir(previousAgentDir);
		await fs.rm(cleanupRoot, { recursive: true, force: true });
	}
}

async function writeDoc(memoryRoot: string, rel: string, content: string): Promise<void> {
	const absPath = path.join(memoryRoot, rel);
	await fs.mkdir(path.dirname(absPath), { recursive: true });
	await Bun.write(absPath, content);
}

describe("KnowledgeProtocolHandler", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	describe("happy path", () => {
		it("resolves knowledge://memory/<doc>.md", async () => {
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "memory/notes.md", SAMPLE_DOC);

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/notes.md");

				expect(resource.content).toBe(SAMPLE_DOC);
				expect(resource.contentType).toBe("text/markdown");
			});
		});

		it("auto-appends .md (slug form matches /knowledge:<slug>)", async () => {
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "memory/notes.md", SAMPLE_DOC);

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/notes");

				expect(resource.content).toBe(SAMPLE_DOC);
			});
		});

		it("resolves skill, design, reference type buckets", async () => {
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "skill/foo/SKILL.md", "skill-body");
				await writeDoc(memoryRoot, "design/arch.md", "design-body");
				await writeDoc(memoryRoot, "reference/api.md", "reference-body");

				const router = InternalUrlRouter.instance();
				expect((await router.resolve("knowledge://skill/foo/SKILL.md")).content).toBe("skill-body");
				expect((await router.resolve("knowledge://design/arch.md")).content).toBe("design-body");
				expect((await router.resolve("knowledge://reference/api.md")).content).toBe("reference-body");
			});
		});

		it("marks resources immutable", async () => {
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "memory/notes.md", SAMPLE_DOC);

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/notes.md");

				expect(resource.immutable).toBe(true);
			});
		});
	});

	describe("part selectors", () => {
		it("?part=body returns body region only when markers exist", async () => {
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "memory/notes.md", SAMPLE_DOC);

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/notes.md?part=body");

				expect(resource.content).toBe("This is the body region.\nSecond body line.");
				expect(resource.contentType).toBe("text/markdown");
			});
		});

		it("?part=body falls back to frontmatter-stripped content when markers absent", async () => {
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "memory/legacy.md", MARKER_LESS_DOC);

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/legacy.md?part=body");

				expect(resource.content).toBe("# Legacy\n\nPlain markdown body without markers.");
			});
		});

		it("?part=summary returns frontmatter summary when set", async () => {
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "memory/notes.md", SAMPLE_DOC);

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/notes.md?part=summary");

				expect(resource.content).toBe("Frontmatter summary line");
			});
		});

		it("?part=summary falls back to ## Summary section when frontmatter omits it", async () => {
			const docWithoutFmSummary = SAMPLE_DOC.replace("summary: Frontmatter summary line\n", "");
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "memory/notes.md", docWithoutFmSummary);

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/notes.md?part=summary");

				expect(resource.content).toBe("Body summary section content.");
			});
		});

		it("?part=full returns raw bytes", async () => {
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "memory/notes.md", SAMPLE_DOC);

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/notes.md?part=full");

				expect(resource.content).toBe(SAMPLE_DOC);
			});
		});

		it("unknown ?part value falls through to full bytes", async () => {
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "memory/notes.md", SAMPLE_DOC);

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/notes.md?part=garbage");

				expect(resource.content).toBe(SAMPLE_DOC);
			});
		});
	});

	describe("frontmatter selector", () => {
		it("?frontmatter=1 returns the YAML head only", async () => {
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "memory/notes.md", SAMPLE_DOC);

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/notes.md?frontmatter=1");

				expect(resource.content).toBe("---\nid: kd_demo\ntitle: Demo\nsummary: Frontmatter summary line\n---\n");
				expect(resource.contentType).toBe("text/plain");
			});
		});

		it("?frontmatter=1 wins over ?part=body", async () => {
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "memory/notes.md", SAMPLE_DOC);

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/notes.md?frontmatter=1&part=body");

				expect(resource.content.startsWith("---\n")).toBe(true);
				expect(resource.content.includes("body region")).toBe(false);
			});
		});
	});

	describe("validation", () => {
		it("rejects missing type bucket", async () => {
			await withKnowledgeFixture(async () => {
				const router = InternalUrlRouter.instance();
				await expect(router.resolve("knowledge://")).rejects.toThrow("knowledge:// URL requires a type bucket");
			});
		});

		it("rejects missing path", async () => {
			await withKnowledgeFixture(async () => {
				const router = InternalUrlRouter.instance();
				await expect(router.resolve("knowledge://memory")).rejects.toThrow("knowledge:// requires a path");
				await expect(router.resolve("knowledge://memory/")).rejects.toThrow("knowledge:// requires a path");
			});
		});

		it("rejects unknown type", async () => {
			await withKnowledgeFixture(async () => {
				const router = InternalUrlRouter.instance();
				await expect(router.resolve("knowledge://unknown/foo.md")).rejects.toThrow(
					/Unknown knowledge type: unknown\. Supported: memory, skill, design, reference/,
				);
			});
		});

		it("blocks path traversal", async () => {
			await withKnowledgeFixture(async () => {
				const router = InternalUrlRouter.instance();
				await expect(router.resolve("knowledge://memory/../secret.md")).rejects.toThrow(
					"Path traversal (..) is not allowed in knowledge:// URLs",
				);
			});
		});

		it("rejects .omp-meta sidecars", async () => {
			await withKnowledgeFixture(async () => {
				const router = InternalUrlRouter.instance();
				await expect(router.resolve("knowledge://memory/foo.omp-meta")).rejects.toThrow(
					"knowledge:// only serves .md documents",
				);
			});
		});

		it("rejects non-.md extensions", async () => {
			await withKnowledgeFixture(async () => {
				const router = InternalUrlRouter.instance();
				await expect(router.resolve("knowledge://memory/foo.txt")).rejects.toThrow(
					"knowledge:// only serves .md documents",
				);
			});
		});

		it("reports missing docs with the requested URL", async () => {
			await withKnowledgeFixture(async () => {
				const router = InternalUrlRouter.instance();
				await expect(router.resolve("knowledge://memory/missing.md")).rejects.toThrow(
					"Knowledge document not found: knowledge://memory/missing.md",
				);
			});
		});
	});

	describe("cross-session", () => {
		it("resolves docs across multiple registered memory roots", async () => {
			await withKnowledgeFixture(async ({ cleanupRoot, agentDir }) => {
				// Register a second session with a disjoint cwd → different memory root.
				const secondCwd = path.join(cleanupRoot, "project-2");
				await fs.mkdir(secondCwd, { recursive: true });
				const secondRoot = getMemoryRoot(agentDir, secondCwd);
				await fs.mkdir(secondRoot, { recursive: true });
				await writeDoc(secondRoot, "memory/only-here.md", "second-root-body");

				AgentRegistry.global().register({
					id: "test-worktree",
					displayName: "worktree",
					kind: "sub",
					session: {
						sessionManager: {
							getCwd: () => secondCwd,
							getArtifactsDir: () => null,
							getSessionId: () => "test-2",
						},
					} as unknown as AgentSession,
					sessionFile: null,
				});

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/only-here.md");

				expect(resource.content).toBe("second-root-body");
			});
		});
	});

	describe("CRLF line endings", () => {
		it("?part=body strips frontmatter from a marker-less CRLF doc", async () => {
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				const crlf = MARKER_LESS_DOC.replace(/\n/g, "\r\n");
				await writeDoc(memoryRoot, "memory/crlf.md", crlf);

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/crlf.md?part=body");

				expect(resource.content.startsWith("---")).toBe(false);
				expect(resource.content).toContain("Plain markdown body without markers.");
			});
		});

		it("?frontmatter=1 returns the YAML head on a CRLF doc", async () => {
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				const crlf = SAMPLE_DOC.replace(/\n/g, "\r\n");
				await writeDoc(memoryRoot, "memory/crlf.md", crlf);

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/crlf.md?frontmatter=1");

				// Frontmatter head emitted with original CRLF preserved (regex did match).
				expect(resource.content).toContain("id: kd_demo");
				expect(resource.content).toContain("summary: Frontmatter summary line");
				expect(resource.content.startsWith("---")).toBe(true);
				expect(resource.content.trimEnd().endsWith("---")).toBe(true);
			});
		});
	});

	describe("case-insensitive type bucket", () => {
		it("knowledge://Memory/<doc> resolves identically to lowercase", async () => {
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "memory/notes.md", SAMPLE_DOC);

				const router = InternalUrlRouter.instance();
				const upper = await router.resolve("knowledge://Memory/notes.md");
				const lower = await router.resolve("knowledge://memory/notes.md");

				expect(upper.content).toBe(lower.content);
			});
		});
	});

	describe("symlink containment", () => {
		it("rejects symlinks that escape the type root", async () => {
			if (process.platform === "win32") return;

			await withKnowledgeFixture(async ({ memoryRoot, cleanupRoot }) => {
				const outsideDir = path.join(cleanupRoot, "outside");
				await fs.mkdir(outsideDir, { recursive: true });
				await Bun.write(path.join(outsideDir, "secret.md"), "secret");
				await fs.mkdir(path.join(memoryRoot, "memory"), { recursive: true });
				await fs.symlink(outsideDir, path.join(memoryRoot, "memory", "linked"));

				const router = InternalUrlRouter.instance();
				await expect(router.resolve("knowledge://memory/linked/secret.md")).rejects.toThrow(
					"knowledge:// URL escapes type root",
				);
			});
		});

		it("rejects cross-bucket symlinks (memory/ → skill/)", async () => {
			if (process.platform === "win32") return;

			await withKnowledgeFixture(async ({ memoryRoot }) => {
				// Plant a real file in skill/, then point memory/ at skill/ via symlink.
				await writeDoc(memoryRoot, "skill/secret/SKILL.md", "skill-body");
				const memDir = path.join(memoryRoot, "memory");
				// memory/ must not exist for the symlink to take its name.
				await fs.symlink(path.join(memoryRoot, "skill"), memDir);

				const router = InternalUrlRouter.instance();
				await expect(router.resolve("knowledge://memory/secret/SKILL.md")).rejects.toThrow(
					"knowledge:// URL escapes type root",
				);
			});
		});
	});

	describe("absent-content notes", () => {
		it("?part=summary returns no-summary note when neither source exists", async () => {
			const noSummaryDoc = `---\nid: kd_nosum\ntitle: NoSummary\n---\n# NoSummary\n\nBody only.\n`;
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "memory/nosum.md", noSummaryDoc);

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/nosum.md?part=summary");

				expect(resource.content).toBe("");
				expect(resource.notes).toEqual(["no summary present"]);
			});
		});

		it("?frontmatter=1 returns no-frontmatter note for a doc without YAML head", async () => {
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "memory/plain.md", "# plain\n\nbody\n");

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/plain.md?frontmatter=1");

				expect(resource.content).toBe("");
				expect(resource.notes).toEqual(["no frontmatter present"]);
			});
		});
	});

	describe("dangling body markers", () => {
		it("?part=body strips orphan start/end markers when only one is present", async () => {
			const orphanDoc = `---\nid: kd_orph\ntitle: Orphan\n---\n# Orphan\n\n<!-- omp:body:start -->\nbody-bytes\n`;
			await withKnowledgeFixture(async ({ memoryRoot }) => {
				await writeDoc(memoryRoot, "memory/orphan.md", orphanDoc);

				const router = InternalUrlRouter.instance();
				const resource = await router.resolve("knowledge://memory/orphan.md?part=body");

				expect(resource.content).not.toContain("omp:body:start");
				expect(resource.content).not.toContain("omp:body:end");
				expect(resource.content).toContain("body-bytes");
			});
		});
	});

	describe("error message scheme labels", () => {
		it("traversal error names knowledge:// (not skill://)", async () => {
			await withKnowledgeFixture(async () => {
				const router = InternalUrlRouter.instance();
				await expect(router.resolve("knowledge://memory/../secret.md")).rejects.toThrow(
					"Path traversal (..) is not allowed in knowledge:// URLs",
				);
			});
		});
	});
});
