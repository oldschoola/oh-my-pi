import { CheckCircle2, Clock, FileCheck } from "lucide-react";
import { useState } from "react";
import { approvePlan } from "../api";
import { usePlanManifest } from "../hooks/usePlanManifest";

export function PlanApprovalBanner({ missionId }: { missionId: string | null }) {
	const { data, refresh } = usePlanManifest(missionId);
	const [submitting, setSubmitting] = useState(false);
	const [feedback, setFeedback] = useState<string | null>(null);

	if (!data) return null;

	const approve = async () => {
		if (!missionId || !data) return;
		setSubmitting(true);
		setFeedback(null);
		try {
			const result = await approvePlan(missionId, {
				milestoneIds: data.milestoneIds,
				featureIds: data.featureIds,
				approvedBy: "dashboard",
			});
			if (result.ok) {
				refresh();
				setFeedback("Plan approved.");
			} else {
				setFeedback(result.reason ?? "Approval failed.");
			}
		} finally {
			setSubmitting(false);
		}
	};

	if (data.status === "approved") {
		return (
			<div
				className="surface p-3 flex items-center gap-2 text-xs text-[var(--accent-green)]"
				style={{ borderColor: "color-mix(in srgb, var(--accent-green) 30%, transparent)" }}
			>
				<CheckCircle2 size={14} />
				<span>
					Plan approved by <span className="font-mono">{data.approvedBy ?? "unknown"}</span> on{" "}
					{data.approvedAt ? new Date(data.approvedAt).toISOString() : "\u2014"}.
				</span>
				<span className="ml-auto text-[10px] text-[var(--text-muted)]">
					{data.milestoneIds.length} milestones · {data.featureIds.length} features
				</span>
			</div>
		);
	}

	if (data.status === "awaiting-approval") {
		return (
			<div
				className="surface p-4 space-y-3"
				style={{ borderColor: "color-mix(in srgb, var(--accent-amber) 30%, transparent)" }}
			>
				<div className="flex items-center gap-2">
					<Clock size={14} className="text-[var(--accent-amber)]" />
					<h3 className="font-medium text-sm">Plan awaiting approval</h3>
				</div>
				<div className="text-xs text-[var(--text-secondary)]">
					Planner drafted {data.milestoneIds.length} milestone{data.milestoneIds.length === 1 ? "" : "s"} and{" "}
					{data.featureIds.length} feature{data.featureIds.length === 1 ? "" : "s"}. Review the plan artifact then
					approve to start execution.
				</div>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => void approve()}
						disabled={submitting}
						className="text-xs px-3 py-1.5 rounded bg-[var(--accent-amber)] text-white disabled:opacity-50 flex items-center gap-1.5"
					>
						<FileCheck size={12} />
						{submitting ? "Approving\u2026" : "Approve plan"}
					</button>
					{feedback && <span className="text-[10px] text-[var(--text-muted)]">{feedback}</span>}
				</div>
			</div>
		);
	}

	return null;
}
