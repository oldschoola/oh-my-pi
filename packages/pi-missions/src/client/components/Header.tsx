import { RefreshCw } from "lucide-react";

export function Header({ onRefresh, refreshing }: { onRefresh: () => void; refreshing: boolean }) {
	return (
		<header className="flex items-center justify-between mb-6">
			<div>
				<h1 className="text-2xl font-bold gradient-text tracking-tight">MissionControl</h1>
				<p className="text-sm text-[var(--text-muted)]">Orchestrated multi-agent missions</p>
			</div>
			<button type="button" className="btn" onClick={onRefresh} disabled={refreshing}>
				<RefreshCw size={14} className={refreshing ? "spin" : ""} />
				Refresh
			</button>
		</header>
	);
}
