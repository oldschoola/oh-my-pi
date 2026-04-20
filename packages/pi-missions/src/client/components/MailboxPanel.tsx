import { ArrowRight, ChevronRight, Inbox, Radio } from "lucide-react";
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
					<ul className="grid gap-1 text-xs max-h-64 overflow-y-auto mt-2">
						{events
							.slice()
							.reverse()
							.map((ev, i) => (
								<MailboxRow key={i} event={ev} />
							))}
					</ul>
				)}
			</div>
		</section>
	);
}

function MailboxRow({ event: ev }: { event: MailboxEvent }) {
	const status = statusFromEvent(ev);
	const isBroadcast = ev.to === "_broadcast" || ev.direction === "broadcast";
	return (
		<li className="flex items-center gap-2 py-1 font-mono">
			<span className="text-[var(--text-muted)] shrink-0">{formatTs(ev.ts)}</span>
			{status && <StatusBadge status={status} />}
			<span className="shrink-0 flex items-center gap-1">
				<span>{ev.from ?? "?"}</span>
				{isBroadcast ? (
					<Radio size={10} className="text-[var(--accent-violet)]" />
				) : (
					<ArrowRight size={10} className="text-[var(--text-muted)]" />
				)}
				<span>{isBroadcast ? "all" : (ev.to ?? "?")}</span>
			</span>
			{ev.type && (
				<span className="text-[var(--accent-blue)] shrink-0">
					{ev.messageType ? String(ev.messageType) : ev.type}
				</span>
			)}
			<span className="truncate text-[var(--text-secondary)]">{String(ev.content ?? "")}</span>
		</li>
	);
}

type MailboxStatus = "sent" | "delivered" | "replied" | "escalated" | "rate-limited" | "inbox" | "outbox";

function statusFromEvent(ev: MailboxEvent): MailboxStatus | null {
	// Prefer explicit audit-event `type`, then fall back to `direction`.
	const t = typeof ev.type === "string" ? ev.type : undefined;
	if (t === "message_sent") return "sent";
	if (t === "message_delivered") return "delivered";
	if (t === "message_replied") return "replied";
	if (t === "message_escalated") return "escalated";
	if (t === "message_rate_limited") return "rate-limited";
	if (ev.direction === "inbox") return "inbox";
	if (ev.direction === "outbox") return "outbox";
	return null;
}

function StatusBadge({ status }: { status: MailboxStatus }) {
	const map: Record<MailboxStatus, { color: string; bg: string; label: string }> = {
		sent: { color: "var(--accent-blue)", bg: "rgba(96, 165, 250, 0.14)", label: "sent" },
		delivered: { color: "var(--accent-green)", bg: "rgba(74, 222, 128, 0.14)", label: "delivered" },
		replied: { color: "var(--accent-cyan)", bg: "rgba(34, 211, 238, 0.14)", label: "reply" },
		escalated: { color: "var(--accent-red)", bg: "rgba(248, 113, 113, 0.14)", label: "escalated" },
		"rate-limited": { color: "var(--accent-amber)", bg: "rgba(251, 191, 36, 0.14)", label: "rate-limit" },
		inbox: { color: "var(--accent-indigo)", bg: "rgba(129, 140, 248, 0.14)", label: "inbox" },
		outbox: { color: "var(--text-muted)", bg: "var(--bg-elevated)", label: "outbox" },
	};
	const s = map[status];
	return (
		<span
			className="inline-block px-1.5 py-0.5 rounded-full shrink-0"
			style={{ background: s.bg, color: s.color, fontSize: "10px", fontWeight: 600 }}
		>
			{s.label}
		</span>
	);
}

function formatTs(ts?: string | number): string {
	if (!ts) return "";
	const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
	if (Number.isNaN(d.getTime())) return String(ts);
	return d.toLocaleTimeString();
}
