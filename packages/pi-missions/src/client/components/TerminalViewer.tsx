import { FileText, MessageSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	getAgentEvents,
	getLaneConversationEvents,
	getMissionAgentStatus,
	getTaskStatusMd,
	resolveWorkerAgentId,
} from "../api";
import { filterStatusMdForSegment } from "../format";
import type { LaneStatus, TaskOutcome, TelemetryEvent } from "../types";
import { LaneSwitcher } from "./LaneSwitcher";
import { StatusMdView } from "./StatusMdView";
import { WorkerTerminal } from "./WorkerTerminal";

/**
 * Parse the numeric lane from common lane id shapes: `lane-3`, `batchId:lane-3`.
 * Returns null when the input does not encode a lane number.
 */
function parseLaneNumber(laneId: string | undefined): number | null {
	if (!laneId) return null;
	const tail = laneId.includes(":") ? (laneId.split(":")[1] ?? "") : laneId;
	const m = tail.match(/^lane-(\d+)$/);
	return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Short human-readable identifier for the worker toolbar. Prefers the parsed
 * lane number (e.g. `lane-1`) and falls back to the tail of the V2 agent id.
 */
function laneLabel(laneId: string | undefined, v2AgentId: string | null): string | undefined {
	const laneNumber = parseLaneNumber(laneId);
	if (laneNumber !== null) return `lane-${laneNumber}`;
	if (v2AgentId) {
		const tail = v2AgentId.split(/[:/]/).pop() ?? v2AgentId;
		return tail.length > 20 ? `…${tail.slice(-20)}` : tail;
	}
	return undefined;
}

export function TerminalViewer({
	missionId,
	laneId,
	taskId,
	currentTask,
	missionLog,
	follow,
	onToggleFollow,
	onClose,
	lanes,
	batchId,
	onPickLane,
}: {
	missionId?: string;
	laneId?: string;
	taskId?: string;
	/** Full task record — used for segment-aware STATUS.md filtering. */
	currentTask?: TaskOutcome;
	missionLog?: string;
	/** STATUS.md auto-follow toggle. Controlled by parent so preference persists. */
	follow: boolean;
	onToggleFollow: () => void;
	/** When provided, renders a close button that collapses the viewer back. */
	onClose?: () => void;
	/** Lane list powering the in-view worker switcher. Omit/empty to hide the strip. */
	lanes?: LaneStatus[];
	/** Batch id prefix for composing `{batchId}:lane-{N}` when picking from the switcher. */
	batchId?: string;
	/** Called when the operator picks a different lane from the switcher. */
	onPickLane?: (laneId: string) => void;
}) {
	const [events, setEvents] = useState<TelemetryEvent[]>([]);
	const [statusMd, setStatusMd] = useState<string | null>(null);
	const [v2AgentId, setV2AgentId] = useState<string | null>(null);
	const lastTsRef = useRef<number>(0);

	// Resolve lane → V2 agent id whenever the lane or mission changes. When
	// found, subsequent event polls go through /api/agent-events/<agentId>
	// (the Runtime V2 stream); otherwise we fall back to the legacy lane JSONL.
	useEffect(() => {
		let cancelled = false;
		const laneNumber = parseLaneNumber(laneId);
		if (!missionId || laneNumber === null) {
			setV2AgentId(null);
			return;
		}
		void getMissionAgentStatus(missionId).then(status => {
			if (cancelled) return;
			setV2AgentId(resolveWorkerAgentId(laneNumber, status.registry));
		});
		return () => {
			cancelled = true;
		};
	}, [missionId, laneId]);

	// Event loader — one polling loop per (v2AgentId or laneId) source. We reset
	// the events array when the source switches so we never mix V2 and legacy
	// events in the same stream.
	useEffect(() => {
		let cancelled = false;
		lastTsRef.current = 0;
		setEvents([]);
		async function load() {
			const [ev, s] = await Promise.all([
				v2AgentId
					? getAgentEvents(v2AgentId, lastTsRef.current)
					: laneId
						? getLaneConversationEvents(laneId)
						: Promise.resolve([]),
				taskId ? getTaskStatusMd(taskId) : Promise.resolve(null),
			]);
			if (cancelled) return;
			if (v2AgentId) {
				// Incremental append; advance the watermark to the latest ts we saw.
				if (ev.length > 0) {
					setEvents(prev => [...prev, ...ev]);
					const tail = ev[ev.length - 1];
					if (tail && typeof tail.ts === "number" && tail.ts > lastTsRef.current) {
						lastTsRef.current = tail.ts;
					}
				}
			} else {
				setEvents(ev);
			}
			setStatusMd(s);
		}
		void load();
		const interval = setInterval(load, 3000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [v2AgentId, laneId, taskId]);

	if (!laneId && !taskId) {
		if (missionLog) {
			return (
				<div className="surface p-4">
					<pre
						className="text-xs whitespace-pre-wrap max-h-96 overflow-y-auto p-3 rounded-[var(--radius-md)]"
						style={{
							background: "var(--bg-elevated)",
							border: "1px solid var(--border-subtle)",
							fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
						}}
					>
						{missionLog}
					</pre>
				</div>
			);
		}
		return (
			<div className="surface p-8 flex flex-col items-center justify-center gap-2">
				<MessageSquare size={24} className="text-[var(--text-muted)] opacity-30" />
				<p className="text-xs text-[var(--text-muted)]">Select a lane or task to inspect its transcript.</p>
			</div>
		);
	}

	// Segment-scoped STATUS.md: when the task has multiple segments, filter to
	// the active segment's block so reviewers see only the relevant scope.
	const displayStatusMd = currentTask && statusMd ? filterStatusMdForActiveSegment(statusMd, currentTask) : statusMd;

	return (
		<div className="space-y-4">
			<div className="surface p-4">
				{lanes && lanes.length > 0 && (
					<LaneSwitcher lanes={lanes} currentLaneId={laneId} batchIdPrefix={batchId} onPickLane={onPickLane} />
				)}
				<div className="flex items-center gap-2 mb-2">
					<div
						className="p-1.5"
						style={{
							borderRadius: "var(--radius-sm)",
							background: "color-mix(in srgb, var(--accent-cyan) 12%, transparent)",
						}}
					>
						<MessageSquare size={12} style={{ color: "var(--accent-cyan)" }} />
					</div>
					<h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] flex-1">
						Conversation {laneId ? `(${laneId})` : ""}
					</h3>
					{onClose && (
						<button
							type="button"
							className="btn-icon"
							onClick={onClose}
							aria-label="Close terminal viewer"
							title="Close"
						>
							<X size={11} />
						</button>
					)}
				</div>
				<WorkerTerminal
					key={v2AgentId ?? laneId ?? "none"}
					agentKey={v2AgentId ?? laneId ?? "none"}
					agentLabel={laneLabel(laneId, v2AgentId)}
					events={events}
				/>
			</div>

			<div className="surface p-4">
				<div className="flex items-center gap-2 mb-2">
					<div
						className="p-1.5"
						style={{
							borderRadius: "var(--radius-sm)",
							background: "color-mix(in srgb, var(--accent-amber) 12%, transparent)",
						}}
					>
						<FileText size={12} style={{ color: "var(--accent-amber)" }} />
					</div>
					<h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
						STATUS.md {taskId ? `(${taskId})` : ""}
					</h3>
				</div>
				<StatusMdView
					markdown={displayStatusMd}
					follow={follow}
					onToggleFollow={onToggleFollow}
					emptyMessage={taskId ? "No STATUS.md found." : "No task selected."}
				/>
			</div>
		</div>
	);
}

/**
 * For a multi-segment task, drop `#### Segment: <repoId>` blocks inside each
 * `### Step N:` section that don't match the active segment. Non-step content
 * (headers, metadata, reviews) is preserved.
 *
 * Returns the original markdown when the task has one or zero segments.
 */
function filterStatusMdForActiveSegment(markdown: string, task: TaskOutcome): string {
	const segmentIds = task.segmentIds ?? [];
	if (segmentIds.length <= 1) return markdown;
	const activeId = task.activeSegmentId && segmentIds.includes(task.activeSegmentId) ? task.activeSegmentId : null;
	if (!activeId) return markdown;
	const sep = activeId.indexOf("::");
	if (sep < 0) return markdown;
	const activeRepoId = activeId.slice(sep + 2).split("::")[0];
	return filterStatusMdForSegment(markdown, activeRepoId);
}
