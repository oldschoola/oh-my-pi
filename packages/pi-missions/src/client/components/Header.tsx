import { Layers, Moon, RefreshCw, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function Header({
	onRefresh,
	refreshing,
	theme,
	onToggleTheme,
}: {
	onRefresh: () => void;
	refreshing: boolean;
	theme: "light" | "dark";
	onToggleTheme: () => void;
}) {
	// Track seconds since last successful refresh
	const [staleSecs, setStaleSecs] = useState(0);
	const [fresh, setFresh] = useState(false);
	const timerRef = useRef<NodeJS.Timeout | undefined>(undefined);

	// Reset staleness counter whenever a refresh completes
	const prevRefreshing = useRef(refreshing);
	useEffect(() => {
		if (prevRefreshing.current && !refreshing) {
			// Refresh just completed
			setStaleSecs(0);
			setFresh(true);
			const fadeTimeout = setTimeout(() => setFresh(false), 2000);
			return () => clearTimeout(fadeTimeout);
		}
		prevRefreshing.current = refreshing;
	}, [refreshing]);

	useEffect(() => {
		timerRef.current = setInterval(() => {
			setStaleSecs(s => s + 1);
		}, 1000);
		return () => clearInterval(timerRef.current);
	}, []);

	const isStale = staleSecs > 60;
	const dotColor = refreshing
		? "var(--accent-amber)"
		: isStale
			? "var(--accent-amber)"
			: fresh
				? "var(--accent-green)"
				: "var(--border-default)";

	return (
		<header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 mb-8 border-b border-[var(--border-subtle)]">
			<div className="flex items-center gap-3">
				<div
					className="w-10 h-10 flex items-center justify-center shadow-lg flex-shrink-0"
					style={{
						borderRadius: "var(--radius-md)",
						background: "linear-gradient(135deg, var(--accent-blue) 0%, var(--accent-indigo) 100%)",
					}}
				>
					<Layers size={20} color="white" />
				</div>
				<div>
					<h1 className="text-xl font-semibold text-[var(--text-primary)]">MissionControl</h1>
					<p className="text-sm text-[var(--text-muted)]">Orchestrated multi-agent missions</p>
				</div>
			</div>
			<div className="flex items-center gap-3">
				{/* Freshness indicator */}
				<div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
					<span
						className="inline-block w-2 h-2 rounded-full transition-colors duration-700"
						style={{ backgroundColor: dotColor }}
					/>
					{isStale ? (
						<span className="text-[var(--accent-amber)]">
							{staleSecs < 120 ? `${staleSecs}s ago` : `${Math.floor(staleSecs / 60)}m ago`}
						</span>
					) : fresh ? (
						<span className="text-[var(--accent-green)]">Updated</span>
					) : null}
				</div>
				<button
					type="button"
					className="btn"
					onClick={onToggleTheme}
					aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
					title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
				>
					{theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
				</button>
				<button
					type="button"
					className="btn btn-primary"
					onClick={onRefresh}
					disabled={refreshing}
					aria-label="Refresh missions"
				>
					<RefreshCw size={14} className={refreshing ? "spin" : ""} />
					<span className="hidden sm:inline">Refresh</span>
				</button>
			</div>
		</header>
	);
}
