import { ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatRelative } from "../format";
import type { MissionSummary } from "../types";
import { StatusBadge } from "./StatusBadge";

const RECENT_CAP = 15;

/**
 * Unified header dropdown for switching between any mission — active,
 * paused, completed, or failed. Replaces the history-only quick switch
 * so the operator has a single jump surface for every mission they know
 * about. Closes on outside click.
 */
export function MissionSwitcher({
	missions,
	selectedId,
	onPick,
}: {
	missions: MissionSummary[];
	selectedId: string | null;
	onPick: (id: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const ref = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) return;
		const onClick = (ev: MouseEvent) => {
			if (!ref.current?.contains(ev.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onClick);
		return () => document.removeEventListener("mousedown", onClick);
	}, [open]);

	useEffect(() => {
		if (open) {
			// Autofocus the filter so operator can type immediately after opening.
			inputRef.current?.focus();
		} else {
			setQuery("");
		}
	}, [open]);

	const { active, recent } = useMemo(() => {
		const q = query.trim().toLowerCase();
		const match = (m: MissionSummary) => {
			if (!q) return true;
			return m.id.toLowerCase().includes(q) || (m.description ?? "").toLowerCase().includes(q);
		};
		const activeList: MissionSummary[] = [];
		const recentList: MissionSummary[] = [];
		for (const m of missions) {
			if (!match(m)) continue;
			if (m.status === "active" || m.status === "paused") activeList.push(m);
			else recentList.push(m);
		}
		return { active: activeList, recent: recentList.slice(0, RECENT_CAP) };
	}, [missions, query]);

	if (missions.length === 0) return null;

	const empty = active.length === 0 && recent.length === 0;

	return (
		<div className="relative" ref={ref}>
			<button
				type="button"
				className="btn"
				onClick={() => setOpen(v => !v)}
				aria-expanded={open}
				aria-haspopup="true"
				title="Switch mission"
			>
				<Search size={12} />
				<span className="hidden md:inline">Switch</span>
				<ChevronDown size={12} />
			</button>
			{open && (
				<div className="history-quick-switch-menu">
					<div className="px-2 pt-1 pb-2">
						<input
							ref={inputRef}
							type="text"
							className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1 text-xs focus:outline-none focus:border-[var(--accent-cyan)] transition-colors"
							placeholder="Search missions…"
							value={query}
							onChange={e => setQuery(e.target.value)}
						/>
					</div>
					{empty ? (
						<div className="text-xs text-[var(--text-muted)] px-3 py-4 text-center">No missions match.</div>
					) : (
						<>
							{active.length > 0 && (
								<MissionGroup
									label="Active"
									missions={active}
									selectedId={selectedId}
									onPick={id => {
										setOpen(false);
										onPick(id);
									}}
								/>
							)}
							{recent.length > 0 && (
								<MissionGroup
									label="Recent"
									missions={recent}
									selectedId={selectedId}
									onPick={id => {
										setOpen(false);
										onPick(id);
									}}
								/>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}

function MissionGroup({
	label,
	missions,
	selectedId,
	onPick,
}: {
	label: string;
	missions: MissionSummary[];
	selectedId: string | null;
	onPick: (id: string) => void;
}) {
	return (
		<div>
			<div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
				{label}
			</div>
			{missions.map(mission => {
				const isSelected = mission.id === selectedId;
				const stamp = mission.completedAt ?? mission.startedAt;
				return (
					<button
						type="button"
						key={mission.id}
						className="history-quick-switch-item"
						style={isSelected ? { background: "var(--bg-active)" } : undefined}
						onClick={() => onPick(mission.id)}
					>
						<div className="flex items-center justify-between gap-2">
							<div className="text-xs font-mono text-[var(--text-muted)] truncate">{mission.id.slice(0, 8)}</div>
							<StatusBadge status={mission.status} />
						</div>
						<div className="text-sm text-[var(--text-primary)] truncate">
							{mission.description || "(no description)"}
						</div>
						<div className="text-[10px] text-[var(--text-muted)]">{formatRelative(stamp)}</div>
					</button>
				);
			})}
		</div>
	);
}
