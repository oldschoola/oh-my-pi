/**
 * Git command runner — synchronous wrappers around `execFileSync`.
 *
 * Ported from taskplane `extensions/taskplane/git.ts`. Pure Node child_process
 * (works under Bun). No oh-my-pi specifics.
 */

import { execFileSync } from "node:child_process";

export interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export function runGit(args: string[], cwd?: string): GitResult {
	try {
		const stdout = execFileSync("git", args, {
			encoding: "utf-8",
			timeout: 30_000,
			cwd: cwd || process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		return { ok: true, stdout, stderr: "" };
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		return {
			ok: false,
			stdout: (e.stdout ?? "").toString().trim(),
			stderr: (e.stderr ?? e.message ?? "unknown error").toString().trim(),
		};
	}
}

export function runGitWithEnv(args: string[], cwd: string, env: Record<string, string>): GitResult {
	try {
		const stdout = execFileSync("git", args, {
			encoding: "utf-8",
			timeout: 30_000,
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...env },
		}).trim();
		return { ok: true, stdout, stderr: "" };
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		return {
			ok: false,
			stdout: (e.stdout ?? "").toString().trim(),
			stderr: (e.stderr ?? e.message ?? "unknown error").toString().trim(),
		};
	}
}

export function getCurrentBranch(cwd?: string): string | null {
	const result = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	if (!result.ok || !result.stdout.trim() || result.stdout.trim() === "HEAD") {
		return null;
	}
	return result.stdout.trim();
}
