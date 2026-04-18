import type { MissionStatus } from "../types";

const LABELS: Record<MissionStatus, string> = {
	active: "Active",
	paused: "Paused",
	completed: "Completed",
	failed: "Failed",
};

export function StatusBadge({ status }: { status: MissionStatus }) {
	return <span className={`badge badge-${status}`}>{LABELS[status]}</span>;
}
