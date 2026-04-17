import type { TelemetrySummary } from "../types";

export function TelemetryPanel({ telemetry }: { telemetry: TelemetrySummary }) {
	const t = telemetry.tokens ?? {};
	const totalTokens = (t.inputTokens ?? 0) + (t.outputTokens ?? 0);
	const cacheTokens = (t.cacheCreationInputTokens ?? 0) + (t.cacheReadInputTokens ?? 0);
	return (
		<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
			<Stat label="Total tokens" value={totalTokens.toLocaleString()} />
			<Stat label="Cache tokens" value={cacheTokens.toLocaleString()} />
			<Stat label="Cost" value={formatCost(t.totalCostUsd)} />
			<Stat label="Tool calls" value={String(telemetry.toolCalls ?? 0)} />
			{telemetry.exitCode !== undefined && <Stat label="Exit code" value={String(telemetry.exitCode)} />}
			{telemetry.retries && telemetry.retries.length > 0 && (
				<Stat label="Retries" value={String(telemetry.retries.length)} />
			)}
		</div>
	);
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="surface p-3">
			<div className="text-xs text-[var(--text-muted)] uppercase tracking-wide">{label}</div>
			<div className="text-lg font-semibold mt-1">{value}</div>
		</div>
	);
}

function formatCost(usd: number | undefined): string {
	if (!usd || usd === 0) return "$0.00";
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	if (usd < 1) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}
