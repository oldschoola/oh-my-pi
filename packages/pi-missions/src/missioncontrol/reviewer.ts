/**
 * Persistent reviewer role extension — ported from taskplane
 * `extensions/reviewer-extension.ts`.
 *
 * Registers the `wait_for_review` tool used by a long-lived reviewer
 * agent to block between review rounds. Poll-driven filesystem signalling:
 *
 *   `<signalDir>/.review-signal-NNN` — request NNN ready
 *   `<signalDir>/<content-of-signal>` — request body
 *   `<signalDir>/.review-shutdown`   — exit cleanly
 *
 * Active only when `REVIEWER_SIGNAL_DIR` env var is set. Otherwise the
 * extension installs nothing, so loading it is safe in non-review flows.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const REVIEWER_POLL_INTERVAL_MS = 3_000;
export const REVIEWER_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
export const REVIEWER_SIGNAL_PREFIX = ".review-signal-";
export const REVIEWER_SHUTDOWN_SIGNAL = ".review-shutdown";

export function reviewerExtension(pi: ExtensionAPI): void {
	const signalDir = process.env.REVIEWER_SIGNAL_DIR;
	if (!signalDir) return;

	let nextSignalNum = 1;

	pi.registerTool({
		name: "wait_for_review",
		label: "Wait for Review",
		description:
			"Block until the next review request is available, then return its content. " +
			"Call this after completing each review to wait for the next one. " +
			"Returns 'SHUTDOWN' when the task is complete and you should exit.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			const startTime = Date.now();
			const signalNum = String(nextSignalNum).padStart(3, "0");
			const signalPath = join(signalDir, `${REVIEWER_SIGNAL_PREFIX}${signalNum}`);
			const shutdownPath = join(signalDir, REVIEWER_SHUTDOWN_SIGNAL);

			while (true) {
				if (signal?.aborted) {
					return {
						content: [{ type: "text" as const, text: "ABORTED — wait_for_review cancelled." }],
					};
				}

				if (existsSync(shutdownPath)) {
					return {
						content: [{ type: "text" as const, text: "SHUTDOWN — The task is complete. Exit cleanly." }],
					};
				}

				if (existsSync(signalPath)) {
					const signalContent = readFileSync(signalPath, "utf-8").trim();
					const requestPath = join(signalDir, signalContent);

					if (!existsSync(requestPath)) {
						return {
							content: [
								{
									type: "text" as const,
									text: `ERROR — Signal file ${REVIEWER_SIGNAL_PREFIX}${signalNum} found but ${signalContent} does not exist.`,
								},
							],
						};
					}

					const requestContent = readFileSync(requestPath, "utf-8");
					nextSignalNum++;
					return {
						content: [{ type: "text" as const, text: requestContent }],
					};
				}

				if (Date.now() - startTime > REVIEWER_WAIT_TIMEOUT_MS) {
					return {
						content: [
							{
								type: "text" as const,
								text: "TIMEOUT — No review request received within the timeout period. Exit cleanly.",
							},
						],
					};
				}

				await new Promise(resolve => setTimeout(resolve, REVIEWER_POLL_INTERVAL_MS));
			}
		},
	});
}
