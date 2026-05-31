import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { BrowserDashboardState } from "./types";

const DEFAULT_PORT = 8765;
const SSE_HEARTBEAT_MS = 15_000;

export interface BrowserDashboardController {
	start(cwd: string): Promise<void>;
	stop(): void;
	broadcast(event: string, data: unknown): void;
	isRunning(): boolean;
	getUrl(): string | null;
}

export function createBrowserDashboardController(): BrowserDashboardController {
	let server: ReturnType<typeof Bun.serve> | null = null;
	const state: BrowserDashboardState = { connected: 0, events: [] };
	const clients = new Set<ReadableStreamDefaultController>();
	let heartbeatInterval: NodeJS.Timeout | undefined;

	const start = async (_workDir: string): Promise<void> => {
		if (server) return;
		const htmlPath = path.join(import.meta.dir, "assets", "template.html");
		const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, "utf8") : fallbackHtml();

		server = Bun.serve({
			port: DEFAULT_PORT,
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

		logger.info("Browser dashboard started", { url: `http://localhost:${DEFAULT_PORT}` });
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
	};

	const broadcast = (event: string, data: unknown): void => {
		state.events.push({ type: event, data, timestamp: Date.now() });
		if (state.events.length > 500) {
			state.events = state.events.slice(-400);
		}
		broadcastSse(event, data);
	};

	const isRunning = (): boolean => server !== null;

	const getUrl = (): string | null => {
		if (!server) return null;
		return `http://localhost:${DEFAULT_PORT}`;
	};

	const handleSse = (request: Request): Response => {
		const stream = new ReadableStream({
			start(controller) {
				clients.add(controller);
				state.connected = clients.size;
				// Send initial state
				const encoder = new TextEncoder();
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "init", state })}\n\n`));
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
