// Coverage for the SkillCreate / SkillReload tool wrappers. Verifies the
// approval-sink protocol (eager validation + queued apply), tool-level
// collision refusal, reload-into-process-global, and skill:// resolution
// after reload.

import { beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSkillPackage } from "@oh-my-pi/pi-coding-agent/extensibility/skill-ops";
import { getActiveSkills, resetActiveSkillsForTests } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SkillCreateTool, SkillReloadTool } from "@oh-my-pi/pi-coding-agent/tools/skill";

interface QueuedDirective {
	label: string;
	onInvoked?: (input: unknown) => Promise<unknown>;
}

interface FakeQueue {
	directives: QueuedDirective[];
	pushOnce(_choice: unknown, options: { label: string; onInvoked: (input: unknown) => Promise<unknown> }): void;
}

function createFakeQueue(): FakeQueue {
	const directives: QueuedDirective[] = [];
	return {
		directives,
		pushOnce(_choice, options) {
			directives.push({ label: options.label, onInvoked: options.onInvoked });
		},
	};
}

function createSession(opts: { cwd: string; queue?: FakeQueue }): ToolSession {
	const queue = opts.queue;
	const settings = Settings.isolated({
		"skills.enabled": true,
		"skills.enableCodexUser": false,
		"skills.enableClaudeUser": false,
		"skills.enableClaudeProject": false,
		"skills.enablePiUser": false,
		"skills.enablePiProject": true,
	});
	return {
		cwd: opts.cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		getToolChoiceQueue: queue
			? () => queue as unknown as ReturnType<NonNullable<ToolSession["getToolChoiceQueue"]>>
			: undefined,
		buildToolChoice: queue
			? () =>
					({ type: "tool", name: "resolve" }) as unknown as ReturnType<NonNullable<ToolSession["buildToolChoice"]>>
			: undefined,
		steer: () => {},
	};
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(p => p.type === "text")?.text ?? "";
}

async function withTempProject<T>(fn: (projectRoot: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-tools-"));
	try {
		const projectRoot = path.join(dir, "project");
		await fs.mkdir(projectRoot, { recursive: true });
		return await fn(projectRoot);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

beforeEach(() => {
	resetActiveSkillsForTests();
});

describe("SkillCreateTool", () => {
	it("refuses when no approval channel is available", async () => {
		await withTempProject(async projectRoot => {
			const session = createSession({ cwd: projectRoot }); // no queue
			const tool = new SkillCreateTool(session);
			await expect(
				tool.execute("call-1", {
					name: "needs-approval",
					description: "x.",
					body: "",
				}),
			).rejects.toThrow(/user approval/);
			expect(await exists(path.join(projectRoot, ".omp", "skills", "needs-approval"))).toBe(false);
		});
	});

	it("queues an approval directive and writes the skill on apply", async () => {
		await withTempProject(async projectRoot => {
			const queue = createFakeQueue();
			const session = createSession({ cwd: projectRoot, queue });
			const tool = new SkillCreateTool(session);

			const pending = await tool.execute("call-1", {
				name: "my-skill",
				description: "Demo skill.",
				body: "# Hello",
			});
			expect(getText(pending)).toContain("pending user approval");
			expect(queue.directives).toHaveLength(1);
			expect(queue.directives[0].label).toContain("skill_create");

			// User approves → directive fires.
			const onInvoked = queue.directives[0].onInvoked!;
			const result = (await onInvoked({ action: "apply", reason: "looks good" })) as {
				content: Array<{ type: string; text?: string }>;
			};
			expect(getText(result)).toMatch(/Created skill package/);
			expect(getText(result)).toMatch(/skill_reload/);
			const skillFile = path.join(projectRoot, ".omp", "skills", "my-skill", "SKILL.md");
			expect(await exists(skillFile)).toBe(true);
			const content = await fs.readFile(skillFile, "utf8");
			expect(content).toContain("name: my-skill");
			expect(content).toContain("description: Demo skill.");
			expect(content).toContain("# Hello");
		});
	});

	it("does NOT write when the user discards the directive", async () => {
		await withTempProject(async projectRoot => {
			const queue = createFakeQueue();
			const session = createSession({ cwd: projectRoot, queue });
			const tool = new SkillCreateTool(session);

			await tool.execute("call-1", {
				name: "withheld",
				description: "x.",
				body: "",
			});
			// User never invokes the directive — file must NOT exist on disk.
			expect(await exists(path.join(projectRoot, ".omp", "skills", "withheld"))).toBe(false);
		});
	});

	it("refuses on collision BEFORE queuing approval", async () => {
		await withTempProject(async projectRoot => {
			await fs.mkdir(path.join(projectRoot, ".omp", "skills", "taken"), { recursive: true });
			const queue = createFakeQueue();
			const session = createSession({ cwd: projectRoot, queue });
			const tool = new SkillCreateTool(session);

			await expect(tool.execute("call-1", { name: "taken", description: "x.", body: "" })).rejects.toThrow(
				/already exists/,
			);
			expect(queue.directives).toHaveLength(0);
		});
	});

	it("refuses on unsafe names BEFORE queuing approval", async () => {
		await withTempProject(async projectRoot => {
			const queue = createFakeQueue();
			const session = createSession({ cwd: projectRoot, queue });
			const tool = new SkillCreateTool(session);

			await expect(tool.execute("call-1", { name: "../escape", description: "x.", body: "" })).rejects.toThrow();
			expect(queue.directives).toHaveLength(0);
		});
	});

	it('refuses when buildToolChoice returns a non-object value (e.g. "required")', async () => {
		// Some providers return the string "required" from buildToolChoice
		// instead of a structured tool-choice object. In that case
		// queueResolveHandler no-ops, so skill_create must hard-fail rather
		// than emit "pending user approval" for a directive that was never
		// queued.
		await withTempProject(async projectRoot => {
			const queue = createFakeQueue();
			const settings = Settings.isolated({
				"skills.enabled": true,
				"skills.enableCodexUser": false,
				"skills.enableClaudeUser": false,
				"skills.enableClaudeProject": false,
				"skills.enablePiUser": false,
				"skills.enablePiProject": true,
			});
			const session: ToolSession = {
				cwd: projectRoot,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings,
				getToolChoiceQueue: () => queue as unknown as ReturnType<NonNullable<ToolSession["getToolChoiceQueue"]>>,
				buildToolChoice: () => "required" as unknown as ReturnType<NonNullable<ToolSession["buildToolChoice"]>>,
				steer: () => {},
			};
			const tool = new SkillCreateTool(session);

			await expect(tool.execute("call-1", { name: "needs-approval", description: "x.", body: "" })).rejects.toThrow(
				/user approval/,
			);
			expect(queue.directives).toHaveLength(0);
			expect(await exists(path.join(projectRoot, ".omp", "skills", "needs-approval"))).toBe(false);
		});
	});
});

describe("SkillReloadTool", () => {
	it("publishes a fresh skill into the active snapshot and resolves via skill://", async () => {
		await withTempProject(async projectRoot => {
			const session = createSession({ cwd: projectRoot });
			await createSkillPackage(projectRoot, {
				name: "hotloaded",
				description: "Reachable after reload.",
				body: "# Hotloaded\n\nThe body.",
			});

			const tool = new SkillReloadTool(session);
			const result = await tool.execute("call-r", {});
			const text = getText(result);
			expect(text).toMatch(/hotloaded/);
			expect(text).toMatch(/added/);

			const active = getActiveSkills();
			expect(active.some(s => s.name === "hotloaded")).toBe(true);

			// skill://hotloaded resolves via the protocol handler using the
			// process-global active-skill snapshot we just published.
			const handler = new SkillProtocolHandler();
			const resource = await handler.resolve(parseInternalUrl("skill://hotloaded"));
			expect(resource.content).toContain("# Hotloaded");
			expect(resource.content).toContain("The body.");
		});
	});

	it("is idempotent: two consecutive reloads with no FS change produce an empty diff", async () => {
		await withTempProject(async projectRoot => {
			const session = createSession({ cwd: projectRoot });
			await createSkillPackage(projectRoot, {
				name: "stable-skill",
				description: "x.",
				body: "",
			});
			const tool = new SkillReloadTool(session);
			await tool.execute("call-r1", {});
			const second = await tool.execute("call-r2", {});
			const text = getText(second);
			expect(text).toContain("added: (none)");
			expect(text).toContain("removed: (none)");
			expect(text).toContain("changed: (none)");
		});
	});
});
