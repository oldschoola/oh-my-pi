// Coverage for the knowledge ops layer used by the seven knowledge
// tools. Verifies path validation, body-marker rewrite, permission
// gating, and cross-type guardrails.

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sidecarPathForDirectory, stringifySidecar, TYPE_DIRS } from "../../src/memories/directory-config";
import { parseMemoryDoc } from "../../src/memories/document";
import {
	extractSummarySection,
	KnowledgeOpsError,
	knowledgeCreateDirectory,
	knowledgeCreateDocument,
	knowledgeDelete,
	knowledgeEditDocument,
	knowledgeList,
	knowledgeMove,
	knowledgeQuery,
	knowledgeRead,
	resolveKnowledgePath,
} from "../../src/memories/knowledge-ops";

async function withTempRoot<T>(fn: (memoryRoot: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-ops-"));
	try {
		const memoryRoot = path.join(dir, "memory-root");
		await fs.mkdir(memoryRoot, { recursive: true });
		return await fn(memoryRoot);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("resolveKnowledgePath", () => {
	it("rejects missing type prefix", () => {
		expect(() => resolveKnowledgePath("/tmp/root", "foo.md", "document")).toThrow(/Unknown knowledge type/);
	});

	it("rejects path traversal", () => {
		expect(() => resolveKnowledgePath("/tmp/root", "memory/../foo.md", "document")).toThrow(/'.'/);
		expect(() => resolveKnowledgePath("/tmp/root", "memory/./foo.md", "document")).toThrow(/'.'/);
	});

	it("rejects sidecar paths", () => {
		expect(() => resolveKnowledgePath("/tmp/root", "memory/topic.omp-meta", "document")).toThrow(/omp-meta/);
	});

	it("requires .md for documents and rejects it for directories", () => {
		expect(() => resolveKnowledgePath("/tmp/root", "memory/foo", "document")).toThrow(/must end with .md/);
		expect(() => resolveKnowledgePath("/tmp/root", "memory/foo.md", "directory")).toThrow(/must not end with .md/);
	});

	it("returns a resolved descriptor for valid input", () => {
		const r = resolveKnowledgePath("/tmp/root", "skill/sbox/import.md", "document");
		expect(r.type).toBe("skill");
		expect(r.relFromTypeRoot).toBe("sbox/import.md");
		expect(r.canonical).toBe("skill/sbox/import.md");
		expect(r.absPath).toContain(`${path.sep}skill${path.sep}sbox${path.sep}import.md`);
	});
});

describe("knowledgeList", () => {
	it("lists across every type root when no prefix is given", async () => {
		await withTempRoot(async memoryRoot => {
			await fs.mkdir(path.join(memoryRoot, "memory"), { recursive: true });
			await fs.mkdir(path.join(memoryRoot, "skill", "ops"), { recursive: true });
			await fs.mkdir(path.join(memoryRoot, "design"), { recursive: true });
			await Bun.write(path.join(memoryRoot, "memory", "MEMORY.md"), "x");
			await Bun.write(path.join(memoryRoot, "skill", "ops", "SKILL.md"), "y");
			await Bun.write(path.join(memoryRoot, "design", "rfc-001.md"), "z");

			const entries = await knowledgeList(memoryRoot);
			const docs = entries.filter(e => e.kind === "document").map(e => e.path);
			expect(docs).toContain("memory/MEMORY.md");
			expect(docs).toContain("skill/ops/SKILL.md");
			expect(docs).toContain("design/rfc-001.md");
			// Directories surfaced too.
			expect(entries.some(e => e.kind === "directory" && e.path === "skill/ops")).toBe(true);
		});
	});

	it("filters by pathPrefix", async () => {
		await withTempRoot(async memoryRoot => {
			await fs.mkdir(path.join(memoryRoot, "memory"), { recursive: true });
			await fs.mkdir(path.join(memoryRoot, "skill"), { recursive: true });
			await Bun.write(path.join(memoryRoot, "memory", "a.md"), "x");
			await Bun.write(path.join(memoryRoot, "skill", "b.md"), "y");

			const entries = await knowledgeList(memoryRoot, "memory/");
			expect(entries.every(e => e.path.startsWith("memory/"))).toBe(true);
			expect(entries.some(e => e.path === "memory/a.md")).toBe(true);
			expect(entries.some(e => e.path === "skill/b.md")).toBe(false);
		});
	});

	it("hides .omp-meta sidecars", async () => {
		await withTempRoot(async memoryRoot => {
			const memDir = path.join(memoryRoot, "memory");
			await fs.mkdir(memDir, { recursive: true });
			await Bun.write(path.join(memDir, "a.md"), "x");
			await Bun.write(sidecarPathForDirectory(memDir), stringifySidecar({ aiMaintained: true }));

			const entries = await knowledgeList(memoryRoot);
			expect(entries.every(e => !e.path.endsWith(".omp-meta"))).toBe(true);
		});
	});
});

describe("knowledgeCreateDocument", () => {
	it("creates a document with body markers and frontmatter", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/notes.md", {
				summary: "Stub summary",
				body: "Body text here.",
			});
			const raw = await Bun.file(path.join(memoryRoot, "memory", "notes.md")).text();
			expect(raw).toContain("<!-- omp:body:start -->");
			expect(raw).toContain("Body text here.");
			expect(raw).toContain("Stub summary");
			const fm = parseMemoryDoc(raw).frontmatter;
			expect(fm.type).toBe("memory");
			expect(fm.path).toBe("notes.md");
			expect(fm.aiMaintained).toBe(true);
			expect(fm.inheritAiConfig).toBe(true);
		});
	});

	it("refuses to overwrite an existing document", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/notes.md", { body: "v1" });
			await expect(knowledgeCreateDocument(memoryRoot, "memory/notes.md", { body: "v2" })).rejects.toThrow(
				/already exists/,
			);
		});
	});

	it("honors allowCreateDocuments: false on the parent sidecar", async () => {
		await withTempRoot(async memoryRoot => {
			const memDir = path.join(memoryRoot, "memory");
			await fs.mkdir(memDir, { recursive: true });
			await Bun.write(sidecarPathForDirectory(memDir), stringifySidecar({ allowCreateDocuments: false }));

			await expect(knowledgeCreateDocument(memoryRoot, "memory/blocked.md", { body: "x" })).rejects.toThrow(
				/denies new docs/,
			);
		});
	});

	it("persists commandEnabled in frontmatter when requested", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/with-cmd.md", {
				body: "body",
				commandEnabled: true,
			});
			const raw = await Bun.file(path.join(memoryRoot, "memory", "with-cmd.md")).text();
			expect(parseMemoryDoc(raw).frontmatter.commandEnabled).toBe(true);
		});
	});

	it("omits commandEnabled from frontmatter when falsy or absent", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/no-cmd.md", { body: "body" });
			await knowledgeCreateDocument(memoryRoot, "memory/off-cmd.md", {
				body: "body",
				commandEnabled: false,
			});
			const a = await Bun.file(path.join(memoryRoot, "memory", "no-cmd.md")).text();
			const b = await Bun.file(path.join(memoryRoot, "memory", "off-cmd.md")).text();
			// `commandEnabled` MUST NOT be written when omitted or false — keeps
			// the on-disk frontmatter quiet for the common case.
			expect(a).not.toContain("commandEnabled");
			expect(b).not.toContain("commandEnabled");
			expect(parseMemoryDoc(a).frontmatter.commandEnabled).toBeUndefined();
			expect(parseMemoryDoc(b).frontmatter.commandEnabled).toBeUndefined();
		});
	});
});

describe("knowledgeRead", () => {
	it("returns body-only when part=body", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/notes.md", {
				summary: "summary text",
				body: "body text",
			});
			const result = await knowledgeRead(memoryRoot, "memory/notes.md", "body");
			expect(result.content).toBe("body text");
			expect(result.content).not.toContain("summary text");
		});
	});

	it("returns frontmatter summary when part=summary", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/notes.md", {
				summary: "the summary",
				body: "body",
			});
			const result = await knowledgeRead(memoryRoot, "memory/notes.md", "summary");
			expect(result.content).toBe("the summary");
		});
	});

	it("renders an agent-friendly markdown view when part=full", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/notes.md", { body: "body" });
			const result = await knowledgeRead(memoryRoot, "memory/notes.md", "full");
			// New behavior (G17): full reads strip frontmatter + omp comment markers
			// and reformat into headings so the LLM only sees the agent surface.
			expect(result.content).not.toContain("---");
			expect(result.content).not.toContain("<!-- omp:");
			expect(result.content).toContain("# notes");
			expect(result.content).toContain("## Content");
			expect(result.content).toContain("body");
		});
	});

	it("throws not_found for missing documents", async () => {
		await withTempRoot(async memoryRoot => {
			await expect(knowledgeRead(memoryRoot, "memory/missing.md")).rejects.toThrow(/not found/);
		});
	});
});

describe("knowledgeEditDocument", () => {
	it("body-only patch preserves frontmatter and summary bytes", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/notes.md", {
				summary: "keep me",
				body: "first body",
			});
			const before = await Bun.file(path.join(memoryRoot, "memory", "notes.md")).text();
			const beforeFrontmatter = before.split("<!-- omp:body:start -->")[0];

			await knowledgeEditDocument(memoryRoot, "memory/notes.md", { body: "second body" });

			const after = await Bun.file(path.join(memoryRoot, "memory", "notes.md")).text();
			expect(after).toContain("second body");
			expect(after).not.toContain("first body");
			// Non-body bytes survive byte-for-byte except for the createdAt/updatedAt timestamps
			// which buildMemoryDoc would refresh; body-only path uses rewriteDocBody.
			expect(after.split("<!-- omp:body:start -->")[0]).toBe(beforeFrontmatter);
		});
	});

	it("refuses to edit user-authored docs (no body markers)", async () => {
		await withTempRoot(async memoryRoot => {
			const p = path.join(memoryRoot, "memory", "user.md");
			await fs.mkdir(path.dirname(p), { recursive: true });
			await Bun.write(p, "# User\n\nhand-authored, no markers.\n");

			await expect(knowledgeEditDocument(memoryRoot, "memory/user.md", { body: "ai body" })).rejects.toThrow(
				/user-authored/,
			);

			const after = await Bun.file(p).text();
			expect(after).toBe("# User\n\nhand-authored, no markers.\n");
		});
	});

	it("refuses to edit user-protected docs without an approvalSink", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/notes.md", { body: "v1" });
			const p = path.join(memoryRoot, "memory", "notes.md");
			const orig = await Bun.file(p).text();
			await Bun.write(
				p,
				orig
					.replace("aiMaintained: true", "aiMaintained: false")
					.replace("inheritAiConfig: true", "inheritAiConfig: false"),
			);

			await expect(knowledgeEditDocument(memoryRoot, "memory/notes.md", { body: "v2" })).rejects.toThrow(
				/user approval required/,
			);
			expect(await Bun.file(p).text()).toBe(
				orig
					.replace("aiMaintained: true", "aiMaintained: false")
					.replace("inheritAiConfig: true", "inheritAiConfig: false"),
			);
		});
	});

	it("routes edit through approvalSink when target has aiMaintained: false (apply path)", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/notes.md", { body: "v1" });
			const p = path.join(memoryRoot, "memory", "notes.md");
			const orig = await Bun.file(p).text();
			await Bun.write(
				p,
				orig
					.replace("aiMaintained: true", "aiMaintained: false")
					.replace("inheritAiConfig: true", "inheritAiConfig: false"),
			);

			let previewedKind: string | undefined;
			const outcome = await knowledgeEditDocument(
				memoryRoot,
				"memory/notes.md",
				{ body: "v2" },
				{
					approvalSink: async request => {
						previewedKind = request.preview.kind;
						await request.apply();
					},
				},
			);
			expect(previewedKind).toBe("edit");
			expect(outcome.applied).toBe(true);
			expect(outcome.requiredApproval).toBe(true);
			expect(await Bun.file(p).text()).toContain("v2");
		});
	});

	it("routes edit through approvalSink but does NOT write when sink withholds apply", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/notes.md", { body: "v1" });
			const p = path.join(memoryRoot, "memory", "notes.md");
			const orig = await Bun.file(p).text();
			await Bun.write(
				p,
				orig
					.replace("aiMaintained: true", "aiMaintained: false")
					.replace("inheritAiConfig: true", "inheritAiConfig: false"),
			);
			const beforeBytes = await Bun.file(p).text();

			const outcome = await knowledgeEditDocument(
				memoryRoot,
				"memory/notes.md",
				{ body: "v2 should not land" },
				{
					approvalSink: async _request => {
						// User declined / discarded — never invoke apply.
					},
				},
			);
			expect(outcome.applied).toBe(false);
			expect(outcome.requiredApproval).toBe(true);
			expect(await Bun.file(p).text()).toBe(beforeBytes);
		});
	});

	it("design/ creates require approval; no-sink call refuses", async () => {
		await withTempRoot(async memoryRoot => {
			await expect(knowledgeCreateDocument(memoryRoot, "design/architecture.md", { body: "x" })).rejects.toThrow(
				/user approval required/,
			);
			expect(await Bun.file(path.join(memoryRoot, "design", "architecture.md")).exists()).toBe(false);
		});
	});

	it("design/ creates with auto-approve sink succeed and inherit aiMaintained: false", async () => {
		await withTempRoot(async memoryRoot => {
			const outcome = await knowledgeCreateDocument(
				memoryRoot,
				"design/architecture.md",
				{ body: "AI-proposed architecture body" },
				{
					approvalSink: async req => {
						await req.apply();
					},
				},
			);
			expect(outcome.applied).toBe(true);
			expect(outcome.requiredApproval).toBe(true);
			const written = await Bun.file(path.join(memoryRoot, "design", "architecture.md")).text();
			expect(written).toContain("<!-- omp:body:start -->");
			expect(written).toContain("AI-proposed architecture body");
			expect(written).toContain("aiMaintained: false");
		});
	});
});

describe("knowledgeMove", () => {
	it("renames a document within the same type", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/old.md", { body: "x" });
			await knowledgeMove(memoryRoot, "memory/old.md", "memory/new.md", "document");
			expect(await Bun.file(path.join(memoryRoot, "memory", "new.md")).exists()).toBe(true);
			expect(await Bun.file(path.join(memoryRoot, "memory", "old.md")).exists()).toBe(false);
		});
	});

	it("refuses cross-type moves", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/x.md", { body: "x" });
			await expect(knowledgeMove(memoryRoot, "memory/x.md", "skill/x.md", "document")).rejects.toThrow(
				/Cross-type move/,
			);
		});
	});

	it("refuses overwriting an existing destination", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/a.md", { body: "a" });
			await knowledgeCreateDocument(memoryRoot, "memory/b.md", { body: "b" });
			await expect(knowledgeMove(memoryRoot, "memory/a.md", "memory/b.md", "document")).rejects.toThrow(
				/already exists/,
			);
		});
	});

	it("refuses to rename a taxonomy root directory (source side)", async () => {
		await withTempRoot(async memoryRoot => {
			await expect(knowledgeMove(memoryRoot, "memory", "memory/archive", "directory")).rejects.toThrow(
				/taxonomy root/,
			);
		});
	});

	it("refuses to rename onto a taxonomy root directory (destination side)", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDirectory(memoryRoot, "memory/archive");
			await expect(knowledgeMove(memoryRoot, "memory/archive", "memory", "directory")).rejects.toThrow(
				/taxonomy root/,
			);
		});
	});
});

describe("knowledgeDelete", () => {
	it("deletes an AI-maintained document", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/x.md", { body: "x" });
			await knowledgeDelete(memoryRoot, "memory/x.md", "document");
			expect(await Bun.file(path.join(memoryRoot, "memory", "x.md")).exists()).toBe(false);
		});
	});

	it("refuses to delete user-protected documents without approvalSink", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/x.md", { body: "x" });
			const p = path.join(memoryRoot, "memory", "x.md");
			const orig = await Bun.file(p).text();
			await Bun.write(
				p,
				orig
					.replace("aiMaintained: true", "aiMaintained: false")
					.replace("inheritAiConfig: true", "inheritAiConfig: false"),
			);

			await expect(knowledgeDelete(memoryRoot, "memory/x.md", "document")).rejects.toThrow(/user approval required/);
			expect(await Bun.file(p).exists()).toBe(true);
		});
	});

	it("routes delete through approvalSink when target has aiMaintained: false", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/x.md", { body: "x" });
			const p = path.join(memoryRoot, "memory", "x.md");
			const orig = await Bun.file(p).text();
			await Bun.write(
				p,
				orig
					.replace("aiMaintained: true", "aiMaintained: false")
					.replace("inheritAiConfig: true", "inheritAiConfig: false"),
			);

			const outcome = await knowledgeDelete(memoryRoot, "memory/x.md", "document", {
				approvalSink: async req => {
					await req.apply();
				},
			});
			expect(outcome.applied).toBe(true);
			expect(outcome.requiredApproval).toBe(true);
			expect(await Bun.file(p).exists()).toBe(false);
		});
	});

	it("refuses to delete under reference/ (read-only type root)", async () => {
		await withTempRoot(async memoryRoot => {
			const p = path.join(memoryRoot, "reference", "ext.md");
			await fs.mkdir(path.dirname(p), { recursive: true });
			await Bun.write(p, "external");

			await expect(knowledgeDelete(memoryRoot, "reference/ext.md", "document")).rejects.toThrow(/read-only/);
		});
	});
});

describe("knowledgeQuery", () => {
	it("ranks hits by term coverage", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/auth.md", {
				summary: "OIDC + WebAuthn fallback",
				body: "Use the OIDC provider for primary auth; WebAuthn handles MFA fallback.",
			});
			await knowledgeCreateDocument(memoryRoot, "memory/unrelated.md", {
				body: "Nothing relevant in this file.",
			});
			await knowledgeCreateDocument(memoryRoot, "skill/auth-runbook.md", {
				body: "Auth runbook: rotate OIDC client secret every quarter.",
			});

			const hits = await knowledgeQuery(memoryRoot, { lexicalQuery: "OIDC auth", limit: 5 });
			expect(hits.length).toBeGreaterThanOrEqual(2);
			expect(hits[0].path === "memory/auth.md" || hits[0].path === "skill/auth-runbook.md").toBe(true);
			expect(hits.some(h => h.path === "memory/unrelated.md")).toBe(false);
		});
	});

	it("returns empty when no terms match", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/a.md", { body: "alpha" });
			const hits = await knowledgeQuery(memoryRoot, { lexicalQuery: "zzzz-no-match" });
			expect(hits).toEqual([]);
		});
	});

	it("respects pathPrefix scoping", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/auth.md", { body: "auth in memory" });
			await knowledgeCreateDocument(memoryRoot, "skill/auth.md", { body: "auth in skill" });

			const hits = await knowledgeQuery(memoryRoot, { lexicalQuery: "auth", pathPrefix: "skill/" });
			expect(hits.every(h => h.path.startsWith("skill/"))).toBe(true);
			expect(hits.some(h => h.path === "skill/auth.md")).toBe(true);
		});
	});

	it("routes queries through a custom ranker when one is provided", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/a.md", { body: "alpha alpha alpha" });
			await knowledgeCreateDocument(memoryRoot, "memory/b.md", { body: "alpha" });

			// Custom ranker: prefer documents whose canonical path ends in "b.md".
			const hits = await knowledgeQuery(memoryRoot, {
				lexicalQuery: "alpha",
				ranker: {
					async rank({ candidates }) {
						return candidates
							.map(c => ({
								path: c.entry.path,
								type: c.entry.type,
								title: c.title,
								score: c.entry.path.endsWith("b.md") ? 100 : 1,
								snippet: "",
							}))
							.sort((x, y) => y.score - x.score);
					},
				},
			});
			expect(hits.length).toBe(2);
			expect(hits[0].path).toBe("memory/b.md");
			expect(hits[0].score).toBe(100);
		});
	});

	it("routes `semanticQuery` through the default (lexical) ranker", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/auth.md", {
				body: "Use the OIDC provider for primary auth.",
			});
			const hits = await knowledgeQuery(memoryRoot, { semanticQuery: "OIDC" });
			expect(hits.some(h => h.path === "memory/auth.md")).toBe(true);
		});
	});
});

describe("knowledgeCreateDirectory", () => {
	it("creates an empty directory and is idempotent", async () => {
		await withTempRoot(async memoryRoot => {
			const first = await knowledgeCreateDirectory(memoryRoot, "memory/topic");
			expect(first).toEqual({ applied: true, requiredApproval: false });
			const target = path.join(memoryRoot, "memory", "topic");
			const stat = await fs.stat(target);
			expect(stat.isDirectory()).toBe(true);

			// Second call is a no-op — distinct from "pending approval" so the
			// tool layer can report it as completed rather than dead-end the user.
			const second = await knowledgeCreateDirectory(memoryRoot, "memory/topic");
			expect(second).toEqual({ applied: false, requiredApproval: false });
			expect((await fs.stat(target)).isDirectory()).toBe(true);
		});
	});

	it("knowledgeMove with source === dest is a no-op (applied:false, requiredApproval:false)", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/foo.md", { body: "hi" });
			const outcome = await knowledgeMove(memoryRoot, "memory/foo.md", "memory/foo.md", "document");
			expect(outcome).toEqual({ applied: false, requiredApproval: false });
		});
	});

	it("refuses to step on an existing file at the same path", async () => {
		await withTempRoot(async memoryRoot => {
			const p = path.join(memoryRoot, "memory", "thing");
			await fs.mkdir(path.dirname(p), { recursive: true });
			await Bun.write(p, "x");

			await expect(knowledgeCreateDirectory(memoryRoot, "memory/thing")).rejects.toThrow(/not a directory/);
		});
	});
});

describe("review-fix regressions", () => {
	it("extractSummarySection captures multi-paragraph bodies up to the next ## section", async () => {
		const raw = "## Summary\nPara 1.\n\nPara 2.\n\n## Other\nfoo";
		expect(extractSummarySection(raw)).toBe("Para 1.\n\nPara 2.");
	});

	it("extractSummarySection captures multi-paragraph bodies up to the omp body-end marker", async () => {
		const raw = "## Summary\nA.\n\nB.\n<!-- omp:body:end -->\n";
		expect(extractSummarySection(raw)).toBe("A.\n\nB.");
	});

	it("knowledgeMove (directory) refuses when the destination parent denies new directories", async () => {
		await withTempRoot(async memoryRoot => {
			// Source bucket allows dir creation by default.
			await knowledgeCreateDirectory(memoryRoot, "memory/src");
			// Destination parent exists already but locks down new dirs via sidecar.
			const destParent = path.join(memoryRoot, TYPE_DIRS.memory);
			await fs.writeFile(
				sidecarPathForDirectory(destParent),
				stringifySidecar({ version: 1, allowCreateDirectories: false, inheritToChildren: true }),
			);
			await expect(knowledgeMove(memoryRoot, "memory/src", "memory/dst", "directory")).rejects.toThrow(
				/destination denies new directories/,
			);
		});
	});
});

describe("KnowledgeOpsError code", () => {
	it("carries a stable code", async () => {
		await withTempRoot(async memoryRoot => {
			try {
				await knowledgeRead(memoryRoot, "memory/missing.md");
				expect(false).toBe(true);
			} catch (error) {
				expect(error).toBeInstanceOf(KnowledgeOpsError);
				expect((error as KnowledgeOpsError).code).toBe("not_found");
			}
		});
	});
});

// Sanity-check TYPE_DIRS to keep the test file aligned with the source.
describe("type-root layout", () => {
	it("declares the four expected types", () => {
		expect(Object.keys(TYPE_DIRS).sort()).toEqual(["design", "memory", "reference", "skill"]);
	});
});

describe("policy gates added by PR review fixes", () => {
	it("knowledgeCreateDirectory refuses bare taxonomy roots", async () => {
		await withTempRoot(async memoryRoot => {
			await expect(knowledgeCreateDirectory(memoryRoot, "memory")).rejects.toThrow(/taxonomy root directory/);
		});
	});

	it("knowledgeCreateDirectory respects readOnly bucket (reference/)", async () => {
		await withTempRoot(async memoryRoot => {
			await expect(knowledgeCreateDirectory(memoryRoot, "reference/locked")).rejects.toThrow(/read-only/);
		});
	});

	it("knowledgeCreateDirectory refuses when allowCreateDirectories=false", async () => {
		await withTempRoot(async memoryRoot => {
			await fs.mkdir(path.join(memoryRoot, TYPE_DIRS.memory), { recursive: true });
			const sidecar = sidecarPathForDirectory(path.join(memoryRoot, TYPE_DIRS.memory));
			await Bun.write(
				sidecar,
				stringifySidecar({ version: 1, allowCreateDirectories: false, inheritToChildren: true }),
			);
			await expect(knowledgeCreateDirectory(memoryRoot, "memory/nope")).rejects.toThrow(
				/directory create not allowed/,
			);
		});
	});

	it("knowledgeCreateDirectory routes through approvalSink when requiresApproval", async () => {
		await withTempRoot(async memoryRoot => {
			let captured = false;
			const outcome = await knowledgeCreateDirectory(memoryRoot, "design/proposals", {
				approvalSink: async req => {
					captured = true;
					await req.apply();
				},
			});
			expect(captured).toBe(true);
			expect(outcome.requiredApproval).toBe(true);
			expect(outcome.applied).toBe(true);
		});
	});

	it("knowledgeCreateDocument leaves no parent dir behind when approval is withheld", async () => {
		await withTempRoot(async memoryRoot => {
			const outcome = await knowledgeCreateDocument(
				memoryRoot,
				"design/draft/note.md",
				{ summary: "s", body: "b" },
				{
					approvalSink: async _req => {
						// withhold: never call apply()
					},
				},
			);
			expect(outcome.applied).toBe(false);
			expect(outcome.requiredApproval).toBe(true);
			// Parent dir must NOT exist on disk.
			const parentExists = await fs
				.stat(path.join(memoryRoot, "design", "draft"))
				.then(s => s.isDirectory())
				.catch(() => false);
			expect(parentExists).toBe(false);
		});
	});

	it("knowledgeMove refuses document moves when allowMoveDocuments=false", async () => {
		await withTempRoot(async memoryRoot => {
			// Author a document under design/ where allowMoveDocuments defaults to false.
			await knowledgeCreateDocument(
				memoryRoot,
				"design/a.md",
				{ summary: "", body: "x" },
				{ approvalSink: async req => req.apply() },
			);
			await expect(knowledgeMove(memoryRoot, "design/a.md", "design/sub/a.md", "document")).rejects.toThrow(
				/document move not allowed/,
			);
		});
	});

	it("knowledgeMove refuses when destination denies new docs", async () => {
		await withTempRoot(async memoryRoot => {
			// Source under memory/ (moves allowed) → destination under a
			// custom locked directory.
			await knowledgeCreateDocument(memoryRoot, "memory/src.md", { body: "x" });
			await fs.mkdir(path.join(memoryRoot, "memory", "locked"), { recursive: true });
			await Bun.write(
				sidecarPathForDirectory(path.join(memoryRoot, "memory", "locked")),
				stringifySidecar({ version: 1, allowCreateDocuments: false }),
			);
			await expect(knowledgeMove(memoryRoot, "memory/src.md", "memory/locked/dst.md", "document")).rejects.toThrow(
				/destination denies new docs/,
			);
		});
	});

	it("knowledgeMove (directory) moves the paired sidecar atomically", async () => {
		await withTempRoot(async memoryRoot => {
			const srcDir = path.join(memoryRoot, "memory", "topic");
			await fs.mkdir(srcDir, { recursive: true });
			const srcSidecar = sidecarPathForDirectory(srcDir);
			await Bun.write(srcSidecar, stringifySidecar({ version: 1, summary: "topic-sidecar" }));

			await knowledgeMove(memoryRoot, "memory/topic", "memory/renamed", "directory");

			const destDir = path.join(memoryRoot, "memory", "renamed");
			expect(await fs.stat(destDir).then(s => s.isDirectory())).toBe(true);
			expect(await fs.stat(sidecarPathForDirectory(destDir)).then(s => s.isFile())).toBe(true);
			await expect(fs.stat(srcSidecar)).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	it("knowledgeDelete refuses bare taxonomy roots", async () => {
		await withTempRoot(async memoryRoot => {
			await fs.mkdir(path.join(memoryRoot, "memory"), { recursive: true });
			await expect(knowledgeDelete(memoryRoot, "memory", "directory")).rejects.toThrow(/taxonomy root/);
		});
	});

	it("knowledgeDelete (directory) removes the paired sidecar", async () => {
		await withTempRoot(async memoryRoot => {
			const dir = path.join(memoryRoot, "memory", "topic");
			await fs.mkdir(dir, { recursive: true });
			const sidecar = sidecarPathForDirectory(dir);
			await Bun.write(sidecar, stringifySidecar({ version: 1 }));

			await knowledgeDelete(memoryRoot, "memory/topic", "directory");

			await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	it("knowledgeQuery forwards semanticQuery to the ranker", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/note.md", { body: "alpha" });
			let receivedSemantic = "";
			const hits = await knowledgeQuery(memoryRoot, {
				semanticQuery: "find-me",
				lexicalQuery: undefined,
				ranker: {
					rank: async input => {
						receivedSemantic = input.semanticQuery;
						return input.candidates.map(c => ({
							path: c.entry.path,
							type: c.entry.type,
							title: c.title,
							score: 1,
							snippet: "stub",
						}));
					},
				},
			});
			expect(receivedSemantic).toBe("find-me");
			expect(hits.length).toBe(1);
		});
	});
});
describe("gap-fix batch 1+2", () => {
	it("G18: knowledge_edit refuses an empty patch", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/notes.md", { body: "body" });
			await expect(knowledgeEditDocument(memoryRoot, "memory/notes.md", {})).rejects.toThrow(
				/at least one of summary, body, or maintenanceRules/,
			);
		});
	});

	it("G1: knowledge_move kind=directory refuses on read-only descendant", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDirectory(memoryRoot, "memory/topic");
			// Hand-write a doc with readOnly:true to simulate user lock.
			const locked = path.join(memoryRoot, "memory", "topic", "locked.md");
			await fs.writeFile(
				locked,
				"---\nreadOnly: true\n---\n# locked\n\n<!-- omp:body:start -->\nbody\n<!-- omp:body:end -->\n",
			);
			await expect(knowledgeMove(memoryRoot, "memory/topic", "memory/moved", "directory")).rejects.toThrow(
				/contains read-only document/,
			);
		});
	});

	it("G2: knowledge_delete kind=directory refuses on read-only descendant", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDirectory(memoryRoot, "memory/topic");
			const locked = path.join(memoryRoot, "memory", "topic", "locked.md");
			await fs.writeFile(
				locked,
				"---\nreadOnly: true\n---\n# locked\n\n<!-- omp:body:start -->\nbody\n<!-- omp:body:end -->\n",
			);
			await expect(knowledgeDelete(memoryRoot, "memory/topic", "directory")).rejects.toThrow(
				/contains read-only document/,
			);
		});
	});

	it("G3: inheritToChildren:false walls off ancestor overrides", async () => {
		const { resolveDirectoryConfig } = await import("../../src/memories/directory-config");
		await withTempRoot(async memoryRoot => {
			// memory/A.omp-meta — allowCreateDocuments:false + inheritToChildren:true
			const outer = path.join(memoryRoot, "memory", "A");
			await fs.mkdir(outer, { recursive: true });
			await fs.writeFile(
				sidecarPathForDirectory(outer),
				stringifySidecar({
					allowCreateDocuments: false,
					inheritToChildren: true,
				}),
			);
			// memory/A/B.omp-meta — inheritToChildren:false (wall)
			const wall = path.join(memoryRoot, "memory", "A", "B");
			await fs.mkdir(wall, { recursive: true });
			await fs.writeFile(sidecarPathForDirectory(wall), stringifySidecar({ inheritToChildren: false }));
			// memory/A/B/C — descendant. Should NOT inherit allowCreateDocuments:false.
			const child = path.join(memoryRoot, "memory", "A", "B", "C");
			await fs.mkdir(child, { recursive: true });

			const config = await resolveDirectoryConfig(memoryRoot, child);
			expect(config).toBeDefined();
			// Type default for memory is allowCreateDocuments:true. The wall
			// drops A's override, so C falls back to type default.
			expect(config!.allowCreateDocuments).toBe(true);
		});
	});

	it("G14/G15/G16: query reports matchedSection and pulls snippet from matched section", async () => {
		await withTempRoot(async memoryRoot => {
			// Doc with summary in frontmatter — term lives only in summary.
			await knowledgeCreateDocument(memoryRoot, "memory/alpha.md", {
				summary: "uniquetermXYZ lives in the summary section.",
				body: "unrelated body content",
			});
			// Doc with the term in title-derived path only.
			await knowledgeCreateDocument(memoryRoot, "memory/needleword.md", {
				body: "unrelated body content too",
			});

			const summaryHits = await knowledgeQuery(memoryRoot, { lexicalQuery: "uniquetermXYZ" });
			expect(summaryHits.length).toBe(1);
			expect(summaryHits[0].matchedSection).toBe("summary");
			expect(summaryHits[0].snippet).toContain("uniquetermXYZ");

			const pathHits = await knowledgeQuery(memoryRoot, { lexicalQuery: "needleword" });
			const titlePath = pathHits.find(h => h.path === "memory/needleword.md");
			expect(titlePath).toBeDefined();
			// Title is derived from filename ("needleword"), so the match
			// lands in title before path.
			expect(titlePath!.matchedSection === "title" || titlePath!.matchedSection === "path").toBe(true);
		});
	});

	it("G17: knowledge_read part=full strips frontmatter and comment markers", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/notes.md", {
				summary: "the summary",
				body: "the body",
				maintenanceRules: "- rule one\n- rule two",
			});
			const result = await knowledgeRead(memoryRoot, "memory/notes.md", "full");
			expect(result.content).not.toContain("---");
			expect(result.content).not.toContain("<!-- omp:");
			expect(result.content).toContain("# notes");
			expect(result.content).toContain("## Summary");
			expect(result.content).toContain("the summary");
			expect(result.content).toContain("## Maintenance Rules");
			expect(result.content).toContain("- rule one");
			expect(result.content).toContain("## Content");
			expect(result.content).toContain("the body");
		});
	});
});

describe("gap-fix batch 3", () => {
	it("G11: refuses to create a skill doc with injectMode=full", async () => {
		await withTempRoot(async memoryRoot => {
			const skillRoot = path.join(memoryRoot, "skill");
			await fs.mkdir(skillRoot, { recursive: true });
			await fs.writeFile(sidecarPathForDirectory(skillRoot), stringifySidecar({ injectMode: "full" }));
			await expect(knowledgeCreateDocument(memoryRoot, "skill/widget.md", { body: "x" })).rejects.toThrow(
				/skill documents cannot use injectMode=full/,
			);
		});
	});

	it("G11: refuses to create a skill doc with injectMode=rule", async () => {
		await withTempRoot(async memoryRoot => {
			// reference/ would also be a target for the invariant, but its
			// `readOnly: true` type default short-circuits create before we
			// reach the validator. Skill is read-write, so this exercises the
			// invariant directly.
			const skillRoot = path.join(memoryRoot, "skill");
			await fs.mkdir(skillRoot, { recursive: true });
			await fs.writeFile(sidecarPathForDirectory(skillRoot), stringifySidecar({ injectMode: "rule" }));
			await expect(knowledgeCreateDocument(memoryRoot, "skill/rule-spec.md", { body: "x" })).rejects.toThrow(
				/skill documents cannot use injectMode=full or injectMode=rule/,
			);
		});
	});

	it("G11: auto-fills maintenance rules on AI-maintained memory docs", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/auto.md", { body: "body" });
			const raw = await Bun.file(path.join(memoryRoot, "memory", "auto.md")).text();
			// Auto-fill kicks in for the default memory bucket (aiMaintained=true).
			expect(raw).toContain("omp:maintain-rules:start");
			expect(raw).toContain("Keep entries durable and reusable");
			// And the resulting frontmatter records the invariant inputs.
			expect(raw).toContain("explicitMaintenanceRules: true");
		});
	});

	it("G11: leaves design docs without rules (aiMaintained:false bypasses auto-fill)", async () => {
		await withTempRoot(async memoryRoot => {
			// Need an approval sink because design/ has aiMaintained:false.
			let applied = false;
			await knowledgeCreateDocument(
				memoryRoot,
				"design/sketch.md",
				{ body: "body" },
				{
					approvalSink: async req => {
						await req.apply();
						applied = true;
					},
				},
			);
			expect(applied).toBe(true);
			const raw = await Bun.file(path.join(memoryRoot, "design", "sketch.md")).text();
			expect(raw).not.toContain("omp:maintain-rules:start");
			expect(raw).toContain("explicitMaintenanceRules: false");
		});
	});

	it("G9: summaryEnabled default tracks per-type (skill/reference=true)", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/m.md", { body: "x" });
			await knowledgeCreateDocument(memoryRoot, "skill/s.md", { body: "x" });
			const mem = parseMemoryDoc(await Bun.file(path.join(memoryRoot, "memory", "m.md")).text());
			const skl = parseMemoryDoc(await Bun.file(path.join(memoryRoot, "skill", "s.md")).text());
			expect(mem.frontmatter.summaryEnabled).toBe(false);
			expect(skl.frontmatter.summaryEnabled).toBe(true);
		});
	});

	it("G4: sidecar inheritInjectMode skips the dir's own injectMode override", async () => {
		const { resolveDirectoryConfig } = await import("../../src/memories/directory-config");
		await withTempRoot(async memoryRoot => {
			// memory/A.omp-meta — injectMode=full, inheritToChildren=true
			const outer = path.join(memoryRoot, "memory", "A");
			await fs.mkdir(outer, { recursive: true });
			await fs.writeFile(
				sidecarPathForDirectory(outer),
				stringifySidecar({ injectMode: "full", inheritToChildren: true }),
			);
			// memory/A/B.omp-meta — sets injectMode=rule but flags inheritInjectMode
			// so its own injectMode is ignored and B inherits "full" from A.
			const inner = path.join(memoryRoot, "memory", "A", "B");
			await fs.mkdir(inner, { recursive: true });
			await fs.writeFile(
				sidecarPathForDirectory(inner),
				stringifySidecar({ injectMode: "rule", inheritInjectMode: true }),
			);

			const config = await resolveDirectoryConfig(memoryRoot, inner);
			expect(config).toBeDefined();
			expect(config!.injectMode).toBe("full");
		});
	});

	it("G4: sidecar inheritAiConfig skips the dir's own aiMaintained override", async () => {
		const { resolveDirectoryConfig } = await import("../../src/memories/directory-config");
		await withTempRoot(async memoryRoot => {
			// memory/A.omp-meta — aiMaintained=false (a user-locked subtree),
			// inheritToChildren=true so policy reaches descendants.
			const outer = path.join(memoryRoot, "memory", "A");
			await fs.mkdir(outer, { recursive: true });
			await fs.writeFile(
				sidecarPathForDirectory(outer),
				stringifySidecar({ aiMaintained: false, inheritToChildren: true }),
			);
			// memory/A/B.omp-meta — declares aiMaintained=true but defers to A.
			const inner = path.join(memoryRoot, "memory", "A", "B");
			await fs.mkdir(inner, { recursive: true });
			await fs.writeFile(
				sidecarPathForDirectory(inner),
				stringifySidecar({ aiMaintained: true, inheritAiConfig: true }),
			);

			const config = await resolveDirectoryConfig(memoryRoot, inner);
			expect(config).toBeDefined();
			expect(config!.aiMaintained).toBe(false);
			expect(config!.requiresApproval).toBe(true);
		});
	});
});

describe("gap-fix batch 4", () => {
	it("query: types[] filter restricts hits to the listed buckets", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/needle.md", {
				body: "uniquetokenABC in body",
			});
			await knowledgeCreateDocument(memoryRoot, "skill/needle.md", {
				body: "uniquetokenABC in body too",
			});

			const all = await knowledgeQuery(memoryRoot, { lexicalQuery: "uniquetokenABC" });
			expect(all.map(h => h.path).sort()).toEqual(["memory/needle.md", "skill/needle.md"]);

			const onlyMemory = await knowledgeQuery(memoryRoot, {
				lexicalQuery: "uniquetokenABC",
				types: ["memory"],
			});
			expect(onlyMemory.map(h => h.path)).toEqual(["memory/needle.md"]);

			// Empty types array behaves like "no filter".
			const empty = await knowledgeQuery(memoryRoot, {
				lexicalQuery: "uniquetokenABC",
				types: [],
			});
			expect(empty.length).toBe(2);
		});
	});

	it("query: hits carry hasSummary / injectMode / aiMaintained / updatedAt", async () => {
		await withTempRoot(async memoryRoot => {
			await knowledgeCreateDocument(memoryRoot, "memory/withSummary.md", {
				summary: "alpha bravo charlie",
				body: "needletoken in body",
			});
			const hits = await knowledgeQuery(memoryRoot, { lexicalQuery: "needletoken" });
			expect(hits.length).toBe(1);
			const hit = hits[0];
			expect(hit.hasSummary).toBe(true);
			expect(hit.injectMode).toBe("none");
			expect(hit.aiMaintained).toBe(true);
			expect(typeof hit.updatedAt).toBe("number");
		});
	});
});
