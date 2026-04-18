/**
 * Structured stderr log helpers for MissionControl engine modules.
 *
 * Ported from the `execLog` helper in taskplane `extensions/taskplane/execution.ts`.
 * All engine diagnostics go to stderr with a `[mission]` prefix and correlation
 * IDs. No PII — only task/lane identifiers and paths.
 */

export function execLog(
	laneId: string,
	taskId: string,
	message: string,
	extra?: Record<string, string | number | boolean>,
): void {
	const prefix = `[mission] ${laneId}/${taskId}`;
	if (extra) {
		const fields = Object.entries(extra)
			.map(([k, v]) => `${k}=${v}`)
			.join(" ");
		console.error(`${prefix}: ${message} (${fields})`);
		return;
	}
	console.error(`${prefix}: ${message}`);
}
