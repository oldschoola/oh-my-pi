// Coverage for the skill ops layer used by the `skill_create` and
// `skill_reload` tools. Verifies name validation, path containment,
// collision detection, frontmatter emission, and reload diffs.

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import {
	commitSkillPackage,
	createSkillPackage,
	prepareSkillPackage,
	reloadSkills,
	SkillOpsError,
} from "../src/extensibility/skill-ops";
import { resetActiveSkillsForTests, type Skill } from "../src/extensibility/skills";

async function withTempProject<T>(fn: (projectRoot: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-ops-"));
	try {
		const projectRoot = path.join(dir, "project");
		await fs.mkdir(projectRoot, { recursive: true });
		return await fn(projectRoot);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function readSkill(skillFile: string): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
	const content = await fs.readFile(skillFile, "utf8");
	const parsed = parseFrontmatter(content, { source: skillFile });
	return { frontmatter: parsed.frontmatter, body: parsed.body };
}

describe("createSkillPackage", () => {
	it("writes a SKILL.md with the expected frontmatter and body", async () => {
		await withTempProject(async projectRoot => {
			const result = await createSkillPackage(projectRoot, {
				name: "deploy-playbook",
				description: "Steps for blue/green deploys.",
				body: "# Deploy\n\nUse blue/green.",
			});
			expect(result.skillFile).toBe(path.join(projectRoot, ".omp", "skills", "deploy-playbook", "SKILL.md"));
			const { frontmatter, body } = await readSkill(result.skillFile);
			expect(frontmatter.name).toBe("deploy-playbook");
			expect(frontmatter.description).toBe("Steps for blue/green deploys.");
			// Default skillSurface is implicit ("auto") — must not appear.
			expect(frontmatter.skillSurface).toBeUndefined();
			expect(body.trim()).toBe("# Deploy\n\nUse blue/green.");
		});
	});

	it("emits explicit skillSurface only when set to 'command'", async () => {
		await withTempProject(async projectRoot => {
			const hidden = await createSkillPackage(projectRoot, {
				name: "secret-handler",
				description: "Opt-in skill.",
				body: "body",
				skillSurface: "command",
			});
			const { frontmatter } = await readSkill(hidden.skillFile);
			expect(frontmatter.skillSurface).toBe("command");

			const visible = await createSkillPackage(projectRoot, {
				name: "open-handler",
				description: "Visible skill.",
				body: "body",
				skillSurface: "auto",
			});
			const { frontmatter: visibleFm } = await readSkill(visible.skillFile);
			expect(visibleFm.skillSurface).toBeUndefined();
		});
	});

	for (const badName of [
		"",
		"../escape",
		"foo/bar",
		"foo\\bar",
		"Foo",
		"-leading-dash",
		"_leading-underscore",
		".",
		"..",
		"a".repeat(65),
	]) {
		it(`refuses unsafe name ${JSON.stringify(badName)}`, async () => {
			await withTempProject(async projectRoot => {
				await expect(
					createSkillPackage(projectRoot, { name: badName, description: "x", body: "" }),
				).rejects.toBeInstanceOf(SkillOpsError);
				// No file written.
				const root = path.join(projectRoot, ".omp", "skills");
				const exists = await fs
					.stat(root)
					.then(() => true)
					.catch(() => false);
				expect(exists).toBe(false);
			});
		});
	}

	it("rejects Windows-style traversal at the name validator", async () => {
		await withTempProject(async projectRoot => {
			await expect(
				createSkillPackage(projectRoot, { name: "..\\evil", description: "x", body: "" }),
			).rejects.toBeInstanceOf(SkillOpsError);
		});
	});

	it("refuses on existing directory collision", async () => {
		await withTempProject(async projectRoot => {
			const skillDir = path.join(projectRoot, ".omp", "skills", "existing");
			await fs.mkdir(skillDir, { recursive: true });
			try {
				await createSkillPackage(projectRoot, {
					name: "existing",
					description: "x",
					body: "",
				});
				throw new Error("expected to refuse");
			} catch (error) {
				expect(error).toBeInstanceOf(SkillOpsError);
				expect((error as SkillOpsError).code).toBe("collision");
			}
		});
	});

	it("refuses empty descriptions", async () => {
		await withTempProject(async projectRoot => {
			await expect(
				createSkillPackage(projectRoot, { name: "ok-name", description: "   ", body: "" }),
			).rejects.toBeInstanceOf(SkillOpsError);
		});
	});

	it("prepare phase reports collisions before any disk write", async () => {
		await withTempProject(async projectRoot => {
			await fs.mkdir(path.join(projectRoot, ".omp", "skills", "taken"), { recursive: true });
			await expect(
				prepareSkillPackage(projectRoot, { name: "taken", description: "x", body: "" }),
			).rejects.toMatchObject({ code: "collision" });
		});
	});

	it("commit writes only after prepare succeeds", async () => {
		await withTempProject(async projectRoot => {
			const prepared = await prepareSkillPackage(projectRoot, {
				name: "two-phase",
				description: "demo",
				body: "body",
			});
			// Nothing on disk yet.
			expect(
				await fs
					.stat(prepared.skillDir)
					.then(() => true)
					.catch(() => false),
			).toBe(false);
			await commitSkillPackage(prepared);
			expect(
				await fs
					.stat(prepared.skillFile)
					.then(() => true)
					.catch(() => false),
			).toBe(true);
		});
	});
});

describe("reloadSkills", () => {
	const loadOpts = (projectRoot: string) => ({
		cwd: projectRoot,
		enabled: true,
		enableCodexUser: false,
		enableClaudeUser: false,
		enableClaudeProject: false,
		enablePiUser: false,
		enablePiProject: true,
		customDirectories: [] as string[],
	});

	it("reports added/removed/changed between snapshots", async () => {
		await withTempProject(async projectRoot => {
			resetActiveSkillsForTests();
			await createSkillPackage(projectRoot, { name: "alpha", description: "A.", body: "" });
			await createSkillPackage(projectRoot, { name: "bravo", description: "B.", body: "" });

			const first = await reloadSkills(loadOpts(projectRoot), []);
			const firstNames = first.skills.map(s => s.name).filter(n => n === "alpha" || n === "bravo");
			expect(firstNames.sort()).toEqual(["alpha", "bravo"]);

			// Add charlie, remove alpha, leave bravo as-is.
			await createSkillPackage(projectRoot, { name: "charlie", description: "C.", body: "" });
			await fs.rm(path.join(projectRoot, ".omp", "skills", "alpha"), { recursive: true });

			const second = await reloadSkills(loadOpts(projectRoot), first.skills);
			expect(second.diff.added).toContain("charlie");
			expect(second.diff.removed).toContain("alpha");
			expect(second.diff.changed).toEqual([]);
		});
	});

	it("reports a skill as 'changed' when its on-disk filePath shifts", async () => {
		await withTempProject(async projectRoot => {
			resetActiveSkillsForTests();
			await createSkillPackage(projectRoot, { name: "movable", description: "x.", body: "" });
			const first = await reloadSkills(loadOpts(projectRoot), []);

			// Synthesize a "moved" prior snapshot by altering the filePath in
			// the previous record. This mirrors what reloadSkills sees when
			// the skill directory itself is renamed/moved between scans.
			const fakePrev: Skill[] = first.skills.map(s =>
				s.name === "movable" ? { ...s, filePath: `${s.filePath}.old` } : s,
			);

			const second = await reloadSkills(loadOpts(projectRoot), fakePrev);
			expect(second.diff.changed).toContain("movable");
			expect(second.diff.added).toEqual([]);
			expect(second.diff.removed).toEqual([]);
		});
	});

	it("returns an empty diff against an identical snapshot", async () => {
		await withTempProject(async projectRoot => {
			resetActiveSkillsForTests();
			await createSkillPackage(projectRoot, { name: "stable", description: "x.", body: "" });
			const first = await reloadSkills(loadOpts(projectRoot), []);
			const second = await reloadSkills(loadOpts(projectRoot), first.skills);
			expect(second.diff.added).toEqual([]);
			expect(second.diff.removed).toEqual([]);
			expect(second.diff.changed).toEqual([]);
		});
	});

	it("returns a warnings array (propagated from loadSkills)", async () => {
		await withTempProject(async projectRoot => {
			resetActiveSkillsForTests();
			const result = await reloadSkills(loadOpts(projectRoot), []);
			expect(Array.isArray(result.diff.warnings)).toBe(true);
		});
	});
});
