import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { createAgentSession, type CreateAgentSessionOptions } from "../../sdk";
import { SessionManager } from "../../session/session-manager";
import { Settings } from "../../config/settings";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import { z } from "zod";

export interface WorkflowAgentOptions {
	cwd?: string;
	/** Extra tools available to the subagent in addition to the structured output tool. */
	tools?: CustomTool[];
	/** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
	session?: Partial<CreateAgentSessionOptions>;
	/** Extra system guidance prepended to every subagent task. */
	instructions?: string;
}

export interface AgentRunOptions {
	label?: string;
	schema?: unknown;
	tools?: CustomTool[];
	instructions?: string;
	signal?: AbortSignal;
}

export type AgentRunResult = unknown;

export interface StructuredOutputCapture<T = unknown> {
	value: T | undefined;
	called: boolean;
}

function createStructuredOutputTool(capture: StructuredOutputCapture): CustomTool {
	return {
		name: "structured_output",
		label: "Structured Output",
		description: "Return the final machine-readable result for this subagent task.",
		parameters: z.object({}).passthrough(),
		async execute(_toolCallId, params) {
			capture.value = params;
			capture.called = true;
			return {
				content: [{ type: "text", text: "Structured output received." }],
				details: params,
			};
		},
	};
}

export class WorkflowAgent {
	readonly #cwd: string;
	readonly #baseTools: CustomTool[];
	readonly #sessionOptions: Partial<CreateAgentSessionOptions>;
	readonly #instructions?: string;

	constructor(options: WorkflowAgentOptions = {}) {
		this.#cwd = options.cwd ?? process.cwd();
		this.#baseTools = options.tools ?? [];
		this.#sessionOptions = options.session ?? {};
		this.#instructions = options.instructions;
	}

	async run(prompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
		const capture: StructuredOutputCapture = { called: false, value: undefined };
		const customTools: CustomTool[] = [...this.#baseTools, ...(options.tools ?? [])];

		if (options.schema) {
			customTools.push(createStructuredOutputTool(capture));
		}

		const { session } = await createAgentSession({
			cwd: this.#cwd,
			settings: Settings.isolated({
				"compaction.enabled": false,
			}),
			sessionManager: SessionManager.inMemory(),
			customTools,
			...this.#sessionOptions,
		});

		let removeAbortListener: (() => void) | undefined;
		try {
			if (options.signal?.aborted) throw new Error("Subagent was aborted");
			if (options.signal) {
				const onAbort = () => void session.abort();
				options.signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
			}

			await session.prompt(this.#buildPrompt(prompt, options, Boolean(options.schema)));
			await session.waitForIdle();

			if (options.signal?.aborted) throw new Error("Subagent was aborted");

			if (options.schema) {
				if (!capture.called) {
					throw new Error("Subagent finished without calling structured_output");
				}
				return capture.value;
			}

			return this.#lastAssistantText(session.messages);
		} finally {
			removeAbortListener?.();
			void session.dispose();
		}
	}

	#buildPrompt(prompt: string, options: AgentRunOptions, structured: boolean): string {
		const parts = [
			this.#instructions,
			options.instructions,
			options.label ? `Task label: ${options.label}` : undefined,
			prompt,
		].filter(Boolean);

		if (structured) {
			parts.push(
				[
					"Final output contract:",
					"- Your final action MUST be a structured_output tool call.",
					"- The structured_output arguments are the return value of this subagent.",
					"- Do not emit a prose final answer instead of structured_output.",
					"- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
				].join("\n"),
			);
		}

		return parts.join("\n\n");
	}

	#lastAssistantText(messages: unknown[]): string {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as Partial<AssistantMessage> | undefined;
			if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
			const text = message.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("");
			if (text.trim()) return text;
		}
		return "";
	}
}
