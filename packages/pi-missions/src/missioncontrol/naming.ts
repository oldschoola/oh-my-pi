/**
 * Naming helpers for lane session IDs, worktree dirs, git branches.
 *
 * Ported from taskplane `extensions/taskplane/naming.ts` with the
 * `OrchestratorConfig` dependency collapsed to an optional override
 * string — operator resolution still falls through the same cascade
 * (env → override → OS user → "op").
 */

import { userInfo } from "node:os";
import { basename, resolve } from "node:path";

export function sanitizeNameComponent(raw: string, maxLen: number = 16): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLen);
}

export function resolveOperatorId(override?: string, env: Record<string, string | undefined> = process.env): string {
	const FALLBACK = "op";
	const MAX_LEN = 12;

	const envValue = env.OMP_OPERATOR_ID ?? env.TASKPLANE_OPERATOR_ID;
	if (envValue?.trim()) {
		const sanitized = sanitizeNameComponent(envValue.trim(), MAX_LEN);
		if (sanitized) return sanitized;
	}

	if (override?.trim()) {
		const sanitized = sanitizeNameComponent(override.trim(), MAX_LEN);
		if (sanitized) return sanitized;
	}

	try {
		const username = userInfo().username;
		if (username?.trim()) {
			const sanitized = sanitizeNameComponent(username.trim(), MAX_LEN);
			if (sanitized) return sanitized;
		}
	} catch {
		// userInfo() can throw on some platforms — fall through.
	}

	return FALLBACK;
}

export function resolveRepoSlug(repoRoot: string): string {
	const FALLBACK = "repo";
	const MAX_LEN = 16;

	const dirName = basename(resolve(repoRoot));
	if (!dirName) return FALLBACK;

	return sanitizeNameComponent(dirName, MAX_LEN) || FALLBACK;
}

export function buildLaneSessionId(opts: {
	operatorId: string;
	repoSlug: string;
	batchId: string;
	lane: number;
}): string {
	return `${opts.operatorId}-${opts.repoSlug}-${opts.batchId}-l${opts.lane}`;
}

export function buildBranchName(opts: { operatorId: string; batchId: string; taskId: string }): string {
	const task = sanitizeNameComponent(opts.taskId, 24);
	return `mission/${opts.operatorId}/${opts.batchId}/${task}`;
}
