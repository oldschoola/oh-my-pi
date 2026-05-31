import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { Text } from "@oh-my-pi/pi-tui";
import { z } from "zod";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import type { ToolSession } from "../index";
import {
	createToolUpdateWorkflowDisplay,
	createWorkflowSnapshot,
	preview,
	recomputeWorkflowSnapshot,
	renderWorkflowComponent,
	type WorkflowSnapshot,
} from "./display.js";
import { parseWorkflowScript, runWorkflow, type WorkflowRunResult } from "./workflow.js";

const workflowSchema = z.object({
	script: z
		.string()
		.describe(
			[
				"Required raw JavaScript workflow script, with no Markdown fences.",
				"First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] }",
				"Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, and budget. The workflow must call agent() at least once.",
				"parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
				"parallel() and pipeline() return per-slot results as { ok: true, value } | { ok: false, error: string }. Inspect r.ok before using r.value; null is a valid value (not a failure sentinel).",
			].join(" "),
		),
	args: z.any().optional().describe("Optional JSON value exposed to the workflow script as global `args`."),
});

export type WorkflowToolInput = z.infer<typeof workflowSchema>;

export interface WorkflowToolDetails {
	meta: WorkflowRunResult["meta"];
	phases: string[];
	logs: string[];
	result: unknown;
	durationMs: number;
	[key: string]: unknown;
}

export class WorkflowTool implements AgentTool<typeof workflowSchema, WorkflowToolDetails, Theme> {
	readonly name = "workflow";
	readonly label = "Workflow";
	readonly summary = "Execute a deterministic JavaScript workflow that orchestrates multiple subagents";
	readonly approval = "exec" as const;
	readonly loadMode = "discoverable" as const;
	readonly strict = true;
	readonly #session: ToolSession;

	get description(): string {
		return [
			"Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline().",
			"script is required raw JavaScript. It must start with export const meta = { name, description, phases? } and must call agent() at least once.",
			"parallel() and pipeline() return per-slot results shaped as { ok: true, value } | { ok: false, error: string }. The model must inspect r.ok before reading r.value because null is a valid value (an agent that intentionally returned nothing).",
		].join(" ");
	}

	get parameters(): typeof workflowSchema {
		return workflowSchema;
	}

	constructor(session: ToolSession) {
		this.#session = session;
	}

	static createIf(session: ToolSession): WorkflowTool | null {
		if (!session.settings.get("workflow.enabled")) return null;
		return new WorkflowTool(session);
	}

	formatApprovalDetails(args: unknown): string[] {
		const params = args as Partial<WorkflowToolInput>;
		const script = normalizeWorkflowScript(params.script ?? "");
		try {
			const { meta } = parseWorkflowScript(script);
			const lines = [`${meta.name}: ${meta.description}`];
			if (meta.phases?.length) {
				lines.push(`Phases: ${meta.phases.map(phase => phase.title).join(" → ")}`);
			}
			return lines;
		} catch {
			const firstLine = script.split("\n")[0] ?? "";
			return [firstLine];
		}
	}

	async execute(
		_toolCallId: string,
		params: WorkflowToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<WorkflowToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<WorkflowToolDetails>> {
		const script = normalizeWorkflowScript(params.script);
		const parsed = parseWorkflowScript(script);
		let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
		const display = createToolUpdateWorkflowDisplay(onUpdate, {
			streamToolUpdates: true,
			maxAgents: 4,
			maxLogs: 1,
			showResultPreviews: false,
		});

		const update = () => {
			snapshot = recomputeWorkflowSnapshot(snapshot);
			display.update(snapshot);
		};

		let result: WorkflowRunResult;
		try {
			result = await runWorkflow(script, {
				cwd: this.#session.cwd,
				args: params.args,
				signal,
				concurrency: this.#session.settings.get("workflow.maxConcurrency"),
				scriptTimeoutMs: this.#session.settings.get("workflow.scriptTimeoutMs"),
				session: {
					settings: this.#session.settings,
					authStorage: this.#session.authStorage,
					modelRegistry: this.#session.modelRegistry,
					taskDepth: (this.#session.taskDepth ?? 0) + 1,
					hasUI: false,
					eventBus: this.#session.eventBus,
					agentRegistry: this.#session.agentRegistry,
					parentTaskPrefix: this.#session.getAgentId?.() ?? undefined,
					parentHindsightSessionState: this.#session.getHindsightSessionState?.(),
					parentMnemosyneSessionState: this.#session.getMnemosyneSessionState?.(),
					parentEvalSessionId: this.#session.getEvalSessionId?.() ?? undefined,
					enableLsp: this.#session.enableLsp,
					enableMCP: !this.#session.mcpManager,
					mcpManager: this.#session.mcpManager,
					localProtocolOptions: this.#session.localProtocolOptions,
					telemetry: this.#session.getTelemetry?.(),
				},
				onLog(message) {
					snapshot.logs.push(message);
					update();
				},
				onPhase(title) {
					snapshot.currentPhase = title;
					if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
					update();
				},
				onAgentStart(event) {
					if (signal?.aborted) throw new Error("Workflow was aborted");
					snapshot.agents.push({
						id: snapshot.agents.length + 1,
						label: event.label,
						phase: event.phase,
						prompt: event.prompt,
						status: "running",
					});
					update();
				},
				onAgentEnd(event) {
					const agent = [...snapshot.agents]
						.reverse()
						.find(item => item.label === event.label && item.status === "running");
					if (agent) {
						agent.status = event.failed ? "error" : "done";
						if (event.error) agent.error = event.error;
						agent.resultPreview = preview(event.result);
					}
					update();
				},
			});
		} catch (error) {
			if (signal?.aborted || isAbortError(error)) {
				for (const agent of snapshot.agents) {
					if (agent.status === "running") {
						agent.status = "skipped";
						agent.error = "aborted";
					}
				}
				snapshot = recomputeWorkflowSnapshot(snapshot);
				display.complete(snapshot);
				throw new Error("Workflow was aborted");
			}
			throw error;
		}

		if (result.agentCount === 0) {
			throw new Error(
				"workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
			);
		}

		snapshot.result = result.result;
		snapshot.durationMs = result.durationMs;
		snapshot = recomputeWorkflowSnapshot(snapshot);
		display.complete(snapshot);

		return {
			content: [
				{
					type: "text",
					text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).\n\nResult:\n${JSON.stringify(result.result, null, 2)}`,
				},
			],
			details: {
				...snapshot,
				meta: result.meta,
				phases: result.phases,
				logs: result.logs,
				result: result.result,
				durationMs: result.durationMs,
			},
		};
	}

	renderCall(_args: WorkflowToolInput, _options: RenderResultOptions, theme: Theme) {
		return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
	}

	renderResult(result: AgentToolResult<WorkflowToolDetails>, options: RenderResultOptions, _theme: Theme) {
		const snapshot = result.details as WorkflowSnapshot | undefined;
		if (snapshot?.name) {
			return renderWorkflowComponent(snapshot, !options.isPartial);
		}
		const text = result.content?.[0];
		return new Text(text?.type === "text" ? text.text : "workflow", 0, 0);
	}
}

function normalizeWorkflowScript(script: string): string {
	let text = script.trim();
	const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
	if (fence) text = fence[1].trim();
	return text;
}

function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /\babort(?:ed)?\b/i.test(error.message);
}
