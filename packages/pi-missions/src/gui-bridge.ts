/**
 * GUI Bridge — connects a running `/mission-gui` slash-command handler in an
 * `omp` chat session with the dashboard's mission-start form in the browser.
 *
 * Design
 * ------
 * The slash-command handler registers a bridge (token + pending promise) in
 * an in-process Map. It then opens the dashboard URL with `?gui=<token>` so
 * the React form knows which bridge to POST back to.
 *
 * When the user submits the form, the dashboard server's `POST /api/mission/
 * start` route calls `dispatchStartRequest(token, request)` which resolves
 * the handler's promise. The handler then runs the same kickoff code path as
 * `/mission` (planner → persist → sendUserMessage).
 *
 * v1 is in-process only (no external TCP listener): the slash command and
 * the `Bun.serve` dashboard live in the same Node process. The token still
 * guards against drive-by POSTs from other browser tabs.
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

export interface GuiBridge {
	/** URL-safe token the browser must echo back. */
	token: string;
	/** Resolves with the user's start request or rejects on timeout/cancel. */
	waitForStart(): Promise<MissionStartRequest>;
	/** Release the bridge without waiting (use in `finally`). */
	close(): void;
}

interface PendingBridge {
	token: string;
	resolve: (req: MissionStartRequest) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const bridges = new Map<string, PendingBridge>();
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.OMP_MISSION_GUI_TIMEOUT_MS ?? "", 10) || 30 * 60 * 1000;

function tokensEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Create a new bridge and register it. */
export function createGuiBridge(timeoutMs: number = DEFAULT_TIMEOUT_MS): GuiBridge {
	const token = randomUUID();
	const { promise, resolve, reject } = Promise.withResolvers<MissionStartRequest>();

	const timer = setTimeout(() => {
		bridges.delete(token);
		reject(new Error(`mission-gui bridge timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	// Don't hold the Node event loop open just for this timer.
	if (typeof timer.unref === "function") timer.unref();

	bridges.set(token, { token, resolve, reject, timer });

	return {
		token,
		waitForStart: () => promise,
		close: () => {
			const entry = bridges.get(token);
			if (!entry) return;
			clearTimeout(entry.timer);
			bridges.delete(token);
		},
	};
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
): { ok: true } | { ok: false; reason: "unknown_token" | "invalid_payload" } {
	if (!req || typeof req.token !== "string" || req.token.length === 0) {
		return { ok: false, reason: "invalid_payload" };
	}

	// Constant-time lookup: iterate every pending bridge so callers can't
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

	clearTimeout(match.timer);
	bridges.delete(match.token);
	match.resolve(req);
	return { ok: true };
}

/** Test helper — number of bridges currently awaiting a submit. */
export function pendingBridgeCount(): number {
	return bridges.size;
}
