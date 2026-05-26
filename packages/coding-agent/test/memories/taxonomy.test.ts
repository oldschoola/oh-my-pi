// Coverage for the four-bucket taxonomy: typed buckets, .omp-meta
// sidecars, body-marker rewrites, built-in seeds, and the
// `applyConsolidation` / `cleanupConsolidatedArtifacts` guardrails that
// keep user-owned files intact.

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyConsolidation, cleanupConsolidatedArtifacts } from "../../src/memories";
import {
	checkDeletePermission,
	checkWritePermission,
	renameDirectoryWithSidecar,
	resolveDirectoryConfig,
	resolveDocConfig,
	sidecarPathForDirectory,
	stringifySidecar,
	TYPE_DIRS,
} from "../../src/memories/directory-config";
import { buildMemoryDoc, parseMemoryDoc, rewriteDocBody } from "../../src/memories/document";
import { seedBuiltinDocs } from "../../src/memories/seed-docs";

async function withTempRoot<T>(fn: (memoryRoot: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-taxonomy-"));
	try {
		const memoryRoot = path.join(dir, "memory-root");
		await fs.mkdir(memoryRoot, { recursive: true });
		return await fn(memoryRoot);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

interface ConsolidationInput {
	memoryMd: string;
	memorySummary: string;
	skills: Array<{
		name: string;
		content: string;
		scripts: { path: string; content: string }[];
		templates: { path: string; content: string }[];
		examples: { path: string; content: string }[];
	}>;
	designDrafts: { path: string; content: string }[];
}

function consolidationFixture(overrides: Partial<ConsolidationInput> = {}): ConsolidationInput {
	return {
		memoryMd: "memory body",
		memorySummary: "summary body",
		skills: [],
		designDrafts: [],
		...overrides,
	};
}

describe("body-marker rewrite", () => {
	it("preserves frontmatter, summary, and rules byte-for-byte; only mutates body", async () => {
		const original = buildMemoryDoc({
			frontmatter: {
				id: "kd_demo",
				type: "memory",
				path: "demo.md",
				title: "Demo",
				injectMode: "summary",
				aiMaintained: true,
				readOnly: false,
				createdAt: 1,
				updatedAt: 1,
			},
			title: "Demo",
			summary: "A demo doc — keep me intact.",
			maintenanceRules: ["Rule A.", "Rule B."],
			body: "first body",
		});

		const doc = parseMemoryDoc(original);
		expect(doc.hasBodyMarkers).toBe(true);

		const rewritten = rewriteDocBody(doc, "second body");
		expect(rewritten).toBeDefined();
		// Frontmatter / heading / summary / rules survive verbatim.
		expect(rewritten).toContain("id: kd_demo");
		expect(rewritten).toContain("# Demo");
		expect(rewritten).toContain("## Summary\nA demo doc — keep me intact.");
		expect(rewritten).toContain("- Rule A.");
		expect(rewritten).toContain("- Rule B.");
		// Body region replaced.
		expect(rewritten).toContain("second body");
		expect(rewritten).not.toContain("first body");

		// Re-parse: structure preserved.
		const reparsed = parseMemoryDoc(rewritten ?? "");
		expect(reparsed.hasBodyMarkers).toBe(true);
		expect(reparsed.body.trim()).toBe("second body");
		expect(reparsed.frontmatter.id).toBe("kd_demo");
	});

	it("rewriteDocBody returns undefined for marker-less docs (user-owned)", () => {
		const userDoc = "---\ntitle: User\n---\n# User\n\nhand-authored body, no markers.\n";
		const doc = parseMemoryDoc(userDoc);
		expect(doc.hasBodyMarkers).toBe(false);
		expect(rewriteDocBody(doc, "anything")).toBeUndefined();
	});
});

describe(".omp-meta directory config", () => {
	it("inherits parent sidecar config when inheritToChildren is true", async () => {
		await withTempRoot(async memoryRoot => {
			// Three-level hierarchy: memory/topic/child. Sidecar on `topic`
			// opts descendants in via inheritToChildren.
			const memDir = path.join(memoryRoot, TYPE_DIRS.memory);
			const topic = path.join(memDir, "topic");
			const child = path.join(topic, "child");
			await fs.mkdir(child, { recursive: true });

			await Bun.write(
				sidecarPathForDirectory(topic),
				stringifySidecar({
					aiMaintained: false,
					inheritToChildren: true,
				}),
			);

			const config = await resolveDirectoryConfig(memoryRoot, child);
			expect(config?.aiMaintained).toBe(false);
			expect(config?.requiresApproval).toBe(true);

			// Update to a doc inside `child` is permitted by checkWritePermission
			// (readOnly is the hard gate, not aiMaintained), but the resolved
			// config carries requiresApproval=true so callers route through
			// the approval sink.
			const target = path.join(child, "note.md");
			const updateReason = await checkWritePermission(memoryRoot, target, "update");
			expect(updateReason).toBeUndefined();
			const docConfig = await resolveDocConfig(memoryRoot, target, {});
			expect(docConfig?.requiresApproval).toBe(true);
		});
	});

	it("applies the type-root sidecar to the whole bucket when inheritToChildren is true", async () => {
		await withTempRoot(async memoryRoot => {
			// `memory.omp-meta` next to the type root with inheritToChildren
			// drives policy for every descendant.
			const memDir = path.join(memoryRoot, TYPE_DIRS.memory);
			const child = path.join(memDir, "topic");
			await fs.mkdir(child, { recursive: true });

			await Bun.write(
				sidecarPathForDirectory(memDir),
				stringifySidecar({
					allowCreateDocuments: false,
					inheritToChildren: true,
				}),
			);

			// Bucket-wide block — new docs refused at the type root AND in
			// any descendant.
			const blockedAtRoot = await checkWritePermission(memoryRoot, path.join(memDir, "new.md"), "create");
			expect(blockedAtRoot).toContain("denies new docs");
			const blockedInChild = await checkWritePermission(memoryRoot, path.join(child, "new.md"), "create");
			expect(blockedInChild).toContain("denies new docs");
		});
	});

	it("ancestor sidecars without inheritToChildren do NOT bleed into children", async () => {
		await withTempRoot(async memoryRoot => {
			const memDir = path.join(memoryRoot, TYPE_DIRS.memory);
			const topic = path.join(memDir, "topic");
			const child = path.join(topic, "child");
			await fs.mkdir(child, { recursive: true });
			await Bun.write(
				sidecarPathForDirectory(topic),
				stringifySidecar({
					aiMaintained: false,
					// no inheritToChildren
				}),
			);

			const config = await resolveDirectoryConfig(memoryRoot, child);
			// Falls back to type defaults (memory: aiMaintained true).
			expect(config?.aiMaintained).toBe(true);
		});
	});

	it("doc-level inheritInjectMode reuses parent injectMode", async () => {
		await withTempRoot(async memoryRoot => {
			const memDir = path.join(memoryRoot, TYPE_DIRS.memory);
			const sub = path.join(memDir, "topic");
			await fs.mkdir(sub, { recursive: true });
			await Bun.write(
				sidecarPathForDirectory(sub),
				stringifySidecar({
					injectMode: "rule",
				}),
			);

			const docPath = path.join(sub, "doc.md");
			const config = await resolveDocConfig(memoryRoot, docPath, {
				injectMode: "summary",
				inheritInjectMode: true,
			});
			// inheritInjectMode wins — falls back to parent's "rule".
			expect(config?.injectMode).toBe("rule");

			const explicit = await resolveDocConfig(memoryRoot, docPath, {
				injectMode: "summary",
				inheritInjectMode: false,
			});
			expect(explicit?.injectMode).toBe("summary");
		});
	});

	it("doc-level inheritAiConfig re-opts into parent aiMaintained / readOnly", async () => {
		await withTempRoot(async memoryRoot => {
			// design/ defaults to aiMaintained: false (requires approval). A doc
			// that pinned aiMaintained: true in its own frontmatter would normally
			// override that — inheritAiConfig: true forces it to track the parent.
			const designDir = path.join(memoryRoot, TYPE_DIRS.design);
			await fs.mkdir(designDir, { recursive: true });
			const docPath = path.join(designDir, "architecture.md");

			const inherited = await resolveDocConfig(memoryRoot, docPath, {
				aiMaintained: true,
				inheritAiConfig: true,
			});
			expect(inherited?.aiMaintained).toBe(false);
			expect(inherited?.requiresApproval).toBe(true);

			const explicit = await resolveDocConfig(memoryRoot, docPath, {
				aiMaintained: true,
				inheritAiConfig: false,
			});
			expect(explicit?.aiMaintained).toBe(true);
			expect(explicit?.requiresApproval).toBe(false);
		});
	});

	it("doc-level inheritAiConfig honours parent readOnly for write + delete gates", async () => {
		await withTempRoot(async memoryRoot => {
			// reference/ defaults to readOnly: true. A doc that flipped readOnly
			// off in its own frontmatter loses that override under inheritAiConfig.
			const refDir = path.join(memoryRoot, TYPE_DIRS.reference);
			await fs.mkdir(refDir, { recursive: true });
			const docPath = path.join(refDir, "spec.md");
			await Bun.write(docPath, "stub");

			const inherited = await resolveDocConfig(memoryRoot, docPath, {
				readOnly: false,
				inheritAiConfig: true,
			});
			expect(inherited?.readOnly).toBe(true);

			const writeBlocked = await checkWritePermission(memoryRoot, docPath, "update", {
				readOnly: false,
				inheritAiConfig: true,
			});
			expect(writeBlocked).toContain("read-only");

			const deleteBlocked = await checkDeletePermission(memoryRoot, docPath, {
				readOnly: false,
				inheritAiConfig: true,
			});
			expect(deleteBlocked).toContain("read-only");
		});
	});

	it("allowCreateDocuments: false blocks new docs in that directory only", async () => {
		await withTempRoot(async memoryRoot => {
			const memDir = path.join(memoryRoot, TYPE_DIRS.memory);
			const locked = path.join(memDir, "locked");
			const open = path.join(memDir, "open");
			await fs.mkdir(locked, { recursive: true });
			await fs.mkdir(open, { recursive: true });
			await Bun.write(sidecarPathForDirectory(locked), stringifySidecar({ allowCreateDocuments: false }));

			const blocked = await checkWritePermission(memoryRoot, path.join(locked, "new.md"), "create");
			expect(blocked).toContain("denies new docs");

			const allowed = await checkWritePermission(memoryRoot, path.join(open, "new.md"), "create");
			expect(allowed).toBeUndefined();
		});
	});

	it("renameDirectoryWithSidecar moves both atomically", async () => {
		await withTempRoot(async memoryRoot => {
			const memDir = path.join(memoryRoot, TYPE_DIRS.memory);
			const src = path.join(memDir, "old");
			const dest = path.join(memDir, "new");
			await fs.mkdir(src, { recursive: true });
			await Bun.write(path.join(src, "doc.md"), "x");
			await Bun.write(sidecarPathForDirectory(src), stringifySidecar({ injectMode: "summary" }));

			await renameDirectoryWithSidecar(src, dest);

			expect(await Bun.file(path.join(dest, "doc.md")).exists()).toBe(true);
			expect(await Bun.file(sidecarPathForDirectory(dest)).exists()).toBe(true);
			expect(await Bun.file(src).exists()).toBe(false);
			expect(await Bun.file(sidecarPathForDirectory(src)).exists()).toBe(false);
		});
	});
});

describe("seedBuiltinDocs", () => {
	it("creates seeds with markers on first run and is idempotent", async () => {
		await withTempRoot(async memoryRoot => {
			await seedBuiltinDocs(memoryRoot);
			const seedPath = path.join(memoryRoot, "memory", "user-preference.md");
			const first = await Bun.file(seedPath).text();
			expect(first).toContain("<!-- omp:body:start -->");
			expect(first).toContain("seedVersion: 2");

			await seedBuiltinDocs(memoryRoot);
			const second = await Bun.file(seedPath).text();
			// Same version → same content (idempotent).
			expect(second).toBe(first);
		});
	});

	it("preserves the body when refreshing from an older seedVersion", async () => {
		await withTempRoot(async memoryRoot => {
			const seedPath = path.join(memoryRoot, "memory", "user-preference.md");
			await fs.mkdir(path.dirname(seedPath), { recursive: true });
			const userBody = "User said: prefer tabs over spaces.";
			const oldDoc = buildMemoryDoc({
				frontmatter: {
					id: "kd_user_preference",
					type: "memory",
					path: "user-preference.md",
					title: "User Preferences",
					injectMode: "rule",
					aiMaintained: true,
					readOnly: false,
					seedVersion: 0,
					createdAt: 1,
					updatedAt: 1,
				},
				title: "User Preferences",
				summary: "stale summary",
				body: userBody,
			});
			await Bun.write(seedPath, oldDoc);

			await seedBuiltinDocs(memoryRoot);

			const refreshed = await Bun.file(seedPath).text();
			const reparsed = parseMemoryDoc(refreshed);
			expect(reparsed.body.trim()).toBe(userBody);
			expect(reparsed.frontmatter.seedVersion).toBe(2);
			// Summary refreshed to canonical text — not "stale summary".
			expect(refreshed).not.toContain("stale summary");
		});
	});

	it("leaves user-owned seed files (markers stripped) alone", async () => {
		await withTempRoot(async memoryRoot => {
			const seedPath = path.join(memoryRoot, "memory", "user-preference.md");
			await fs.mkdir(path.dirname(seedPath), { recursive: true });
			const userOwned = "---\ntitle: User Preferences\n---\n# Mine\n\nNo markers here.\n";
			await Bun.write(seedPath, userOwned);

			await seedBuiltinDocs(memoryRoot);

			const after = await Bun.file(seedPath).text();
			expect(after).toBe(userOwned);
		});
	});

	it("materializes the `project-understanding/` directory seed with `.omp-meta`", async () => {
		await withTempRoot(async memoryRoot => {
			await seedBuiltinDocs(memoryRoot);
			const dir = path.join(memoryRoot, "memory", "project-understanding");
			const sidecar = sidecarPathForDirectory(dir);
			expect((await fs.stat(dir)).isDirectory()).toBe(true);
			expect(await Bun.file(sidecar).exists()).toBe(true);
			const sidecarText = await Bun.file(sidecar).text();
			expect(sidecarText).toContain("injectMode: path");
			expect(sidecarText).toContain("seedVersion: 2");

			// User customizes maintenance rules → flip explicitMaintenanceRules
			// and re-run. The customized rules must survive.
			await Bun.write(
				sidecar,
				stringifySidecar({
					version: 1,
					summary: "user-edited summary",
					injectMode: "path",
					inheritToChildren: true,
					aiMaintained: true,
					seedVersion: 1,
					maintenanceRules: "- only my rule",
					explicitMaintenanceRules: true,
				}),
			);
			await seedBuiltinDocs(memoryRoot);
			const refreshed = await Bun.file(sidecar).text();
			expect(refreshed).toContain("only my rule");
			expect(refreshed).toContain("explicitMaintenanceRules: true");
		});
	});

	it("derives `requiresApproval: true` for `aiMaintained: false` directories", async () => {
		await withTempRoot(async memoryRoot => {
			const designDir = path.join(memoryRoot, TYPE_DIRS.design);
			await fs.mkdir(designDir, { recursive: true });
			const config = await resolveDirectoryConfig(memoryRoot, designDir);
			expect(config?.aiMaintained).toBe(false);
			expect(config?.requiresApproval).toBe(true);
			expect(config?.injectMode).toBe("path");
		});
	});

	it("derives `requiresApproval: false` for `readOnly` targets (no approval routing)", async () => {
		await withTempRoot(async memoryRoot => {
			const refDir = path.join(memoryRoot, TYPE_DIRS.reference);
			await fs.mkdir(refDir, { recursive: true });
			const config = await resolveDirectoryConfig(memoryRoot, refDir);
			expect(config?.readOnly).toBe(true);
			// readOnly is the hard refusal; no approval flow is offered.
			expect(config?.requiresApproval).toBe(false);
		});
	});

	it("round-trips `injectMode: path` through doc frontmatter", async () => {
		await withTempRoot(async memoryRoot => {
			const memDir = path.join(memoryRoot, TYPE_DIRS.memory);
			await fs.mkdir(memDir, { recursive: true });
			const docPath = path.join(memDir, "breadcrumb.md");
			const doc = buildMemoryDoc({
				frontmatter: {
					id: "kd_breadcrumb",
					type: "memory",
					path: "breadcrumb.md",
					title: "Breadcrumb",
					injectMode: "path",
					aiMaintained: true,
					readOnly: false,
					createdAt: 1,
					updatedAt: 1,
				},
				title: "Breadcrumb",
				body: "Body content",
			});
			await Bun.write(docPath, doc);

			const parsed = parseMemoryDoc(await Bun.file(docPath).text());
			expect(parsed.frontmatter.injectMode).toBe("path");

			const resolved = await resolveDocConfig(memoryRoot, docPath, parsed.frontmatter);
			expect(resolved?.injectMode).toBe("path");
		});
	});
});

describe("applyConsolidation", () => {
	it("writes memory_md, memory_summary, and skills under the typed dirs", async () => {
		await withTempRoot(async memoryRoot => {
			await applyConsolidation(
				memoryRoot,
				consolidationFixture({
					memoryMd: "long memory body",
					memorySummary: "summary body",
					skills: [
						{
							name: "demo",
							content: "demo skill body",
							scripts: [{ path: "run.sh", content: "echo hi" }],
							templates: [],
							examples: [],
						},
					],
				}),
			);

			const memoryDoc = await Bun.file(path.join(memoryRoot, "memory", "MEMORY.md")).text();
			expect(memoryDoc).toContain("<!-- omp:body:start -->");
			expect(memoryDoc).toContain("long memory body");

			const summaryDoc = await Bun.file(path.join(memoryRoot, "memory", "memory_summary.md")).text();
			expect(summaryDoc).toContain("summary body");

			const skillDoc = await Bun.file(path.join(memoryRoot, "skill", "demo", "SKILL.md")).text();
			expect(skillDoc).toContain("demo skill body");

			const script = await Bun.file(path.join(memoryRoot, "skill", "demo", "scripts", "run.sh")).text();
			expect(script).toBe("echo hi\n");
		});
	});

	it("preserves the body of a user-protected skill (aiMaintained: false)", async () => {
		await withTempRoot(async memoryRoot => {
			// First pass: create an AI-maintained skill.
			await applyConsolidation(
				memoryRoot,
				consolidationFixture({
					skills: [{ name: "userskill", content: "v1 body", scripts: [], templates: [], examples: [] }],
				}),
			);
			const skillPath = path.join(memoryRoot, "skill", "userskill", "SKILL.md");
			// User takes ownership of the SKILL.md by flipping aiMaintained.
			const original = await Bun.file(skillPath).text();
			const userOwned = original.replace("aiMaintained: true", "aiMaintained: false");
			await Bun.write(skillPath, userOwned);

			// Second pass tries to overwrite body — must be refused.
			await applyConsolidation(
				memoryRoot,
				consolidationFixture({
					skills: [
						{ name: "userskill", content: "v2 SHOULD NOT APPEAR", scripts: [], templates: [], examples: [] },
					],
				}),
			);

			const after = await Bun.file(skillPath).text();
			expect(after).toContain("v1 body");
			expect(after).not.toContain("v2 SHOULD NOT APPEAR");
		});
	});

	it("preserves a markerless user-authored SKILL.md and its assets across consolidations", async () => {
		await withTempRoot(async memoryRoot => {
			// First pass: AI-maintained skill with an asset.
			await applyConsolidation(
				memoryRoot,
				consolidationFixture({
					skills: [
						{
							name: "user-md",
							content: "v1 body",
							scripts: [{ path: "run.sh", content: "echo v1" }],
							templates: [],
							examples: [],
						},
					],
				}),
			);
			const skillPath = path.join(memoryRoot, "skill", "user-md", "SKILL.md");
			const assetPath = path.join(memoryRoot, "skill", "user-md", "scripts", "run.sh");

			// User rewrites SKILL.md from scratch without frontmatter or body
			// markers — the consolidator must treat the dir as user-owned and
			// leave both the doc and its assets untouched, even though the
			// effective `aiMaintained` config still defaults to `true`.
			const userAuthored = "# My Skill\n\nHand-authored, no markers.\n";
			await Bun.write(skillPath, userAuthored);
			const userAsset = "echo user-curated\n";
			await Bun.write(assetPath, userAsset);

			await applyConsolidation(
				memoryRoot,
				consolidationFixture({
					skills: [
						{
							name: "user-md",
							content: "v2 SHOULD NOT APPEAR",
							scripts: [{ path: "run.sh", content: "echo v2 SHOULD NOT APPEAR" }],
							templates: [],
							examples: [],
						},
					],
				}),
			);

			expect(await Bun.file(skillPath).text()).toBe(userAuthored);
			expect(await Bun.file(assetPath).text()).toBe(userAsset);
		});
	});

	it("does not touch user-authored docs lacking body markers", async () => {
		await withTempRoot(async memoryRoot => {
			const memoryMdPath = path.join(memoryRoot, "memory", "MEMORY.md");
			await fs.mkdir(path.dirname(memoryMdPath), { recursive: true });
			const userDoc = "# Hand-authored\n\nNo markers — this is mine.\n";
			await Bun.write(memoryMdPath, userDoc);

			await applyConsolidation(memoryRoot, consolidationFixture({ memoryMd: "AI tried to write this" }));

			const after = await Bun.file(memoryMdPath).text();
			expect(after).toBe(userDoc);
		});
	});

	it("preserves skill assets (scripts/templates/examples) when the skill is user-protected", async () => {
		await withTempRoot(async memoryRoot => {
			// First pass: AI-maintained skill with one asset.
			await applyConsolidation(
				memoryRoot,
				consolidationFixture({
					skills: [
						{
							name: "ops",
							content: "ops body v1",
							scripts: [{ path: "deploy.sh", content: "echo v1" }],
							templates: [],
							examples: [],
						},
					],
				}),
			);
			// User takes ownership of the skill (aiMaintained: false) AND
			// edits the asset by hand.
			const skillPath = path.join(memoryRoot, "skill", "ops", "SKILL.md");
			const assetPath = path.join(memoryRoot, "skill", "ops", "scripts", "deploy.sh");
			const skillDoc = await Bun.file(skillPath).text();
			await Bun.write(skillPath, skillDoc.replace("aiMaintained: true", "aiMaintained: false"));
			const handEdited = "echo user-curated\n";
			await Bun.write(assetPath, handEdited);

			// Second pass: consolidator emits a new asset payload and a
			// different file under the same skill. Both must be refused.
			await applyConsolidation(
				memoryRoot,
				consolidationFixture({
					skills: [
						{
							name: "ops",
							content: "ops body v2",
							scripts: [
								{ path: "deploy.sh", content: "echo v2" },
								{ path: "rollback.sh", content: "echo rollback" },
							],
							templates: [],
							examples: [],
						},
					],
				}),
			);

			expect(await Bun.file(assetPath).text()).toBe(handEdited);
			// The new asset the consolidator tried to add was refused too —
			// the user-protected dir is fully off-limits.
			expect(await Bun.file(path.join(memoryRoot, "skill", "ops", "scripts", "rollback.sh")).exists()).toBe(false);
		});
	});

	it("preserves skill assets when the skill is read-only (aiMaintained: true, readOnly: true)", async () => {
		await withTempRoot(async memoryRoot => {
			// First pass: AI-maintained skill with an asset.
			await applyConsolidation(
				memoryRoot,
				consolidationFixture({
					skills: [
						{
							name: "locked",
							content: "locked body v1",
							scripts: [{ path: "run.sh", content: "echo v1" }],
							templates: [],
							examples: [],
						},
					],
				}),
			);
			// User locks the skill but leaves aiMaintained: true. readOnly is the
			// hard gate — the consolidator must skip both SKILL.md AND the asset
			// buckets even though aiMaintained still says "AI can touch this".
			const skillPath = path.join(memoryRoot, "skill", "locked", "SKILL.md");
			const assetPath = path.join(memoryRoot, "skill", "locked", "scripts", "run.sh");
			const skillDoc = await Bun.file(skillPath).text();
			await Bun.write(skillPath, skillDoc.replace("readOnly: false", "readOnly: true"));
			const handEdited = "echo user-curated\n";
			await Bun.write(assetPath, handEdited);

			// Second pass: would overwrite the asset and add a new file.
			await applyConsolidation(
				memoryRoot,
				consolidationFixture({
					skills: [
						{
							name: "locked",
							content: "locked body v2",
							scripts: [
								{ path: "run.sh", content: "echo v2" },
								{ path: "extra.sh", content: "echo extra" },
							],
							templates: [],
							examples: [],
						},
					],
				}),
			);

			expect(await Bun.file(assetPath).text()).toBe(handEdited);
			expect(await Bun.file(path.join(memoryRoot, "skill", "locked", "scripts", "extra.sh")).exists()).toBe(false);
		});
	});

	it("preserves read-only skill dirs during the consolidator empty-pass prune", async () => {
		await withTempRoot(async memoryRoot => {
			// First pass: AI-maintained skill.
			await applyConsolidation(
				memoryRoot,
				consolidationFixture({
					skills: [{ name: "gamma", content: "g", scripts: [], templates: [], examples: [] }],
				}),
			);
			// User locks the skill (readOnly: true) while leaving aiMaintained: true.
			const gammaPath = path.join(memoryRoot, "skill", "gamma", "SKILL.md");
			const gamma = await Bun.file(gammaPath).text();
			await Bun.write(gammaPath, gamma.replace("readOnly: false", "readOnly: true"));

			// cleanupConsolidatedArtifacts runs pruneSkillsDir directly (empty-pass
			// path). The read-only skill must survive.
			await cleanupConsolidatedArtifacts(memoryRoot);

			expect(await Bun.file(gammaPath).exists()).toBe(true);
		});
	});

	it("prunes AI-maintained skill dirs the consolidator no longer emits, but keeps user-protected ones", async () => {
		await withTempRoot(async memoryRoot => {
			// First pass: two AI skills.
			await applyConsolidation(
				memoryRoot,
				consolidationFixture({
					skills: [
						{ name: "alpha", content: "a", scripts: [], templates: [], examples: [] },
						{ name: "beta", content: "b", scripts: [], templates: [], examples: [] },
					],
				}),
			);
			// Make `beta` user-protected via doc-level frontmatter.
			const betaPath = path.join(memoryRoot, "skill", "beta", "SKILL.md");
			const beta = await Bun.file(betaPath).text();
			await Bun.write(betaPath, beta.replace("aiMaintained: true", "aiMaintained: false"));

			// Second pass emits neither skill.
			await applyConsolidation(memoryRoot, consolidationFixture());

			// alpha pruned, beta survives.
			expect(await Bun.file(path.join(memoryRoot, "skill", "alpha", "SKILL.md")).exists()).toBe(false);
			expect(await Bun.file(betaPath).exists()).toBe(true);
		});
	});

	it("writes design_drafts under design/_drafts/ with aiMaintained: false and refuses to overwrite", async () => {
		await withTempRoot(async memoryRoot => {
			await applyConsolidation(
				memoryRoot,
				consolidationFixture({
					designDrafts: [{ path: "spike.md", content: "proposed approach" }],
				}),
			);
			const draftPath = path.join(memoryRoot, "design", "_drafts", "spike.md");
			const first = await Bun.file(draftPath).text();
			expect(first).toContain("proposed approach");
			expect(first).toContain("aiMaintained: false");

			// Second pass with different body must NOT overwrite the existing draft.
			await applyConsolidation(
				memoryRoot,
				consolidationFixture({
					designDrafts: [{ path: "spike.md", content: "different proposal" }],
				}),
			);
			const after = await Bun.file(draftPath).text();
			expect(after).toBe(first);
			expect(after).not.toContain("different proposal");
		});
	});

	it("leaves design/ and reference/ untouched on a no-output consolidation pass", async () => {
		await withTempRoot(async memoryRoot => {
			const designPath = path.join(memoryRoot, "design", "spec.md");
			const referencePath = path.join(memoryRoot, "reference", "spec.md");
			await fs.mkdir(path.dirname(designPath), { recursive: true });
			await fs.mkdir(path.dirname(referencePath), { recursive: true });
			await Bun.write(designPath, "user design note");
			await Bun.write(referencePath, "user reference material");

			await cleanupConsolidatedArtifacts(memoryRoot);

			expect(await Bun.file(designPath).text()).toBe("user design note");
			expect(await Bun.file(referencePath).text()).toBe("user reference material");
		});
	});

	it("migrates legacy MEMORY.md / memory_summary.md / skills/ on first pass", async () => {
		await withTempRoot(async memoryRoot => {
			// Pre-populate with the old shape.
			await Bun.write(path.join(memoryRoot, "MEMORY.md"), "legacy mem body");
			await Bun.write(path.join(memoryRoot, "memory_summary.md"), "legacy summary body");
			const legacySkillsDir = path.join(memoryRoot, "skills", "old");
			await fs.mkdir(legacySkillsDir, { recursive: true });
			await Bun.write(
				path.join(legacySkillsDir, "SKILL.md"),
				"---\naiMaintained: false\n---\n# Old\n\nlegacy skill body\n",
			);

			await applyConsolidation(memoryRoot, consolidationFixture());

			// Migrated to new shape.
			expect(await Bun.file(path.join(memoryRoot, "memory", "MEMORY.md")).exists()).toBe(true);
			expect(await Bun.file(path.join(memoryRoot, "memory", "memory_summary.md")).exists()).toBe(true);
			expect(await Bun.file(path.join(memoryRoot, "skill", "old", "SKILL.md")).exists()).toBe(true);
			// Legacy roots cleared.
			expect(await Bun.file(path.join(memoryRoot, "MEMORY.md")).exists()).toBe(false);
		});
	});

	it("refreshes migrated legacy MEMORY.md and memory_summary.md on subsequent consolidations", async () => {
		await withTempRoot(async memoryRoot => {
			// Pre-PR shape: marker-less MEMORY.md / memory_summary.md.
			await Bun.write(path.join(memoryRoot, "MEMORY.md"), "legacy mem body v0");
			await Bun.write(path.join(memoryRoot, "memory_summary.md"), "legacy summary v0");

			// First Phase-2 migrates AND seeds new body via the migrated docs.
			await applyConsolidation(
				memoryRoot,
				consolidationFixture({ memoryMd: "phase2 v1", memorySummary: "summary v1" }),
			);
			const memPath = path.join(memoryRoot, "memory", "MEMORY.md");
			const sumPath = path.join(memoryRoot, "memory", "memory_summary.md");
			const memAfterFirst = await Bun.file(memPath).text();
			const sumAfterFirst = await Bun.file(sumPath).text();
			expect(memAfterFirst).toContain("<!-- omp:body:start -->");
			expect(memAfterFirst).toContain("phase2 v1");
			expect(sumAfterFirst).toContain("summary v1");

			// Second Phase-2 must refresh the body region — this is the regression
			// the migration->marker promotion guards against. Without the promote,
			// writeMemoryDoc would see the marker-less migrated content and skip.
			await applyConsolidation(
				memoryRoot,
				consolidationFixture({ memoryMd: "phase2 v2", memorySummary: "summary v2" }),
			);
			expect(await Bun.file(memPath).text()).toContain("phase2 v2");
			expect(await Bun.file(sumPath).text()).toContain("summary v2");
		});
	});
});
