import type { TelemetryEvent } from "../types";

export function EventFeed({ events }: { events: TelemetryEvent[] }) {
	if (events.length === 0) {
		return <div className="text-sm text-[var(--text-muted)]">No telemetry events yet.</div>;
	}
	return (
		<div className="surface max-h-96 overflow-y-auto">
			{events.slice(-200).map((ev, idx) => (
				<div key={idx} className="event-row">
					<span className="text-[var(--accent-cyan)]">{String(ev.type ?? "event")}</span>
					{ev.ts && typeof ev.ts === "number" && (
						<span className="text-[var(--text-muted)] ml-2">{new Date(ev.ts).toLocaleTimeString()}</span>
					)}
					<span className="ml-2">{summarize(ev)}</span>
				</div>
			))}
		</div>
	);
}

function summarize(ev: TelemetryEvent): string {
	const { type: _t, ts: _ts, ...rest } = ev;
	const entries = Object.entries(rest).slice(0, 4);
	if (entries.length === 0) return "";
	return entries
		.map(([k, v]) => {
			if (typeof v === "string") return `${k}=${truncate(v, 80)}`;
			if (typeof v === "number" || typeof v === "boolean") return `${k}=${v}`;
			return `${k}=…`;
		})
		.join(" ");
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}
