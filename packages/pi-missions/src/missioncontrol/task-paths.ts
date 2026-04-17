/**
 * Canonical task-path resolution — translates a task folder path into
 * its worktree-relative equivalent for `.DONE`/`STATUS.md` detection.
 *
 * Ported (minimal) from `taskplane/execution.ts:resolveCanonicalTaskPaths`.
 * Workspace-mode cross-repo fallback + archive lookup are deferred until
 * the full `execution.ts` port lands; abort + resume only need the
 * repo-mode translation path today.
 */

import { basename, join, resolve } from "node:path";

export interface ResolvedTaskPaths {
	taskFolderResolved: string;
	donePath: string;
	statusPath: string;
}

/**
 * Resolve a task folder inside a lane worktree.
 *
 * - Repo mode: if `taskFolder` is inside `repoRoot`, rewrite to the
 *   equivalent path under `worktreePath`.
 * - Workspace mode (cross-repo): fall back to
 *   `worktreePath/.mission-tasks/<basename>/` (rename of legacy
 *   `.taskplane-tasks/` used by taskplane).
 * - Otherwise: return the task folder absolute path unchanged.
 */
export function resolveCanonicalTaskPaths(
	taskFolder: string,
	worktreePath: string,
	repoRoot: string,
	isWorkspaceMode?: boolean,
): ResolvedTaskPaths {
	const repoRootNorm = resolve(repoRoot).replace(/\\/g, "/");
	const folderNorm = resolve(taskFolder).replace(/\\/g, "/");

	let resolvedFolder: string;

	if (isWorkspaceMode) {
		if (folderNorm.startsWith(`${repoRootNorm}/`)) {
			const relPath = folderNorm.slice(repoRootNorm.length + 1);
			resolvedFolder = join(worktreePath, relPath);
		} else {
			const taskDirName = basename(resolve(taskFolder));
			resolvedFolder = join(worktreePath, ".mission-tasks", taskDirName);
		}
	} else if (folderNorm.startsWith(`${repoRootNorm}/`)) {
		const relativePath = folderNorm.slice(repoRootNorm.length + 1);
		resolvedFolder = join(worktreePath, relativePath);
	} else {
		resolvedFolder = resolve(taskFolder);
	}

	return {
		taskFolderResolved: resolvedFolder,
		donePath: join(resolvedFolder, ".DONE"),
		statusPath: join(resolvedFolder, "STATUS.md"),
	};
}
