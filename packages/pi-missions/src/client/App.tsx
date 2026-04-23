import { Archive, ArrowLeft, ChevronRight, Play, Rocket } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getMission, getPreferences, listMissions, postPreferences } from "./api";
import { AgentsPanel } from "./components/AgentsPanel";
import { CommandCenter } from "./components/CommandCenter";
import { Header } from "./components/Header";
import { HistoryPanel } from "./components/HistoryPanel";
import { MailboxPanel } from "./components/MailboxPanel";
import { MissionDetail } from "./components/MissionDetail";
import { MissionList } from "./components/MissionList";
import { MissionStartForm } from "./components/MissionStartForm";
import { SupervisorPanel } from "./components/SupervisorPanel";
import { TerminalViewer } from "./components/TerminalViewer";
import { useConnectionStatus } from "./hooks/useConnectionStatus";
import type { MissionDetail as MissionDetailType, MissionState, MissionSummary } from "./types";

type Tab = "start" | "active" | "history";
type Theme = "light" | "dark";

const THEME_KEY = "missioncontrol-theme";

function readInitialTheme(): Theme {
	if (typeof window === "undefined") return "dark";
	const stored = localStorage.getItem(THEME_KEY);
	if (stored === "light" || stored === "dark") return stored;
	return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: Theme) {
	if (typeof document === "undefined") return;
	document.documentElement.setAttribute("data-theme", theme);
	localStorage.setItem(THEME_KEY, theme);
}

function readGuiToken(): string | null {
	if (typeof window === "undefined") return null;
	const params = new URLSearchParams(window.location.search);
	return params.get("gui");
}

function readViewParam(): Tab | null {
	if (typeof window === "undefined") return null;
	const params = new URLSearchParams(window.location.search);
	const v = params.get("view");
	if (v === "start" || v === "active" || v === "history") return v;
	return null;
}

export default function App() {
	const guiToken = useMemo(readGuiToken, []);
	const initialTab: Tab = guiToken ? "start" : (readViewParam() ?? "active");
	const [theme, setTheme] = useState<Theme>(readInitialTheme);
	const [tab, setTab] = useState<Tab>(initialTab);
	const [missions, setMissions] = useState<MissionSummary[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [selectedDetail, setSelectedDetail] = useState<MissionDetailType | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Lane selected for the inline terminal viewer (e.g. "batchId:lane-1").
	const [viewingLaneId, setViewingLaneId] = useState<string | null>(null);
	// Collapsed state per inspector-rail card, keyed by cardKey. Persisted via
	// dashboard preferences so the rail layout survives a reload.
	const [railCollapsed, setRailCollapsed] = useState<Record<string, boolean>>({});
	// STATUS.md auto-follow state. Defaults to follow=true; overridden by
	// persisted preference on first mount.
	const [followStatusMd, setFollowStatusMd] = useState(true);

	// Apply theme on mount and when it changes; sync to server preferences.
	useEffect(() => {
		applyTheme(theme);
		void postPreferences({ theme });
	}, [theme]);

	// Bootstrap preferences from the server once; fall back to localStorage.
	// Note: `lastSelectedMissionId` is intentionally NOT restored — the Active
	// tab uses a page-swap layout that defaults to the list view, so auto-
	// selecting a mission on reload would skip past the list.
	useEffect(() => {
		let cancelled = false;
		void getPreferences().then(prefs => {
			if (cancelled) return;
			if (prefs.theme === "light" || prefs.theme === "dark") setTheme(prefs.theme);
			if (prefs.rightRailCollapsed && typeof prefs.rightRailCollapsed === "object") {
				setRailCollapsed(prefs.rightRailCollapsed);
			}
			if (typeof prefs.followStatusMd === "boolean") setFollowStatusMd(prefs.followStatusMd);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	function toggleTheme() {
		setTheme(prev => (prev === "dark" ? "light" : "dark"));
	}

	function toggleRailCard(cardKey: string) {
		setRailCollapsed(prev => {
			const next = { ...prev, [cardKey]: !prev[cardKey] };
			void postPreferences({ rightRailCollapsed: next });
			return next;
		});
	}

	function toggleFollowStatusMd() {
		setFollowStatusMd(prev => {
			const next = !prev;
			void postPreferences({ followStatusMd: next });
			return next;
		});
	}

	const loadMissions = useCallback(async () => {
		setRefreshing(true);
		try {
			const list = await listMissions();
			setMissions(list);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRefreshing(false);
		}
	}, []);

	useEffect(() => {
		void loadMissions();
		const interval = setInterval(loadMissions, 10000);
		return () => clearInterval(interval);
	}, [loadMissions]);

	useEffect(() => {
		if (selectedId) void postPreferences({ lastSelectedMissionId: selectedId });
	}, [selectedId]);
	useEffect(() => {
		if (!selectedId) {
			setSelectedDetail(null);
			return;
		}
		let cancelled = false;
		void getMission(selectedId)
			.then(d => {
				if (!cancelled) setSelectedDetail(d);
			})
			.catch(err => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [selectedId]);

	const activeMissions = missions.filter(m => m.status === "active" || m.status === "paused");
	const historyMissions = missions.filter(m => m.status === "completed" || m.status === "failed");
	const activeBatchId = selectedDetail?.state?.batch?.batchId;
	const simpleMissionLog =
		!activeBatchId && selectedDetail?.state ? formatSimpleMissionLog(selectedDetail.state) : undefined;

	const connection = useConnectionStatus(
		selectedDetail && selectedDetail.status !== "completed" && selectedDetail.status !== "failed"
			? selectedDetail.id
			: null,
	);

	function handleHistorySelect(id: string) {
		setSelectedId(id);
		setTab("active");
	}

	// Swap the Active tab into detail view for the clicked mission.
	function handleOpenMission(id: string) {
		setSelectedId(id);
		setViewingLaneId(null);
	}

	// Return to the Active tab list view. Clears the selected mission so the
	// list renders and the next load will not auto-open anything.
	function handleCloseDetail() {
		setSelectedId(null);
		setSelectedDetail(null);
		setViewingLaneId(null);
	}

	function handleViewLane(laneId: string) {
		setViewingLaneId(laneId);
	}

	function handleCloseTerminal() {
		setViewingLaneId(null);
	}

	return (
		<div className="min-h-screen flex flex-col">
			<div className="flex-1">
				<div className="max-w-[1600px] mx-auto px-6 py-6">
					<Header
						onRefresh={() => void loadMissions()}
						refreshing={refreshing}
						theme={theme}
						onToggleTheme={toggleTheme}
						connection={connection}
						activeMission={selectedDetail}
						allMissions={missions}
						selectedId={selectedId}
						onPickMission={handleHistorySelect}
						onJumpToActive={() => setTab("active")}
					/>

					{/* Pill-container tab strip */}
					<div className="tab-pill-container mb-8">
						<TabPill current={tab} target="start" onClick={setTab} icon={<Rocket size={14} />} label="Start" />
						<TabPill
							current={tab}
							target="active"
							onClick={setTab}
							icon={<Play size={14} />}
							label="Active"
							badge={activeMissions.length > 0 ? activeMissions.length : undefined}
						/>
						<TabPill
							current={tab}
							target="history"
							onClick={setTab}
							icon={<Archive size={14} />}
							label="History"
							badge={historyMissions.length > 0 ? historyMissions.length : undefined}
						/>
					</div>

					{error && (
						<div className="surface p-4 mb-4 text-sm text-[var(--accent-red)] border-[var(--accent-red)]">
							{error}
						</div>
					)}

					{tab === "start" && (
						<div className="grid gap-6">
							<MissionStartForm token={guiToken ?? undefined} onDispatched={() => setTab("active")} />
						</div>
					)}

					{tab === "active" && !selectedId && activeMissions.length === 0 && (
						<CommandCenter
							recentMissions={historyMissions}
							onStartClick={() => setTab("start")}
							onPickRecent={handleHistorySelect}
						/>
					)}

					{tab === "active" && !selectedId && activeMissions.length > 0 && (
						<div className="grid gap-4 content-start max-w-3xl mx-auto" data-testid="active-list-view">
							<MissionList missions={activeMissions} selectedId={null} onSelect={handleOpenMission} />
						</div>
					)}

					{tab === "active" && selectedId && (
						<div className="grid gap-4" data-testid="active-detail-view">
							<div className="flex items-center justify-between">
								<button
									type="button"
									className="tab-pill"
									onClick={handleCloseDetail}
									data-testid="back-to-missions"
								>
									<ArrowLeft size={14} />
									Back to missions
								</button>
							</div>
							<div className="grid lg:grid-cols-[1fr_360px] gap-6">
								{/* Detail */}
								<div className="grid gap-4 content-start min-w-0">
									{selectedDetail ? (
										<MissionDetail
											initialDetail={selectedDetail}
											onViewLane={handleViewLane}
											terminalSlot={
												<TerminalViewer
													missionId={selectedId ?? undefined}
													laneId={viewingLaneId ?? (activeBatchId ? `${activeBatchId}:lane-1` : undefined)}
													taskId={selectedDetail.state.batch?.tasks?.[0]?.taskId}
													currentTask={selectedDetail.state.batch?.tasks?.[0]}
													missionLog={simpleMissionLog}
													follow={followStatusMd}
													onToggleFollow={toggleFollowStatusMd}
													onClose={viewingLaneId ? handleCloseTerminal : undefined}
													lanes={selectedDetail.state.batch?.laneStatuses ?? []}
													batchId={activeBatchId}
													onPickLane={setViewingLaneId}
												/>
											}
										/>
									) : (
										<div className="surface p-8 text-center text-[var(--text-muted)] text-sm">
											Loading mission…
										</div>
									)}
								</div>

								{/* Right: inspector rail (Supervisor / Mailbox / Agents) */}
								<div className="grid gap-4 content-start">
									<InspectorCard
										title="Supervisor"
										collapsed={!!railCollapsed.supervisor}
										onToggle={() => toggleRailCard("supervisor")}
									>
										<SupervisorPanel batchId={activeBatchId} missionId={selectedId ?? undefined} />
									</InspectorCard>
									<InspectorCard
										title="Mailbox"
										collapsed={!!railCollapsed.mailbox}
										onToggle={() => toggleRailCard("mailbox")}
									>
										<MailboxPanel batchId={activeBatchId} missionId={selectedId ?? undefined} />
									</InspectorCard>
									<InspectorCard
										title="Agents"
										collapsed={!!railCollapsed.agents}
										onToggle={() => toggleRailCard("agents")}
									>
										<AgentsPanel batchId={activeBatchId} missionId={selectedId ?? undefined} />
									</InspectorCard>
								</div>
							</div>
						</div>
					)}

					{tab === "history" && (
						<div className="grid gap-4">
							<HistoryPanel missions={historyMissions} onSelect={handleHistorySelect} />
						</div>
					)}
				</div>
			</div>

			{/* Footer */}
			<footer className="border-t border-[var(--border-subtle)] mt-auto">
				<div className="max-w-[1600px] mx-auto px-6 py-3 flex items-center justify-between text-xs text-[var(--text-muted)]">
					<span>MissionControl Dashboard</span>
					<span>Auto-refresh every 10s</span>
				</div>
			</footer>
		</div>
	);
}

function InspectorCard({
	title,
	collapsed,
	onToggle,
	children,
}: {
	title: string;
	collapsed: boolean;
	onToggle: () => void;
	children: React.ReactNode;
}) {
	return (
		<div className="surface p-4">
			<button type="button" className="collapsible-header" onClick={onToggle} aria-expanded={!collapsed}>
				<h3 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">{title}</h3>
				<ChevronRight size={14} className={`collapsible-chevron ml-auto ${collapsed ? "" : "open"}`} />
			</button>
			{!collapsed && <div className="mt-3">{children}</div>}
		</div>
	);
}

function TabPill({
	current,
	target,
	onClick,
	icon,
	label,
	badge,
}: {
	current: Tab;
	target: Tab;
	onClick: (t: Tab) => void;
	icon: React.ReactNode;
	label: string;
	badge?: number;
}) {
	const active = current === target;
	return (
		<button
			type="button"
			className={`tab-pill ${active ? "active" : ""}`}
			onClick={() => onClick(target)}
			aria-pressed={active}
		>
			{icon}
			{label}
			{badge !== undefined && (
				<span
					className="inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold rounded-full ml-0.5"
					style={{
						background: active ? "color-mix(in srgb, var(--accent-blue) 20%, transparent)" : "var(--bg-elevated)",
						color: active ? "var(--accent-blue)" : "var(--text-muted)",
					}}
				>
					{badge}
				</span>
			)}
		</button>
	);
}

/** Format simple-mission state as a plain-text activity log for the Terminal panel. */
function formatSimpleMissionLog(state: MissionState): string {
	const lines: string[] = [];
	lines.push(`Mission: ${state.description}`);
	lines.push(`Started: ${state.startedAt}`);
	if (state.completedAt) lines.push(`Completed: ${state.completedAt}`);
	lines.push("");
	if (state.phases && state.phases.length > 0) {
		lines.push("=== Phases ===");
		for (const p of state.phases) {
			const icon = p.status === "done" ? "✓" : p.status === "active" ? "▶" : p.status === "skipped" ? "⊘" : "○";
			let line = `${icon} ${p.emoji ? `${p.emoji} ` : ""}${p.name} [${p.status}]`;
			if (p.startedAt) line += ` started=${p.startedAt}`;
			if (p.completedAt) line += ` done=${p.completedAt}`;
			lines.push(line);
		}
		lines.push("");
	}
	const log = state.progressLog ?? [];
	if (log.length > 0) {
		lines.push("=== Activity ===");
		for (const ev of log) {
			lines.push(`[${ev.timestamp}] ${ev.type}: ${ev.detail}`);
		}
	}
	return lines.join("\n");
}
