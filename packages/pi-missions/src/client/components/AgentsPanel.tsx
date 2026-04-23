import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import type { MissionAgentStatus } from "../api";
import { getMissionAgentStatus } from "../api";

export function AgentsPanel({ batchId, missionId }: { batchId?: string; missionId?: string }) {
	const [snapshot, setSnapshot] = useState<MissionAgentStatus>({ batchId: null, registry: null });

	useEffect(() => {
		let cancelled = false;
		async function tick() {
			if (!missionId) {
				if (!cancelled) setSnapshot({ batchId: null, registry: null });
				return;
			}
			const snap = await getMissionAgentStatus(missionId);
			if (!cancelled) setSnapshot(snap);
		}
		void tick();
		const interval = setInterval(tick, 2000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [batchId, missionId]);

	const agents = snapshot.registry?.agents ?? [];

	return (
		<section className="surface p-4">
			<header className="flex items-center justify-between mb-3">
				<div className="flex items-center gap-2">
					<div
						className="p-1.5"
						style={{
							borderRadius: "var(--radius-sm)",
							background: "color-mix(in srgb, var(--accent-violet) 12%, transparent)",
						}}
					>
						<Bot size={13} style={{ color: "var(--accent-violet)" }} />
					</div>
					<h3 className="font-medium text-sm">Agents</h3>
				</div>
				<span className="text-xs text-[var(--text-muted)]">
					{agents.length} process{agents.length === 1 ? "" : "es"}
				</span>
			</header>
			{!snapshot.batchId ? (
				<div className="text-xs text-[var(--text-muted)] py-2 text-center">No active batch.</div>
			) : agents.length === 0 ? (
				<div className="text-xs text-[var(--text-muted)] py-2 text-center">No agent processes registered.</div>
			) : (
				<ul className="grid gap-1 text-xs font-mono max-h-64 overflow-y-auto">
					{agents.map((a, i) => (
						<li key={i} className="flex gap-3 py-0.5">
							<span className="font-medium">{a.agentId}</span>
							<span style={{ color: "var(--accent-blue)" }}>{a.role}</span>
							<span className="text-[var(--text-secondary)]">{a.status}</span>
							{a.pid ? <span className="text-[var(--text-muted)]">pid {a.pid}</span> : null}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
