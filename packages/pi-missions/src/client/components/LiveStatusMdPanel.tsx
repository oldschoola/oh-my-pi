import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { getTaskStatusMd } from "../api";
import type { BatchState, TaskOutcome } from "../types";
import { StatusMdView } from "./StatusMdView";

/**
 * Always-visible live STATUS.md viewer for batch missions.
 *
 * Picks the "most interesting" task (first lane-bound task, else first running
 * task, else first task overall), polls its STATUS.md every 3s, and renders
 * through {@link StatusMdView}. A tab strip lets the operator switch between
 * tasks when a batch has more than one.
 */
export function LiveStatusMdPanel({ batch }: { batch: BatchState }) {
	const tasks = batch.tasks ?? [];
	const defaultId = pickDefaultTaskId(batch);
	const [selectedId, setSelectedId] = useState<string | null>(defaultId);
	const [markdown, setMarkdown] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [follow, setFollow] = useState(true);

	// When the batch's task set changes and the current selection is stale,
	// fall back to the default task so we don't render a dead panel.
	useEffect(() => {
		if (!selectedId || !tasks.some(t => t.taskId === selectedId)) {
			setSelectedId(pickDefaultTaskId(batch));
		}
	}, [batch, selectedId, tasks]);

	useEffect(() => {
		if (!selectedId) {
			setMarkdown(null);
			return;
		}
		let cancelled = false;
		const load = async () => {
			setLoading(true);
			try {
				const text = await getTaskStatusMd(selectedId);
				if (!cancelled) setMarkdown(text);
			} catch {
				if (!cancelled) setMarkdown(null);
			} finally {
				if (!cancelled) setLoading(false);
			}
		};
		void load();
		const interval = setInterval(load, 3000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [selectedId]);

	if (tasks.length === 0) return null;

	return (
		<div className="surface p-4 space-y-3">
			<div className="flex items-center gap-2">
				<FileText size={14} className="text-[var(--accent-cyan)]" />
				<h3 className="font-medium text-sm">Live STATUS.md</h3>
				{loading && <span className="text-[10px] text-[var(--text-muted)] font-mono">refreshing…</span>}
			</div>
			{tasks.length > 1 && (
				<div className="pi-lane-tabs">
					{tasks.map(t => (
						<TaskTab
							key={t.taskId}
							task={t}
							active={t.taskId === selectedId}
							onSelect={() => setSelectedId(t.taskId)}
						/>
					))}
				</div>
			)}
			<StatusMdView
				markdown={markdown}
				follow={follow}
				onToggleFollow={() => setFollow(f => !f)}
				emptyMessage={selectedId ? `No STATUS.md for ${selectedId} yet.` : "No task selected."}
			/>
		</div>
	);
}

function pickDefaultTaskId(batch: BatchState): string | null {
	const tasks = batch.tasks ?? [];
	if (tasks.length === 0) return null;
	// Prefer a task currently bound to a running lane.
	for (const lane of batch.laneStatuses ?? []) {
		if (lane.status === "running" && lane.taskId) return lane.taskId;
	}
	// Otherwise pick the first task that is still in flight.
	const inFlight = tasks.find(t => t.status !== "succeeded" && t.status !== "failed");
	return (inFlight ?? tasks[0]).taskId;
}

function TaskTab({ task, active, onSelect }: { task: TaskOutcome; active: boolean; onSelect: () => void }) {
	const sd = task.statusData;
	const pct = sd && sd.total > 0 ? Math.round((sd.checked / sd.total) * 100) : null;
	return (
		<button
			type="button"
			className={`pi-lane-tab${active ? " active" : ""}`}
			onClick={onSelect}
			aria-pressed={active}
		>
			<span className={`pi-lane-tab-dot ${task.status === "succeeded" ? "complete" : "running"}`} />
			<span>{task.taskId}</span>
			{pct !== null && <span className="text-[var(--text-muted)]">· {pct}%</span>}
		</button>
	);
}
