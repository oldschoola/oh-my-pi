/**
 * Sidecar JSONL telemetry writer for missions.
 *
 * Writes redacted events to `.omp/mission-telemetry/{missionId}/{role}.jsonl`.
 * All events pass through `redactEvent()` before disk write.
 */

import { redactEvent } from "./redaction";

export interface SidecarEvent {
	type: string;
	[key: string]: unknown;
}

export async function writeSidecarEvent(sidecarPath: string, event: SidecarEvent): Promise<void> {
	const redacted = redactEvent(event);
	const entry = { ...redacted, ts: Date.now() };
	const line = `${JSON.stringify(entry)}\n`;

	const existing = Bun.file(sidecarPath);
	const prior = (await existing.exists()) ? await existing.text() : "";
	await Bun.write(sidecarPath, prior + line);
}

export async function* readSidecar(sidecarPath: string): AsyncGenerator<Record<string, unknown>> {
	const file = Bun.file(sidecarPath);
	if (!(await file.exists())) return;

	const text = await file.text();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			yield JSON.parse(line) as Record<string, unknown>;
		} catch {
			// Skip malformed lines — telemetry is best-effort.
		}
	}
}
