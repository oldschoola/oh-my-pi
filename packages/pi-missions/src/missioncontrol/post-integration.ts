/**
 * Post-integration cleanup helpers.
 *
 * Ported from `taskplane/extensions/taskplane/extension.ts:381-671`:
 *  - `selectBatchAutostashIndices` / `dropBatchAutostash` (lines 626-671)
 *  - `withPreservedMissionHistory`  (formerly `withPreservedBatchHistory`,
 *    lines 381-409)
 *
 * The pure index-selection logic is split out of `dropBatchAutostash`
 * so it can be unit-tested without shelling out to `git`.
 *
 * Autostash messages targeted:
 *   - `orch-integrate-autostash-{batchId}`        (set by `/mission-integrate`)
 *   - `merge-agent-autostash-w{N}-{batchId}`      (set by merge.ts wave ff)
 *
 * Git prefixes stash subjects with `On <branch>: ` so both matchers work
 * against the full subject line rather than an exact equality check.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { missionHistoryPath } from "./adapter";
import { runGit } from "./git";
import { escapeRegex } from "./worktree";

/**
 * Given the raw stdout of `git stash list --format='%gd %s'` and a batch
 * ID, return the stash indices (the N in `stash@{N}`) that correspond to
 * batch-scoped autostashes. Indices are returned in **descending** order
 * so the caller can drop them without invalidating remaining indices.
 *
 * Pure — no I/O.
 */
export function selectBatchAutostashIndices(stashListOutput: string, batchId: string): number[] {
	if (!batchId) return [];
	const trimmed = stashListOutput.trim();
	if (!trimmed) return [];

	const integrateSubstring = `orch-integrate-autostash-${batchId}`;
	const mergePattern = new RegExp(`merge-agent-autostash-w\\d+-${escapeRegex(batchId)}`);

	const indices: number[] = [];
	for (const line of trimmed.split("\n")) {
		const match = line.match(/^stash@\{(\d+)\}\s+(.*)$/);
		if (!match) continue;
		const idx = Number.parseInt(match[1] ?? "", 10);
		if (Number.isNaN(idx)) continue;
		const subject = match[2] ?? "";
		if (subject.includes(integrateSubstring) || mergePattern.test(subject)) {
			indices.push(idx);
		}
	}

	indices.sort((a, b) => b - a);
	return indices;
}

/**
 * Drop batch-scoped autostash entries from a repo.
 *
 * Scans `git stash list` for stashes matching this batch's integrate or
 * merge-wave autostash patterns and drops them bottom-up. Non-matching
 * stashes are never touched.
 *
 * Silently returns when the stash list is empty or unreadable — this is
 * a best-effort cleanup step and a failure here should not abort the
 * surrounding integration flow.
 */
export function dropBatchAutostash(repoRoot: string, batchId: string): void {
	if (!batchId) return;

	const stashList = runGit(["stash", "list", "--format=%gd %s"], repoRoot);
	if (!stashList.ok || !stashList.stdout.trim()) return;

	const indices = selectBatchAutostashIndices(stashList.stdout, batchId);
	for (const idx of indices) {
		runGit(["stash", "drop", `stash@{${idx}}`], repoRoot);
	}
}

// ── Mission history preservation ─────────────────────────────────────

/** Snapshot of `.omp/mission-history.json` captured before an integration. */
interface MissionHistorySnapshot {
	filePath: string;
	raw: string;
}

/**
 * Run `operation` with the rolling mission history snapshotted and
 * restored atomically on exit.
 *
 * Runtime history is sidecar state, not source-controlled content. A git
 * merge or checkout performed by the integration can replace the live
 * `.omp/mission-history.json` with a stale branch snapshot; this wrapper
 * snapshots the file before the operation and rewrites it afterwards
 * (tmp + rename so readers never see a partial write).
 *
 * Best effort in every direction: a read failure skips capture, a write
 * failure silently drops the restore. Integration completion must never
 * depend on history-file durability.
 *
 * @param stateRoot - Project root (typically `pi.cwd`)
 * @param operation - Sync operation whose return value is passed through
 * @returns The operation's return value
 */
export function withPreservedMissionHistory<T>(stateRoot: string, operation: () => T): T {
	const filePath = missionHistoryPath(stateRoot);
	let snapshot: MissionHistorySnapshot | null = null;
	try {
		if (existsSync(filePath)) {
			snapshot = { filePath, raw: readFileSync(filePath, "utf-8") };
		}
	} catch {
		// Best-effort capture — integration must never fail on snapshot read.
	}

	try {
		return operation();
	} finally {
		if (snapshot) {
			try {
				const dir = dirname(snapshot.filePath);
				if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
				const tmpPath = `${snapshot.filePath}.tmp`;
				writeFileSync(tmpPath, snapshot.raw);
				renameSync(tmpPath, snapshot.filePath);
			} catch {
				// Best-effort restore — never block integration completion.
			}
		}
	}
}
