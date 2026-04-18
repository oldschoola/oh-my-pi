import { BarChart3, Database, DollarSign, Gauge, Hash, Layers, RefreshCw, Wrench, Zap } from "lucide-react";
import type { TelemetrySummary } from "../types";

interface StatConfig {
	key: string;
	label: string;
	icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
	color: string;
	getValue: (t: TelemetrySummary) => string;
	/** Extra accent/animation hook — e.g., pulsing amber border when a retry is active. */
	className?: (t: TelemetrySummary) => string | undefined;
	/** Tooltip surfaced via title attribute — used for retry error text and last-tool previews. */
	getTitle?: (t: TelemetrySummary) => string | undefined;
	show?: (t: TelemetrySummary) => boolean;
}

const STAT_CONFIG: StatConfig[] = [
	{
		key: "total-tokens",
		label: "Total Tokens",
		icon: BarChart3,
		color: "var(--accent-cyan)",
		getValue: t => {
			const tok = t.tokens ?? {};
			return ((tok.inputTokens ?? 0) + (tok.outputTokens ?? 0)).toLocaleString();
		},
	},
	{
		key: "cache-tokens",
		label: "Cache Tokens",
		icon: Database,
		color: "var(--accent-violet)",
		getValue: t => {
			const tok = t.tokens ?? {};
			return ((tok.cacheCreationInputTokens ?? 0) + (tok.cacheReadInputTokens ?? 0)).toLocaleString();
		},
	},
	{
		key: "cost",
		label: "Cost",
		icon: DollarSign,
		color: "var(--accent-indigo)",
		getValue: t => formatCost(t.tokens?.totalCostUsd),
	},
	{
		key: "tool-calls",
		label: "Tool Calls",
		icon: Zap,
		color: "var(--accent-amber)",
		getValue: t => String(t.toolCalls ?? 0),
	},
	{
		key: "context",
		label: "Context",
		icon: Gauge,
		color: "var(--accent-cyan)",
		getValue: t => formatPct(t.contextPct),
		show: t => typeof t.contextPct === "number",
	},
	{
		key: "last-tool",
		label: "Last Tool",
		icon: Wrench,
		color: "var(--accent-indigo)",
		getValue: t => truncate(t.lastToolCall ?? "—", 24),
		getTitle: t => t.lastToolCall,
		show: t => !!t.lastToolCall,
	},
	{
		key: "retries",
		label: "Retries",
		icon: RefreshCw,
		color: "var(--accent-red)",
		getValue: t => (t.retryActive ? `${t.retries ?? 0} ⟳` : String(t.retries ?? 0)),
		getTitle: t => t.lastRetryError,
		// Pulse the retry card while a backoff is active so operators see the stall.
		className: t => (t.retryActive ? "stat-card-pulse" : undefined),
		show: t => (t.retries ?? 0) > 0 || !!t.retryActive,
	},
	{
		key: "compactions",
		label: "Compactions",
		icon: Layers,
		color: "var(--accent-amber)",
		getValue: t => String(t.compactions ?? 0),
		show: t => (t.compactions ?? 0) > 0,
	},
	{
		key: "exit-code",
		label: "Exit Code",
		icon: Hash,
		color: "var(--accent-green)",
		getValue: t => String(t.exitCode ?? "—"),
		show: t => t.exitCode !== undefined,
	},
];

export function TelemetryPanel({ telemetry }: { telemetry: TelemetrySummary }) {
	const visible = STAT_CONFIG.filter(s => !s.show || s.show(telemetry));
	return (
		<div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
			{visible.map(s => {
				const Icon = s.icon;
				const extraCls = s.className?.(telemetry);
				const title = s.getTitle?.(telemetry);
				return (
					<div key={s.key} className={`stat-card${extraCls ? ` ${extraCls}` : ""}`} title={title}>
						<div className="flex items-center justify-between mb-3">
							<span className="text-xs font-medium text-[var(--text-secondary)]">{s.label}</span>
							<div
								className="p-1.5"
								style={{
									borderRadius: "var(--radius-sm)",
									backgroundColor: `${s.color}18`,
								}}
							>
								<Icon size={14} style={{ color: s.color }} />
							</div>
						</div>
						<div className="text-xl font-bold text-[var(--text-primary)]">{s.getValue(telemetry)}</div>
					</div>
				);
			})}
		</div>
	);
}

function formatCost(usd: number | undefined): string {
	if (!usd || usd === 0) return "$0.00";
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	if (usd < 1) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

function formatPct(pct: number | undefined): string {
	if (typeof pct !== "number") return "—";
	return `${pct.toFixed(1)}%`;
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}
