import { useTelemetryRollup } from "../hooks/useTelemetryRollup";

const ROLE_LABEL: Record<string, string> = {
	orchestrator: "Orchestrator",
	worker: "Worker",
	fix_worker: "Fix worker",
	scrutiny_validator: "Scrutiny validator",
	user_testing_validator: "User-testing validator",
};

/**
 * Per-role telemetry table. Renders headless inside its parent surface — the
 * parent owns the section heading. Empty / error states are inline muted
 * notices, not full surface cards.
 */
export function RollupTelemetryPanel({ missionId }: { missionId: string | null }) {
	const { data, error } = useTelemetryRollup(missionId);

	if (error) {
		return <div className="text-xs text-[var(--accent-red)]">Rollup unavailable: {error}</div>;
	}

	if (!data) {
		return <div className="text-xs text-[var(--text-muted)]">No rollup data yet.</div>;
	}

	return (
		<div className="space-y-3">
			<div className="text-[10px] text-[var(--text-muted)] font-mono">
				{data.totals.totalTokens.toLocaleString()} tokens · ${data.totals.costUsd.toFixed(2)}
			</div>
			<table className="w-full text-xs">
				<thead className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
					<tr>
						<th className="text-left pb-2">Role</th>
						<th className="text-right pb-2">Tokens</th>
						<th className="text-right pb-2">Cost</th>
						<th className="text-right pb-2">Tools</th>
						<th className="text-right pb-2">Duration</th>
						<th className="text-right pb-2">Samples</th>
					</tr>
				</thead>
				<tbody>
					{data.perRole.map(r => (
						<tr key={r.role} className="border-t border-[var(--border-subtle)]">
							<td className="py-1.5 font-mono text-[var(--text-secondary)]">{ROLE_LABEL[r.role] ?? r.role}</td>
							<td className="py-1.5 text-right font-mono">{r.totalTokens.toLocaleString()}</td>
							<td className="py-1.5 text-right font-mono">${r.costUsd.toFixed(2)}</td>
							<td className="py-1.5 text-right font-mono">{r.toolCalls}</td>
							<td className="py-1.5 text-right font-mono">{formatDuration(r.durationMs)}</td>
							<td className="py-1.5 text-right font-mono text-[var(--text-muted)]">{r.count}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "\u2014";
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
	return `${(ms / 3_600_000).toFixed(1)}h`;
}
