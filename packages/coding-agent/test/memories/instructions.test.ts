import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { buildMemoryToolDeveloperInstructions, getMemoryRoot } from "../../src/memories";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-instructions-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("buildMemoryToolDeveloperInstructions", () => {
	it("uses memory:// URLs under the new taxonomy and does not expose raw memory root paths", async () => {
		await withTempDir(async agentDir => {
			const settings = Settings.isolated({ "memories.enabled": true });
			const memoryRoot = getMemoryRoot(agentDir, settings.getCwd());
			await fs.mkdir(path.join(memoryRoot, "memory"), { recursive: true });
			await Bun.write(
				path.join(memoryRoot, "memory", "memory_summary.md"),
				"Use structured retries for flaky network calls.",
			);

			const instructions = await buildMemoryToolDeveloperInstructions(agentDir, settings);
			expect(instructions).toBeDefined();
			expect(instructions).toContain("memory://root/memory/memory_summary.md");
			expect(instructions).toContain("memory://root/skill/<name>/SKILL.md");
			expect(instructions).toContain("Use structured retries for flaky network calls.");
			expect(instructions).not.toContain(memoryRoot);
		});
	});

	it("falls back to legacy memory_summary.md when the new-shape file is missing", async () => {
		await withTempDir(async agentDir => {
			const settings = Settings.isolated({ "memories.enabled": true });
			const memoryRoot = getMemoryRoot(agentDir, settings.getCwd());
			await fs.mkdir(memoryRoot, { recursive: true });
			await Bun.write(path.join(memoryRoot, "memory_summary.md"), "Legacy summary content.");

			const instructions = await buildMemoryToolDeveloperInstructions(agentDir, settings);
			expect(instructions).toBeDefined();
			expect(instructions).toContain("Legacy summary content.");
		});
	});

	it("surfaces only the body region when the summary uses body markers", async () => {
		await withTempDir(async agentDir => {
			const settings = Settings.isolated({ "memories.enabled": true });
			const memoryRoot = getMemoryRoot(agentDir, settings.getCwd());
			await fs.mkdir(path.join(memoryRoot, "memory"), { recursive: true });
			const docPath = path.join(memoryRoot, "memory", "memory_summary.md");
			await Bun.write(
				docPath,
				[
					"---",
					"type: memory",
					"injectMode: summary",
					"---",
					"# Memory Summary",
					"",
					"## Summary",
					"Frontmatter summary block — should NOT appear in injection.",
					"",
					"<!-- omp:body:start -->",
					"Body-only guidance must be the only thing injected.",
					"<!-- omp:body:end -->",
					"",
				].join("\n"),
			);

			const instructions = await buildMemoryToolDeveloperInstructions(agentDir, settings);
			expect(instructions).toBeDefined();
			expect(instructions).toContain("Body-only guidance must be the only thing injected.");
			expect(instructions).not.toContain("Frontmatter summary block");
		});
	});
});
