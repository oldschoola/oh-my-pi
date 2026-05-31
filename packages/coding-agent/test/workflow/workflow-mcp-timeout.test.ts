import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import * as mcpClient from "../../src/mcp/client";
import type { MCPManager } from "../../src/mcp/manager";
import * as proxyTools from "../../src/mcp/proxy-tools";
import * as sdkModule from "../../src/sdk";
import { WorkflowAgent } from "../../src/tools/workflow/agent";

afterEach(() => {
	vi.restoreAllMocks();
});

function makeFakeManager(): MCPManager {
	return {
		getTools: () => [
			{
				name: "slow_tool",
				label: "slow_tool",
				description: "slow tool",
				parameters: {} as never,
				mcpServerName: "fake",
				mcpToolName: "slow_tool",
			},
		],
		waitForConnection: async () => ({}) as never,
	} as unknown as MCPManager;
}

describe("createMCPProxyTools timeoutMs argument", () => {
	test("applies the passed-in timeoutMs when the underlying MCP call hangs", async () => {
		const fakeManager = makeFakeManager();
		const neverResolving = new Promise(() => {});
		const callToolSpy = spyOn(mcpClient, "callTool").mockImplementation(() => neverResolving as never);

		try {
			const tools = proxyTools.createMCPProxyTools(fakeManager, 25);
			expect(tools).toHaveLength(1);

			const before = Date.now();
			const result = await tools[0].execute("call-1", {}, undefined as never, undefined as never, undefined);
			const elapsed = Date.now() - before;

			// The timeout produces a CustomTool error result (per the proxy-tools error
			// handler), not a thrown error — so we assert on `details.isError` and the
			// formatted message.
			expect(result.details?.isError).toBe(true);
			expect(result.content[0]?.type).toBe("text");
			expect((result.content[0] as { text: string }).text).toMatch(/MCP tool call timed out after 25ms/);
			// Elapsed should be near the 25ms budget, definitely under 1s.
			expect(elapsed).toBeLessThan(1_000);
		} finally {
			callToolSpy.mockRestore();
		}
	});

	test("defaults to the legacy 60_000ms timeout when no argument is supplied", async () => {
		const fakeManager = makeFakeManager();
		const callToolSpy = spyOn(mcpClient, "callTool").mockResolvedValue({
			content: [{ type: "text", text: "ok" }],
		} as never);

		try {
			// No explicit timeout argument — falls back to the default.
			const tools = proxyTools.createMCPProxyTools(fakeManager);
			const result = await tools[0].execute("call-2", {}, undefined as never, undefined as never, undefined);

			// Did not time out — call resolved normally with the mocked content.
			expect(result.details?.isError).toBeUndefined();
			expect(result.content[0]).toEqual({ type: "text", text: "ok" });
			expect(callToolSpy).toHaveBeenCalledTimes(1);
		} finally {
			callToolSpy.mockRestore();
		}
	});
});

describe("WorkflowAgent reads workflow.mcpCallTimeoutMs from settings", () => {
	test("forwards the configured timeout value to createMCPProxyTools", async () => {
		const fakeManager = {
			getTools: () => [],
			waitForConnection: async () => ({}) as never,
		} as unknown as MCPManager;

		const proxySpy = spyOn(proxyTools, "createMCPProxyTools").mockReturnValue([]);
		// Bail before createAgentSession does any real work; we only need to prove
		// that createMCPProxyTools sees the workflow-scoped setting first.
		const sessionSpy = spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			throw new Error("test-stop");
		});

		try {
			const settings = Settings.isolated({ "workflow.mcpCallTimeoutMs": 12_345 });
			const agent = new WorkflowAgent({ session: { settings, mcpManager: fakeManager } });

			await expect(agent.run("hello")).rejects.toThrow(/test-stop/);

			expect(proxySpy).toHaveBeenCalledTimes(1);
			expect(proxySpy.mock.calls[0]).toEqual([fakeManager, 12_345]);
			expect(sessionSpy).toHaveBeenCalledTimes(1);
		} finally {
			proxySpy.mockRestore();
			sessionSpy.mockRestore();
		}
	});

	test("falls back to the schema default (60_000) when the setting is unset", async () => {
		const fakeManager = {
			getTools: () => [],
			waitForConnection: async () => ({}) as never,
		} as unknown as MCPManager;

		const proxySpy = spyOn(proxyTools, "createMCPProxyTools").mockReturnValue([]);
		const sessionSpy = spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			throw new Error("test-stop");
		});

		try {
			// Empty isolated settings has no workflow.mcpCallTimeoutMs override; the
			// schema default (60_000) is what get() returns.
			const settings = Settings.isolated();
			const agent = new WorkflowAgent({ session: { settings, mcpManager: fakeManager } });

			await expect(agent.run("hello")).rejects.toThrow(/test-stop/);

			expect(proxySpy.mock.calls[0]).toEqual([fakeManager, 60_000]);
		} finally {
			proxySpy.mockRestore();
			sessionSpy.mockRestore();
		}
	});
});
