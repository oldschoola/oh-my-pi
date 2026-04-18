import { ChevronRight, RadioTower } from "lucide-react";
import { useEffect, useState } from "react";
import { listSupervisorEvents } from "../api";
import type { SupervisorEvent } from "../types";

export function SupervisorPanel({ batchId }: { batchId?: string }) {
	const [events, setEvents] = useState<SupervisorEvent[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		async function tick() {
			try {
				const list = await listSupervisorEvents(100, batchId);
				if (!cancelled) {
					setEvents(list);
					setError(null);
				}
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		}
		void tick();
		const interval = setInterval(tick, 2000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [batchId]);

	return (
		<section>
			<button type="button" className="collapsible-header" onClick={() => setCollapsed(c => !c)}>
				<div className="flex items-center gap-2">
					<div
						className="p-1.5"
						style={{
							borderRadius: "var(--radius-sm)",
							background: "color-mix(in srgb, var(--accent-cyan) 12%, transparent)",
						}}
					>
						<RadioTower size={13} style={{ color: "var(--accent-cyan)" }} />
					</div>
					<h3 className="font-medium text-sm">Supervisor</h3>
				</div>
				<span className="text-xs text-[var(--text-muted)] ml-auto mr-2">{events.length} events</span>
				<ChevronRight size={14} className={`collapsible-chevron ${collapsed ? "" : "open"}`} />
			</button>
			<div className={`collapsible-body ${collapsed ? "collapsed" : "expanded"}`}>
				{error && <div className="text-xs text-[var(--accent-red)] mb-2">{error}</div>}
				{events.length === 0 ? (
					<div className="flex flex-col items-center justify-center py-6 gap-2">
						<RadioTower size={20} className="text-[var(--text-muted)] opacity-30" />
						<p className="text-xs text-[var(--text-muted)]">No supervisor events yet.</p>
					</div>
				) : (
					<ul className="grid gap-1 text-xs font-mono max-h-64 overflow-y-auto mt-2">
						{events
							.slice()
							.reverse()
							.map((ev, i) => (
								<li key={i} className="flex gap-2 py-0.5">
									<span className="text-[var(--text-muted)] flex-shrink-0">{ev.ts ?? ""}</span>
									<span className="font-semibold flex-shrink-0">{String(ev.action ?? "event")}</span>
									{ev.classification ? (
										<span style={{ color: "var(--accent-blue)" }}>[{String(ev.classification)}]</span>
									) : null}
									<span className="truncate text-[var(--text-secondary)]">{String(ev.detail ?? "")}</span>
								</li>
							))}
					</ul>
				)}
			</div>
		</section>
	);
}
