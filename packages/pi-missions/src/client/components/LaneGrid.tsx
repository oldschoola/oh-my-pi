import {
	Activity,
	CheckCircle2,
	CircleDashed,
	ClipboardCheck,
	Clock,
	Copy,
	DollarSign,
	Eye,
	Gauge,
	Layers,
	RefreshCw,
	Wrench,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import { formatDuration, formatTokens, segmentProgressText, taskSegmentProgress } from "../format";
import type { BatchState, LaneStatus, ReviewerStatus, TaskOutcome, TaskTelemetry } from "../types";

interface LaneGridProps {
	batch: BatchState;
	onViewLane?: (laneId: string) => void;
	/** When set, hide lanes whose repoId doesn't match. */
	selectedRepo?: string;
	/** True when the batch has >= 2 repos — enables repo badges + filter visibility. */
	showRepos?: boolean;
}

export function LaneGrid({ batch, onViewLane, selectedRepo, showRepos = false }: LaneGridProps) {
	const visible = selectedRepo
		? batch.laneStatuses.filter(l => !l.repoId || l.repoId === selectedRepo)
		: batch.laneStatuses;
	return (
		<div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
			{visible.map(l => {
				const currentTask = l.taskId ? (batch.tasks.find(t => t.taskId === l.taskId) ?? null) : null;
				const laneConvId = `${batch.batchId}:lane-${l.lane}`;
				return (
					<LaneCell
						key={l.lane}
						lane={l}
						currentTask={currentTask}
						showRepos={showRepos}
						onView={onViewLane ? () => onViewLane(laneConvId) : undefined}
					/>
				);
			})}
		</div>
	);
}

// ---------------------------------------------------------------------------
// LaneCell — progress-bar-first layout
// ---------------------------------------------------------------------------

interface LaneCellProps {
	lane: LaneStatus;
	currentTask: TaskOutcome | null;
	showRepos: boolean;
	onView?: () => void;
}

/** Progress fraction + display flags for the lane bar. */
interface LaneBarState {
	pct: number;
	knownPct: boolean;
	indeterminate: boolean;
}

function computeLaneBar(lane: LaneStatus, task: TaskOutcome | null): LaneBarState {
	const sd = task?.statusData;
	if (sd && sd.total > 0) {
		return {
			pct: Math.round((sd.checked / sd.total) * 100),
			knownPct: true,
			indeterminate: false,
		};
	}
	switch (lane.status) {
		case "complete":
			return { pct: 100, knownPct: true, indeterminate: false };
		case "failed":
		case "stalled":
			return { pct: 100, knownPct: false, indeterminate: false };
		case "running":
			return { pct: 50, knownPct: false, indeterminate: true };
		default:
			return { pct: 0, knownPct: false, indeterminate: false };
	}
}

function LaneCell({ lane, currentTask, showRepos, onView }: LaneCellProps) {
	const [copied, setCopied] = useState(false);
	const tel = currentTask?.telemetry;
	const isRetryActive = tel?.retryActive === true;
	const cellClass = `lane-cell lane-${lane.status}${isRetryActive ? " lane-retrying" : ""}`;
	const laneRepoId = lane.repoId ?? currentTask?.resolvedRepoId ?? currentTask?.repoId;
	const segmentInfo = currentTask ? taskSegmentProgress(currentTask) : null;
	const bar = computeLaneBar(lane, currentTask);
	const fillClass = bar.indeterminate
		? `lane-bar-fill lane-bar-fill--${lane.status} lane-bar-fill--indeterminate`
		: `lane-bar-fill lane-bar-fill--${lane.status}`;
	const taskLabel = currentTask?.taskId ?? lane.taskId ?? null;

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
			{/* Dominant progress bar — status colour + percentage lives here. */}
			<div className="lane-bar" title={bar.knownPct ? `${bar.pct}% complete` : `Lane ${lane.lane} · ${lane.status}`}>
				<div className={fillClass} style={{ width: `${bar.pct}%` }} />
				<div className="lane-bar-overlay">
					<span className="lane-bar-pct">{bar.knownPct ? `${bar.pct}%` : ""}</span>
					{onView && (
						<button
							type="button"
							className="lane-bar-view"
							onClick={onView}
							title="View conversation"
							aria-label={`View lane ${lane.lane} conversation`}
						>
							<Eye size={11} />
							<span>View</span>
						</button>
					)}
				</div>
			</div>

			{/* Label row: lane id · status · task · step progress · repo/segment chips */}
			<div className="lane-bar-label">
				<LaneIcon status={lane.status} />
				<span className="text-xs font-mono text-[var(--text-muted)]">lane {lane.lane}</span>
				<span className="text-[11px] uppercase tracking-wider" style={{ color: statusColor(lane.status) }}>
					{lane.status}
				</span>
				{taskLabel ? (
					<span className="text-xs text-[var(--text-secondary)] lane-bar-label-task">· {taskLabel}</span>
				) : (
					<span className="text-xs text-[var(--text-muted)]">· idle</span>
				)}
				{lane.stepProgress && <span className="text-[11px] text-[var(--text-muted)]">· {lane.stepProgress}</span>}
				{lane.iteration > 1 && (
					<span className="text-[11px] text-[var(--text-muted)]" title="Iteration/retry count">
						· i{lane.iteration}
					</span>
				)}
				{showRepos && laneRepoId && <RepoBadge repoId={laneRepoId} />}
				{segmentInfo && <SegmentChip info={segmentInfo} />}
			</div>

			{/* Worker stats + retry/compaction inline badges. */}
			{tel && <WorkerStatsRow telemetry={tel} lane={lane} />}

			{/* Reviewer sub-row when reviewer agent is running. */}
			{lane.reviewer?.active && <ReviewerSubRow status={lane.reviewer} />}

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

function WorkerStatsRow({ telemetry, lane }: { telemetry: TaskTelemetry; lane: LaneStatus }) {
	const totalIn = telemetry.inputTokens + telemetry.cacheReadTokens;
	const out = telemetry.outputTokens;
	const hasTokens = totalIn > 0 || out > 0;
	const ctx = typeof telemetry.contextPct === "number" ? Math.round(telemetry.contextPct) : null;
	const hasAny =
		hasTokens ||
		telemetry.toolCalls > 0 ||
		ctx !== null ||
		(telemetry.lastTool ?? "").length > 0 ||
		lane.elapsed > 0 ||
		(telemetry.retries ?? 0) > 0 ||
		telemetry.retryActive === true ||
		(telemetry.compactions ?? 0) > 0;
	if (!hasAny) return null;

	let tokenChip: string | null = null;
	if (hasTokens) {
		tokenChip = `↑${formatTokens(totalIn)} ↓${formatTokens(out)}`;
		if (telemetry.costUsd > 0) tokenChip += ` $${telemetry.costUsd.toFixed(2)}`;
	}

	return (
		<div className="worker-stats mb-2">
			{lane.elapsed > 0 && (
				<span className="worker-stat" title="Worker elapsed">
					<Clock size={10} /> {formatDuration(lane.elapsed)}
				</span>
			)}
			{telemetry.toolCalls > 0 && (
				<span className="worker-stat" title="Tool calls">
					<Wrench size={10} /> {telemetry.toolCalls}
				</span>
			)}
			{ctx !== null && (
				<span className="worker-stat" title="Context window used">
					<Gauge size={10} /> {ctx}%
				</span>
			)}
			{tokenChip && (
				<span className="worker-stat" title="Tokens: input↑ output↓ cost">
					<DollarSign size={10} /> {tokenChip}
				</span>
			)}
			{telemetry.lastTool && (
				<span className="worker-stat worker-last-tool" title="Last tool invocation">
					{telemetry.lastTool}
				</span>
			)}
			{telemetry.retryActive && (
				<span
					className="telem-badge telem-retry-active"
					title={
						telemetry.lastRetryError ? `Retry in progress — ${telemetry.lastRetryError}` : "Retry in progress"
					}
				>
					<RefreshCw size={10} /> retrying
				</span>
			)}
			{!telemetry.retryActive && (telemetry.retries ?? 0) > 0 && (
				<span className="telem-badge telem-retry" title={`${telemetry.retries} auto-retry event(s)`}>
					<RefreshCw size={10} /> {telemetry.retries}
				</span>
			)}
			{(telemetry.compactions ?? 0) > 0 && (
				<span className="telem-badge telem-compaction" title={`${telemetry.compactions} context compaction(s)`}>
					<Layers size={10} /> {telemetry.compactions}
				</span>
			)}
		</div>
	);
}

function ReviewerSubRow({ status }: { status: ReviewerStatus }) {
	const elapsed = status.elapsedMs ? formatDuration(status.elapsedMs) : null;
	const tools = typeof status.toolCalls === "number" ? status.toolCalls : null;
	const ctx = typeof status.contextPct === "number" ? Math.round(status.contextPct) : null;
	const tokensIn = (status.inputTokens ?? 0) + (status.cacheReadTokens ?? 0);
	const tokensOut = status.outputTokens ?? 0;
	const tokenStr = tokensIn > 0 || tokensOut > 0 ? `↑${formatTokens(tokensIn)} ↓${formatTokens(tokensOut)}` : null;
	return (
		<div className="reviewer-sub-row">
			<div className="reviewer-sub-row-header">
				<span className="reviewer-sub-row-label">
					<ClipboardCheck size={10} /> Reviewer
				</span>
				{status.reviewType && <span className="text-[10px] text-[var(--text-muted)]">{status.reviewType}</span>}
				{typeof status.reviewStep === "number" && (
					<span className="text-[10px] text-[var(--text-muted)]">Step {status.reviewStep}</span>
				)}
			</div>
			<div className="worker-stats">
				{elapsed && (
					<span className="worker-stat" title="Reviewer elapsed">
						<Clock size={10} /> {elapsed}
					</span>
				)}
				{tools !== null && tools > 0 && (
					<span className="worker-stat" title="Reviewer tool calls">
						<Wrench size={10} /> {tools}
					</span>
				)}
				{ctx !== null && ctx > 0 && (
					<span className="worker-stat" title="Reviewer context used">
						<Gauge size={10} /> {ctx}%
					</span>
				)}
				{tokenStr && (
					<span className="worker-stat" title="Reviewer tokens">
						<DollarSign size={10} /> {tokenStr}
					</span>
				)}
				{status.lastTool && (
					<span className="worker-stat worker-last-tool" title="Reviewer last tool">
						{status.lastTool}
					</span>
				)}
			</div>
		</div>
	);
}

function RepoBadge({ repoId }: { repoId: string }) {
	return (
		<span className="repo-badge" title={`Repo: ${repoId}`}>
			{repoId}
		</span>
	);
}

function SegmentChip({ info }: { info: { index: number; total: number; repoId?: string } }) {
	return (
		<span className="segment-chip" title={`Active segment: ${info.repoId ?? "unknown"}`}>
			{segmentProgressText(info)}
		</span>
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
