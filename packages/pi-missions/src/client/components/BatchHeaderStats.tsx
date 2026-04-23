import { CheckCircle2, Clock, DollarSign, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { formatDuration, formatTokens } from "../format";
import type { BatchState, MissionSummary } from "../types";

/**
 * Compact batch-progress digest rendered inline with MissionControlBar in the
 * mission header. Shows the essentials — percentage complete, task counts,
 * wave progress, aggregate tokens and cost, elapsed — in a single flex row.
 *
 * Replaces the legacy full-width `SummaryBar` block for batch missions; the
 * richer segmented/wave view lives inside the Lanes surface now.
 */
export function BatchHeaderStats({
	batch,
	summary,
}: {
	batch: BatchState;
	summary: Pick<MissionSummary, "cost" | "aggregateTokens">;
}) {
	const [now, setNow] = useState(Date.now());
	const active = !batch.endTime;
	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [active]);

	const elapsed = formatDuration((batch.endTime ?? now) - batch.startTime);
	const lanesRunning = batch.laneStatuses.filter(l => l.status === "running").length;
	const tasksFailed = batch.tasksFailed;

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
		<div className="batch-header-stats">
			<div className="batch-header-stats-bar">
				<div
					className="batch-header-stats-fill"
					style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
					aria-valuenow={pct}
					role="progressbar"
					aria-valuemin={0}
					aria-valuemax={100}
				/>
			</div>
			<div className="batch-header-stats-row">
				<span className="batch-header-stats-pct" style={{ fontVariantNumeric: "tabular-nums" }}>
					{pct}%
				</span>
				<span className="batch-header-stats-dot">·</span>
				<span className="batch-header-stats-item">
					<CheckCircle2 size={11} className="text-[var(--accent-green)]" />
					<span className="font-mono">
						{batch.tasksComplete}/{batch.tasksTotal}
					</span>
					<span className="text-[var(--text-muted)]">tasks</span>
				</span>
				{lanesRunning > 0 && (
					<span className="batch-header-stats-item text-[var(--accent-cyan)]">
						<Zap size={11} />
						<span className="font-mono">{lanesRunning} running</span>
					</span>
				)}
				{tasksFailed > 0 && (
					<span className="batch-header-stats-item text-[var(--accent-red)]">
						<span className="font-mono">{tasksFailed} failed</span>
					</span>
				)}
				<span className="batch-header-stats-item font-mono text-[var(--text-muted)]">
					W{batch.currentWave + 1}/{batch.waves.length}
				</span>
				{tokens && (totalIn > 0 || totalOut > 0) && (
					<span className="batch-header-stats-item font-mono text-[var(--text-muted)]">
						↑{formatTokens(totalIn)} ↓{formatTokens(totalOut)}
					</span>
				)}
				{summary.cost !== undefined && summary.cost > 0 && (
					<span className="batch-header-stats-item font-mono text-[var(--accent-indigo)]">
						<DollarSign size={10} />
						{summary.cost.toFixed(2)}
					</span>
				)}
				<span className="batch-header-stats-item font-mono text-[var(--text-muted)]">
					<Clock size={11} />
					{elapsed}
				</span>
			</div>
		</div>
	);
}
