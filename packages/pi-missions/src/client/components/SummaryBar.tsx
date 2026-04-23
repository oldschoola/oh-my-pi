import { CheckCircle2, Clock, DollarSign, XCircle, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { formatDuration, formatTokens } from "../format";
import type { BatchState, MissionSummary } from "../types";
import { SegmentedBar } from "./SegmentedBar";

interface SummaryBarProps {
	batch: BatchState;
	/** Mission summary fields used for aggregate tokens/cost. */
	summary: Pick<MissionSummary, "cost" | "aggregateTokens">;
}

export function SummaryBar({ batch, summary }: SummaryBarProps) {
	const [now, setNow] = useState(Date.now());
	const active = !batch.endTime;
	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [active]);

	const elapsed = formatDuration((batch.endTime ?? now) - batch.startTime);
	const taskMap = new Map(batch.tasks.map(t => [t.taskId, t]));
	const lanesRunning = batch.laneStatuses.filter(l => l.status === "running").length;
	const tasksPending = Math.max(0, batch.tasksTotal - batch.tasksComplete - batch.tasksFailed - lanesRunning);

	const checkedTotal = batch.tasks.reduce((acc, t) => acc + (t.statusData?.checked ?? 0), 0);
	const totalBoxes = batch.tasks.reduce((acc, t) => acc + (t.statusData?.total ?? 0), 0);
	const pct =
		totalBoxes > 0
			? Math.round((checkedTotal / totalBoxes) * 100)
			: batch.tasksTotal > 0
				? Math.round((batch.tasksComplete / batch.tasksTotal) * 100)
				: 0;

	const tokens = summary.aggregateTokens;
	const totalIn = tokens ? tokens.inputTokens + tokens.cacheReadTokens : 0;
	const totalOut = tokens ? tokens.outputTokens : 0;

	return (
		<div className="surface p-4 space-y-3">
			<div className="flex items-center justify-between">
				<div className="text-sm flex items-center gap-2">
					<span className="font-semibold gradient-text">Batch Progress</span>
					<span className="text-[var(--text-muted)]">
						Wave {batch.currentWave + 1}/{batch.waves.length}
					</span>
				</div>
				<div className="flex items-center gap-3 text-xs">
					<span className="font-mono text-[var(--text-muted)]" style={{ fontVariantNumeric: "tabular-nums" }}>
						{pct}%
					</span>
					<span className="font-mono text-[var(--text-muted)] flex items-center gap-1">
						<Clock size={11} />
						{elapsed}
					</span>
				</div>
			</div>

			<SegmentedBar
				waves={batch.waves}
				currentWave={batch.currentWave}
				phase={batch.phase}
				tasksTotal={batch.tasksTotal}
				taskMap={taskMap}
			/>

			<div className="flex items-center gap-2 text-xs flex-wrap">
				{batch.tasksComplete > 0 && (
					<StatusChip
						icon={<CheckCircle2 size={11} />}
						label={`${batch.tasksComplete} succeeded`}
						bg="rgba(74, 222, 128, 0.12)"
						color="var(--accent-green)"
					/>
				)}
				{lanesRunning > 0 && (
					<StatusChip
						icon={<Zap size={11} />}
						label={`${lanesRunning} running`}
						bg="rgba(34, 211, 238, 0.12)"
						color="var(--accent-cyan)"
					/>
				)}
				{batch.tasksFailed > 0 && (
					<StatusChip
						icon={<XCircle size={11} />}
						label={`${batch.tasksFailed} failed`}
						bg="rgba(248, 113, 113, 0.12)"
						color="var(--accent-red)"
					/>
				)}
				{tasksPending > 0 && (
					<StatusChip
						icon={null}
						label={`${tasksPending} pending`}
						bg="rgba(100, 116, 139, 0.08)"
						color="var(--text-muted)"
					/>
				)}

				<span className="text-[var(--text-muted)] font-mono ml-auto flex items-center gap-3">
					{tokens && (totalIn > 0 || totalOut > 0) && (
						<span title="Aggregate input↑ / output↓ tokens">
							↑{formatTokens(totalIn)} ↓{formatTokens(totalOut)}
						</span>
					)}
					{summary.cost !== undefined && summary.cost > 0 && (
						<span className="flex items-center gap-0.5 text-[var(--accent-indigo)]">
							<DollarSign size={10} />
							{summary.cost.toFixed(2)}
						</span>
					)}
					<span>
						{batch.tasksComplete}/{batch.tasksTotal}
					</span>
				</span>
			</div>

			{batch.waves.length > 1 && (
				<div className="flex items-center gap-1.5 flex-wrap">
					{batch.waves.map((w, i) => (
						<WaveChip key={i} waveIndex={i} currentWave={batch.currentWave} taskIds={w.taskIds} />
					))}
				</div>
			)}
		</div>
	);
}

function StatusChip({
	icon,
	label,
	bg,
	color,
}: {
	icon: React.ReactNode | null;
	label: string;
	bg: string;
	color: string;
}) {
	return (
		<span
			className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium font-mono"
			style={{ background: bg, color, fontSize: "11px" }}
		>
			{icon}
			{label}
		</span>
	);
}

function WaveChip({ waveIndex, currentWave, taskIds }: { waveIndex: number; currentWave: number; taskIds: string[] }) {
	const isPast = waveIndex < currentWave;
	const isCurrent = waveIndex === currentWave;

	let bg = "var(--bg-elevated)";
	let color = "var(--text-muted)";
	let border = "var(--border-default)";

	if (isPast) {
		bg = "rgba(74, 222, 128, 0.12)";
		color = "var(--accent-green)";
		border = "transparent";
	} else if (isCurrent) {
		bg = "rgba(96, 165, 250, 0.12)";
		color = "var(--accent-blue)";
		border = "var(--accent-blue)";
	}

	const title = taskIds.length > 0 ? `W${waveIndex + 1}: ${taskIds.join(", ")}` : `W${waveIndex + 1}`;

	return (
		<span
			className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[11px] font-medium"
			style={{ background: bg, color, border: `1px solid ${border}` }}
			title={title}
		>
			W{waveIndex + 1}
			{taskIds.length > 0 && <span style={{ opacity: 0.6, fontSize: "10px" }}>[{taskIds.join(", ")}]</span>}
		</span>
	);
}
