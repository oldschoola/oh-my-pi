import { formatDistanceToNow } from "date-fns";
import { useEffect, useState } from "react";
import { getMissionEvents, getMissionTelemetry, subscribeMission } from "../api";
import type { MissionDetail as MissionDetailType, TelemetryEvent, TelemetrySummary } from "../types";
import { EventFeed } from "./EventFeed";
import { LaneGrid } from "./LaneGrid";
import { PhaseTimeline } from "./PhaseTimeline";
import { StatusBadge } from "./StatusBadge";
import { TelemetryPanel } from "./TelemetryPanel";

export function MissionDetail({ initialDetail }: { initialDetail: MissionDetailType }) {
	const [detail, setDetail] = useState<MissionDetailType>(initialDetail);
	const [events, setEvents] = useState<TelemetryEvent[]>([]);
	const [telemetry, setTelemetry] = useState<TelemetrySummary>({});

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
			} catch (err) {
				console.error(err);
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
	return (
		<div className="space-y-6 animate-fade-in">
			<div className="surface p-5">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0">
						<div className="font-mono text-xs text-[var(--text-muted)]">{detail.id}</div>
						<h2 className="text-lg font-semibold mt-1">{state.description || "(no description)"}</h2>
						<div className="mt-2 flex items-center gap-3 text-xs text-[var(--text-muted)]">
							<span>Started {relative(state.startedAt)}</span>
							{state.completedAt && <span>Completed {relative(state.completedAt)}</span>}
							<span>Kind: {detail.kind}</span>
						</div>
					</div>
					<StatusBadge status={detail.status} />
				</div>
			</div>

			{detail.kind === "batch" && state.batch ? (
				<LaneGrid batch={state.batch} />
			) : (
				<div className="surface p-5">
					<h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-3">Phases</h3>
					<PhaseTimeline phases={state.phases ?? []} />
				</div>
			)}

			<div>
				<h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-3">Telemetry</h3>
				<TelemetryPanel telemetry={telemetry} />
			</div>

			<div>
				<h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-3">
					Events ({events.length})
				</h3>
				<EventFeed events={events} />
			</div>
		</div>
	);
}

function relative(iso: string): string {
	try {
		return formatDistanceToNow(new Date(iso), { addSuffix: true });
	} catch {
		return iso;
	}
}
