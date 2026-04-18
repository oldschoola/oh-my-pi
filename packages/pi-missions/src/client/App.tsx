import { Archive, Play, Rocket } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getMission, listMissions } from "./api";
import { AgentsPanel } from "./components/AgentsPanel";
import { Header } from "./components/Header";
import { HistoryPanel } from "./components/HistoryPanel";
import { MailboxPanel } from "./components/MailboxPanel";
import { MissionDetail } from "./components/MissionDetail";
import { MissionList } from "./components/MissionList";
import { MissionStartForm } from "./components/MissionStartForm";
import { SupervisorPanel } from "./components/SupervisorPanel";
import { TerminalViewer } from "./components/TerminalViewer";
import type { MissionDetail as MissionDetailType, MissionState, MissionSummary } from "./types";

type Tab = "start" | "active" | "history";
type SecondaryTab = "supervisor" | "mailbox" | "terminal";
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

export default function App() {
	const guiToken = useMemo(readGuiToken, []);
	const [theme, setTheme] = useState<Theme>(readInitialTheme);
	const [tab, setTab] = useState<Tab>(guiToken ? "start" : "active");
	const [secondaryTab, setSecondaryTab] = useState<SecondaryTab>("supervisor");
	const [missions, setMissions] = useState<MissionSummary[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [selectedDetail, setSelectedDetail] = useState<MissionDetailType | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Lane selected for conversation viewing (e.g. "batchId:lane-1")
	const [viewingLaneId, setViewingLaneId] = useState<string | null>(null);

	// Apply theme on mount and when it changes
	useEffect(() => {
		applyTheme(theme);
	}, [theme]);

	function toggleTheme() {
		setTheme(prev => (prev === "dark" ? "light" : "dark"));
	}

	const loadMissions = useCallback(async () => {
		setRefreshing(true);
		try {
			const list = await listMissions();
			setMissions(list);
			if (!selectedId && list.length > 0) setSelectedId(list[0].id);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRefreshing(false);
		}
	}, [selectedId]);

	useEffect(() => {
		void loadMissions();
		const interval = setInterval(loadMissions, 10000);
		return () => clearInterval(interval);
	}, [loadMissions]);

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

	// Build a plain-text progress log for simple missions (no batch lanes).
	const simpleMissionLog =
		!activeBatchId && selectedDetail?.state ? formatSimpleMissionLog(selectedDetail.state) : undefined;

	// When History tab selects a mission, switch to Active tab showing that mission
	function handleHistorySelect(id: string) {
		setSelectedId(id);
		setTab("active");
	}

	function handleViewLane(laneId: string) {
		setViewingLaneId(laneId);
		setSecondaryTab("terminal");
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
							{guiToken ? (
								<MissionStartForm token={guiToken} onDispatched={() => setTab("active")} />
							) : (
								<div className="surface p-6 text-sm text-[var(--text-muted)]">
									No GUI token in URL. Run <code>/mission-gui</code> in your omp session to launch this form
									with a fresh token, or use <code>/mission</code> to start interactively.
								</div>
							)}
						</div>
					)}

					{tab === "active" && (
						<div className="grid lg:grid-cols-[380px_1fr] gap-6">
							{/* Left: mission list + agents */}
							<div className="grid gap-4 content-start">
								<MissionList missions={activeMissions} selectedId={selectedId} onSelect={setSelectedId} />
								<AgentsPanel batchId={activeBatchId} missionId={selectedId ?? undefined} />
							</div>

							{/* Right: detail at top, secondary panels via sub-tabs */}
							<div className="grid gap-4 content-start">
								{selectedDetail ? (
									<MissionDetail initialDetail={selectedDetail} onViewLane={handleViewLane} />
								) : (
									<div className="surface p-8 text-center text-[var(--text-muted)] text-sm">
										Select a mission to view details.
									</div>
								)}

								{/* Secondary sub-tab bar */}
								<div className="surface overflow-hidden">
									<div className="subtab-bar">
										<SubTabItem
											current={secondaryTab}
											target="supervisor"
											onClick={setSecondaryTab}
											label="Supervisor"
										/>
										<SubTabItem
											current={secondaryTab}
											target="mailbox"
											onClick={setSecondaryTab}
											label="Mailbox"
										/>
										<SubTabItem
											current={secondaryTab}
											target="terminal"
											onClick={setSecondaryTab}
											label="Terminal"
										/>
									</div>
									<div className="p-4">
										{secondaryTab === "supervisor" && (
											<SupervisorPanel batchId={activeBatchId} missionId={selectedId ?? undefined} />
										)}
										{secondaryTab === "mailbox" && (
											<MailboxPanel batchId={activeBatchId} missionId={selectedId ?? undefined} />
										)}
										{secondaryTab === "terminal" && (
											<TerminalViewer
												laneId={viewingLaneId ?? (activeBatchId ? `${activeBatchId}:lane-1` : undefined)}
												taskId={selectedDetail?.state?.batch?.tasks?.[0]?.taskId}
												missionLog={simpleMissionLog}
											/>
										)}
									</div>
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

function SubTabItem({
	current,
	target,
	onClick,
	label,
}: {
	current: SecondaryTab;
	target: SecondaryTab;
	onClick: (t: SecondaryTab) => void;
	label: string;
}) {
	const active = current === target;
	return (
		<button
			type="button"
			className={`subtab-item ${active ? "active" : ""}`}
			onClick={() => onClick(target)}
			aria-pressed={active}
		>
			{label}
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
