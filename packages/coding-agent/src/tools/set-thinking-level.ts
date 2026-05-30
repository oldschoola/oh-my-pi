/**
 * `set_thinking_level` — the agent's lever for **adaptive thinking** mode.
 *
 * When the session selector is `ThinkingLevel.Adaptive`, this tool is the only
 * way to mutate the *underlying* reasoning effort the provider sees on the next
 * turn. The tool is registered in `BUILTIN_TOOLS` so the discovery + reporting
 * machinery recognizes the name, but {@link SetThinkingLevelTool.createIf}
 * returns `null` outside adaptive mode — so the registration is inert and the
 * model never sees the schema unless adaptive is currently active.
 *
 * `persist=false` (default): apply for this turn only; restored to the adaptive
 *   baseline at `agent_end` by the session.
 * `persist=true`: replaces the adaptive baseline for the rest of the session.
 *
 * The tool intentionally returns *plain text* on every failure mode (not active,
 * invalid effort, model unsupported) so the model can self-correct without
 * blowing up the turn with an exception.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Effort } from "@oh-my-pi/pi-ai";
import * as z from "zod/v4";
import type { ToolSession } from ".";

const setThinkingLevelSchema = z.object({
	level: z
		.string()
		.min(1)
		.describe("Target effort supported by the current model (e.g. minimal, low, medium, high, xhigh)"),
	persist: z
		.boolean()
		.optional()
		.describe("false (default) applies for this turn only; true updates the session baseline"),
});

type SetThinkingLevelParams = z.infer<typeof setThinkingLevelSchema>;

export interface SetThinkingLevelDetails {
	level: Effort;
	persist: boolean;
	previous?: Effort;
}

export class SetThinkingLevelTool implements AgentTool<typeof setThinkingLevelSchema, SetThinkingLevelDetails> {
	readonly name = "set_thinking_level";
	readonly approval = "read" as const;
	readonly label = "Set Thinking Level";
	readonly summary = "Adjust the underlying reasoning effort while in adaptive thinking mode";
	readonly loadMode = "essential";
	readonly description =
		"Change the underlying reasoning effort while operating in adaptive thinking mode. " +
		"`persist=false` (default) applies for the current turn only; `persist=true` updates the session baseline.";
	readonly parameters = setThinkingLevelSchema;
	readonly strict = true;
	readonly intent = (args: Partial<SetThinkingLevelParams>) =>
		args.level ? `thinking → ${args.level}` : "adjusting thinking level";

	constructor(private readonly session: ToolSession) {}

	/**
	 * Built-in tool factory hook. Only constructs the tool when the session is
	 * currently in adaptive thinking mode — the surrounding code (createTools,
	 * search_tool_bm25 indices, autoQA enums) all treat a null return as "tool
	 * not available", which is the right shape for a per-session feature gate.
	 */
	static createIf(session: ToolSession): SetThinkingLevelTool | null {
		return session.isAdaptiveThinking?.() === true ? new SetThinkingLevelTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: SetThinkingLevelParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SetThinkingLevelDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SetThinkingLevelDetails>> {
		const session = this.session;
		if (session.isAdaptiveThinking?.() !== true) {
			return textResult("Adaptive thinking is not active for this session.");
		}

		const requested = params.level.trim().toLowerCase();
		const supported = session.getSupportedThinkingEfforts?.() ?? [];
		// `Effort` is a const enum of string literals, so a value-equality test
		// against the supported list is the same as a type-narrowing check.
		if (!supported.includes(requested as Effort)) {
			const list = supported.length > 0 ? supported.join(", ") : "<none>";
			return textResult(`"${requested}" is not a supported thinking effort. Valid: ${list}.`);
		}

		const level = requested as Effort;
		const persist = params.persist === true;
		const previous = session.getAdaptiveEffort?.();
		const ok = session.setAdaptiveEffort?.(level, persist) === true;
		if (!ok) {
			return textResult(`Failed to apply thinking effort ${level}.`);
		}

		const scope = persist ? "baseline" : "this turn";
		return {
			content: [{ type: "text", text: `Thinking effort set to ${level} (${scope}).` }],
			details: { level, persist, previous },
		};
	}
}

function textResult(text: string): AgentToolResult<SetThinkingLevelDetails> {
	return { content: [{ type: "text", text }], details: undefined };
}
