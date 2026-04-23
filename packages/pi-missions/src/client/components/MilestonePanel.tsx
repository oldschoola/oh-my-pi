import { Flag } from "lucide-react";
import { useState } from "react";
import { useMilestones, useValidationStatus } from "../hooks/useMilestones";
import type { BatchMilestoneStatus, ClientMilestone, MilestoneStatusRow } from "../types";
import { MilestoneDetailModal } from "./MilestoneDetailModal";

const STATUS_COLORS: Record<BatchMilestoneStatus, string> = {
	pending: "var(--text-muted)",
	in_progress: "var(--accent-cyan)",
	validating: "var(--accent-amber)",
	passed: "var(--accent-green)",
	failed: "var(--accent-red)",
};

export function MilestonePanel({ missionId }: { missionId: string | null }) {
	const { data: milestones, error } = useMilestones(missionId);
	const { data: status } = useValidationStatus(missionId);
	const [openId, setOpenId] = useState<string | null>(null);

	if (error) {
		return <div className="surface p-4 text-xs text-[var(--accent-red)]">Milestones unavailable: {error}</div>;
	}

	if (!milestones || milestones.length === 0) {
		return (
			<div className="surface p-4 text-xs text-[var(--text-muted)] flex items-center gap-2">
				<Flag size={12} />
				<span>No milestones defined yet.</span>
			</div>
		);
	}

	const statusById = new Map<string, MilestoneStatusRow>();
	for (const row of status?.rows ?? []) statusById.set(row.milestone.id, row);

	const openMilestone = openId ? milestones.find(m => m.id === openId) : null;
	const openDetails = openId ? statusById.get(openId) : undefined;

	return (
		<div className="surface p-4 space-y-3">
			<div className="flex items-center gap-2">
				<Flag size={14} className="text-[var(--accent-violet)]" />
				<h3 className="font-medium text-sm">Milestones ({milestones.length})</h3>
			</div>
			<ul className="space-y-2">
				{milestones.map(m => (
					<MilestoneRow key={m.id} milestone={m} details={statusById.get(m.id)} onOpen={() => setOpenId(m.id)} />
				))}
			</ul>
			{openMilestone && (
				<MilestoneDetailModal milestone={openMilestone} details={openDetails} onClose={() => setOpenId(null)} />
			)}
		</div>
	);
}

function MilestoneRow({
	milestone,
	details,
	onOpen,
}: {
	milestone: ClientMilestone;
	details?: MilestoneStatusRow;
	onOpen: () => void;
}) {
	const color = STATUS_COLORS[milestone.status];
	return (
		<li>
			<button
				type="button"
				onClick={onOpen}
				aria-label={`Open details for milestone ${milestone.id}`}
				className="milestone-row-clickable rounded p-3 space-y-1.5 w-full text-left"
			>
				<div className="flex items-center justify-between gap-2">
					<div className="min-w-0">
						<div className="text-xs font-mono text-[var(--text-muted)]">{milestone.id}</div>
						<div className="text-sm font-medium text-[var(--text-primary)] truncate">{milestone.name}</div>
					</div>
					<span
						className="badge text-[10px]"
						style={{
							background: `color-mix(in srgb, ${color} 16%, transparent)`,
							color,
						}}
					>
						{milestone.status}
					</span>
				</div>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[var(--text-muted)] font-mono">
					<span>
						Round {milestone.validationRounds}/{milestone.maxValidationRounds}
					</span>
					<span>
						{milestone.featureIds.length} feature{milestone.featureIds.length === 1 ? "" : "s"}
					</span>
					<span>
						{milestone.assertionIds.length} assertion{milestone.assertionIds.length === 1 ? "" : "s"}
					</span>
				</div>
				{details?.boundAssertions && details.boundAssertions.length > 0 && (
					<div className="text-[10px] text-[var(--text-muted)] font-mono">
						{details.boundAssertions.length} bound assertion
						{details.boundAssertions.length === 1 ? "" : "s"}
					</div>
				)}
				{details?.findings && details.findings.length > 0 && (
					<div className="text-[10px] font-mono text-[var(--accent-amber)]">
						{details.findings.length} finding{details.findings.length === 1 ? "" : "s"}
					</div>
				)}
			</button>
		</li>
	);
}
