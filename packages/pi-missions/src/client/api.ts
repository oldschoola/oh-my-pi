import type { MissionDetail, MissionSummary, TelemetryEvent, TelemetrySummary } from "./types";

const API_BASE = "/api";

export async function listMissions(): Promise<MissionSummary[]> {
	const res = await fetch(`${API_BASE}/missions`);
	if (!res.ok) throw new Error("Failed to list missions");
	return res.json() as Promise<MissionSummary[]>;
}

export async function getMission(id: string): Promise<MissionDetail> {
	const res = await fetch(`${API_BASE}/mission/${encodeURIComponent(id)}`);
	if (!res.ok) throw new Error(`Mission ${id} not found`);
	return res.json() as Promise<MissionDetail>;
}

export async function getMissionEvents(id: string, role = "worker"): Promise<TelemetryEvent[]> {
	const res = await fetch(`${API_BASE}/mission/${encodeURIComponent(id)}/events?role=${role}`);
	if (!res.ok) throw new Error("Failed to fetch events");
	const body = (await res.json()) as { events: TelemetryEvent[] };
	return body.events;
}

export async function getMissionTelemetry(id: string): Promise<TelemetrySummary> {
	const res = await fetch(`${API_BASE}/mission/${encodeURIComponent(id)}/telemetry`);
	if (!res.ok) throw new Error("Failed to fetch telemetry");
	return res.json() as Promise<TelemetrySummary>;
}

export function subscribeMission(
	id: string,
	onSnapshot: (detail: MissionDetail) => void,
	onError?: (err: Event) => void,
): () => void {
	const url = `${API_BASE}/mission/${encodeURIComponent(id)}/stream`;
	const es = new EventSource(url);
	es.addEventListener("message", ev => {
		try {
			const data = JSON.parse(ev.data) as { type?: string; detail?: MissionDetail };
			if (data.type === "snapshot" && data.detail) onSnapshot(data.detail);
		} catch {}
	});
	if (onError) es.addEventListener("error", onError);
	return () => es.close();
}
