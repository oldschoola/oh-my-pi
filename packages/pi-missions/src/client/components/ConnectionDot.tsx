import type { ConnectionState } from "../hooks/useConnectionStatus";

const LABEL: Record<ConnectionState, string> = {
	connecting: "connecting",
	open: "live",
	error: "reconnecting",
	closed: "offline",
};

const COLOR: Record<ConnectionState, string> = {
	connecting: "var(--accent-amber)",
	open: "var(--accent-green)",
	error: "var(--accent-red)",
	closed: "var(--border-default)",
};

/**
 * Compact connection indicator for the header. Shows a colored dot + short
 * label so operators can tell at a glance whether the SSE pipe is alive.
 */
export function ConnectionDot({ state }: { state: ConnectionState }) {
	return (
		<div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]" title={`Dashboard ${LABEL[state]}`}>
			<span
				className="inline-block w-2 h-2 rounded-full transition-colors duration-500"
				style={{ backgroundColor: COLOR[state] }}
			/>
			<span>{LABEL[state]}</span>
		</div>
	);
}
