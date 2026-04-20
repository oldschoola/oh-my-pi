import { Boxes, Clock, DollarSign, Layers, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { formatDuration, formatRelative, pctClass } from "../format";
import type { MissionSummary } from "../types";
import { StatusBadge } from "./StatusBadge";

export function MissionList({
	missions,
	selectedId,
	onSelect,
}: {
	missions: MissionSummary[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	const [query, setQuery] = useState("");

	const filtered = query.trim()
		? missions.filter(m => {
				const q = query.toLowerCase();
				return m.description.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
			})
		: missions;

	if (missions.length === 0) {
		return (
			<div className="surface p-6 text-center text-[var(--text-muted)] text-sm">
				No missions yet. Start one with <code className="font-mono">/mission</code> in a pi session.
			</div>
		);
	}

	return (
		<div className="surface overflow-hidden">
			<div className="px-3 py-2 border-b border-[var(--border-subtle)] flex items-center gap-2">
				<Search size={12} className="text-[var(--text-muted)] shrink-0" />
				<input
					type="text"
					value={query}
					onChange={e => setQuery(e.target.value)}
					placeholder={`Search ${missions.length} missions…`}
					className="flex-1 bg-transparent border-0 outline-none text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)]"
				/>
			</div>
			{filtered.length === 0 ? (
				<div className="p-6 text-center text-xs text-[var(--text-muted)]">No missions match your search.</div>
			) : (
				<div className="divide-y divide-[var(--border-subtle)]">
					{filtered.map(m => (
						<MissionRow key={m.id} mission={m} selected={selectedId === m.id} onClick={() => onSelect(m.id)} />
					))}
				</div>
			)}
		</div>
	);
}

interface MissionRowProps {
	mission: MissionSummary;
	selected: boolean;
	onClick: () => void;
}

function MissionRow({ mission: m, selected, onClick }: MissionRowProps) {
	const [now, setNow] = useState(() => Date.now());
	const isActive = m.status === "active" || m.status === "paused";
	// Tick every second while active so duration timer stays live.
	useEffect(() => {
		if (!isActive) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [isActive]);

	const duration = computeDuration(m.startedAt, m.completedAt, isActive ? now : undefined);
	const progress = computeProgress(m);

	return (
		<button
			type="button"
			onClick={onClick}
			className={`w-full text-left px-4 py-3 transition ${selected ? "bg-[var(--bg-active)]" : "hover:bg-[var(--bg-hover)]"}`}
		>
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2 min-w-0">
					{m.kind === "batch" ? (
						<Boxes size={14} className="text-[var(--accent-violet)] shrink-0" />
					) : (
						<Layers size={14} className="text-[var(--accent-cyan)] shrink-0" />
					)}
					<span className="font-mono text-xs text-[var(--text-muted)] shrink-0">{m.id.slice(0, 8)}</span>
					<span className="truncate text-sm">{m.description || "(no description)"}</span>
				</div>
				<StatusBadge status={m.status} />
			</div>
			{progress && (
				<div className="mt-2">
					<div className="task-progress-bar">
						<div
							className={`task-progress-fill ${pctClass(progress.pct)}`}
							style={{ width: `${progress.pct}%` }}
						/>
					</div>
				</div>
			)}
			<div className="mt-1 text-xs text-[var(--text-muted)] flex items-center gap-3 flex-wrap">
				<span>Started {formatRelative(m.startedAt)}</span>
				{duration && (
					<span className="flex items-center gap-1 font-mono">
						<Clock size={10} />
						{duration}
					</span>
				)}
				{m.kind === "batch" && m.tasksTotal !== undefined && m.tasksTotal > 0 && (
					<span className="font-mono">
						{m.tasksComplete ?? 0}/{m.tasksTotal} tasks
						{m.tasksFailed !== undefined && m.tasksFailed > 0 && (
							<span className="text-[var(--accent-red)] ml-1">({m.tasksFailed} failed)</span>
						)}
					</span>
				)}
				{m.kind === "simple" && m.phaseCount !== undefined && m.phaseCount > 0 && (
					<span>
						{m.completedPhases ?? 0}/{m.phaseCount} phases
					</span>
				)}
				{m.kind === "batch" && m.laneCount !== undefined && <span>{m.laneCount} lanes</span>}
				{m.cost !== undefined && m.cost > 0 && (
					<span className="flex items-center gap-0.5 font-mono text-[var(--accent-indigo)]">
						<DollarSign size={10} />
						{m.cost.toFixed(2)}
					</span>
				)}
			</div>
		</button>
	);
}

function computeProgress(m: MissionSummary): { pct: number } | null {
	if (m.kind === "batch" && m.tasksTotal && m.tasksTotal > 0) {
		return { pct: Math.round(((m.tasksComplete ?? 0) / m.tasksTotal) * 100) };
	}
	if (m.kind === "simple" && m.phaseCount && m.phaseCount > 0) {
		return { pct: Math.round(((m.completedPhases ?? 0) / m.phaseCount) * 100) };
	}
	return null;
}

function computeDuration(startedAt: string, completedAt?: string, liveNow?: number): string | null {
	try {
		const start = new Date(startedAt).getTime();
		if (Number.isNaN(start)) return null;
		const end = completedAt ? new Date(completedAt).getTime() : (liveNow ?? Date.now());
		const ms = end - start;
		if (ms < 0) return null;
		return formatDuration(ms);
	} catch {
		return null;
	}
}
