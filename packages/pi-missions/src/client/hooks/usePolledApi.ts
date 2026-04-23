import { useEffect, useState } from "react";

/**
 * Shared polling hook for the Factory-alignment dashboard panels.
 *
 * Invokes `fetcher(id)` on mount + every `intervalMs`, stashing the
 * latest resolved value in state. Returns `{ data, error, refresh }`.
 * Swap the id (or call `refresh`) to force a fresh fetch outside the
 * polling cadence.
 *
 * All panels use 2s polling to match the existing telemetry cadence —
 * tight enough for live mission feel, loose enough to avoid hammering
 * the dashboard server.
 */
export function usePolledApi<T>(
	id: string | null,
	fetcher: (id: string) => Promise<T>,
	intervalMs = 2000,
): { data: T | null; error: string | null; refresh: () => void } {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		if (!id) {
			setData(null);
			setError(null);
			return;
		}
		let cancelled = false;
		const load = async () => {
			try {
				const result = await fetcher(id);
				if (!cancelled) {
					setData(result);
					setError(null);
				}
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		};
		void load();
		const timer = setInterval(load, intervalMs);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [id, fetcher, intervalMs, nonce]);

	return {
		data,
		error,
		refresh: () => setNonce(n => n + 1),
	};
}
