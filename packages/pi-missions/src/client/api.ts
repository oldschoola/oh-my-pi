import type {
	AgentSnapshot,
	BatchHistoryEntry,
	MailboxEvent,
	MissionDetail,
	MissionStartRequest,
	MissionSummary,
	SupervisorEvent,
	TelemetryEvent,
	TelemetrySummary,
} from "./types";

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

// ---------------------------------------------------------------------------
// /mission-gui + taskplane-parity fetchers
// ---------------------------------------------------------------------------

export interface StartMissionResponse {
	ok: boolean;
	dispatchedTo?: "chat";
	reason?: "unknown_token" | "invalid_payload";
}

export async function startMissionFromGui(req: MissionStartRequest): Promise<StartMissionResponse> {
	const res = await fetch(`${API_BASE}/mission/start`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(req),
	});
	const body = (await res.json().catch(() => ({}))) as StartMissionResponse;
	return { ...body, ok: res.ok && body.ok !== false };
}

export async function listHistory(): Promise<BatchHistoryEntry[]> {
	const res = await fetch(`${API_BASE}/history`);
	if (!res.ok) return [];
	const body = (await res.json()) as { entries?: BatchHistoryEntry[] };
	return body.entries ?? [];
}

export async function getHistoryEntry(id: string): Promise<BatchHistoryEntry | null> {
	const res = await fetch(`${API_BASE}/history/${encodeURIComponent(id)}`);
	if (!res.ok) return null;
	return res.json() as Promise<BatchHistoryEntry>;
}

export async function listSupervisorEvents(limit = 200, batchId?: string): Promise<SupervisorEvent[]> {
	const qs = new URLSearchParams({ limit: String(limit) });
	if (batchId) qs.set("batchId", batchId);
	const res = await fetch(`${API_BASE}/supervisor/events?${qs.toString()}`);
	if (!res.ok) return [];
	const body = (await res.json()) as { entries?: SupervisorEvent[] };
	return body.entries ?? [];
}

export async function listMailboxEvents(batchId?: string, limit = 200): Promise<MailboxEvent[]> {
	const qs = new URLSearchParams({ limit: String(limit) });
	if (batchId) qs.set("batchId", batchId);
	const res = await fetch(`${API_BASE}/mailbox/events?${qs.toString()}`);
	if (!res.ok) return [];
	const body = (await res.json()) as { events?: MailboxEvent[] };
	return body.events ?? [];
}

export async function getAgentsSnapshot(batchId?: string): Promise<AgentSnapshot> {
	const qs = new URLSearchParams();
	if (batchId) qs.set("batchId", batchId);
	const res = await fetch(`${API_BASE}/agents?${qs.toString()}`);
	if (!res.ok) return { batchId: null, registry: null };
	return res.json() as Promise<AgentSnapshot>;
}

export async function getLaneConversation(laneId: string): Promise<string | null> {
	const res = await fetch(`${API_BASE}/conversation/${encodeURIComponent(laneId)}`);
	if (!res.ok) return null;
	return res.text();
}

export async function getTaskStatusMd(taskId: string): Promise<string | null> {
	const res = await fetch(`${API_BASE}/status-md/${encodeURIComponent(taskId)}`);
	if (!res.ok) return null;
	return res.text();
}
