import { Activity, CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import type { BatchState, LaneStatus } from "../types";

export function LaneGrid({ batch }: { batch: BatchState }) {
	return (
		<div className="space-y-4">
			<WaveHeader batch={batch} />
			<div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
				{batch.laneStatuses.map(l => (
					<LaneCell key={l.laneId} lane={l} />
				))}
			</div>
		</div>
	);
}

function WaveHeader({ batch }: { batch: BatchState }) {
	const pct = batch.tasksTotal > 0 ? Math.round((batch.tasksComplete / batch.tasksTotal) * 100) : 0;
	return (
		<div className="surface p-4">
			<div className="flex items-center justify-between mb-2">
				<div className="text-sm">
					<span className="font-semibold">Wave {batch.currentWave + 1}</span>
					<span className="text-[var(--text-muted)]"> / {batch.waves.length}</span>
				</div>
				<div className="text-xs text-[var(--text-muted)]">
					{batch.tasksComplete}/{batch.tasksTotal} done · {batch.tasksFailed} failed
				</div>
			</div>
			<div className="h-2 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
				<div className="h-full bg-[var(--accent-cyan)] transition-all" style={{ width: `${pct}%` }} />
			</div>
		</div>
	);
}

function LaneCell({ lane }: { lane: LaneStatus }) {
	const cellClass = `lane-cell lane-${lane.state}`;
	return (
		<div className={cellClass}>
			<div className="flex items-center justify-between mb-2">
				<div className="flex items-center gap-2">
					<LaneIcon state={lane.state} />
					<span className="text-xs font-mono text-[var(--text-muted)]">Lane {lane.laneId}</span>
				</div>
				<span className="text-xs text-[var(--text-muted)] uppercase tracking-wider">{lane.state}</span>
			</div>
			<div className="text-sm truncate">
				{lane.currentTaskTitle ?? <span className="text-[var(--text-muted)]">(idle)</span>}
			</div>
			{lane.pid && <div className="mt-1 text-xs text-[var(--text-muted)] font-mono">pid {lane.pid}</div>}
		</div>
	);
}

function LaneIcon({ state }: { state: LaneStatus["state"] }) {
	switch (state) {
		case "running":
			return <Activity size={14} className="text-[var(--accent-cyan)]" />;
		case "complete":
			return <CheckCircle2 size={14} className="text-[var(--accent-green)]" />;
		case "failed":
		case "recovering":
			return <XCircle size={14} className="text-[var(--accent-red)]" />;
		default:
			return <CircleDashed size={14} className="text-[var(--text-muted)]" />;
	}
}
