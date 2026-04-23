import { MessageCircle, RadioTower } from "lucide-react";
import { useEffect, useState } from "react";
import { getSupervisorDetail } from "../api";
import type {
	SupervisorAutonomyLevel,
	SupervisorConversationEntry,
	SupervisorDetail,
	SupervisorStatus,
	SupervisorTimelineEntry,
} from "../types";

const EMPTY_DETAIL: SupervisorDetail = {
	status: { state: "inactive", lock: null, heartbeatAgeMs: null },
	conversation: [],
	timeline: [],
	summary: null,
};

export function SupervisorPanel({ batchId }: { batchId?: string; missionId?: string }) {
	const [detail, setDetail] = useState<SupervisorDetail>(EMPTY_DETAIL);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		async function tick() {
			try {
				const data = await getSupervisorDetail(batchId);
				if (!cancelled) {
					setDetail(data);
					setError(null);
				}
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		}
		void tick();
		const interval = setInterval(tick, 3000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [batchId]);

	const { status, conversation, timeline, summary } = detail;

	return (
		<section>
			<header className="flex items-center gap-2 mb-3">
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
				<StateSummary status={status} timelineLen={timeline.length} />
			</header>
			{error && <div className="text-xs text-[var(--accent-red)] mb-2">{error}</div>}
			<StatusSection status={status} />
			<ConversationSection conversation={conversation} />
			<TimelineSection entries={timeline} />
			<SummarySection content={summary} />
		</section>
	);
}

function StateSummary({ status, timelineLen }: { status: SupervisorStatus; timelineLen: number }) {
	const dot =
		status.state === "active"
			? "var(--accent-green)"
			: status.state === "stale"
				? "var(--accent-amber)"
				: "var(--text-muted)";
	return (
		<span className="text-xs text-[var(--text-muted)] ml-auto mr-2 flex items-center gap-2">
			<span
				className="inline-block rounded-full"
				style={{ width: 8, height: 8, background: dot }}
				title={status.state}
			/>
			{timelineLen} events
		</span>
	);
}

function StatusSection({ status }: { status: SupervisorStatus }) {
	const label = status.state.charAt(0).toUpperCase() + status.state.slice(1);
	const dot =
		status.state === "active"
			? "var(--accent-green)"
			: status.state === "stale"
				? "var(--accent-amber)"
				: "var(--text-muted)";
	return (
		<div className="supervisor-subsection">
			<h4 className="supervisor-subheading">Status</h4>
			{status.lock ? (
				<div className="grid gap-1 text-xs font-mono">
					<div className="flex items-center gap-2">
						<span className="inline-block rounded-full" style={{ width: 8, height: 8, background: dot }} />
						<span className="font-semibold" style={{ color: dot }}>
							{label}
						</span>
						{status.autonomy && <AutonomyBadge level={status.autonomy} />}
						{status.heartbeatAgeMs !== null && (
							<span className="text-[var(--text-muted)]">
								(heartbeat {formatAge(status.heartbeatAgeMs)} ago)
							</span>
						)}
					</div>
					<div className="text-[var(--text-muted)]">Session: {status.lock.sessionId}</div>
					<div className="text-[var(--text-muted)]">Batch: {status.lock.batchId}</div>
					<div className="text-[var(--text-muted)]">PID: {status.lock.pid}</div>
				</div>
			) : (
				<div className="text-xs text-[var(--text-muted)]">No active supervisor.</div>
			)}
		</div>
	);
}

function ConversationSection({ conversation }: { conversation: SupervisorConversationEntry[] }) {
	if (conversation.length === 0) return null;
	return (
		<div className="supervisor-subsection">
			<h4 className="supervisor-subheading">
				<MessageCircle size={11} className="inline-block mr-1 align-[-1px]" />
				Conversation
			</h4>
			<ul className="grid gap-2 max-h-64 overflow-y-auto">
				{conversation.map((entry, i) => (
					<ConversationBubble key={i} entry={entry} />
				))}
			</ul>
		</div>
	);
}

function ConversationBubble({ entry }: { entry: SupervisorConversationEntry }) {
	const isOperator = entry.role === "operator" || entry.role === "user";
	return (
		<li className={`conv-bubble ${isOperator ? "conv-operator" : "conv-supervisor"}`}>
			<div className="flex items-center gap-2 mb-1">
				<span className="text-[10px] font-semibold uppercase tracking-wider">
					{isOperator ? "Operator" : entry.role === "supervisor" ? "Supervisor" : entry.role}
				</span>
				{entry.ts && <span className="text-[10px] text-[var(--text-muted)] font-mono">{formatTs(entry.ts)}</span>}
			</div>
			<div className="text-xs whitespace-pre-wrap text-[var(--text-secondary)]">{entry.content}</div>
		</li>
	);
}

function TimelineSection({ entries }: { entries: SupervisorTimelineEntry[] }) {
	if (entries.length === 0) {
		return (
			<div className="supervisor-subsection">
				<h4 className="supervisor-subheading">Recovery Actions</h4>
				<div className="text-xs text-[var(--text-muted)]">No recovery actions yet.</div>
			</div>
		);
	}
	return (
		<div className="supervisor-subsection">
			<h4 className="supervisor-subheading">Recovery Actions</h4>
			<ul className="grid gap-1 max-h-64 overflow-y-auto">
				{entries
					.slice()
					.reverse()
					.map((ev, i) => (
						<TimelineRow key={i} entry={ev} />
					))}
			</ul>
		</div>
	);
}

function TimelineRow({ entry }: { entry: SupervisorTimelineEntry }) {
	const outcomeColor =
		entry.outcome === "success"
			? "var(--accent-green)"
			: entry.outcome === "failure"
				? "var(--accent-red)"
				: entry.outcome === "pending"
					? "var(--accent-amber)"
					: "var(--text-muted)";
	return (
		<li className="flex items-start gap-2 py-0.5 text-xs font-mono">
			<span
				className="inline-block rounded-full mt-1.5 shrink-0"
				style={{ width: 6, height: 6, background: outcomeColor }}
				title={entry.outcome ?? "event"}
			/>
			<span className="text-[var(--text-muted)] shrink-0">{formatTs(entry.ts)}</span>
			<span className="badge-tier shrink-0" data-tier={entry.tier}>
				T{entry.tier}
			</span>
			<span className="font-semibold shrink-0">{entry.label}</span>
			{entry.taskId && <span className="text-[var(--accent-indigo)] shrink-0">{entry.taskId}</span>}
			{entry.classification && <span className="text-[var(--accent-blue)] shrink-0">[{entry.classification}]</span>}
			{(entry.reason || entry.detail) && (
				<span className="truncate text-[var(--text-secondary)]">{entry.reason ?? entry.detail}</span>
			)}
		</li>
	);
}

function SummarySection({ content }: { content: string | null }) {
	if (!content) return null;
	return (
		<div className="supervisor-subsection">
			<h4 className="supervisor-subheading">Batch Summary</h4>
			<div className="supervisor-markdown">{renderMarkdown(content)}</div>
		</div>
	);
}

/**
 * Minimal markdown renderer — supports headings, bullet lists, checkboxes, and
 * plain paragraphs. Intentionally avoids a full markdown dependency; the
 * supervisor summary is short and predictable.
 */
function renderMarkdown(md: string): React.ReactNode {
	const lines = md.split("\n");
	const blocks: React.ReactNode[] = [];
	let listItems: React.ReactNode[] = [];

	const flushList = () => {
		if (listItems.length === 0) return;
		blocks.push(
			<ul key={`list-${blocks.length}`} className="list-disc ml-5 my-1">
				{listItems}
			</ul>,
		);
		listItems = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (!trimmed) {
			flushList();
			continue;
		}
		const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			flushList();
			const level = Math.min(6, heading[1].length);
			blocks.push(
				<div key={`h-${i}`} className={`font-semibold mt-2 mb-1 text-${level <= 2 ? "sm" : "xs"}`}>
					{heading[2]}
				</div>,
			);
			continue;
		}
		const checkbox = trimmed.match(/^[-*]\s+\[( |x|X)\]\s+(.*)$/);
		if (checkbox) {
			const checked = checkbox[1].toLowerCase() === "x";
			listItems.push(
				<li key={`li-${i}`} className="flex items-start gap-2">
					<input type="checkbox" readOnly checked={checked} className="mt-0.5" />
					<span className={checked ? "line-through opacity-60" : ""}>{checkbox[2]}</span>
				</li>,
			);
			continue;
		}
		const bullet = trimmed.match(/^[-*]\s+(.*)$/);
		if (bullet) {
			listItems.push(<li key={`li-${i}`}>{bullet[1]}</li>);
			continue;
		}
		flushList();
		blocks.push(
			<p key={`p-${i}`} className="my-1">
				{trimmed}
			</p>,
		);
	}
	flushList();
	return blocks;
}

function AutonomyBadge({ level }: { level: SupervisorAutonomyLevel }) {
	const color =
		level === "autonomous"
			? "var(--accent-green)"
			: level === "supervised"
				? "var(--accent-amber)"
				: "var(--accent-blue)";
	return (
		<span
			className="autonomy-badge"
			style={{
				color,
				background: `color-mix(in srgb, ${color} 12%, transparent)`,
				border: `1px solid color-mix(in srgb, ${color} 22%, transparent)`,
			}}
			title={`Supervisor autonomy: ${level}`}
		>
			{level}
		</span>
	);
}

function formatAge(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return `${h}h`;
}

function formatTs(ts: string): string {
	// Accept ISO strings or anything Date.parse understands. Falls back to raw.
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return ts;
	return d.toLocaleTimeString();
}
