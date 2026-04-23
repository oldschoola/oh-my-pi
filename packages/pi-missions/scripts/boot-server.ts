/**
 * Boot the MissionControl dashboard server against a specific sandbox
 * directory. Pairs with scripts/smoke-integration.ts — call that first to
 * seed state, then this to serve it.
 *
 * Usage:
 *
 *     bun run scripts/boot-server.ts <cwd> [port]
 */

import { startServer } from "../src/server";

const cwd = process.argv[2];
const port = process.argv[3] ? Number.parseInt(process.argv[3], 10) : 3848;
if (!cwd) {
	console.error("Usage: bun run scripts/boot-server.ts <cwd> [port]");
	process.exit(1);
}

const server = await startServer({ cwd, port });
console.log(`MissionControl dashboard: http://localhost:${server.port} (cwd=${cwd})`);

process.on("SIGINT", () => {
	server.stop();
	process.exit(0);
});

// Keep alive.
await new Promise(() => {});
