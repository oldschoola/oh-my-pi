// Coverage for positive-framing skill surface (`skillSurface: "auto" |
// "command"`) and its legacy `hide: true` alias.

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deriveSkillSurface, loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";

interface SkillFixture {
	name: string;
	frontmatter: Record<string, unknown>;
}

async function withSkillFixtures<T>(fixtures: SkillFixture[], fn: (dir: string) => Promise<T>): Promise<T> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-surface-"));
	try {
		for (const fixture of fixtures) {
			const skillDir = path.join(tempDir, fixture.name);
			await fs.mkdir(skillDir, { recursive: true });
			const fmLines = ["---", `name: ${fixture.name}`, "description: Test skill."];
			for (const [key, value] of Object.entries(fixture.frontmatter)) {
				fmLines.push(`${key}: ${JSON.stringify(value)}`);
			}
			fmLines.push("---", "", `# ${fixture.name}`, "");
			await fs.writeFile(path.join(skillDir, "SKILL.md"), fmLines.join("\n"));
		}
		return await fn(tempDir);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

describe("deriveSkillSurface", () => {
	it("defaults to auto when nothing is set", () => {
		expect(deriveSkillSurface(undefined)).toBe("auto");
		expect(deriveSkillSurface({})).toBe("auto");
	});

	it("honours explicit skillSurface", () => {
		expect(deriveSkillSurface({ skillSurface: "auto" })).toBe("auto");
		expect(deriveSkillSurface({ skillSurface: "command" })).toBe("command");
	});

	it("treats legacy hide: true as command", () => {
		expect(deriveSkillSurface({ hide: true })).toBe("command");
	});

	it("explicit skillSurface beats legacy hide", () => {
		expect(deriveSkillSurface({ skillSurface: "auto", hide: true })).toBe("auto");
		expect(deriveSkillSurface({ skillSurface: "command", hide: false })).toBe("command");
	});

	it("ignores garbage skillSurface values and falls back to hide / default", () => {
		expect(deriveSkillSurface({ skillSurface: "nonsense" as unknown as "auto" })).toBe("auto");
		expect(deriveSkillSurface({ skillSurface: 42 as unknown as "auto", hide: true })).toBe("command");
	});
});

describe("loadSkills with skillSurface", () => {
	it("loads command-surfaced skills but tags them so the prompt filter can drop them", async () => {
		await withSkillFixtures(
			[
				{ name: "auto-skill", frontmatter: {} },
				{ name: "command-skill", frontmatter: { skillSurface: "command" } },
				{ name: "hidden-legacy", frontmatter: { hide: true } },
			],
			async dir => {
				const { skills } = await loadSkills({
					enableCodexUser: false,
					enableClaudeUser: false,
					enableClaudeProject: false,
					enablePiUser: false,
					enablePiProject: false,
					customDirectories: [dir],
				});

				const byName = new Map(skills.map(skill => [skill.name, skill]));
				expect(byName.has("auto-skill")).toBe(true);
				expect(byName.has("command-skill")).toBe(true);
				expect(byName.has("hidden-legacy")).toBe(true);

				expect(byName.get("auto-skill")?.surface ?? "auto").toBe("auto");
				expect(byName.get("command-skill")?.surface).toBe("command");
				expect(byName.get("hidden-legacy")?.surface).toBe("command");

				// `.hide` mirror stays in sync so legacy callsites keep working.
				expect(byName.get("auto-skill")?.hide).toBe(false);
				expect(byName.get("command-skill")?.hide).toBe(true);
				expect(byName.get("hidden-legacy")?.hide).toBe(true);

				// The rendered-prompt filter (mirroring system-prompt.ts) drops
				// any skill whose effective surface is "command".
				const visibleInPrompt = skills.filter(skill => (skill.surface ?? "auto") !== "command");
				const visibleNames = visibleInPrompt.map(skill => skill.name);
				expect(visibleNames).toContain("auto-skill");
				expect(visibleNames).not.toContain("command-skill");
				expect(visibleNames).not.toContain("hidden-legacy");
			},
		);
	});
});
