/**
 * Tests for `ensureTaskFilesCommitted` ported from taskplane
 * `extensions/taskplane/execution.ts:1425`.
 *
 * Uses a real ephemeral git repo so the plumbing (`read-tree`, `write-tree`,
 * `commit-tree`, `update-ref`) is exercised end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ParsedTask } from "../src/missioncontrol/discovery";
import { ensureTaskFilesCommitted } from "../src/missioncontrol/execution";

function mkTmp(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function gitRun(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
	const result = Bun.spawnSync({ cmd: ["git", ...args], cwd });
	const decoder = new TextDecoder();
	return { ok: result.exitCode === 0, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}

function gitOrThrow(args: string[], cwd: string): void {
	const r = gitRun(args, cwd);
	if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function initRepo(): string {
	const dir = mkTmp("mc-etfc");
	gitOrThrow(["init", "-q", "-b", "main"], dir);
	gitOrThrow(["config", "user.email", "t@e.invalid"], dir);
	gitOrThrow(["config", "user.name", "t"], dir);
	writeFileSync(join(dir, "README.md"), "x\n");
	gitOrThrow(["add", "."], dir);
	gitOrThrow(["commit", "-q", "-m", "init"], dir);
	return dir;
}

function makeTask(repo: string, taskId: string): ParsedTask {
	const folderPath = join(repo, "tasks", taskId);
	mkdirSync(folderPath, { recursive: true });
	writeFileSync(join(folderPath, "PROMPT.md"), `# ${taskId}\n`);
	writeFileSync(join(folderPath, "STATUS.md"), "not-started\n");
	return {
		taskId,
		taskName: taskId,
		folderPath,
		taskFolder: folderPath,
		promptPath: join(folderPath, "PROMPT.md"),
		prompt: `# ${taskId}\n`,
		dependencies: [],
		size: "M",
	};
}

function headSha(repo: string, ref: string): string {
	return gitRun(["rev-parse", ref], repo).stdout.trim();
}

describe("ensureTaskFilesCommitted", () => {
	let repo: string;

	beforeEach(() => {
		repo = initRepo();
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	test("no-op when no task folders have uncommitted files", () => {
		const task = makeTask(repo, "TP-001");
		gitOrThrow(["add", "."], repo);
		gitOrThrow(["commit", "-q", "-m", "seed"], repo);

		const before = headSha(repo, "HEAD");
		const pending = new Map<string, ParsedTask>([[task.taskId, task]]);
		ensureTaskFilesCommitted([task.taskId], pending, repo, 1);
		expect(headSha(repo, "HEAD")).toBe(before);
	});

	test("commits via orch-branch plumbing when orchBranch provided", () => {
		const task = makeTask(repo, "TP-001");
		gitOrThrow(["branch", "mission/b-1", "main"], repo);

		const baseSha = headSha(repo, "refs/heads/mission/b-1");
		const pending = new Map<string, ParsedTask>([[task.taskId, task]]);
		ensureTaskFilesCommitted([task.taskId], pending, repo, 1, "mission/b-1");

		const newSha = headSha(repo, "refs/heads/mission/b-1");
		expect(newSha).not.toBe(baseSha);

		const log = gitRun(["log", "-1", "--format=%s", "mission/b-1"], repo).stdout.trim();
		expect(log).toContain("stage task files for mission wave 1");
		expect(log).toContain("TP-001");

		// HEAD stays on main
		expect(headSha(repo, "HEAD")).toBe(headSha(repo, "refs/heads/main"));
	});

	test("falls back to HEAD + FF orch branch when plumbing commits succeed but ref advances", () => {
		// Same repo path — but omit orchBranch to force legacy path
		const task = makeTask(repo, "TP-002");
		const pending = new Map<string, ParsedTask>([[task.taskId, task]]);

		const before = headSha(repo, "HEAD");
		ensureTaskFilesCommitted([task.taskId], pending, repo, 2);
		const after = headSha(repo, "HEAD");

		expect(after).not.toBe(before);
		const log = gitRun(["log", "-1", "--format=%s"], repo).stdout.trim();
		expect(log).toContain("TP-002");
	});

	test("skips tasks that are not present in `pending` map", () => {
		makeTask(repo, "TP-003"); // files exist on disk but task isn't in pending
		const before = headSha(repo, "HEAD");
		const pending = new Map<string, ParsedTask>();
		ensureTaskFilesCommitted(["TP-003"], pending, repo, 1);
		expect(headSha(repo, "HEAD")).toBe(before);
	});

	test("skips task folder that escapes the repo (relPath starts with '..')", () => {
		const externalDir = mkTmp("mc-etfc-ext");
		writeFileSync(join(externalDir, "PROMPT.md"), "external\n");
		const task: ParsedTask = {
			taskId: "TP-X",
			taskName: "TP-X",
			folderPath: externalDir,
			taskFolder: externalDir,
			promptPath: join(externalDir, "PROMPT.md"),
			prompt: "external\n",
			dependencies: [],
			size: "M",
		};
		try {
			const before = headSha(repo, "HEAD");
			const pending = new Map<string, ParsedTask>([[task.taskId, task]]);
			ensureTaskFilesCommitted([task.taskId], pending, repo, 1);
			expect(headSha(repo, "HEAD")).toBe(before);
		} finally {
			rmSync(externalDir, { recursive: true, force: true });
		}
	});

	test("commits multiple tasks in one staging commit", () => {
		const t1 = makeTask(repo, "TP-A");
		const t2 = makeTask(repo, "TP-B");
		gitOrThrow(["branch", "mission/b-2", "main"], repo);

		const pending = new Map<string, ParsedTask>([
			[t1.taskId, t1],
			[t2.taskId, t2],
		]);
		ensureTaskFilesCommitted([t1.taskId, t2.taskId], pending, repo, 3, "mission/b-2");

		const log = gitRun(["log", "-1", "--format=%s", "mission/b-2"], repo).stdout.trim();
		expect(log).toContain("TP-A");
		expect(log).toContain("TP-B");
	});
});
