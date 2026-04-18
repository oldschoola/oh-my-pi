import { ChevronRight, Inbox } from "lucide-react";
import { useEffect, useState } from "react";
import { listMailboxEvents } from "../api";
import type { MailboxEvent } from "../types";

export function MailboxPanel({ batchId, missionId: _missionId }: { batchId?: string; missionId?: string }) {
	const [events, setEvents] = useState<MailboxEvent[]>([]);
	const [collapsed, setCollapsed] = useState(false);

	useEffect(() => {
		if (!batchId) return;
		let cancelled = false;
		async function tick() {
			const list = await listMailboxEvents(batchId, 100);
			if (!cancelled) setEvents(list);
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
							background: "color-mix(in srgb, var(--accent-indigo) 12%, transparent)",
						}}
					>
						<Inbox size={13} style={{ color: "var(--accent-indigo)" }} />
					</div>
					<h3 className="font-medium text-sm">Mailbox</h3>
				</div>
				<span className="text-xs text-[var(--text-muted)] ml-auto mr-2">{events.length} messages</span>
				<ChevronRight size={14} className={`collapsible-chevron ${collapsed ? "" : "open"}`} />
			</button>
			<div className={`collapsible-body ${collapsed ? "collapsed" : "expanded"}`}>
				{events.length === 0 ? (
					<div className="flex flex-col items-center justify-center py-6 gap-2">
						<Inbox size={20} className="text-[var(--text-muted)] opacity-30" />
						<p className="text-xs text-[var(--text-muted)]">
							{batchId
								? "No inter-agent messages yet."
								: "Mailbox is available for multi-lane batch missions. Start with lane count > 1 to enable inter-agent messaging."}
						</p>
					</div>
				) : (
					<ul className="grid gap-1 text-xs font-mono max-h-64 overflow-y-auto mt-2">
						{events
							.slice()
							.reverse()
							.map((ev, i) => (
								<li key={i} className="flex gap-2 py-0.5">
									<span className="text-[var(--text-muted)] flex-shrink-0">{ev.ts ?? ""}</span>
									<span className="flex-shrink-0">
										{ev.from ?? "?"} → {ev.to ?? "?"}
									</span>
									<span style={{ color: "var(--accent-blue)" }} className="flex-shrink-0">
										{ev.type ?? ""}
									</span>
									<span className="truncate text-[var(--text-secondary)]">{String(ev.content ?? "")}</span>
								</li>
							))}
					</ul>
				)}
			</div>
		</section>
	);
}
