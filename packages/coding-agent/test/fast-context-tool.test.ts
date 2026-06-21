import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createTools, FastContextTool, normalizeFastContextBaseUrl } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

interface CapturedChatBody {
	model?: string;
	messages?: Array<{ role?: string; content?: string | null; tool_call_id?: string }>;
	tools?: Array<{ function?: { name?: string } }>;
}

function createSession(cwd: string, overrides: Partial<Record<string, unknown>> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated(overrides),
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

describe("FastContext tool", () => {
	it("normalizes root and /v1 base URLs to chat-completions API roots", () => {
		expect(normalizeFastContextBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/v1");
		expect(normalizeFastContextBaseUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1");
		expect(normalizeFastContextBaseUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080/v1");
	});

	it("only exposes fast_context when FastContext is enabled", async () => {
		const disabledTools = await createTools(createSession(process.cwd()), ["fast_context"]);
		expect(disabledTools.some(tool => tool.name === "fast_context")).toBe(false);
		const defaultTools = await createTools(createSession(process.cwd(), { "fastContext.enabled": true }));
		expect(defaultTools.some(tool => tool.name === "fast_context")).toBe(false);

		const enabledTools = await createTools(createSession(process.cwd(), { "fastContext.enabled": true }), [
			"fast_context",
		]);
		expect(enabledTools.some(tool => tool.name === "fast_context")).toBe(true);
	});

	it("runs a Chat Completions loop with exact FastContext tool names and citations", async () => {
		const temp = TempDir.createSync("omp-fast-context-test-");
		try {
			const cwd = path.resolve(temp.path());
			const targetPath = path.join(cwd, "src", "auth.ts");
			await Bun.write(targetPath, "export function authenticate() {\n\treturn true;\n}\n");
			const capturedChats: CapturedChatBody[] = [];
			let chatCalls = 0;
			const fetchMock = async (url: string, init?: RequestInit): Promise<Response> => {
				if (url === "http://127.0.0.1:8080/v1/models") {
					return Response.json({ data: [{ id: "FastContext-1.0-4B-RL-Q4_K_M" }] });
				}
				if (url === "http://127.0.0.1:8080/v1/chat/completions") {
					const body = JSON.parse(String(init?.body ?? "{}")) as CapturedChatBody;
					capturedChats.push(body);
					chatCalls++;
					if (chatCalls === 1) {
						return Response.json({
							choices: [
								{
									message: {
										role: "assistant",
										content: null,
										tool_calls: [
											{
												id: "call_read",
												type: "function",
												function: { name: "Read", arguments: JSON.stringify({ path: targetPath }) },
											},
										],
									},
								},
							],
						});
					}
					return Response.json({
						choices: [
							{
								message: {
									role: "assistant",
									content: `Authentication is implemented here.\n\n<final_answer>\n${targetPath}:1-3\n</final_answer>`,
								},
							},
						],
					});
				}
				return new Response("not found", { status: 404 });
			};
			const tool = new FastContextTool(
				createSession(cwd, { "fastContext.enabled": true, "fastContext.baseUrl": "http://127.0.0.1:8080" }),
				{ fetch: fetchMock },
			);

			const result = await tool.execute("call", { query: "find auth implementation", max_turns: 2, mode: "agent" });

			expect(capturedChats[0]?.model).toBe("FastContext-1.0-4B-RL-Q4_K_M");
			expect(capturedChats[0]?.tools?.map(toolDef => toolDef.function?.name)).toEqual(["Read", "Glob", "Grep"]);
			expect(
				capturedChats[1]?.messages?.some(
					message => message.role === "tool" && message.tool_call_id === "call_read",
				),
			).toBe(true);
			expect(result.details?.citations).toEqual([`${targetPath}:1-3`]);
			expect(result.content[0]?.type).toBe("text");
			if (result.content[0]?.type === "text") {
				expect(result.content[0].text).toContain("<final_answer>");
			}
		} finally {
			await temp.remove();
		}
	});

	it("rejects URL and endpoint prose as non-citation output", async () => {
		const temp = TempDir.createSync("omp-fast-context-empty-citation-");
		try {
			const fetchMock = async (url: string): Promise<Response> => {
				if (url === "http://127.0.0.1:8080/v1/models") {
					return Response.json({ data: [{ id: "FastContext-1.0-4B-RL-Q4_K_M" }] });
				}
				if (url === "http://127.0.0.1:8080/v1/chat/completions") {
					return Response.json({
						choices: [
							{
								message: {
									role: "assistant",
									content:
										"<final_answer>\nhttp://127.0.0.1:8080/v1/models\n- `/models`: lists models\n</final_answer>",
								},
							},
						],
					});
				}
				return new Response("not found", { status: 404 });
			};
			const tool = new FastContextTool(
				createSession(temp.path(), { "fastContext.enabled": true, "fastContext.baseUrl": "http://127.0.0.1:8080" }),
				{ fetch: fetchMock },
			);

			const result = await tool.execute("call", { query: "find model endpoint", max_turns: 1, mode: "agent" });

			expect(result.isError).toBe(true);
			expect(result.details?.citations).toEqual([]);
			expect(result.details?.error).toContain("no file-line citations");
		} finally {
			await temp.remove();
		}
	});

	it("accepts POSIX absolute file-line citations inside the workspace", async () => {
		const posixCitation = "/tmp/omp-fast-context-posix/file.ts";
		const workspace = path.resolve(path.parse(process.cwd()).root, "tmp", "omp-fast-context-posix");
		const filePath = path.join(workspace, "file.ts");
		await Bun.write(filePath, "export const value = true;\n");
		try {
			const fetchMock = async (url: string): Promise<Response> => {
				if (url === "http://127.0.0.1:8080/v1/models") {
					return Response.json({ data: [{ id: "FastContext-1.0-4B-RL-Q4_K_M" }] });
				}
				if (url === "http://127.0.0.1:8080/v1/chat/completions") {
					return Response.json({
						choices: [
							{
								message: {
									role: "assistant",
									content: `<final_answer>\n${posixCitation}:1-1\n</final_answer>`,
								},
							},
						],
					});
				}
				return new Response("not found", { status: 404 });
			};
			const tool = new FastContextTool(
				createSession(workspace, { "fastContext.enabled": true, "fastContext.baseUrl": "http://127.0.0.1:8080" }),
				{ fetch: fetchMock },
			);

			const result = await tool.execute("call", { query: "find posix citation", max_turns: 1, mode: "agent" });

			expect(result.isError).toBeUndefined();
			expect(result.details?.citations).toEqual([`${posixCitation}:1-1`]);
		} finally {
			await fs.rm(workspace, { force: true, recursive: true });
		}
	});

	it("accepts top-level relative file citations inside the workspace", async () => {
		const temp = TempDir.createSync("omp-fast-context-relative-citation-");
		try {
			await Bun.write(path.join(temp.path(), "README.md"), "FastContext top-level citation target\n");
			const fetchMock = async (url: string): Promise<Response> => {
				if (url === "http://127.0.0.1:8080/v1/models") {
					return Response.json({ data: [{ id: "FastContext-1.0-4B-RL-Q4_K_M" }] });
				}
				if (url === "http://127.0.0.1:8080/v1/chat/completions") {
					return Response.json({
						choices: [
							{
								message: {
									role: "assistant",
									content: "<final_answer>\nREADME.md:1-1\n</final_answer>",
								},
							},
						],
					});
				}
				return new Response("not found", { status: 404 });
			};
			const tool = new FastContextTool(
				createSession(temp.path(), { "fastContext.enabled": true, "fastContext.baseUrl": "http://127.0.0.1:8080" }),
				{ fetch: fetchMock },
			);

			const result = await tool.execute("call", {
				query: "find FastContext citation target",
				max_turns: 1,
				mode: "agent",
			});

			expect(result.isError).toBeUndefined();
			expect(result.details?.citations).toEqual(["README.md:1-1"]);
		} finally {
			await temp.remove();
		}
	});

	it("hint mode expands query into keywords and native search results", async () => {
		const temp = TempDir.createSync("omp-fast-context-hint-");
		try {
			const cwd = path.resolve(temp.path());
			const authPath = path.join(cwd, "src", "auth.ts");
			const tokenPath = path.join(cwd, "src", "token.ts");
			await Bun.write(authPath, "export function authenticate() { return true; }\n");
			await Bun.write(tokenPath, "export function verifyToken() { return false; }\n");
			const fetchMock = async (url: string): Promise<Response> => {
				if (url === "http://127.0.0.1:8080/v1/models") {
					return Response.json({ data: [{ id: "FastContext-1.0-4B-RL-Q4_K_M" }] });
				}
				if (url === "http://127.0.0.1:8080/v1/chat/completions") {
					return Response.json({
						choices: [
							{
								message: {
									role: "assistant",
									content: JSON.stringify({
										keywords: ["authenticate", "verifyToken", "auth", "token"],
										globs: ["src/**/*auth*", "src/**/*token*"],
										grep_patterns: ["authenticate", "verifyToken"],
										grep_paths: ["src"],
										description: "Authentication and token verification",
									}),
								},
							},
						],
					});
				}
				return new Response("not found", { status: 404 });
			};
			const tool = new FastContextTool(
				createSession(cwd, { "fastContext.enabled": true, "fastContext.baseUrl": "http://127.0.0.1:8080" }),
				{ fetch: fetchMock },
			);

			const result = await tool.execute("call", { query: "find authentication logic" });

			expect(result.isError).toBeUndefined();
			expect(result.details?.mode).toBe("hint");
			expect(result.details?.turns).toBe(1);
			expect(result.details?.keywords).toContain("authenticate");
			expect(result.details?.globs).toContain("src/**/*auth*");
			const citations = result.details?.citations ?? [];
			expect(citations.length).toBeGreaterThanOrEqual(2);
			const citationPaths = citations.map(c => c.replace(/:\d+-\d+.*$/, "").replace(/\\/g, "/"));
			expect(citationPaths.some(p => p.includes("auth.ts"))).toBe(true);
			expect(citationPaths.some(p => p.includes("token.ts"))).toBe(true);
			expect(result.details?.description).toBe("Authentication and token verification");
		} finally {
			await temp.remove();
		}
	});

	it("agent mode exits early when <final_answer> accompanies tool calls", async () => {
		const temp = TempDir.createSync("omp-fast-context-early-");
		try {
			const cwd = path.resolve(temp.path());
			const targetPath = path.join(cwd, "target.ts");
			await Bun.write(targetPath, "export const found = true;\n");
			let chatCalls = 0;
			const fetchMock = async (url: string): Promise<Response> => {
				if (url === "http://127.0.0.1:8080/v1/models") {
					return Response.json({ data: [{ id: "FastContext-1.0-4B-RL-Q4_K_M" }] });
				}
				if (url === "http://127.0.0.1:8080/v1/chat/completions") {
					chatCalls++;
					// Turn 1: tool calls + final_answer in the SAME response.
					// Before fix, early termination was dead code (extractFinalAnswer
					// strips tags, so includes("<final_answer>") was always false).
					// The loop would execute the tool call and need a 2nd turn.
					return Response.json({
						choices: [
							{
								message: {
									role: "assistant",
									content: `Found it.\n<final_answer>\n${targetPath}:1-1\n</final_answer>`,
									tool_calls: [
										{
											id: "call_read",
											type: "function",
											function: { name: "Read", arguments: JSON.stringify({ path: targetPath }) },
										},
									],
								},
							},
						],
					});
				}
				return new Response("not found", { status: 404 });
			};
			const tool = new FastContextTool(
				createSession(cwd, { "fastContext.enabled": true, "fastContext.baseUrl": "http://127.0.0.1:8080" }),
				{ fetch: fetchMock },
			);

			const result = await tool.execute("call", { query: "find target", max_turns: 4, mode: "agent" });

			// Must exit after 1 turn, not 2 — early termination fired.
			expect(chatCalls).toBe(1);
			expect(result.details?.turns).toBe(1);
			expect(result.details?.citations).toEqual([`${targetPath}:1-1`]);
			expect(result.isError).toBeUndefined();
		} finally {
			await temp.remove();
		}
	});

	it("hint mode drops blank glob entries from model plan", async () => {
		const temp = TempDir.createSync("omp-fast-context-blank-glob-");
		try {
			const cwd = path.resolve(temp.path());
			const realPath = path.join(cwd, "src", "real.ts");
			await Bun.write(realPath, "export function authenticate() { return true; }\n");
			const fetchMock = async (url: string): Promise<Response> => {
				if (url === "http://127.0.0.1:8080/v1/models") {
					return Response.json({ data: [{ id: "FastContext-1.0-4B-RL-Q4_K_M" }] });
				}
				if (url === "http://127.0.0.1:8080/v1/chat/completions") {
					return Response.json({
						choices: [
							{
								message: {
									role: "assistant",
									content: JSON.stringify({
										keywords: ["authenticate"],
										// Empty string glob — before fix, #nativeGlob("")
										// resolved to cwd, globbed **/*, and flooded
										// results with random files.
										globs: ["", "src/**/*auth*"],
										grep_patterns: ["authenticate"],
										grep_paths: ["."],
										description: "",
									}),
								},
							},
						],
					});
				}
				return new Response("not found", { status: 404 });
			};
			const tool = new FastContextTool(
				createSession(cwd, { "fastContext.enabled": true, "fastContext.baseUrl": "http://127.0.0.1:8080" }),
				{ fetch: fetchMock },
			);

			const result = await tool.execute("call", { query: "find authenticate" });

			// The empty glob must be dropped — it should not appear in details.globs.
			expect(result.details?.globs).not.toContain("");
			// And results must not be flooded with workspace-root random files.
			// The only matching file is src/real.ts via the real glob + grep.
			const citations = result.details?.citations ?? [];
			const citationPaths = citations.map(c => c.replace(/:\d+-\d+.*$/, "").replace(/\\/g, "/"));
			expect(citationPaths.every(p => p.includes("real.ts"))).toBe(true);
		} finally {
			await temp.remove();
		}
	});

	it("re-resolves model when baseUrl changes mid-session", async () => {
		const temp = TempDir.createSync("omp-fast-context-model-cache-");
		try {
			const cwd = path.resolve(temp.path());
			await Bun.write(path.join(cwd, "src", "auth.ts"), "export function authenticate() { return true; }\n");
			let modelsCalls = 0;
			const fetchMock = async (url: string): Promise<Response> => {
				// Two different endpoints return different model ids.
				if (url === "http://127.0.0.1:8080/v1/models") {
					modelsCalls++;
					return Response.json({ data: [{ id: "model-A" }] });
				}
				if (url === "http://127.0.0.1:9090/v1/models") {
					modelsCalls++;
					return Response.json({ data: [{ id: "model-B" }] });
				}
				if (url.endsWith("/v1/chat/completions")) {
					return Response.json({
						choices: [
							{
								message: {
									role: "assistant",
									content: `<final_answer>\n${path.join(cwd, "src", "auth.ts")}:1-1\n</final_answer>`,
								},
							},
						],
					});
				}
				return new Response("not found", { status: 404 });
			};
			// Use a single session + tool instance so the #resolvedModel cache
			// is shared across calls. Mutate baseUrl on the same session to
			// exercise URL-keyed cache invalidation (not a new instance).
			const session = createSession(cwd, {
				"fastContext.enabled": true,
				"fastContext.baseUrl": "http://127.0.0.1:8080",
			});
			const tool = new FastContextTool(session, { fetch: fetchMock });
			// Call 1: resolves model-A from port 8080.
			await tool.execute("call", { query: "find auth", max_turns: 1, mode: "agent" });
			expect(modelsCalls).toBe(1);
			// Call 2: same endpoint — cache hit, no new /models fetch.
			await tool.execute("call", { query: "find auth", max_turns: 1, mode: "agent" });
			expect(modelsCalls).toBe(1);
			// Call 3: mutate baseUrl on the SAME session to port 9090.
			// The cache must invalidate (url mismatch) and re-resolve model-B.
			session.settings.override("fastContext.baseUrl", "http://127.0.0.1:9090");
			await tool.execute("call", { query: "find auth", max_turns: 1, mode: "agent" });
			expect(modelsCalls).toBe(2);
		} finally {
			await temp.remove();
		}
	});
});
