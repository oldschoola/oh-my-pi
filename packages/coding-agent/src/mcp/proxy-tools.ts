import type { CustomTool } from "../extensibility/custom-tools/types";
import { ToolAbortError } from "../tools/tool-errors";
import { callTool } from "./client";
import type { MCPManager } from "./manager";

const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;

/**
 * Create proxy tools that reuse an existing MCP manager's live connections.
 *
 * Subagents receive these as custom tools when they inherit a parent MCP manager;
 * createAgentSession only discovers MCP tools when it owns discovery itself.
 *
 * `timeoutMs` bounds each individual MCP `tools/call`. Callers that have their own
 * timeout source (e.g. a settings-driven workflow value) pass it in; everyone else
 * gets the legacy 60s default. Pass `0` to disable the per-call timeout entirely.
 */
export function createMCPProxyTools(
	mcpManager: MCPManager,
	timeoutMs: number = DEFAULT_MCP_CALL_TIMEOUT_MS,
): CustomTool[] {
	return mcpManager.getTools().map(tool => {
		const mcpTool = tool as { mcpToolName?: string; mcpServerName?: string };
		return {
			name: tool.name,
			label: tool.label ?? tool.name,
			description: tool.description ?? "",
			parameters: tool.parameters,
			execute: async (_toolCallId, params, _onUpdate, _ctx, signal) => {
				if (signal?.aborted) {
					throw new ToolAbortError();
				}
				const serverName = mcpTool.mcpServerName ?? "";
				const mcpToolName = mcpTool.mcpToolName ?? "";
				try {
					const result = await withAbortTimeout(
						(async () => {
							const connection = await mcpManager.waitForConnection(serverName);
							return callTool(connection, mcpToolName, params as Record<string, unknown>, { signal });
						})(),
						timeoutMs,
						signal,
					);
					return {
						content: (result.content ?? []).map(item =>
							item.type === "text"
								? { type: "text" as const, text: item.text ?? "" }
								: { type: "text" as const, text: JSON.stringify(item) },
						),
						details: { serverName, mcpToolName, isError: result.isError },
					};
				} catch (error) {
					if (error instanceof ToolAbortError) {
						throw error;
					}
					return {
						content: [
							{
								type: "text" as const,
								text: `MCP error: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						details: { serverName, mcpToolName, isError: true },
					};
				}
			},
		};
	});
}

function withAbortTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) {
		return Promise.reject(new ToolAbortError());
	}
	if (timeoutMs <= 0) {
		// No timeout: still honor abort, but never reject for elapsed time.
		return signal ? attachAbortOnly(promise, signal) : promise;
	}

	const { promise: wrappedPromise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const timeoutId = setTimeout(() => {
		if (settled) return;
		settled = true;
		reject(new Error(`MCP tool call timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	const onAbort = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		reject(new ToolAbortError());
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	promise.then(resolve, reject).finally(() => {
		if (signal) signal.removeEventListener("abort", onAbort);
		clearTimeout(timeoutId);
	});

	return wrappedPromise;
}

function attachAbortOnly<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	const { promise: wrappedPromise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const onAbort = () => {
		if (settled) return;
		settled = true;
		reject(new ToolAbortError());
	};
	signal.addEventListener("abort", onAbort, { once: true });
	promise.then(resolve, reject).finally(() => {
		settled = true;
		signal.removeEventListener("abort", onAbort);
	});
	return wrappedPromise;
}
