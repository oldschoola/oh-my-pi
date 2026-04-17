import { formatDistanceToNow } from "date-fns";
import { Boxes, Layers } from "lucide-react";
import type { MissionSummary } from "../types";
import { StatusBadge } from "./StatusBadge";

export function MissionList({
	missions,
	selectedId,
	onSelect,
}: {
	missions: MissionSummary[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	if (missions.length === 0) {
		return (
			<div className="surface p-6 text-center text-[var(--text-muted)] text-sm">
				No missions yet. Start one with <code className="font-mono">/mission</code> in a pi session.
			</div>
		);
	}

	return (
		<div className="surface overflow-hidden">
			<div className="divide-y divide-[var(--border-subtle)]">
				{missions.map(m => {
					const isSelected = selectedId === m.id;
					return (
						<button
							type="button"
							key={m.id}
							onClick={() => onSelect(m.id)}
							className={`w-full text-left px-4 py-3 transition ${isSelected ? "bg-[var(--bg-active)]" : "hover:bg-[var(--bg-hover)]"}`}
						>
							<div className="flex items-center justify-between gap-3">
								<div className="flex items-center gap-2 min-w-0">
									{m.kind === "batch" ? (
										<Boxes size={14} className="text-[var(--accent-violet)] shrink-0" />
									) : (
										<Layers size={14} className="text-[var(--accent-cyan)] shrink-0" />
									)}
									<span className="font-mono text-xs text-[var(--text-muted)] shrink-0">
										{m.id.slice(0, 8)}
									</span>
									<span className="truncate text-sm">{m.description || "(no description)"}</span>
								</div>
								<StatusBadge status={m.status} />
							</div>
							<div className="mt-1 text-xs text-[var(--text-muted)] flex items-center gap-3">
								<span>Started {formatRelative(m.startedAt)}</span>
								{m.kind === "batch" && m.laneCount !== undefined && <span>{m.laneCount} lanes</span>}
								{m.kind === "simple" && m.phaseCount !== undefined && (
									<span>
										{m.completedPhases ?? 0}/{m.phaseCount} phases
									</span>
								)}
							</div>
						</button>
					);
				})}
			</div>
		</div>
	);
}

function formatRelative(iso: string): string {
	try {
		return formatDistanceToNow(new Date(iso), { addSuffix: true });
	} catch {
		return iso;
	}
}
