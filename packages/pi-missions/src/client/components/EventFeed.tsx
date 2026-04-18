import { AlertTriangle, Hammer, Layers, MessageSquare, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TelemetryEvent } from "../types";

/**
 * Typed renderer for the worker.jsonl sidecar. Each entry carries a `type` tag
 * emitted by pi-missions/index.ts and taskplane-style lane runners. We render
 * the most informative subset (assistant turns, tool calls, retries,
 * compactions) as chat-style rows with inline tool previews.
 *
 * Unknown event types fall back to a key-value summary so new event types stay
 * visible without requiring a UI patch.
 */
export function EventFeed({ events }: { events: TelemetryEvent[] }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [autoScroll, setAutoScroll] = useState(true);

	// Auto-scroll to the newest event when the event list grows, unless the user
	// has scrolled up — exit the auto-scroll mode to let them inspect history.
	useEffect(() => {
		if (!autoScroll) return;
		const el = containerRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [events, autoScroll]);

	if (events.length === 0) {
		return <div className="text-sm text-[var(--text-muted)]">No telemetry events yet.</div>;
	}

	const trimmed = events.slice(-200);

	function handleScroll(el: HTMLDivElement) {
		const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
		if (!atBottom && autoScroll) setAutoScroll(false);
		else if (atBottom && !autoScroll) setAutoScroll(true);
	}

	return (
		<div className="space-y-2">
			<label className="flex items-center gap-2 cursor-pointer select-none text-xs text-[var(--text-muted)]">
				<input
					type="checkbox"
					checked={autoScroll}
					onChange={e => setAutoScroll(e.target.checked)}
					className="accent-[var(--accent-cyan)]"
				/>
				<span>
					Follow feed ({events.length} event{events.length === 1 ? "" : "s"})
				</span>
			</label>
			<div
				ref={containerRef}
				onScroll={e => handleScroll(e.currentTarget)}
				className="surface max-h-96 overflow-y-auto"
				style={{ padding: "4px 0" }}
			>
				{trimmed.map((ev, idx) => (
					<EventRow key={`${ev.ts ?? idx}-${idx}`} ev={ev} />
				))}
			</div>
		</div>
	);
}

function EventRow({ ev }: { ev: TelemetryEvent }) {
	const ts = typeof ev.ts === "number" ? new Date(ev.ts).toLocaleTimeString() : "";
	const { type } = ev;

	if (type === "message_end") return <MessageRow ev={ev} ts={ts} />;
	if (type === "tool_execution_start") return <ToolStartRow ev={ev} ts={ts} />;
	if (type === "tool_execution_end") return <ToolEndRow ev={ev} ts={ts} />;
	if (type === "auto_retry_start" || type === "auto_retry_end") return <RetryRow ev={ev} ts={ts} />;
	if (type === "auto_compaction_start") return <CompactionRow ev={ev} ts={ts} />;
	return <UnknownRow ev={ev} ts={ts} />;
}

function MessageRow({ ev, ts }: { ev: TelemetryEvent; ts: string }) {
	const text = typeof ev.text === "string" ? ev.text : "";
	const usage = ev.usage as { input?: number; output?: number; cost?: { total?: number } | number } | null | undefined;
	const contextPct = typeof ev.contextPct === "number" ? ev.contextPct : null;
	const role = typeof ev.role === "string" ? ev.role : "assistant";
	return (
		<div className="event-row event-row-msg">
			<RowHeader ts={ts} icon={<MessageSquare size={11} />} color="var(--accent-cyan)" label={role} />
			{text && <div className="event-body">{truncate(text, 320)}</div>}
			{(usage || contextPct !== null) && (
				<div className="event-meta">
					{usage && (
						<>
							{typeof usage.input === "number" && (
								<span className="event-meta-chip" title="Input tokens">
									↑{usage.input.toLocaleString()}
								</span>
							)}
							{typeof usage.output === "number" && (
								<span className="event-meta-chip" title="Output tokens">
									↓{usage.output.toLocaleString()}
								</span>
							)}
							{(() => {
								const total =
									typeof usage.cost === "number"
										? usage.cost
										: usage.cost && typeof usage.cost.total === "number"
											? usage.cost.total
											: null;
								return total !== null ? (
									<span className="event-meta-chip" title="Cost (USD)">
										${total.toFixed(4)}
									</span>
								) : null;
							})()}
						</>
					)}
					{contextPct !== null && (
						<span className="event-meta-chip" title="Context window %">
							ctx {contextPct.toFixed(1)}%
						</span>
					)}
				</div>
			)}
		</div>
	);
}

function ToolStartRow({ ev, ts }: { ev: TelemetryEvent; ts: string }) {
	const toolName = typeof ev.toolName === "string" ? ev.toolName : "tool";
	const preview = typeof ev.argsPreview === "string" ? ev.argsPreview : null;
	return (
		<div className="event-row event-row-tool">
			<RowHeader ts={ts} icon={<Hammer size={11} />} color="var(--accent-amber)" label={toolName} />
			{preview && <div className="event-body event-body-mono">{preview}</div>}
		</div>
	);
}

function ToolEndRow({ ev, ts }: { ev: TelemetryEvent; ts: string }) {
	const toolName = typeof ev.toolName === "string" ? ev.toolName : "tool";
	const isError = !!ev.isError;
	return (
		<div className="event-row event-row-tool-end">
			<RowHeader
				ts={ts}
				icon={isError ? <AlertTriangle size={11} /> : <Hammer size={11} />}
				color={isError ? "var(--accent-red)" : "var(--text-muted)"}
				label={`${toolName} ${isError ? "failed" : "done"}`}
			/>
		</div>
	);
}

function RetryRow({ ev, ts }: { ev: TelemetryEvent; ts: string }) {
	const isStart = ev.type === "auto_retry_start";
	const attempt = typeof ev.attempt === "number" ? ev.attempt : null;
	const maxAttempts = typeof ev.maxAttempts === "number" ? ev.maxAttempts : null;
	const delayMs = typeof ev.delayMs === "number" ? ev.delayMs : null;
	const errorMessage = typeof ev.errorMessage === "string" ? ev.errorMessage : null;
	const finalError = typeof ev.finalError === "string" ? ev.finalError : null;
	const success = typeof ev.success === "boolean" ? ev.success : null;
	const label = isStart
		? attempt && maxAttempts
			? `retry ${attempt}/${maxAttempts}`
			: "retry"
		: success === false
			? "retry failed"
			: "retry resolved";
	return (
		<div className="event-row event-row-retry">
			<RowHeader ts={ts} icon={<RefreshCw size={11} />} color="var(--accent-red)" label={label} />
			{isStart && delayMs !== null && <div className="event-body">backoff {formatDelay(delayMs)}</div>}
			{(errorMessage || finalError) && <div className="event-body event-body-dim">{errorMessage ?? finalError}</div>}
		</div>
	);
}

function CompactionRow({ ev, ts }: { ev: TelemetryEvent; ts: string }) {
	const reason = typeof ev.reason === "string" ? ev.reason : "unspecified";
	const action = typeof ev.action === "string" ? ev.action : null;
	return (
		<div className="event-row event-row-compaction">
			<RowHeader ts={ts} icon={<Layers size={11} />} color="var(--accent-violet)" label="compaction" />
			<div className="event-body event-body-dim">
				{reason}
				{action && ` · ${action}`}
			</div>
		</div>
	);
}

function UnknownRow({ ev, ts }: { ev: TelemetryEvent; ts: string }) {
	return (
		<div className="event-row">
			<RowHeader ts={ts} color="var(--text-muted)" label={String(ev.type ?? "event")} />
			<div className="event-body event-body-dim">{summarize(ev)}</div>
		</div>
	);
}

function RowHeader({ ts, icon, color, label }: { ts: string; icon?: React.ReactNode; color: string; label: string }) {
	return (
		<div className="event-head">
			<span className="event-ts">{ts}</span>
			{icon && (
				<span className="event-icon" style={{ color }}>
					{icon}
				</span>
			)}
			<span className="event-label" style={{ color }}>
				{label}
			</span>
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

function formatDelay(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const sec = ms / 1000;
	if (sec < 60) return `${sec.toFixed(1)}s`;
	const min = Math.floor(sec / 60);
	const rem = Math.floor(sec % 60);
	return `${min}m ${rem}s`;
}
