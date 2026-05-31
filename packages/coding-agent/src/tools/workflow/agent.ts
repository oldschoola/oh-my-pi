import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { z } from "zod";
import { Settings } from "../../config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "../../config/settings-schema";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import workflowSubagentPrompt from "../../prompts/system/workflow-subagent-prompt.md" with { type: "text" };
import { type CreateAgentSessionOptions, createAgentSession } from "../../sdk";
import { SessionManager } from "../../session/session-manager";

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

function createSubagentSettings(baseSettings: Settings | undefined): Settings {
	if (!baseSettings) return Settings.isolated({ "compaction.enabled": false });
	const snapshot: Partial<Record<SettingPath, unknown>> = {};
	for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		snapshot[key] = baseSettings.get(key);
	}
	return Settings.isolated({
		...snapshot,
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
		"tools.approvalMode": "yolo",
		"compaction.enabled": false,
	});
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

	async run(promptText: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
		const capture: StructuredOutputCapture = { called: false, value: undefined };
		const customTools: CustomTool[] = [...this.#baseTools, ...(options.tools ?? [])];

		if (options.schema) {
			customTools.push(createStructuredOutputTool(capture));
		}

		const { session } = await createAgentSession({
			cwd: this.#cwd,
			settings: createSubagentSettings(this.#sessionOptions.settings),
			sessionManager: SessionManager.inMemory(),
			customTools,
			requireYieldTool: true,
			taskDepth: this.#sessionOptions.taskDepth ?? 0,
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

			await session.prompt(
				prompt.render(workflowSubagentPrompt, {
					instructions: this.#instructions,
					taskInstructions: options.instructions,
					label: options.label,
					prompt: promptText,
					structured: Boolean(options.schema),
				}),
			);
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

	#lastAssistantText(messages: unknown[]): string {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as Partial<AssistantMessage> | undefined;
			if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
			const text = message.content
				.filter((part): part is TextContent => part.type === "text")
				.map(part => part.text)
				.join("");
			if (text.trim()) return text;
		}
		return "";
	}
}
