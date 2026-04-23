import { Moon, RefreshCw, Sun } from "lucide-react";
import type { ConnectionState } from "../hooks/useConnectionStatus";
import type { MissionDetail, MissionSummary } from "../types";
import { ActiveMissionPill } from "./ActiveMissionPill";
import { ConnectionDot } from "./ConnectionDot";
import { MissionSwitcher } from "./MissionSwitcher";

export function Header({
	onRefresh,
	refreshing,
	theme,
	onToggleTheme,
	connection,
	activeMission,
	allMissions,
	selectedId,
	onPickMission,
	onJumpToActive,
}: {
	onRefresh: () => void;
	refreshing: boolean;
	theme: "light" | "dark";
	onToggleTheme: () => void;
	connection: ConnectionState;
	activeMission: MissionDetail | null;
	allMissions: MissionSummary[];
	selectedId: string | null;
	onPickMission: (id: string) => void;
	onJumpToActive: () => void;
}) {
	return (
		<header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 mb-8 border-b border-[var(--border-subtle)]">
			<div className="flex items-center gap-3">
				<div className="pi-logo" aria-hidden="true">
					<svg viewBox="0 0 36 36" width="36" height="36" role="img">
						<title>pi-missions</title>
						<rect x="0.5" y="0.5" width="35" height="35" rx="8" fill="none" stroke="var(--border-default)" />
						{/* π glyph: top crossbar + two descending strokes */}
						<path
							d="M9 14 H27 M14 14 V26 M22 14 V26"
							stroke="var(--text-primary)"
							strokeWidth="1.8"
							strokeLinecap="round"
							fill="none"
						/>
						{/* cyan accent under the glyph */}
						<line
							x1="10"
							y1="29"
							x2="26"
							y2="29"
							stroke="var(--accent-cyan)"
							strokeWidth="1.8"
							strokeLinecap="round"
						/>
					</svg>
				</div>
				<div>
					<h1 className="text-xl font-semibold text-[var(--text-primary)] tracking-tight">MissionControl</h1>
					<p className="text-sm text-[var(--text-muted)]">Orchestrated multi-agent missions</p>
				</div>
			</div>
			<div className="flex items-center gap-3 flex-wrap">
				<ConnectionDot state={connection} />
				<ActiveMissionPill detail={activeMission} onClick={onJumpToActive} />
				<MissionSwitcher missions={allMissions} selectedId={selectedId} onPick={onPickMission} />
				<button
					type="button"
					className="btn"
					onClick={onToggleTheme}
					aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
					title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
				>
					{theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
				</button>
				<button
					type="button"
					className="btn btn-accent"
					onClick={onRefresh}
					disabled={refreshing}
					aria-label="Refresh missions"
				>
					<RefreshCw size={14} className={refreshing ? "spin" : ""} />
					<span className="hidden sm:inline">Refresh</span>
				</button>
			</div>
		</header>
	);
}
