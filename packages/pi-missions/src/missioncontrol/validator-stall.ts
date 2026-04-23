/**
 * Validator stall detection (Track H2).
 *
 * Long-running missions (days of wall-clock time) occasionally see a
 * validator spawn hang without producing output. This module provides a
 * thin `withStallTimeout` helper that races a validator promise against
 * a timeout and reports the outcome in a structured way, plus heartbeat
 * helpers the engine can layer on top.
 *
 * Pure data + timer logic \u2014 no I/O, no process control. The caller is
 * responsible for invoking the kill callback when this helper reports a
 * stall.
 */

/** Default validator stall timeout (2 hours). */
export const DEFAULT_VALIDATOR_STALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Outcome of a validator run under stall surveillance. */
export type ValidatorRunOutcome =
	| { kind: "completed"; value: unknown }
	| { kind: "stalled"; timeoutMs: number }
	| { kind: "aborted"; reason?: string };

export interface WithStallTimeoutOptions<T> {
	/** The underlying validator promise. */
	promise: Promise<T>;
	/** Stall threshold in ms. Zero or negative disables the timer. */
	timeoutMs: number;
	/** AbortSignal that short-circuits the race to `aborted` outcome. */
	signal?: AbortSignal;
	/**
	 * Callback fired when the stall timeout fires. Invoked BEFORE the
	 * outcome resolves so the caller can kill the underlying process.
	 */
	onStall?: () => void;
}

/**
 * Race `promise` against a stall timeout. Resolves with a structured
 * {@link ValidatorRunOutcome}:
 *
 *   `{ kind: "completed", value }` when the promise resolves first.
 *   `{ kind: "stalled", timeoutMs }` when the timer fires first.
 *   `{ kind: "aborted", reason }` when the signal fires first.
 *
 * The helper does not cancel the underlying promise \u2014 callers wire a
 * kill + cleanup callback via `onStall` or by listening to the signal.
 */
export function withStallTimeout<T>(options: WithStallTimeoutOptions<T>): Promise<ValidatorRunOutcome> {
	const { promise, timeoutMs, signal, onStall } = options;
	const effective = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
	return new Promise<ValidatorRunOutcome>(resolve => {
		let settled = false;
		const finalize = (outcome: ValidatorRunOutcome): void => {
			if (settled) return;
			settled = true;
			resolve(outcome);
		};

		let timer: ReturnType<typeof setTimeout> | undefined;
		if (effective > 0) {
			timer = setTimeout(() => {
				if (settled) return;
				try {
					onStall?.();
				} finally {
					finalize({ kind: "stalled", timeoutMs: effective });
				}
			}, effective);
		}

		const onAbort = (): void => {
			if (timer) clearTimeout(timer);
			finalize({ kind: "aborted", reason: signal?.reason ? String(signal.reason) : undefined });
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		promise
			.then(value => {
				if (timer) clearTimeout(timer);
				finalize({ kind: "completed", value });
			})
			.catch((err: unknown) => {
				if (timer) clearTimeout(timer);
				finalize({ kind: "completed", value: err });
			});
	});
}

// \u2500\u2500 Heartbeat helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Default heartbeat cadence: 60s. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * How "stale" a heartbeat is relative to `now`. Values below 0 (future
 * timestamps from clock skew) are treated as `0`.
 */
export function heartbeatAgeMs(lastHeartbeatMs: number, now: number = Date.now()): number {
	if (!Number.isFinite(lastHeartbeatMs)) return Number.POSITIVE_INFINITY;
	return Math.max(0, now - lastHeartbeatMs);
}

/**
 * True when a heartbeat is stale relative to `now`. "Stale" = older than
 * 3\u00d7 the configured cadence (matches existing process-registry
 * conventions for liveness). Missing / non-finite timestamps are always
 * stale.
 */
export function isHeartbeatStale(
	lastHeartbeatMs: number,
	now: number = Date.now(),
	intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
): boolean {
	const age = heartbeatAgeMs(lastHeartbeatMs, now);
	if (!Number.isFinite(age)) return true;
	return age > intervalMs * 3;
}

/**
 * Human-readable age bucket for long-run dashboards. Mirrors Factory's
 * "idle since X" badge shorthand.
 */
export function idleSinceLabel(lastHeartbeatMs: number, now: number = Date.now()): string {
	const age = heartbeatAgeMs(lastHeartbeatMs, now);
	if (!Number.isFinite(age)) return "unknown";
	if (age < 60_000) return `${Math.round(age / 1000)}s`;
	if (age < 60 * 60_000) return `${Math.round(age / 60_000)}m`;
	if (age < 24 * 60 * 60_000) return `${Math.round(age / (60 * 60_000))}h`;
	return `${Math.round(age / (24 * 60 * 60_000))}d`;
}

/**
 * Elapsed days between `startedAt` and `now`, rounded down. Negative or
 * missing inputs return 0 (avoids negative badges from clock skew).
 */
export function elapsedDays(startedAtMs: number, now: number = Date.now()): number {
	if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return 0;
	return Math.max(0, Math.floor((now - startedAtMs) / (24 * 60 * 60_000)));
}
