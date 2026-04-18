/**
 * Canonical task-path resolution — translates a task folder path into
 * its worktree-relative equivalent for `.DONE`/`STATUS.md` detection.
 *
 * Ported from `taskplane/execution.ts:resolveCanonicalTaskPaths`.
 * Handles three cases:
 *
 * 1. **Repo mode** (`taskFolder` inside `repoRoot`): rewrite to the
 *    equivalent path under `worktreePath`. Worktrees mirror the repo
 *    structure, so the relative path is the same.
 * 2. **Workspace mode** (cross-repo task folder): fall back to
 *    `worktreePath/.mission-tasks/<basename>/` where the supervisor
 *    copied the task files. (Rename of legacy `.taskplane-tasks/`.)
 * 3. **Absolute fallback**: task folder lives outside the repo and
 *    must be addressed directly.
 *
 * Both branches probe an archive fallback: during "Documentation &
 * Delivery" the worker may move the task folder to
 * `<parent>/archive/<taskDirName>/`. If `.DONE` or `STATUS.md` lives
 * there, return the archive paths instead.
 */

import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface ResolvedTaskPaths {
	/** Absolute path to the resolved task folder (worktree-relative or external). */
	taskFolderResolved: string;
	/** Absolute path to the `.DONE` marker file. */
	donePath: string;
	/** Absolute path to the `STATUS.md` file. */
	statusPath: string;
}

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

	const primaryDone = join(resolvedFolder, ".DONE");
	const primaryStatus = join(resolvedFolder, "STATUS.md");
	if (existsSync(primaryDone) || existsSync(primaryStatus)) {
		return {
			taskFolderResolved: resolvedFolder,
			donePath: primaryDone,
			statusPath: primaryStatus,
		};
	}

	// Archive fallback: worker may have relocated the folder under
	// `<parent>/archive/<taskDirName>/` during delivery.
	const resolvedNorm = resolve(resolvedFolder).replace(/\\/g, "/");
	const parts = resolvedNorm.split("/");
	const taskDirName = parts[parts.length - 1];
	const parentDir = parts.slice(0, -1).join("/");
	const archiveFolder = join(parentDir, "archive", taskDirName);
	const archiveDone = join(archiveFolder, ".DONE");
	const archiveStatus = join(archiveFolder, "STATUS.md");

	if (existsSync(archiveDone) || existsSync(archiveStatus)) {
		return {
			taskFolderResolved: archiveFolder,
			donePath: archiveDone,
			statusPath: archiveStatus,
		};
	}

	return {
		taskFolderResolved: resolvedFolder,
		donePath: primaryDone,
		statusPath: primaryStatus,
	};
}
