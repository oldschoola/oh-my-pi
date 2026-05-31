import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { HookPayload, HookResult } from "./types";

export const HOOKS_DIR = "autoresearch.hooks";
const MAX_HOOK_OUTPUT = 8 * 1024;

export function listHooks(cwd: string, event: HookPayload["event"]): string[] {
	const dir = path.join(cwd, HOOKS_DIR);
	if (!fs.existsSync(dir)) return [];
	const files = fs.readdirSync(dir).filter(name => name.endsWith(".sh"));
	// Sort by name for deterministic order
	files.sort();
	const prefix = event.replace("_", "-");
	return files.filter(name => name.startsWith(prefix)).map(name => path.join(dir, name));
}

export async function runHook(scriptPath: string, payload: HookPayload): Promise<HookResult> {
	if (!fs.existsSync(scriptPath)) {
		return { exitCode: 0, stdout: "", stderr: "", allowed: true, message: null };
	}
	const payloadJson = JSON.stringify(payload);
	try {
		const proc = Bun.spawn(["bash", scriptPath], {
			cwd: payload.cwd,
			stdin: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(payloadJson));
					controller.close();
				},
			}),
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const allowed = exitCode === 0;
		let message: string | null = null;
		try {
			const parsed = JSON.parse(stdout.slice(0, MAX_HOOK_OUTPUT)) as unknown;
			if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
				message = String((parsed as { message: unknown }).message);
			}
		} catch {
			// Not JSON, ignore
		}
		return {
			exitCode,
			stdout: stdout.slice(0, MAX_HOOK_OUTPUT),
			stderr: stderr.slice(0, MAX_HOOK_OUTPUT),
			allowed,
			message,
		};
	} catch (err) {
		logger.warn("Hook execution failed", { scriptPath, error: err instanceof Error ? err.message : String(err) });
		return {
			exitCode: 1,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			allowed: false,
			message: "Hook execution failed",
		};
	}
}

export async function runHooksForEvent(
	cwd: string,
	event: HookPayload["event"],
	payload: HookPayload,
): Promise<HookResult[]> {
	const scripts = listHooks(cwd, event);
	const results: HookResult[] = [];
	for (const scriptPath of scripts) {
		const result = await runHook(scriptPath, payload);
		results.push(result);
		if (!result.allowed) break;
	}
	return results;
}

export function hasHooks(cwd: string, event: HookPayload["event"]): boolean {
	return listHooks(cwd, event).length > 0;
}
