import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import { buildExperimentState } from "./state";
import { openAutoresearchStorageIfExists } from "./storage";
import type { BrowserDashboardState, ExperimentResult, SessionSnapshot } from "./types";

const DEFAULT_PORT = 8765;
const SSE_HEARTBEAT_MS = 15_000;

export interface BrowserDashboardStartOptions {
	port?: number;
}

export interface BrowserDashboardController {
	start(cwd: string, options?: BrowserDashboardStartOptions): Promise<void>;
	stop(): void;
	broadcast(event: string, data: unknown): void;
	isRunning(): boolean;
	getUrl(): string | null;
}

export function createBrowserDashboardController(): BrowserDashboardController {
	let server: ReturnType<typeof Bun.serve> | null = null;
	const state: BrowserDashboardState = { connected: 0, events: [] };
	let latestSession: SessionSnapshot | null = null;
	const clients = new Set<ReadableStreamDefaultController>();
	let heartbeatInterval: NodeJS.Timeout | undefined;

	const start = async (cwd: string, options: BrowserDashboardStartOptions = {}): Promise<void> => {
		if (server) return;
		const htmlPath = path.join(import.meta.dir, "assets", "template.html");
		const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, "utf8") : fallbackHtml();

		// Seed the cached session snapshot from storage if one already exists so
		// new SSE clients see the recorded runs even when no live `broadcast`
		// has fired yet. Tolerated to fail: tests start the dashboard against
		// directories that aren't git repos.
		try {
			latestSession = await loadSessionSnapshotFromStorage(cwd);
		} catch (err) {
			logger.debug("Browser dashboard: storage seed skipped", {
				cwd,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		server = Bun.serve({
			port: options.port ?? DEFAULT_PORT,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/events") {
					return handleSse(request);
				}
				return new Response(html, {
					headers: { "Content-Type": "text/html" },
				});
			},
		});

		heartbeatInterval = setInterval(() => {
			broadcastSse("heartbeat", { timestamp: Date.now() });
		}, SSE_HEARTBEAT_MS);

		logger.info("Browser dashboard started", { url: getUrl() });
	};

	const stop = (): void => {
		if (heartbeatInterval) {
			clearInterval(heartbeatInterval);
			heartbeatInterval = undefined;
		}
		for (const controller of clients) {
			try {
				controller.close();
			} catch {
				// ignore
			}
		}
		clients.clear();
		server?.stop();
		server = null;
		latestSession = null;
	};

	const broadcast = (event: string, data: unknown): void => {
		state.events.push({ type: event, data, timestamp: Date.now() });
		if (state.events.length > 500) {
			state.events = state.events.slice(-400);
		}
		// The `session` broadcast IS the latest snapshot — cache it so new SSE
		// clients can replay it via the `init` frame instead of waiting for the
		// next state change.
		if (event === "session" && isSessionSnapshotLike(data)) {
			latestSession = data;
		}
		broadcastSse(event, data);
	};

	const isRunning = (): boolean => server !== null;

	const getUrl = (): string | null => {
		if (!server) return null;
		return `http://localhost:${server.port}`;
	};

	const handleSse = (request: Request): Response => {
		const stream = new ReadableStream({
			start(controller) {
				clients.add(controller);
				state.connected = clients.size;
				// Init frame uses the wire shape the browser template parses:
				// `data.data.state` is the session snapshot, and `data.data.results`
				// is a flat copy of `state.results` so future client variants can
				// read it without descending into state.
				const sessionForInit = latestSession;
				const results: ExperimentResult[] = sessionForInit?.results ?? [];
				const encoder = new TextEncoder();
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ type: "init", data: { state: sessionForInit, results } })}\n\n`,
					),
				);
				for (const event of state.events) {
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify({ type: event.type, data: event.data })}\n\n`),
					);
				}
				request.signal.addEventListener("abort", () => {
					clients.delete(controller);
					state.connected = clients.size;
					try {
						controller.close();
					} catch {
						// ignore
					}
				});
			},
		});
		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	};

	const broadcastSse = (event: string, data: unknown): void => {
		const message = `data: ${JSON.stringify({ type: event, data })}\n\n`;
		const encoder = new TextEncoder();
		for (const controller of clients) {
			try {
				controller.enqueue(encoder.encode(message));
			} catch {
				clients.delete(controller);
				state.connected = clients.size;
			}
		}
	};

	return { start, stop, broadcast, isRunning, getUrl };
}

async function loadSessionSnapshotFromStorage(cwd: string): Promise<SessionSnapshot | null> {
	const storage = await openAutoresearchStorageIfExists(cwd);
	if (!storage) return null;
	const branch = (await git.branch.current(cwd).catch(() => null)) ?? null;
	const session = storage.getActiveSessionForBranch(branch) ?? storage.getActiveSession();
	if (!session) return null;
	const loggedRuns = storage.listLoggedRuns(session.id);
	const state = buildExperimentState(session, loggedRuns);
	return {
		name: state.name,
		goal: state.goal,
		metricName: state.metricName,
		metricUnit: state.metricUnit,
		bestDirection: state.bestDirection,
		currentSegment: state.currentSegment,
		maxExperiments: state.maxExperiments,
		results: state.results,
		confidence: state.confidence,
		branch: state.branch,
		baselineCommit: state.baselineCommit,
		notes: state.notes,
	};
}

function isSessionSnapshotLike(value: unknown): value is SessionSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Partial<SessionSnapshot>;
	return Array.isArray(v.results) && typeof v.metricName === "string";
}

function fallbackHtml(): string {
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<title>Autoresearch Dashboard</title>
	<style>
		body { font-family: monospace; background: #1a1a2e; color: #eee; padding: 2rem; }
		#status { color: #0f0; }
		#events { white-space: pre-wrap; }
	</style>
</head>
<body>
	<h1>Autoresearch Dashboard</h1>
	<div id="status">Connecting...</div>
	<div id="events"></div>
	<script>
		const source = new EventSource('/events');
		const status = document.getElementById('status');
		const events = document.getElementById('events');
		source.onopen = () => { status.textContent = 'Connected'; };
		source.onerror = () => { status.textContent = 'Disconnected'; };
		source.onmessage = (e) => {
			const data = JSON.parse(e.data);
			const div = document.createElement('div');
			div.textContent = new Date().toISOString() + ' ' + data.type + ': ' + JSON.stringify(data.data);
			events.appendChild(div);
		};
	</script>
</body>
</html>`;
}
