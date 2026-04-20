import { Clock } from "lucide-react";
import { useEffect, useState } from "react";
import { getMissionEvents, getMissionTelemetry, subscribeMission } from "../api";
import { formatDuration } from "../format";
import type { MissionDetail as MissionDetailType, TelemetryEvent, TelemetrySummary } from "../types";
import { ErrorsPanel } from "./ErrorsPanel";
import { EventFeed } from "./EventFeed";
import { LaneGrid } from "./LaneGrid";
import { PhaseTimeline } from "./PhaseTimeline";
import { StatusBadge } from "./StatusBadge";
import { SummaryBar } from "./SummaryBar";
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

	const state = detail.state;
	const isActive = detail.status === "active" || detail.status === "paused";

	// Tick every second while active so the elapsed timer stays live.
	// Completed/failed missions render a static duration — no need to tick.
	useEffect(() => {
		if (!isActive) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [isActive]);

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

	// Compute duration — live ticking for active, static for completed.
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
				<>
					<SummaryBar
						batch={state.batch}
						summary={{ cost: detail.cost, aggregateTokens: detail.aggregateTokens }}
					/>
					<LaneGrid batch={state.batch} onViewLane={onViewLane} />
					<ErrorsPanel errors={state.batch.errors ?? []} />
				</>
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
