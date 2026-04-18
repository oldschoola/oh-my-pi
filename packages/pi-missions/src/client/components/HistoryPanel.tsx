import { formatDistanceToNow } from "date-fns";
import { Archive, Boxes, Layers, Search } from "lucide-react";
import { useState } from "react";
import type { MissionSummary } from "../types";
import { StatusBadge } from "./StatusBadge";

export function HistoryPanel({ missions, onSelect }: { missions: MissionSummary[]; onSelect?: (id: string) => void }) {
	const [query, setQuery] = useState("");

	const filtered = query.trim()
		? missions.filter(m => m.description.toLowerCase().includes(query.toLowerCase()))
		: missions;

	return (
		<section className="surface p-4">
			{/* Top bar */}
			<header className="flex items-center gap-3 mb-4">
				<Archive size={16} className="text-[var(--accent-violet)] shrink-0" />
				<h3 className="font-medium flex-1">Completed Missions</h3>
				<span className="badge badge-completed text-xs">{missions.length}</span>
				<div className="relative">
					<Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
					<input
						type="text"
						value={query}
						onChange={e => setQuery(e.target.value)}
						placeholder="Search…"
						className="pl-7 pr-3 py-1.5 text-xs bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-[var(--radius-md)] outline-none focus:border-[var(--accent-blue)] text-[var(--text-primary)] placeholder-[var(--text-muted)] w-40"
					/>
				</div>
			</header>

			{filtered.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-12 text-center gap-2">
					<Archive size={32} className="text-[var(--text-muted)] opacity-30" />
					<p className="text-sm text-[var(--text-muted)]">
						{query ? "No missions match your search." : "No completed missions yet."}
					</p>
					{!query && (
						<p className="text-xs text-[var(--text-muted)] opacity-60">Missions appear here once they finish.</p>
					)}
				</div>
			) : (
				<div className="grid gap-2">
					{filtered.map(m => (
						<MissionCard key={m.id} mission={m} onSelect={onSelect} />
					))}
				</div>
			)}
		</section>
	);
}

function MissionCard({ mission: m, onSelect }: { mission: MissionSummary; onSelect?: (id: string) => void }) {
	const duration = computeDuration(m.startedAt, m.completedAt);
	const ago = formatRelative(m.startedAt);

	return (
		<button type="button" className="mission-card text-left w-full" onClick={() => onSelect?.(m.id)}>
			<div className="flex items-start justify-between gap-3">
				{/* Left: icon + description */}
				<div className="flex items-center gap-2 min-w-0 flex-1">
					{m.kind === "batch" ? (
						<Boxes size={14} className="text-[var(--accent-violet)] shrink-0 mt-0.5" />
					) : (
						<Layers size={14} className="text-[var(--accent-cyan)] shrink-0 mt-0.5" />
					)}
					<span className="text-sm truncate">{m.description || "(no description)"}</span>
				</div>
				{/* Right: status badge + duration */}
				<div className="flex items-center gap-2 shrink-0">
					{duration && <span className="text-xs text-[var(--text-muted)] font-mono">{duration}</span>}
					<StatusBadge status={m.status} />
				</div>
			</div>
			{/* Bottom row */}
			<div className="mt-1.5 flex items-center gap-3 text-xs text-[var(--text-muted)]">
				<span className="font-mono">{m.id.slice(0, 8)}</span>
				<span>{ago}</span>
				{m.kind === "simple" && m.phaseCount !== undefined && (
					<span>
						{m.completedPhases ?? 0}/{m.phaseCount} phases
					</span>
				)}
				{m.kind === "batch" && m.laneCount !== undefined && <span>{m.laneCount} lanes</span>}
			</div>
		</button>
	);
}

function computeDuration(startedAt: string, completedAt?: string): string | null {
	if (!completedAt) return null;
	try {
		const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
		if (ms < 0) return null;
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ${s % 60}s`;
		return `${Math.floor(m / 60)}h ${m % 60}m`;
	} catch {
		return null;
	}
}

function formatRelative(iso: string): string {
	try {
		return formatDistanceToNow(new Date(iso), { addSuffix: true });
	} catch {
		return iso;
	}
}
