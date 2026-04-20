import { pctClass } from "../format";
import type { TaskOutcome, WaveAssignment } from "../types";

/**
 * Per-wave segmented progress bar.
 *
 * Segment widths are proportional to either checkbox totals (when STATUS.md
 * progress is available) or task counts (fallback). The current wave fills
 * from the live checkbox ratio; past waves are fully filled; future waves
 * stay empty but keep their slot.
 */
export function SegmentedBar({
	waves,
	currentWave,
	tasksTotal,
	taskMap,
	compact = false,
}: {
	waves: WaveAssignment[];
	currentWave: number;
	tasksTotal: number;
	taskMap: Map<string, TaskOutcome>;
	/** Reduces height and hides numeric wave labels. */
	compact?: boolean;
}) {
	if (tasksTotal === 0) return null;

	const waveStats = waves.map(w => {
		let checked = 0;
		let total = 0;
		for (const tid of w.taskIds) {
			const t = taskMap.get(tid);
			if (!t) continue;
			if (t.statusData && t.statusData.total > 0) {
				checked += t.statusData.checked;
				total += t.statusData.total;
			} else if (t.status === "succeeded") {
				checked += 1;
				total += 1;
			} else {
				total += 1;
			}
		}
		return { taskIds: w.taskIds, checked, total };
	});
	const bigTotal = waveStats.reduce((acc, w) => acc + w.total, 0);
	const useCheckboxWidths = bigTotal > 0 && bigTotal !== waves.reduce((acc, w) => acc + w.taskIds.length, 0);

	const height = compact ? "h-2" : "h-2.5";
	const showLabel = !compact && waves.length <= 8;

	return (
		<div className={`${height} rounded-full overflow-hidden flex`} style={{ background: "var(--bg-elevated)" }}>
			{waves.map((w, i) => {
				const ws = waveStats[i];
				const widthPct = useCheckboxWidths ? (ws.total / bigTotal) * 100 : (w.taskIds.length / tasksTotal) * 100;
				if (widthPct === 0) return null;

				const isCurrent = i === currentWave;
				const isFuture = i > currentWave;
				const isPast = i < currentWave;
				const liveFill = ws.total > 0 ? Math.round((ws.checked / ws.total) * 100) : 0;
				const fillPct = isPast ? 100 : isCurrent ? (liveFill > 0 ? liveFill : 50) : 0;

				return (
					<div
						key={i}
						className="wave-seg"
						title={`W${i + 1}: ${ws.checked}/${ws.total} (${w.taskIds.join(", ")})`}
						style={{
							width: `${widthPct}%`,
							boxShadow: isCurrent ? "inset 0 0 0 1px var(--accent-blue)" : undefined,
							background: isFuture ? "var(--bg-hover)" : undefined,
						}}
					>
						<div className={`wave-seg-fill ${pctClass(fillPct)}`} style={{ width: `${fillPct}%` }} />
						{showLabel && <span className="wave-seg-label">{i + 1}</span>}
					</div>
				);
			})}
		</div>
	);
}
