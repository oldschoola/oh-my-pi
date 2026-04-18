import { FileText, MessageSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getLaneConversation, getTaskStatusMd } from "../api";

export function TerminalViewer({
	laneId,
	taskId,
	missionLog,
}: {
	laneId?: string;
	taskId?: string;
	missionLog?: string;
}) {
	const [conversation, setConversation] = useState<string | null>(null);
	const [statusMd, setStatusMd] = useState<string | null>(null);
	const [autoScroll, setAutoScroll] = useState(true);
	const convRef = useRef<HTMLPreElement>(null);
	const statusRef = useRef<HTMLPreElement>(null);

	useEffect(() => {
		let cancelled = false;
		async function load() {
			const [c, s] = await Promise.all([
				laneId ? getLaneConversation(laneId) : Promise.resolve(null),
				taskId ? getTaskStatusMd(taskId) : Promise.resolve(null),
			]);
			if (!cancelled) {
				setConversation(c);
				setStatusMd(s);
			}
		}
		void load();
		const interval = setInterval(load, 3000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [laneId, taskId]);

	// Auto-scroll when new content arrives
	useEffect(() => {
		if (autoScroll && convRef.current) {
			convRef.current.scrollTop = convRef.current.scrollHeight;
		}
		if (autoScroll && statusRef.current) {
			statusRef.current.scrollTop = statusRef.current.scrollHeight;
		}
	}, [conversation, statusMd, autoScroll]);

	function handleScroll(el: HTMLPreElement) {
		const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
		if (!atBottom && autoScroll) setAutoScroll(false);
	}

	if (!laneId && !taskId) {
		if (missionLog) {
			return (
				<pre
					className="text-xs whitespace-pre-wrap max-h-96 overflow-y-auto p-3 rounded-[var(--radius-md)]"
					style={{
						background: "var(--bg-elevated)",
						border: "1px solid var(--border-subtle)",
						fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
					}}
				>
					{missionLog}
				</pre>
			);
		}
		return (
			<div className="flex flex-col items-center justify-center py-8 gap-2">
				<MessageSquare size={24} className="text-[var(--text-muted)] opacity-30" />
				<p className="text-xs text-[var(--text-muted)]">Select a lane or task to inspect its transcript.</p>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{/* Auto-scroll control */}
			<label className="flex items-center gap-2 cursor-pointer select-none">
				<input
					type="checkbox"
					checked={autoScroll}
					onChange={e => setAutoScroll(e.target.checked)}
					className="accent-[var(--accent-cyan)]"
				/>
				<span className="text-xs text-[var(--text-muted)]">Follow feed</span>
			</label>

			<div className="grid lg:grid-cols-2 gap-4">
				<div>
					<div className="flex items-center gap-2 mb-2">
						<div
							className="p-1.5"
							style={{
								borderRadius: "var(--radius-sm)",
								background: "color-mix(in srgb, var(--accent-cyan) 12%, transparent)",
							}}
						>
							<MessageSquare size={12} style={{ color: "var(--accent-cyan)" }} />
						</div>
						<h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
							Conversation {laneId ? `(${laneId})` : ""}
						</h3>
					</div>
					<pre
						ref={convRef}
						onScroll={e => handleScroll(e.currentTarget)}
						className="text-xs whitespace-pre-wrap max-h-96 overflow-y-auto p-3 rounded-[var(--radius-md)]"
						style={{
							background: "var(--bg-elevated)",
							border: "1px solid var(--border-subtle)",
							fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
						}}
					>
						{conversation ?? (laneId ? "No transcript found." : "No lane selected.")}
					</pre>
				</div>
				<div>
					<div className="flex items-center gap-2 mb-2">
						<div
							className="p-1.5"
							style={{
								borderRadius: "var(--radius-sm)",
								background: "color-mix(in srgb, var(--accent-amber) 12%, transparent)",
							}}
						>
							<FileText size={12} style={{ color: "var(--accent-amber)" }} />
						</div>
						<h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
							STATUS.md {taskId ? `(${taskId})` : ""}
						</h3>
					</div>
					<pre
						ref={statusRef}
						onScroll={e => handleScroll(e.currentTarget)}
						className="text-xs whitespace-pre-wrap max-h-96 overflow-y-auto p-3 rounded-[var(--radius-md)]"
						style={{
							background: "var(--bg-elevated)",
							border: "1px solid var(--border-subtle)",
							fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
						}}
					>
						{statusMd ?? (taskId ? "No STATUS.md found." : "No task selected.")}
					</pre>
				</div>
			</div>
		</div>
	);
}
