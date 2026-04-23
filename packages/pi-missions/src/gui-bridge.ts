/**
 * GUI Bridge — connects a running `/mission-gui` slash-command handler (or the
 * dashboard's persistent default bridge) with the dashboard's mission-start
 * form in the browser.
 *
 * Bridge kinds
 * ------------
 * - **explicit** — minted by `/mission-gui`. One-shot: the handler awaits a
 *   promise that resolves on the first submit. Bridge entry is removed after
 *   the submit (or on timeout / close).
 * - **default**  — registered at extension startup. Persistent: every submit
 *   routes through the same `handler` callback, which runs the full mission
 *   kickoff in-process. Lives for the lifetime of the extension.
 *
 * An explicit bridge always beats the default bridge when both exist, because
 * `/mission-gui` is a user-initiated, focused intent.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AutonomyLevel, ModelAssignment } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MissionStartRequest {
	token: string;
	templateKey: string;
	description: string;
	autonomy: AutonomyLevel;
	modelAssignment: ModelAssignment;
	constraints?: string;
	/** Optional — when > 1 the chat handler promotes the mission to a batch. */
	laneCount?: number;
	/** Optional wave size override for batch missions. */
	waveSize?: number;
}

export type BridgeKind = "default" | "explicit";

export interface GuiBridge {
	/** URL-safe token the browser must echo back. */
	token: string;
	/** Resolves with the user's start request or rejects on timeout/cancel. */
	waitForStart(): Promise<MissionStartRequest>;
	/** Release the bridge without waiting (use in `finally`). */
	close(): void;
}

/** Handler invoked for every submit on a persistent default bridge. */
export type DefaultBridgeHandler = (req: MissionStartRequest) => void | Promise<void>;

interface PendingBridge {
	token: string;
	kind: BridgeKind;
	// Explicit (one-shot)
	resolve?: (req: MissionStartRequest) => void;
	reject?: (err: Error) => void;
	timer?: NodeJS.Timeout;
	// Default (persistent)
	handler?: DefaultBridgeHandler;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const bridges = new Map<string, PendingBridge>();
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.OMP_MISSION_GUI_TIMEOUT_MS ?? "", 10) || 30 * 60 * 1000;

let defaultToken: string | null = null;

function tokensEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new explicit (one-shot) bridge and register it.
 */
export function createGuiBridge(timeoutMs: number = DEFAULT_TIMEOUT_MS): GuiBridge {
	const token = randomUUID();
	const { promise, resolve, reject } = Promise.withResolvers<MissionStartRequest>();

	const timer = setTimeout(() => {
		bridges.delete(token);
		reject(new Error(`mission-gui bridge timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	// Don't hold the Node event loop open just for this timer.
	if (typeof timer.unref === "function") timer.unref();

	bridges.set(token, { token, kind: "explicit", resolve, reject, timer });

	return {
		token,
		waitForStart: () => promise,
		close: () => {
			const entry = bridges.get(token);
			if (!entry) return;
			if (entry.timer) clearTimeout(entry.timer);
			bridges.delete(token);
		},
	};
}

/**
 * Register (or replace) the persistent default bridge. The returned token is
 * stable for the extension's lifetime unless re-registered.
 *
 * Submissions against this token dispatch to `handler` in-process rather than
 * resolving a one-shot promise. Use this to wire the browser's Start form
 * into the extension's live mission-kickoff code path even when no
 * `/mission-gui` command is outstanding.
 */
export function registerDefaultBridge(handler: DefaultBridgeHandler): string {
	removeDefaultBridge();
	const token = randomUUID();
	bridges.set(token, { token, kind: "default", handler });
	defaultToken = token;
	return token;
}

/** Return the current default bridge token, or null when none is registered. */
export function getDefaultToken(): string | null {
	return defaultToken;
}

/** Remove the default bridge. Safe to call when none is registered. */
export function removeDefaultBridge(): void {
	if (defaultToken) {
		bridges.delete(defaultToken);
		defaultToken = null;
	}
}

/**
 * Called by the dashboard server when the browser POSTs to /api/mission/start.
 *
 * Returns an `ok` flag + reason so the HTTP handler can map to status codes:
 *   ok=false + reason="unknown_token"  → 403
 *   ok=false + reason="invalid_payload" → 400
 *   ok=true                            → 202 (accepted, dispatched)
 */
export function dispatchStartRequest(
	req: MissionStartRequest,
): { ok: true; kind: BridgeKind } | { ok: false; reason: "unknown_token" | "invalid_payload" } {
	if (!req || typeof req.token !== "string" || req.token.length === 0) {
		return { ok: false, reason: "invalid_payload" };
	}

	// Constant-time lookup: iterate every bridge so callers can't
	// distinguish "no bridge registered" from "wrong token" via timing.
	let match: PendingBridge | null = null;
	for (const entry of bridges.values()) {
		if (tokensEqual(entry.token, req.token)) match = entry;
	}
	if (!match) return { ok: false, reason: "unknown_token" };

	if (
		typeof req.templateKey !== "string" ||
		typeof req.description !== "string" ||
		typeof req.autonomy !== "string" ||
		!req.modelAssignment ||
		typeof req.modelAssignment !== "object"
	) {
		return { ok: false, reason: "invalid_payload" };
	}

	if (match.kind === "explicit") {
		if (match.timer) clearTimeout(match.timer);
		bridges.delete(match.token);
		match.resolve?.(req);
		return { ok: true, kind: "explicit" };
	}

	// Default bridges persist across submits — fire the handler without
	// blocking the HTTP response. Errors are surfaced via the handler's own
	// logging; the browser has already received a 202.
	void Promise.resolve()
		.then(() => match?.handler?.(req))
		.catch(() => {
			// Handler already logs; swallow to keep the registry consistent.
		});
	return { ok: true, kind: "default" };
}

/** Test helper — number of bridges currently awaiting a submit. */
export function pendingBridgeCount(): number {
	return bridges.size;
}
