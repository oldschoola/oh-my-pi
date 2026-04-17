/**
 * Detach helper for batch engine startup.
 *
 * Ported from taskplane `extension.ts` `startBatchAsync` (lines 925-961).
 * Wraps an async engine function so the caller (typically a slash-command
 * handler) returns immediately — the engine's synchronous planning/discovery
 * phase would otherwise block the command until its first await.
 *
 * Idempotent terminal path: `onTerminal` fires exactly once, on either the
 * success or rejection branch. On rejection, the batch is marked `failed`
 * unless it already reached a terminal phase (`completed` / `failed`).
 */

import type { MissionBatchRuntimeState } from "./types";

export type NotifyLevel = "info" | "warning" | "error";

export type Notify = (message: string, level: NotifyLevel) => void;

export interface DetachEngineRunDeps {
	engineFn: () => Promise<void>;
	batchState: MissionBatchRuntimeState;
	notify: Notify;
	updateWidget: () => void;
	onTerminal?: () => void;
}

/**
 * Detach `engineFn` execution to the next tick and route success / rejection
 * through `updateWidget` + `onTerminal`. Mirrors taskplane semantics:
 * - success: `updateWidget()` → `onTerminal()`
 * - rejection: mark batch failed (if not already terminal) → `notify` →
 *   `updateWidget()` → `onTerminal()`
 */
export function detachEngineRun(deps: DetachEngineRunDeps): void {
	const { engineFn, batchState, notify, updateWidget, onTerminal } = deps;

	setTimeout(() => {
		engineFn()
			.then(() => {
				updateWidget();
				onTerminal?.();
			})
			.catch((err: unknown) => {
				const errMsg = err instanceof Error ? err.message : String(err);
				if (batchState.phase !== "completed" && batchState.phase !== "failed") {
					batchState.phase = "failed";
					batchState.endedAt = Date.now();
					batchState.errors.push(`Unhandled engine error: ${errMsg}`);
				}
				notify(
					`❌ Engine crashed with unhandled error: ${errMsg}\n   Batch ${batchState.batchId} marked as failed.`,
					"error",
				);
				updateWidget();
				onTerminal?.();
			});
	}, 0);
}
