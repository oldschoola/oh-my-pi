import { Clock } from "lucide-react";
import { useEffect, useState } from "react";
import { getMissionEvents, getMissionTelemetry, subscribeMission } from "../api";
import type { MissionDetail as MissionDetailType, TelemetryEvent, TelemetrySummary } from "../types";
import { EventFeed } from "./EventFeed";
import { LaneGrid } from "./LaneGrid";
import { PhaseTimeline } from "./PhaseTimeline";
import { StatusBadge } from "./StatusBadge";
import { TelemetryPanel } from "./TelemetryPanel";

export function MissionDetail({
	initialDetail,
	onViewLane,
}: {
	initialDetail: MissionDetailType;
	onViewLane?: (laneId: string) => void;
}) {
	const [detail, setDetail] = useState<MissionDetailType>(initialDetail);
	const [events, setEvents] = useState<TelemetryEvent[]>([]);
	const [telemetry, setTelemetry] = useState<TelemetrySummary>({});
	const [now, setNow] = useState(Date.now());

	// Tick every second for live elapsed timer
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	useEffect(() => {
		setDetail(initialDetail);
	}, [initialDetail]);

	useEffect(() => {
		const id = detail.id;
		const unsub = subscribeMission(id, snap => setDetail(snap));
		let cancelled = false;
		const loadSidecars = async () => {
			try {
				const [evts, tele] = await Promise.all([getMissionEvents(id), getMissionTelemetry(id)]);
				if (!cancelled) {
					setEvents(evts);
					setTelemetry(tele);
				}
			} catch {
				// sidecar data is supplemental — silently skip if unavailable
			}
		};
		void loadSidecars();
		const interval = setInterval(loadSidecars, 5000);
		return () => {
			cancelled = true;
			unsub();
			clearInterval(interval);
		};
	}, [detail.id]);

	const state = detail.state;
	const isActive = detail.status === "active" || detail.status === "paused";

	// Compute duration — live ticking for active, static for completed
	let duration: string | null = null;
	if (state.startedAt && state.completedAt && !isActive) {
		duration = durationBetween(state.startedAt, state.completedAt);
	} else if (state.startedAt && isActive) {
		const ms = now - new Date(state.startedAt).getTime();
		if (ms > 0) duration = formatDuration(ms);
	}

	return (
		<div className="space-y-6 animate-fade-in">
			<div className="surface gradient-border p-5">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0 flex-1">
						<div className="font-mono text-xs text-[var(--text-muted)] mb-1">{detail.id}</div>
						<h2 className="text-lg font-semibold text-[var(--text-primary)]">
							{state.description || "(no description)"}
						</h2>
						<div className="mt-3 flex flex-wrap items-center gap-2">
							<span
								className="badge"
								style={{
									background: "color-mix(in srgb, var(--accent-violet) 12%, transparent)",
									color: "var(--accent-violet)",
								}}
							>
								{detail.kind}
							</span>
							{duration && (
								<span className="text-xs text-[var(--text-muted)] font-mono flex items-center gap-1">
									<Clock size={10} />
									{duration}
								</span>
							)}
						</div>
					</div>
					<StatusBadge status={detail.status} />
				</div>
			</div>

			{detail.kind === "batch" && state.batch ? (
				<LaneGrid batch={state.batch} onViewLane={onViewLane} />
			) : (
				<div className="surface p-5">
					<SectionHeader label="Phases" />
					<PhaseTimeline phases={state.phases ?? []} />
				</div>
			)}

			<div className="surface p-5">
				<SectionHeader label="Telemetry" />
				<TelemetryPanel telemetry={telemetry} />
			</div>

			<div className="surface p-5">
				<SectionHeader label={`Events (${events.length})`} />
				<EventFeed events={events} />
			</div>
		</div>
	);
}

function SectionHeader({ label }: { label: string }) {
	return <h3 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-4">{label}</h3>;
}

function durationBetween(startIso: string, endIso: string): string {
	try {
		const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
		return formatDuration(ms);
	} catch {
		return "";
	}
}

function formatDuration(ms: number): string {
	if (ms <= 0) return "0s";
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
	return `${m}m ${String(s).padStart(2, "0")}s`;
}
