import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../../src/registry/agent-registry";

interface MemoryFixture {
	cwd: string;
	memoryRoot: string;
	agentDir: string;
	cleanupRoot: string;
}

async function withMemoryFixture(fn: (fixture: MemoryFixture) => Promise<void>): Promise<void> {
	const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-protocol-"));
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

describe("MemoryProtocolHandler", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	it("resolves memory://root to memory/memory_summary.md (new layout)", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			await fs.mkdir(path.join(memoryRoot, "memory"), { recursive: true });
			await Bun.write(path.join(memoryRoot, "memory", "memory_summary.md"), "new-shape summary");

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root");

			expect(resource.content).toBe("new-shape summary");
			expect(resource.contentType).toBe("text/markdown");
		});
	});

	it("falls back to legacy memory_summary.md at the root", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			await Bun.write(path.join(memoryRoot, "memory_summary.md"), "legacy summary");

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root");

			expect(resource.content).toBe("legacy summary");
		});
	});

	it("redirects memory://root/memory/MEMORY.md to legacy MEMORY.md when only legacy exists", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			await Bun.write(path.join(memoryRoot, "MEMORY.md"), "legacy memory body");

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root/memory/MEMORY.md");

			expect(resource.content).toBe("legacy memory body");
		});
	});

	it("redirects legacy memory://root/MEMORY.md to new memory/MEMORY.md when only new exists", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			await fs.mkdir(path.join(memoryRoot, "memory"), { recursive: true });
			await Bun.write(path.join(memoryRoot, "memory", "MEMORY.md"), "new memory body");

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root/MEMORY.md");

			expect(resource.content).toBe("new memory body");
		});
	});

	it("redirects memory://root/skill/<name>/SKILL.md to legacy skills/<name>/SKILL.md", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			const legacy = path.join(memoryRoot, "skills", "old", "SKILL.md");
			await fs.mkdir(path.dirname(legacy), { recursive: true });
			await Bun.write(legacy, "legacy skill body");

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root/skill/old/SKILL.md");

			expect(resource.content).toBe("legacy skill body");
		});
	});

	it("redirects legacy memory://root/skills/<name>/SKILL.md to new skill/<name>/SKILL.md", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			const newPath = path.join(memoryRoot, "skill", "fresh", "SKILL.md");
			await fs.mkdir(path.dirname(newPath), { recursive: true });
			await Bun.write(newPath, "new-shape skill body");

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root/skills/fresh/SKILL.md");

			expect(resource.content).toBe("new-shape skill body");
		});
	});

	it("resolves memory://root/<path> within memory root", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			const skillPath = path.join(memoryRoot, "skill", "demo", "SKILL.md");
			await fs.mkdir(path.dirname(skillPath), { recursive: true });
			await Bun.write(skillPath, "demo skill");

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root/skill/demo/SKILL.md");

			expect(resource.content).toBe("demo skill");
			expect(resource.contentType).toBe("text/markdown");
		});
	});

	it("serves .omp-meta sidecars as text/plain", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			const sidecar = path.join(memoryRoot, "memory.omp-meta");
			await Bun.write(sidecar, "aiMaintained: false\n");

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root/memory.omp-meta");

			expect(resource.content).toBe("aiMaintained: false\n");
			expect(resource.contentType).toBe("text/plain");
		});
	});

	it("throws for unknown memory namespace", async () => {
		await withMemoryFixture(async () => {
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://other/memory_summary.md")).rejects.toThrow(
				"Unknown memory namespace: other. Supported: root",
			);
		});
	});

	it("blocks path traversal attempts", async () => {
		await withMemoryFixture(async () => {
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://root/../secret.md")).rejects.toThrow(
				"Path traversal (..) is not allowed in memory:// URLs",
			);
			await expect(router.resolve("memory://root/%2E%2E/secret.md")).rejects.toThrow(
				"Path traversal (..) is not allowed in memory:// URLs",
			);
		});
	});

	it("throws clear error for missing files", async () => {
		await withMemoryFixture(async () => {
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://root/missing.md")).rejects.toThrow(
				"Memory file not found: memory://root/missing.md",
			);
		});
	});

	it("blocks symlink escapes outside memory root", async () => {
		if (process.platform === "win32") return;

		await withMemoryFixture(async ({ memoryRoot, cleanupRoot }) => {
			const outsideDir = path.join(cleanupRoot, "outside");
			await fs.mkdir(outsideDir, { recursive: true });
			await Bun.write(path.join(outsideDir, "secret.md"), "secret");
			await fs.symlink(outsideDir, path.join(memoryRoot, "linked"));

			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://root/linked/secret.md")).rejects.toThrow(
				"memory:// URL escapes memory root",
			);
		});
	});
});
