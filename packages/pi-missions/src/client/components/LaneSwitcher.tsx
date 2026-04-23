import type { LaneStatus } from "../types";

/**
 * Horizontal pill strip that lets operators flip between worker terminals
 * without returning to the lane grid. Each pill shows `lane-{N}` + a live
 * status dot tied to `lane.status`. Hidden by the caller when the mission
 * has no lanes (non-batch missions).
 */
export function LaneSwitcher({
	lanes,
	currentLaneId,
	batchIdPrefix,
	onPickLane,
}: {
	lanes: LaneStatus[];
	currentLaneId?: string;
	/** Explicit batch id when the caller owns it. Otherwise parsed from `currentLaneId`. */
	batchIdPrefix?: string;
	onPickLane?: (laneId: string) => void;
}) {
	if (lanes.length === 0) return null;

	const prefix = batchIdPrefix ?? (currentLaneId?.includes(":") ? currentLaneId.split(":")[0] : null);
	const currentLaneNumber = parseLaneNumber(currentLaneId);

	return (
		<div className="pi-lane-tabs" role="tablist" aria-label="Worker lanes">
			{lanes.map(lane => {
				const isActive = lane.lane === currentLaneNumber;
				const disabled = !onPickLane || !prefix;
				return (
					<button
						key={lane.lane}
						type="button"
						role="tab"
						aria-selected={isActive}
						className={`pi-lane-tab ${isActive ? "active" : ""}`}
						disabled={disabled}
						title={`Lane ${lane.lane} · ${lane.status}`}
						onClick={() => {
							if (!onPickLane || !prefix) return;
							onPickLane(`${prefix}:lane-${lane.lane}`);
						}}
					>
						<span className={`pi-lane-tab-dot ${lane.status}`} aria-hidden="true" />
						<span>lane-{lane.lane}</span>
					</button>
				);
			})}
		</div>
	);
}

function parseLaneNumber(laneId: string | undefined): number | null {
	if (!laneId) return null;
	const tail = laneId.includes(":") ? (laneId.split(":")[1] ?? "") : laneId;
	const m = tail.match(/^lane-(\d+)$/);
	return m ? Number.parseInt(m[1], 10) : null;
}
