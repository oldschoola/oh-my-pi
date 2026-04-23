import { Activity } from "lucide-react";
import { useEffect, useState } from "react";
import { formatDuration } from "../format";
import type { MissionDetail } from "../types";

/**
 * Header pill that surfaces the currently-selected mission's identity and
 * elapsed clock. Clicking jumps the Active tab to the mission detail.
 */
export function ActiveMissionPill({ detail, onClick }: { detail: MissionDetail | null; onClick: () => void }) {
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		if (!detail || detail.status === "completed" || detail.status === "failed") return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [detail]);

	if (!detail) return null;
	const batchId = detail.state.batch?.batchId;
	const phase =
		detail.state.batch?.phase ?? (detail.state.paused ? "paused" : detail.state.completedAt ? "done" : "running");
	const elapsed = formatDuration(now - new Date(detail.state.startedAt).getTime());

	return (
		<button type="button" className="active-mission-pill" onClick={onClick} title={`Jump to mission ${detail.id}`}>
			<Activity size={11} />
			<span className="active-mission-pill-id">{batchId ?? detail.id}</span>
			<span className="active-mission-pill-sep">·</span>
			<span className="active-mission-pill-phase">{phase}</span>
			<span className="active-mission-pill-sep">·</span>
			<span className="active-mission-pill-elapsed">{elapsed}</span>
		</button>
	);
}
