import type {
	AgentSnapshot,
	BatchHistoryEntry,
	ClientMilestone,
	KnowledgeResponse,
	MailboxEvent,
	MissionDetail,
	MissionRollup,
	MissionStartRequest,
	MissionSummary,
	PlanManifest,
	RoleModelsResponse,
	SkillsResponse,
	SupervisorDetail,
	SupervisorEvent,
	TelemetryEvent,
	TelemetrySummary,
	ValidationContract,
	ValidationStatusResult,
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
	kind?: "default" | "explicit";
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

export async function sendSupervisorMessage(
	content: string,
	batchId?: string,
): Promise<{ ok: boolean; reason?: string }> {
	const qs = new URLSearchParams();
	if (batchId) qs.set("batchId", batchId);
	const res = await fetch(`${API_BASE}/supervisor/send${qs.size > 0 ? `?${qs.toString()}` : ""}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ content }),
	});
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
	return { ok: res.ok && body.ok !== false, reason: body.reason };
}

export async function getSupervisorDetail(batchId?: string): Promise<SupervisorDetail> {
	const qs = new URLSearchParams();
	if (batchId) qs.set("batchId", batchId);
	const res = await fetch(`${API_BASE}/supervisor/detail?${qs.toString()}`);
	if (!res.ok) {
		return {
			status: { state: "inactive", lock: null, heartbeatAgeMs: null },
			conversation: [],
			timeline: [],
			summary: null,
		};
	}
	return res.json() as Promise<SupervisorDetail>;
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

export async function getLaneConversationEvents(laneId: string): Promise<TelemetryEvent[]> {
	const res = await fetch(`${API_BASE}/conversation/${encodeURIComponent(laneId)}/events`);
	if (!res.ok) return [];
	const body = (await res.json()) as { events?: TelemetryEvent[] };
	return body.events ?? [];
}

export async function getTaskStatusMd(taskId: string): Promise<string | null> {
	const res = await fetch(`${API_BASE}/status-md/${encodeURIComponent(taskId)}`);
	if (!res.ok) return null;
	return res.text();
}

export interface MissionActivityEntry {
	ts: string;
	action: string;
	classification?: string;
	detail: string;
}

export async function getMissionActivity(id: string): Promise<MissionActivityEntry[]> {
	const res = await fetch(`${API_BASE}/mission/${encodeURIComponent(id)}/activity`);
	if (!res.ok) return [];
	const body = (await res.json()) as { entries?: MissionActivityEntry[] };
	return body.entries ?? [];
}

export interface MissionAgentStatusEntry {
	agentId: string;
	role: string;
	status: string;
	pid?: number;
	laneNumber?: number | null;
	taskId?: string | null;
}

export interface MissionAgentStatus {
	batchId: string | null;
	registry: { agents: MissionAgentStatusEntry[] } | null;
}

export async function getMissionAgentStatus(id: string): Promise<MissionAgentStatus> {
	const res = await fetch(`${API_BASE}/mission/${encodeURIComponent(id)}/agent-status`);
	if (!res.ok) return { batchId: null, registry: null };
	return res.json() as Promise<MissionAgentStatus>;
}

export function resolveWorkerAgentId(laneNumber: number, registry: MissionAgentStatus["registry"]): string | null {
	if (!registry) return null;
	for (const a of registry.agents) {
		if (a.role === "worker" && a.laneNumber === laneNumber) return a.agentId;
	}
	return null;
}

export async function getAgentEvents(agentId: string, sinceTs = 0): Promise<TelemetryEvent[]> {
	const qs = sinceTs > 0 ? `?sinceTs=${sinceTs}` : "";
	const res = await fetch(`${API_BASE}/agent-events/${encodeURIComponent(agentId)}${qs}`);
	if (!res.ok) return [];
	const body = (await res.json()) as { events?: TelemetryEvent[] };
	return body.events ?? [];
}

// ---------------------------------------------------------------------------
// Mission control bar + meta editor + preferences (round 4)
// ---------------------------------------------------------------------------

export interface MissionControlResponse {
	ok: boolean;
	reason?: string;
	phase?: string;
	completedPhaseName?: string;
}

export async function pauseMissionById(id: string): Promise<MissionControlResponse> {
	return sendControl(id, "pause");
}

export async function resumeMissionById(id: string): Promise<MissionControlResponse> {
	return sendControl(id, "resume");
}

export async function abortMissionById(id: string, reason?: string): Promise<MissionControlResponse> {
	return sendControl(id, "abort", { reason });
}

async function sendControl(
	id: string,
	action: "pause" | "resume" | "abort",
	body?: Record<string, unknown>,
): Promise<MissionControlResponse> {
	const res = await fetch(`${API_BASE}/mission/${encodeURIComponent(id)}/${action}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	const parsed = (await res.json().catch(() => ({}))) as MissionControlResponse;
	return { ...parsed, ok: res.ok && parsed.ok !== false };
}

export async function redirectMission(id: string, message: string): Promise<MissionControlResponse> {
	const res = await fetch(`${API_BASE}/mission/${encodeURIComponent(id)}/redirect`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ message }),
	});
	const parsed = (await res.json().catch(() => ({}))) as MissionControlResponse;
	return { ...parsed, ok: res.ok && parsed.ok !== false };
}

export async function skipMissionPhase(id: string): Promise<MissionControlResponse> {
	const res = await fetch(`${API_BASE}/mission/${encodeURIComponent(id)}/skip-phase`, { method: "POST" });
	const parsed = (await res.json().catch(() => ({}))) as MissionControlResponse;
	return { ...parsed, ok: res.ok && parsed.ok !== false };
}

export interface MissionMetaPatch {
	autonomy?: "low" | "medium" | "high" | "auto";
	constraints?: string;
}

export async function patchMission(id: string, patch: MissionMetaPatch): Promise<MissionControlResponse> {
	const res = await fetch(`${API_BASE}/mission/${encodeURIComponent(id)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	});
	const parsed = (await res.json().catch(() => ({}))) as MissionControlResponse;
	return { ...parsed, ok: res.ok && parsed.ok !== false };
}

export interface MissionGuiTokenInfo {
	token: string;
	kind: "default" | "explicit";
}

export async function getMissionGuiToken(): Promise<MissionGuiTokenInfo | null> {
	const res = await fetch(`${API_BASE}/mission-gui/token`);
	if (!res.ok) return null;
	return res.json() as Promise<MissionGuiTokenInfo>;
}

export interface DashboardPreferences {
	theme?: "dark" | "light";
	rightRailCollapsed?: Record<string, boolean>;
	lastSelectedMissionId?: string;
	followStatusMd?: boolean;
	[key: string]: unknown;
}

export async function getPreferences(): Promise<DashboardPreferences> {
	const res = await fetch(`${API_BASE}/preferences`);
	if (!res.ok) return {};
	return res.json() as Promise<DashboardPreferences>;
}

export async function postPreferences(patch: Record<string, unknown>): Promise<DashboardPreferences> {
	const res = await fetch(`${API_BASE}/preferences`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) return {};
	const body = (await res.json()) as { preferences?: DashboardPreferences };
	return body.preferences ?? {};
}

// ---------------------------------------------------------------------------
// Factory-alignment endpoints (Track J2–J10)
// ---------------------------------------------------------------------------

function missionPath(id: string, suffix: string): string {
	return `${API_BASE}/mission/${encodeURIComponent(id)}${suffix}`;
}

export async function getValidationContract(id: string): Promise<ValidationContract | null> {
	const res = await fetch(missionPath(id, "/validation-contract"));
	if (!res.ok) return null;
	return (await res.json()) as ValidationContract | null;
}

export async function getMilestones(id: string): Promise<ClientMilestone[]> {
	const res = await fetch(missionPath(id, "/milestones"));
	if (!res.ok) return [];
	const body = (await res.json()) as { milestones?: ClientMilestone[] };
	return body.milestones ?? [];
}

export async function getValidationStatus(id: string, milestoneId?: string): Promise<ValidationStatusResult | null> {
	const suffix = milestoneId
		? `/validation-status?milestoneId=${encodeURIComponent(milestoneId)}`
		: "/validation-status";
	const res = await fetch(missionPath(id, suffix));
	if (!res.ok) return null;
	return (await res.json()) as ValidationStatusResult;
}

export async function getKnowledge(id: string, scope?: string, limit?: number): Promise<KnowledgeResponse | null> {
	const qs = new URLSearchParams();
	if (scope) qs.set("scope", scope);
	if (limit) qs.set("limit", String(limit));
	const suffix = qs.size > 0 ? `/knowledge?${qs.toString()}` : "/knowledge";
	const res = await fetch(missionPath(id, suffix));
	if (!res.ok) return null;
	return (await res.json()) as KnowledgeResponse;
}

export async function getPlanManifest(id: string): Promise<PlanManifest | null> {
	const res = await fetch(missionPath(id, "/plan"));
	if (!res.ok) return null;
	return (await res.json()) as PlanManifest | null;
}

export async function approvePlan(
	id: string,
	body: {
		milestoneIds: string[];
		featureIds: string[];
		approvedBy?: string;
	},
): Promise<{ ok: boolean; manifest?: PlanManifest; reason?: string }> {
	const res = await fetch(missionPath(id, "/plan/approve"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; manifest?: PlanManifest; reason?: string };
}

export async function getTelemetryRollup(id: string): Promise<MissionRollup | null> {
	const res = await fetch(missionPath(id, "/telemetry-rollup"));
	if (!res.ok) return null;
	return (await res.json()) as MissionRollup | null;
}

export async function getRoleModels(id: string): Promise<RoleModelsResponse> {
	const res = await fetch(missionPath(id, "/role-models"));
	if (!res.ok) return { roles: [] };
	return (await res.json()) as RoleModelsResponse;
}

export async function setRoleModel(id: string, role: string, model: string): Promise<{ ok: boolean; reason?: string }> {
	const res = await fetch(missionPath(id, "/role-models"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ role, model }),
	});
	return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; reason?: string };
}

export async function getSkills(id: string): Promise<SkillsResponse> {
	const res = await fetch(missionPath(id, "/skills"));
	if (!res.ok) return { promoted: [], drafts: [] };
	return (await res.json()) as SkillsResponse;
}
