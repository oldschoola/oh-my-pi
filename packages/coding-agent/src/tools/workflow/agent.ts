import type { AgentIdentity, AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { recordHandoff, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { z } from "zod";
import { Settings } from "../../config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "../../config/settings-schema";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import workflowSubagentPrompt from "../../prompts/system/workflow-subagent-prompt.md" with { type: "text" };
import { type CreateAgentSessionOptions, createAgentSession } from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import { SessionManager } from "../../session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../task";
import { buildOutputValidator, summarizeValidationFailure } from "../output-schema-validator";

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

function createStructuredOutputTool(capture: StructuredOutputCapture, schema: unknown): CustomTool {
	const { validator, error } = buildOutputValidator(schema);
	if (error) throw new Error(`Invalid structured_output schema: ${error}`);
	return {
		name: "structured_output",
		label: "Structured Output",
		description: "Return the final machine-readable result for this subagent task.",
		parameters: z.object({}).passthrough(),
		async execute(_toolCallId, params) {
			if (validator) {
				const result = validator.validate(params);
				if (!result.success) {
					const summary = summarizeValidationFailure(result, params, validator.requiredFields);
					throw new Error(`structured_output failed schema validation: ${summary.message}`);
				}
			}
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
	#runIndex = 0;

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
			customTools.push(createStructuredOutputTool(capture, options.schema));
		}

		const runIndex = ++this.#runIndex;
		const agentDisplayName = options.label ?? `workflow agent ${runIndex}`;
		const parentTaskPrefix = this.#sessionOptions.parentTaskPrefix;
		const agentId = `${parentTaskPrefix ? `${parentTaskPrefix}-` : ""}${sanitizeAgentId(agentDisplayName, runIndex)}`;

		const { session } = await createAgentSession({
			...this.#sessionOptions,
			cwd: this.#cwd,
			settings: createSubagentSettings(this.#sessionOptions.settings),
			sessionManager: SessionManager.inMemory(),
			customTools,
			requireYieldTool: true,
			taskDepth: this.#sessionOptions.taskDepth ?? 0,
			hasUI: false,
			parentTaskPrefix,
			agentId,
			agentDisplayName,
			telemetry: createWorkflowSubagentTelemetry(this.#sessionOptions.telemetry, {
				id: agentId,
				name: agentDisplayName,
				description: "Workflow subagent",
			}),
		});

		await removeParentOwnedTools(session);
		emitLifecycle(this.#sessionOptions, {
			id: agentId,
			agent: agentDisplayName,
			status: "started",
			index: runIndex - 1,
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

			const result = options.schema
				? this.#structuredOutputValue(capture)
				: this.#lastAssistantText(session.messages);
			emitLifecycle(this.#sessionOptions, {
				id: agentId,
				agent: agentDisplayName,
				status: "completed",
				index: runIndex - 1,
			});
			return result;
		} catch (error) {
			emitLifecycle(this.#sessionOptions, {
				id: agentId,
				agent: agentDisplayName,
				status: options.signal?.aborted ? "aborted" : "failed",
				index: runIndex - 1,
			});
			throw error;
		} finally {
			removeAbortListener?.();
			void session.dispose();
		}
	}

	#structuredOutputValue(capture: StructuredOutputCapture): unknown {
		if (!capture.called) {
			throw new Error("Subagent finished without calling structured_output");
		}
		return capture.value;
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

function createWorkflowSubagentTelemetry(
	parentTelemetry: AgentTelemetryConfig | undefined,
	agent: AgentIdentity,
): AgentTelemetryConfig | undefined {
	if (!parentTelemetry) return undefined;
	const parentTelemetryHandle = resolveTelemetry(parentTelemetry, parentTelemetry.conversationId);
	recordHandoff(parentTelemetryHandle, {
		fromAgent: parentTelemetry.agent,
		toAgent: agent,
	});
	return {
		...parentTelemetry,
		agent,
		conversationId: undefined,
	};
}

async function removeParentOwnedTools(session: AgentSession): Promise<void> {
	const parentOwnedToolNames = new Set(["todo_write"]);
	const activeToolNames = session.getActiveToolNames();
	const filteredToolNames = activeToolNames.filter(name => !parentOwnedToolNames.has(name));
	if (filteredToolNames.length !== activeToolNames.length) {
		await session.setActiveToolsByName(filteredToolNames);
	}
}

function emitLifecycle(
	sessionOptions: Partial<CreateAgentSessionOptions>,
	event: { id: string; agent: string; status: "started" | "completed" | "failed" | "aborted"; index: number },
): void {
	sessionOptions.eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: event.id,
		agent: event.agent,
		agentSource: "bundled",
		status: event.status,
		index: event.index,
	});
}

function sanitizeAgentId(label: string, index: number): string {
	const slug = label
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${index}-${slug || "workflow-agent"}`;
}
