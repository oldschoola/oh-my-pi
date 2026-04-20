import { Activity, CheckCircle2, CircleDashed, Clock, Copy, Eye, XCircle } from "lucide-react";
import { useState } from "react";
import { formatDuration, formatTokens, pctClass } from "../format";
import type { BatchState, LaneStatus, TaskOutcome, TaskTelemetry } from "../types";

interface LaneGridProps {
	batch: BatchState;
	onViewLane?: (laneId: string) => void;
}

export function LaneGrid({ batch, onViewLane }: LaneGridProps) {
	return (
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
	);
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
