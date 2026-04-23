import { GitMerge } from "lucide-react";
import { formatCost, formatDuration, formatTokens } from "../format";
import type { MergeResult, RepoMergeResult } from "../types";

interface MergePanelProps {
	mergeResults: MergeResult[];
	/** Per-merge telemetry keyed by waveIndex (0-based). Optional. */
	mergeTelemetry?: Map<number, MergeTelemetry>;
	/** Filter rows to a repo (workspace mode). */
	selectedRepo?: string;
	/** When true, render per-repo sub-rows under each wave. */
	showRepos?: boolean;
}

/** Merge-agent telemetry, keyed by waveIndex in the snapshot. */
export interface MergeTelemetry {
	startedAt?: number;
	elapsedMs?: number;
	toolCalls?: number;
	contextPct?: number;
	costUsd?: number;
	currentTool?: string;
	lastTool?: string;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	alive?: boolean;
}

export function MergePanel({ mergeResults, mergeTelemetry, selectedRepo, showRepos = false }: MergePanelProps) {
	if (mergeResults.length === 0) return null;

	const filtered = selectedRepo
		? mergeResults.filter(mr => (mr.repoResults ?? []).some(rr => rr.repoId === selectedRepo))
		: mergeResults;

	if (filtered.length === 0) return null;

	return (
		<section className="surface p-5">
			<div className="flex items-center gap-2 mb-4">
				<GitMerge size={14} style={{ color: "var(--accent-violet)" }} />
				<h3 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">Merge Agents</h3>
			</div>
			<div className="overflow-x-auto">
				<table className="merge-table">
					<thead>
						<tr>
							<th>Wave</th>
							<th>Status</th>
							<th>Session</th>
							<th>Telemetry</th>
							<th>Detail</th>
						</tr>
					</thead>
					<tbody>
						{filtered.flatMap(mr => {
							const tel = mergeTelemetry?.get(mr.waveIndex);
							const rows: React.ReactNode[] = [];
							rows.push(<MergeRow key={`w${mr.waveIndex}`} mergeResult={mr} telemetry={tel} />);
							if (showRepos && mr.repoResults && mr.repoResults.length > 0) {
								const subRows = selectedRepo
									? mr.repoResults.filter(rr => rr.repoId === selectedRepo)
									: mr.repoResults;
								for (let i = 0; i < subRows.length; i++) {
									rows.push(<MergeRepoRow key={`w${mr.waveIndex}-r${i}`} repoResult={subRows[i]} />);
								}
							}
							return rows;
						})}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function MergeRow({ mergeResult, telemetry }: { mergeResult: MergeResult; telemetry?: MergeTelemetry }) {
	const statusClass = mergeStatusClass(mergeResult.status);
	const sessionLabel = telemetry?.alive ? "running" : "—";
	const detail = mergeResult.failureReason ? mergeResult.failureReason : "—";
	return (
		<tr>
			<td className="merge-wave-cell">Wave {mergeResult.waveIndex + 1}</td>
			<td>
				<span className="badge" style={statusStyle(mergeResult.status)}>
					{mergeResult.status}
				</span>
				<span className="sr-only">{statusClass}</span>
			</td>
			<td className="merge-session-cell">{sessionLabel}</td>
			<td>
				<MergeTelemetryCell telemetry={telemetry} alive={!!telemetry?.alive} />
			</td>
			<td className="merge-detail-cell">{detail}</td>
		</tr>
	);
}

function MergeRepoRow({ repoResult }: { repoResult: RepoMergeResult }) {
	const lanes = repoResult.laneNumbers.map(n => `L${n}`).join(", ") || "—";
	const detail = repoResult.failureReason ?? "—";
	return (
		<tr className="merge-repo-row">
			<td>
				<span className="repo-badge">{repoResult.repoId ?? "unknown"}</span>
			</td>
			<td>
				<span className="badge" style={statusStyle(repoResult.status)}>
					{repoResult.status}
				</span>
			</td>
			<td className="merge-session-cell">{lanes}</td>
			<td />
			<td className="merge-detail-cell">{detail}</td>
		</tr>
	);
}

function MergeTelemetryCell({ telemetry, alive }: { telemetry?: MergeTelemetry; alive: boolean }) {
	if (!telemetry) return <span className="text-[var(--text-muted)]">—</span>;
	const hasData =
		(telemetry.inputTokens ?? 0) > 0 ||
		(telemetry.outputTokens ?? 0) > 0 ||
		(telemetry.toolCalls ?? 0) > 0 ||
		(telemetry.costUsd ?? 0) > 0;
	if (!hasData) return <span className="text-[var(--text-muted)]">—</span>;
	const tokensIn = (telemetry.inputTokens ?? 0) + (telemetry.cacheReadTokens ?? 0);
	const tokensOut = telemetry.outputTokens ?? 0;
	const lastTool = alive ? telemetry.currentTool : telemetry.lastTool;
	return (
		<div className="worker-stats">
			{telemetry.elapsedMs && telemetry.elapsedMs > 0 && (
				<span className="worker-stat" title="Merge elapsed">
					⏱ {formatDuration(telemetry.elapsedMs)}
				</span>
			)}
			{telemetry.toolCalls !== undefined && telemetry.toolCalls > 0 && (
				<span className="worker-stat" title="Tool calls">
					🔧 {telemetry.toolCalls}
				</span>
			)}
			{telemetry.contextPct !== undefined && telemetry.contextPct > 0 && (
				<span className="worker-stat" title="Context window used">
					📊 {Math.round(telemetry.contextPct)}%
				</span>
			)}
			{(tokensIn > 0 || tokensOut > 0) && (
				<span className="worker-stat" title="Tokens">
					🪙 ↑{formatTokens(tokensIn)} ↓{formatTokens(tokensOut)}
					{telemetry.costUsd !== undefined && telemetry.costUsd > 0 && ` ${formatCost(telemetry.costUsd)}`}
				</span>
			)}
			{lastTool && (
				<span className="worker-stat worker-last-tool" title={alive ? "Current tool" : "Last tool"}>
					{lastTool}
				</span>
			)}
		</div>
	);
}

function mergeStatusClass(status: MergeResult["status"]): string {
	if (status === "succeeded") return "status-succeeded";
	if (status === "partial") return "status-stalled";
	return "status-failed";
}

function statusStyle(status: MergeResult["status"] | RepoMergeResult["status"]): React.CSSProperties {
	const color =
		status === "succeeded"
			? "var(--accent-green)"
			: status === "partial"
				? "var(--accent-amber)"
				: "var(--accent-red)";
	return {
		background: `color-mix(in srgb, ${color} 12%, transparent)`,
		color,
		padding: "1px 7px",
		borderRadius: 8,
		fontSize: 11,
		fontWeight: 600,
	};
}
