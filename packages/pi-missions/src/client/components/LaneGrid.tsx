import { Activity, CheckCircle2, CircleDashed, Clock, Copy, Eye, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { BatchState, LaneStatus, TaskOutcome, TaskTelemetry, WaveAssignment } from "../types";

interface LaneGridProps {
	batch: BatchState;
	onViewLane?: (laneId: string) => void;
}

export function LaneGrid({ batch, onViewLane }: LaneGridProps) {
	return (
		<div className="space-y-4">
			<WaveHeader batch={batch} />
			<div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
				{batch.laneStatuses.map(l => {
					// Find the task currently assigned to this lane
					const currentTask = l.taskId ? (batch.tasks.find(t => t.taskId === l.taskId) ?? null) : null;
					const laneConvId = `${batch.batchId}:lane-${l.lane}`;
					return (
						<LaneCell
							key={l.lane}
							lane={l}
							currentTask={currentTask}
							onView={onViewLane ? () => onViewLane(laneConvId) : undefined}
						/>
					);
				})}
			</div>
		</div>
	);
}

function WaveHeader({ batch }: { batch: BatchState }) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	const elapsed = formatDuration(now - batch.startTime);
	const taskMap = new Map(batch.tasks.map(t => [t.taskId, t]));
	// Prefer checkbox-based progress (STATUS.md derived) when enough data exists.
	const { checked: batchChecked, total: batchTotal } = aggregateCheckboxProgress(batch);
	const checkboxPct = batchTotal > 0 ? Math.round((batchChecked / batchTotal) * 100) : null;
	const taskPct = batch.tasksTotal > 0 ? Math.round((batch.tasksComplete / batch.tasksTotal) * 100) : 0;
	const pct = checkboxPct ?? taskPct;

	// Count running lanes (not tasks — lanes can be running without a known task)
	const lanesRunning = batch.laneStatuses.filter(l => l.status === "running").length;
	const tasksPending = batch.tasksTotal - batch.tasksComplete - batch.tasksFailed - lanesRunning;

	return (
		<div className="surface p-4">
			<div className="flex items-center justify-between mb-3">
				<div className="text-sm flex items-center gap-2">
					<span className="font-semibold gradient-text">Wave {batch.currentWave + 1}</span>
					<span className="text-[var(--text-muted)]">/ {batch.waves.length}</span>
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

			{/* Segmented wave progress bar */}
			<SegmentedBar
				waves={batch.waves}
				currentWave={batch.currentWave}
				tasksTotal={batch.tasksTotal}
				taskMap={taskMap}
			/>

			{/* Count chips */}
			<div className="flex items-center gap-2 mt-3 text-xs">
				{batch.tasksComplete > 0 && <CountChip label={`${batch.tasksComplete} done`} variant="green" />}
				{lanesRunning > 0 && <CountChip label={`${lanesRunning} running`} variant="cyan" />}
				{batch.tasksFailed > 0 && <CountChip label={`${batch.tasksFailed} failed`} variant="red" />}
				{tasksPending > 0 && <CountChip label={`${tasksPending} pending`} variant="muted" />}
				<span className="text-[var(--text-muted)] font-mono ml-auto">
					{batch.tasksComplete}/{batch.tasksTotal}
				</span>
			</div>

			{/* Wave chips */}
			{batch.waves.length > 1 && (
				<div className="flex items-center gap-1.5 mt-2 flex-wrap">
					{batch.waves.map((w, i) => (
						<WaveChip key={i} waveIndex={i} currentWave={batch.currentWave} taskCount={w.taskIds.length} />
					))}
				</div>
			)}
		</div>
	);
}

function SegmentedBar({
	waves,
	currentWave,
	tasksTotal,
	taskMap,
}: {
	waves: WaveAssignment[];
	currentWave: number;
	tasksTotal: number;
	taskMap: Map<string, TaskOutcome>;
}) {
	if (tasksTotal === 0) return null;

	// Precompute per-wave checkbox totals so width ∨ total and fill ∨ checked.
	// Fallback to per-task counts when no STATUS.md data is available.
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
				// Succeeded tasks count as fully done even when STATUS.md is absent.
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

	return (
		<div className="h-2.5 rounded-full overflow-hidden flex" style={{ background: "var(--bg-elevated)" }}>
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
						{waves.length <= 8 && <span className="wave-seg-label">{i + 1}</span>}
					</div>
				);
			})}
		</div>
	);
}

/** Roll checkbox totals across all tasks with `statusData`. Returns {0,0} when none. */
function aggregateCheckboxProgress(batch: BatchState): { checked: number; total: number } {
	let checked = 0;
	let total = 0;
	for (const t of batch.tasks) {
		if (t.statusData && t.statusData.total > 0) {
			checked += t.statusData.checked;
			total += t.statusData.total;
		}
	}
	return { checked, total };
}

function CountChip({ label, variant }: { label: string; variant: "green" | "cyan" | "red" | "muted" }) {
	const styles: Record<string, { bg: string; color: string }> = {
		green: { bg: "rgba(74, 222, 128, 0.12)", color: "var(--accent-green)" },
		cyan: { bg: "rgba(34, 211, 238, 0.12)", color: "var(--accent-cyan)" },
		red: { bg: "rgba(248, 113, 113, 0.12)", color: "var(--accent-red)" },
		muted: { bg: "rgba(100, 116, 139, 0.08)", color: "var(--text-muted)" },
	};
	const s = styles[variant];
	return (
		<span
			className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium font-mono"
			style={{ background: s.bg, color: s.color, fontSize: "11px" }}
		>
			{label}
		</span>
	);
}

function WaveChip({
	waveIndex,
	currentWave,
	taskCount,
}: {
	waveIndex: number;
	currentWave: number;
	taskCount: number;
}) {
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

	return (
		<span
			className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[11px] font-medium"
			style={{ background: bg, color, border: `1px solid ${border}` }}
		>
			W{waveIndex + 1}
			<span style={{ opacity: 0.6, fontSize: "10px" }}>{taskCount}</span>
		</span>
	);
}

function pctClass(pct: number): string {
	if (pct >= 100) return "pct-hi";
	if (pct >= 50) return "pct-mid";
	if (pct > 0) return "pct-low";
	return "pct-0";
}

// ---------------------------------------------------------------------------
// LaneCell
// ---------------------------------------------------------------------------

interface LaneCellProps {
	lane: LaneStatus;
	currentTask: TaskOutcome | null;
	onView?: () => void;
}

function LaneCell({ lane, currentTask, onView }: LaneCellProps) {
	const [copied, setCopied] = useState(false);
	const cellClass = `lane-cell lane-${lane.status}`;

	function handleCopy() {
		if (!lane.sessionName) return;
		navigator.clipboard
			.writeText(lane.sessionName)
			.then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			})
			.catch(() => {});
	}

	return (
		<div className={cellClass}>
			{/* Lane header row */}
			<div className="flex items-center justify-between mb-2">
				<div className="flex items-center gap-2">
					<LaneIcon status={lane.status} />
					<span className="text-xs font-mono text-[var(--text-muted)]">Lane {lane.lane}</span>
					<span className="text-xs uppercase tracking-wider" style={{ color: statusColor(lane.status) }}>
						{lane.status}
					</span>
				</div>
				{/* View conversation button */}
				{onView && (
					<button type="button" className="btn-icon" onClick={onView} title="View conversation">
						<Eye size={11} />
						<span>View</span>
					</button>
				)}
			</div>

			{/* Current task title */}
			<div className="text-sm truncate font-medium mb-2">
				{currentTask?.taskId ?? lane.taskId ?? <span className="text-[var(--text-muted)] font-normal">(idle)</span>}
			</div>

			{/* STATUS.md checkbox progress — mirrors taskplane's per-task bar. */}
			{currentTask?.statusData && currentTask.statusData.total > 0 && (
				<TaskProgressBar statusData={currentTask.statusData} />
			)}

			{/* Step progress + elapsed */}
			{(lane.stepProgress || lane.elapsed > 0) && (
				<div className="flex items-center gap-3 mb-2">
					{lane.stepProgress && (
						<span className="lane-meta-chip">
							<CheckCircle2 size={10} style={{ opacity: 0.6 }} />
							{lane.stepProgress}
						</span>
					)}
					{lane.elapsed > 0 && (
						<span className="lane-meta-chip">
							<Clock size={10} style={{ opacity: 0.6 }} />
							{formatDuration(lane.elapsed)}
						</span>
					)}
					{lane.iteration > 1 && (
						<span className="lane-meta-chip" title="Iteration/retry count">
							i{lane.iteration}
						</span>
					)}
				</div>
			)}

			{/* Task telemetry */}
			{currentTask?.telemetry && <TaskTelemetryBadge telemetry={currentTask.telemetry} />}

			{/* Session name */}
			{lane.sessionName && (
				<div className="mt-2">
					<button
						type="button"
						className={`session-tag ${copied ? "copied" : ""}`}
						onClick={handleCopy}
						title={copied ? "Copied!" : `Session: ${lane.sessionName} — click to copy`}
					>
						<Copy size={9} style={{ opacity: 0.7 }} />
						{lane.sessionName}
					</button>
				</div>
			)}
		</div>
	);
}

function TaskProgressBar({ statusData }: { statusData: NonNullable<TaskOutcome["statusData"]> }) {
	const pct = statusData.total > 0 ? Math.round((statusData.checked / statusData.total) * 100) : 0;
	const fillClass = pctClass(pct);
	return (
		<div className="mb-2">
			<div className="task-progress-bar">
				<div className={`task-progress-fill ${fillClass}`} style={{ width: `${pct}%` }} />
			</div>
			<div className="flex items-center justify-between mt-1 text-[10px] text-[var(--text-muted)] font-mono">
				<span title={statusData.currentStep ? `Step: ${statusData.currentStep}` : undefined}>
					{statusData.currentStep ? truncateStep(statusData.currentStep) : "steps"}
				</span>
				<span>
					{statusData.checked}/{statusData.total} · {pct}%
					{statusData.iteration > 0 && <span className="ml-1">i{statusData.iteration}</span>}
					{statusData.reviews > 0 && <span className="ml-1">r{statusData.reviews}</span>}
				</span>
			</div>
		</div>
	);
}

function truncateStep(name: string): string {
	return name.length > 28 ? `${name.slice(0, 27)}…` : name;
}

function TaskTelemetryBadge({ telemetry }: { telemetry: TaskTelemetry }) {
	const totalIn = telemetry.inputTokens + telemetry.cacheReadTokens;
	const out = telemetry.outputTokens;
	if (totalIn === 0 && out === 0) return null;

	let label = `↑${formatTokens(totalIn)} ↓${formatTokens(out)}`;
	if (telemetry.costUsd > 0) label += ` $${telemetry.costUsd.toFixed(2)}`;

	return (
		<div className="mb-2">
			<span className="telemetry-badge" title="Tokens: input↑ output↓ cost">
				{label}
			</span>
		</div>
	);
}

function LaneIcon({ status }: { status: LaneStatus["status"] }) {
	switch (status) {
		case "running":
			return <Activity size={14} className="text-[var(--accent-cyan)]" />;
		case "complete":
			return <CheckCircle2 size={14} className="text-[var(--accent-green)]" />;
		case "failed":
			return <XCircle size={14} className="text-[var(--accent-red)]" />;
		default:
			return <CircleDashed size={14} className="text-[var(--text-muted)]" />;
	}
}

function statusColor(status: LaneStatus["status"]): string {
	switch (status) {
		case "running":
			return "var(--accent-cyan)";
		case "complete":
			return "var(--accent-green)";
		case "failed":
			return "var(--accent-red)";
		case "stalled":
			return "var(--accent-amber)";
		default:
			return "var(--text-muted)";
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
	if (ms <= 0) return "0s";
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
	return `${m}m ${String(s).padStart(2, "0")}s`;
}

function formatTokens(n: number): string {
	if (n === 0) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}
