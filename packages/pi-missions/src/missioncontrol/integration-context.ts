/**
 * Pure resolver for `/mission-integrate` context.
 *
 * Ported from `taskplane/extensions/taskplane/extension.ts:212-339`. All
 * git + FS reads are injected via `IntegrationDeps` so the resolver itself
 * is side-effect-free and unit-testable.
 *
 * Resolution order:
 *   1. Try loading persisted batch state → extract `orchBranch` / `baseBranch` / `batchId`.
 *   2. If state unavailable, use the CLI positional arg.
 *   3. If neither, scan local `orch/*` branches.
 *
 * In addition, enforces:
 *   - phase gate: batch must be `completed` before integration.
 *   - legacy merge-mode detection (`orchBranch` empty on a completed batch).
 *   - branch existence check.
 *   - detached-HEAD rejection.
 *   - branch-safety match between current branch and inferred `baseBranch`
 *     (bypassable with `--force`).
 *
 * Slash-command strings are renamed from `/orch-*` to `/mission-*` to match
 * the MissionControl command surface.
 */

import type { IntegrateArgs } from "./extension-args";
import type { IntegrationContext, IntegrationContextError, IntegrationDeps } from "./types";
import { StateFileError } from "./types";

export function resolveIntegrationContext(
	parsed: IntegrateArgs,
	deps: IntegrationDeps,
): IntegrationContext | IntegrationContextError {
	let orchBranch = "";
	let baseBranch = "";
	let batchId = "";
	const notices: string[] = [];

	// Source 1: persisted batch state
	try {
		const state = deps.loadBatchState();
		if (state) {
			orchBranch = state.orchBranch ?? "";
			baseBranch = state.baseBranch ?? "";
			batchId = state.batchId;

			if (state.phase !== "completed") {
				return {
					error:
						`⏳ Batch ${batchId} is currently in "${state.phase}" phase.\n` +
						`Integration requires a completed batch.\n` +
						`Run /mission-status to check progress, or wait for the batch to finish.`,
					severity: "info",
				};
			}

			if (!orchBranch) {
				return {
					error:
						`ℹ️ Batch ${batchId} used legacy merge mode — work was already merged directly into ${baseBranch || "the base branch"}.\n` +
						`There is no separate mission branch to integrate.`,
					severity: "info",
				};
			}
		}
	} catch (err: unknown) {
		const msg =
			err instanceof StateFileError
				? err.code === "STATE_FILE_IO_ERROR"
					? `Could not read batch state file: ${err.message}`
					: err.code === "STATE_FILE_PARSE_ERROR"
						? `Batch state file contains invalid JSON: ${err.message}`
						: `Batch state file has invalid schema: ${err.message}`
				: `Unexpected error loading batch state: ${(err as Error).message}`;
		if (!parsed.orchBranchArg) {
			return {
				error: `⚠️ ${msg}\nYou can specify the mission branch directly: /mission-integrate <mission-branch>`,
				severity: "error",
			};
		}
		notices.push(`⚠️ ${msg} — using provided branch arg instead.`);
	}

	// Source 2: CLI positional override
	if (parsed.orchBranchArg) {
		orchBranch = parsed.orchBranchArg;
	}

	// Source 3: scan fallback
	if (!orchBranch) {
		const candidates = deps.listOrchBranches();
		if (candidates.length === 0) {
			return {
				error:
					"❌ No completed batch found and no mission branches exist.\n" +
					"Run /mission first to create a batch, or specify a branch: /mission-integrate <mission-branch>",
				severity: "error",
			};
		}
		if (candidates.length === 1) {
			orchBranch = candidates[0] ?? "";
			notices.push(`ℹ️ No batch state found. Auto-detected mission branch: ${orchBranch}`);
		} else {
			return {
				error: `❌ No batch state found and multiple mission branches exist:\n${candidates.map(b => `  • ${b}`).join("\n")}\n\nSpecify which branch to integrate: /mission-integrate <mission-branch>`,
				severity: "error",
			};
		}
	}

	if (!deps.orchBranchExists(orchBranch)) {
		return {
			error: `❌ Branch "${orchBranch}" does not exist locally.\nCheck the branch name and try again.`,
			severity: "error",
		};
	}

	const currentBranch = deps.getCurrentBranch();
	if (currentBranch === null) {
		return {
			error:
				"❌ HEAD is detached — cannot integrate.\n" +
				"Check out a branch first (e.g., `git checkout main`), then retry.",
			severity: "error",
		};
	}

	if (!baseBranch) {
		baseBranch = currentBranch;
	}

	if (currentBranch !== baseBranch && !parsed.force) {
		return {
			error:
				`⚠️ Batch was started from ${baseBranch}, but you're on ${currentBranch}.\n` +
				`Switch to ${baseBranch} first, or use /mission-integrate --force to skip this check.`,
			severity: "error",
		};
	}

	return { orchBranch, baseBranch, batchId, currentBranch, notices };
}
