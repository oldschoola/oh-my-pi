import { Archive, Boxes, ChevronDown, ChevronRight, Layers, Search } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { getHistoryEntry } from "../api";
import { formatDurationOrNull, formatRelative, formatTokens } from "../format";
import type { BatchHistoryEntry, BatchHistoryTask, BatchHistoryWave, MissionSummary } from "../types";
import { StatusBadge } from "./StatusBadge";

export function HistoryPanel({ missions, onSelect }: { missions: MissionSummary[]; onSelect?: (id: string) => void }) {
	const [query, setQuery] = useState("");
	const [expandedId, setExpandedId] = useState<string | null>(null);

	const filtered = query.trim()
		? missions.filter(m => {
				const q = query.toLowerCase();
				return m.description.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
			})
		: missions;

	return (
		<section className="surface p-4">
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
						<div key={m.id}>
							<MissionCard
								mission={m}
								expanded={expandedId === m.id}
								onToggle={() => setExpandedId(prev => (prev === m.id ? null : m.id))}
								onSelect={onSelect}
							/>
							{expandedId === m.id && <HistoryDetailView missionId={m.id} />}
						</div>
					))}
				</div>
			)}
		</section>
	);
}

function MissionCard({
	mission: m,
	expanded,
	onToggle,
	onSelect,
}: {
	mission: MissionSummary;
	expanded: boolean;
	onToggle: () => void;
	onSelect?: (id: string) => void;
}) {
	const duration = computeDuration(m.startedAt, m.completedAt);
	const ago = formatRelative(m.startedAt);

	// Use div[role=button] so the "Open live view" child can be a real <button>
	// without violating the HTML rule that bans nested interactive elements.
	const handleKey = (ev: KeyboardEvent<HTMLDivElement>) => {
		if (ev.key === "Enter" || ev.key === " ") {
			ev.preventDefault();
			onToggle();
		}
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: must be a div so the nested "Open live view" can be a real <button> (no button-in-button)
		<div
			className="mission-card text-left w-full"
			role="button"
			tabIndex={0}
			onClick={onToggle}
			onKeyDown={handleKey}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex items-center gap-2 min-w-0 flex-1">
					{expanded ? (
						<ChevronDown size={14} className="text-[var(--text-muted)] shrink-0 mt-0.5" />
					) : (
						<ChevronRight size={14} className="text-[var(--text-muted)] shrink-0 mt-0.5" />
					)}
					{m.kind === "batch" ? (
						<Boxes size={14} className="text-[var(--accent-violet)] shrink-0 mt-0.5" />
					) : (
						<Layers size={14} className="text-[var(--accent-cyan)] shrink-0 mt-0.5" />
					)}
					<span className="text-sm truncate">{m.description || "(no description)"}</span>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					{duration && <span className="text-xs text-[var(--text-muted)] font-mono">{duration}</span>}
					<StatusBadge status={m.status} />
				</div>
			</div>
			<div className="mt-1.5 flex items-center gap-3 text-xs text-[var(--text-muted)]">
				<span className="font-mono">{m.id.slice(0, 8)}</span>
				<span>{ago}</span>
				{m.kind === "simple" && m.phaseCount !== undefined && (
					<span>
						{m.completedPhases ?? 0}/{m.phaseCount} phases
					</span>
				)}
				{m.kind === "batch" && m.tasksTotal !== undefined && (
					<span>
						{m.tasksComplete ?? 0}/{m.tasksTotal} tasks
					</span>
				)}
				{m.kind === "batch" && m.laneCount !== undefined && <span>{m.laneCount} lanes</span>}
				{onSelect && (
					<button
						type="button"
						className="ml-auto text-xs text-[var(--accent-blue)] hover:underline"
						onClick={ev => {
							ev.stopPropagation();
							onSelect(m.id);
						}}
					>
						Open live view
					</button>
				)}
			</div>
		</div>
	);
}

function HistoryDetailView({ missionId }: { missionId: string }) {
	const [entry, setEntry] = useState<BatchHistoryEntry | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		getHistoryEntry(missionId)
			.then(data => {
				if (!cancelled) {
					setEntry(data);
					setLoading(false);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setEntry(null);
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [missionId]);

	if (loading) {
		return <div className="mt-2 p-4 text-xs text-[var(--text-muted)]">Loading…</div>;
	}
	if (!entry) {
		return (
			<div className="mt-2 p-4 text-xs text-[var(--text-muted)]">
				No detailed history available for this mission.
			</div>
		);
	}
	return <HistoryDetailContent entry={entry} />;
}

function HistoryDetailContent({ entry }: { entry: BatchHistoryEntry }) {
	const total = entry.totalTasks ?? entry.tasksTotal ?? 0;
	const succeeded = entry.succeededTasks ?? entry.tasksComplete ?? 0;
	const failed = entry.failedTasks ?? entry.tasksFailed ?? 0;
	const waves = entry.totalWaves ?? entry.waves?.length ?? 0;
	const duration = formatDurationOrNull(entry.durationMs);
	const tokens = entry.tokens;
	const tokenLabel = tokens
		? `${formatTokens(tokens.input + tokens.cacheRead)} in / ${formatTokens(tokens.output)} out`
		: null;

	return (
		<div className="mt-2 surface p-4 space-y-4 animate-fade-in">
			<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
				<StatCard label="Tasks" value={String(total)} />
				<StatCard label="Succeeded" value={String(succeeded)} color="var(--accent-green)" />
				<StatCard label="Failed" value={String(failed)} color={failed > 0 ? "var(--accent-red)" : undefined} />
				<StatCard label="Waves" value={String(waves)} />
				<StatCard label="Duration" value={duration ?? "—"} />
				<StatCard label="Cost" value={tokens && tokens.costUsd > 0 ? `$${tokens.costUsd.toFixed(3)}` : "$0.00"} />
			</div>
			{tokenLabel && <div className="text-xs text-[var(--text-muted)] font-mono">Tokens: {tokenLabel}</div>}

			{entry.waves && entry.waves.length > 0 && <WavesTable waves={entry.waves} />}
			{entry.tasks && entry.tasks.length > 0 && <TasksTable tasks={entry.tasks} />}
		</div>
	);
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
	return (
		<div className="stat-card" style={{ padding: "10px 12px" }}>
			<div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
			<div className="text-sm font-semibold font-mono mt-0.5" style={{ color }}>
				{value}
			</div>
		</div>
	);
}

function WavesTable({ waves }: { waves: BatchHistoryWave[] }) {
	return (
		<div>
			<h4 className="supervisor-subheading mb-2">Waves</h4>
			<div className="history-table">
				<table className="w-full text-xs">
					<thead>
						<tr>
							<th>Wave</th>
							<th>Tasks</th>
							<th>Merge</th>
							<th>Duration</th>
							<th>Cost</th>
						</tr>
					</thead>
					<tbody>
						{waves.map(w => (
							<tr key={w.wave}>
								<td className="font-mono">W{w.wave}</td>
								<td className="font-mono">{w.tasks.length}</td>
								<td>
									<MergeBadge status={w.mergeStatus} />
								</td>
								<td className="font-mono">{formatDurationOrNull(w.durationMs) ?? "—"}</td>
								<td className="font-mono">{w.tokens.costUsd > 0 ? `$${w.tokens.costUsd.toFixed(3)}` : "—"}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

function TasksTable({ tasks }: { tasks: BatchHistoryTask[] }) {
	return (
		<div>
			<h4 className="supervisor-subheading mb-2">Tasks</h4>
			<div className="history-table overflow-x-auto">
				<table className="w-full text-xs">
					<thead>
						<tr>
							<th>Task</th>
							<th>Status</th>
							<th>Wave</th>
							<th>Lane</th>
							<th>Duration</th>
							<th>Tokens</th>
							<th>Cost</th>
							<th>Exit</th>
						</tr>
					</thead>
					<tbody>
						{tasks.map(t => (
							<tr key={t.taskId}>
								<td className="font-mono text-[var(--text-primary)]">{t.taskId}</td>
								<td>
									<TaskStatusBadge status={t.status} />
								</td>
								<td className="font-mono">{t.wave}</td>
								<td className="font-mono">{t.lane}</td>
								<td className="font-mono">{formatDurationOrNull(t.durationMs) ?? "—"}</td>
								<td className="font-mono">
									↑{formatTokens(t.tokens.input + t.tokens.cacheRead)} ↓{formatTokens(t.tokens.output)}
								</td>
								<td className="font-mono">{t.tokens.costUsd > 0 ? `$${t.tokens.costUsd.toFixed(3)}` : "—"}</td>
								<td className="truncate max-w-[220px]" title={t.exitReason ?? ""}>
									{t.exitReason ?? "—"}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

function MergeBadge({ status }: { status: BatchHistoryWave["mergeStatus"] }) {
	const color =
		status === "succeeded"
			? "var(--accent-green)"
			: status === "failed"
				? "var(--accent-red)"
				: status === "partial"
					? "var(--accent-amber)"
					: "var(--text-muted)";
	return (
		<span className="badge-tier" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
			{status}
		</span>
	);
}

function TaskStatusBadge({ status }: { status: BatchHistoryTask["status"] }) {
	const color =
		status === "succeeded"
			? "var(--accent-green)"
			: status === "failed"
				? "var(--accent-red)"
				: status === "stalled"
					? "var(--accent-amber)"
					: "var(--text-muted)";
	return (
		<span className="badge-tier" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
			{status}
		</span>
	);
}

function computeDuration(startedAt?: string | number, completedAt?: string | number): string | null {
	if (!startedAt || !completedAt) return null;
	try {
		const s = typeof startedAt === "number" ? startedAt : new Date(startedAt).getTime();
		const e = typeof completedAt === "number" ? completedAt : new Date(completedAt).getTime();
		return formatDurationOrNull(e - s);
	} catch {
		return null;
	}
}
