import turnAbortedGuidance from "../prompts/turn-aborted-guidance.md" with { type: "text" };
import type {
	Api,
	AssistantMessage,
	DeveloperMessage,
	Message,
	Model,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../types";

const enum ToolCallStatus {
	/** Tool call has received a result (real or synthetic for orphan) */
	Resolved = 1,
	/** Tool call was from an aborted message; synthetic result injected, skip real results */
	Aborted = 2,
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 *
 * For aborted/errored turns, this function:
 * - Preserves tool call structure (unlike converting to text summaries)
 * - Injects synthetic "aborted" tool results
 * - Adds a <turn-aborted> guidance marker for the model
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();

	const latestAssistantIndex = messages.findLastIndex(msg => msg.role === "assistant");
	// First pass: transform messages (thinking blocks, tool call ID normalization)
	const transformed = messages.map((msg, index) => {
		// User and developer messages pass through unchanged
		if (msg.role === "user" || msg.role === "developer") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const mustPreserveLatestAnthropicThinking =
				index === latestAssistantIndex &&
				model.api === "anthropic-messages" &&
				assistantMsg.api === "anthropic-messages";
			// Aborted/errored messages may have partially-streamed thinking signatures.
			// A partial signature is invalid and will be rejected by the API, so we must
			// strip signatures from thinking blocks in these messages.
			const hasInvalidSignatures = assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error";

			const transformedContent = assistantMsg.content.flatMap(block => {
				if (block.type === "thinking") {
					// Strip signature from aborted/errored messages — it's likely incomplete
					const sanitized =
						hasInvalidSignatures && block.thinkingSignature ? { ...block, thinkingSignature: undefined } : block;
					if (mustPreserveLatestAnthropicThinking) return sanitized;
					// For same model: keep thinking blocks with signatures (needed for replay)
					// even if the thinking text is empty (OpenAI encrypted reasoning)
					if (isSameModel && sanitized.thinkingSignature) return sanitized;
					// Skip empty thinking blocks, convert others to plain text
					if (!sanitized.thinking || sanitized.thinking.trim() === "") return [];
					if (isSameModel) return sanitized;
					return {
						type: "text" as const,
						text: sanitized.thinking,
					};
				}

				if (block.type === "redactedThinking") {
					if (mustPreserveLatestAnthropicThinking) return block;
					if (isSameModel) return block;
					return [];
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});
	// Always index real `tool_result`s by id so the orphan-synthesis branch
	// can ask "does a real result land later in history?" cheaply. This is the
	// only piece of bookkeeping every provider needs; pull-forward is layered
	// on top below for Anthropic.
	const realToolResultIds = new Set<string>();
	for (const msg of transformed) {
		if (msg.role === "toolResult") realToolResultIds.add(msg.toolCallId);
	}

	// Pull-forward exists to satisfy Anthropic's "every assistant `tool_use`
	// must be immediately followed by its `tool_result`" invariant. Other
	// provider wire formats (OpenAI chat/responses/codex, Google generative-ai
	// / vertex / gemini-cli, ollama-chat, cursor-agent, and Bedrock with
	// non-Anthropic models) tolerate intervening `user`/`developer` turns
	// between an assistant tool call and its tool result, and silently
	// reordering history there would change instruction chronology without
	// any wire-format payoff. Gate the queue + identity tracking on Anthropic
	// so the iterator-side skip is a guaranteed no-op for other providers and
	// `flushPendingToolCalls` falls back to the original "let the real result
	// land naturally" behavior.
	const pullForwardEnabled = model.api === "anthropic-messages";

	// Queue every real tool result by its tool-call id so we can pull deferred
	// results forward when a non-toolResult message would otherwise split a
	// tool_use from its result (two consecutive assistant messages, a developer
	// message injected between the call and the result, etc.).
	//
	// We queue per id (instead of "first wins") because cross-provider tool-call
	// ID normalization is not necessarily injective: Mistral truncates to 9
	// alphanumeric chars, Google sanitizes-then-slices to 64, and any such
	// transform can collide distinct source IDs. With a queue plus
	// identity-based consumed tracking, the Nth tool_use with id X consumes
	// the Nth tool_result with id X — the only association we can make once
	// the IDs have already collided.
	const realToolResultQueue = new Map<string, ToolResultMessage[]>();
	if (pullForwardEnabled) {
		for (const msg of transformed) {
			if (msg.role !== "toolResult") continue;
			const existing = realToolResultQueue.get(msg.toolCallId);
			if (existing) existing.push(msg);
			else realToolResultQueue.set(msg.toolCallId, [msg]);
		}
	}
	// Tool result instances already emitted via pull-forward. Identity-based so
	// a collision between distinct ids never causes us to drop a legitimate
	// second result that just happens to share the normalized id. Stays empty
	// when `pullForwardEnabled` is false, making the iterator-side skip a no-op.
	const consumedRealToolResults = new Set<ToolResultMessage>();

	// Anthropic rejects `tool_result` blocks whose `tool_use_id` does not appear in a prior
	// `tool_use` block. After handoff/compaction folds an assistant turn into a summary
	// string, the user-side `toolResult` for that turn can survive while the originating
	// `tool_use` disappears — leaving an orphan that triggers HTTP 400. Track the set of
	// `tool_use` ids that survive transformation so the second pass can drop orphans cleanly.
	const validToolUseIds = new Set<string>();
	for (const msg of transformed) {
		if (msg.role !== "assistant") continue;
		for (const block of msg.content) {
			if (block.type === "toolCall") validToolUseIds.add(block.id);
		}
	}

	// Second pass: insert synthetic empty tool results for orphaned tool calls
	// and preserve aborted/errored tool results when they were already persisted.
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let pendingAbortedToolCalls = new Map<string, ToolCall>();
	let pendingAbortedTimestamp: number | undefined;
	// Track tool call status: whether resolved (has result) or aborted
	// (synthetic result injected, skip later real results). Keyed by id so
	// the toolResult iterator can still answer "was this id aborted?" when
	// it has no back-reference to the originating ToolCall.
	const toolCallStatus = new Map<string, ToolCallStatus>();
	// Identity-based "this specific ToolCall has been satisfied" tracking.
	// We can't use the id-keyed `toolCallStatus` map as the per-flush guard
	// because cross-provider id normalization (Mistral 9-char truncation,
	// Google sanitize-then-slice, etc.) is not injective. With id-keyed
	// dedup, the replay shape
	//   assistant(toolCall=X) -> assistant(toolCall=X) -> developer
	//     -> toolResult(X) -> toolResult(X)
	// resolves the first X and marks the id `Resolved`, then the second
	// flush sees the same id-keyed status and skips the second pending
	// call, leaving its `tool_use` unmatched and the developer wedged
	// between assistant#2 and its `tool_result` — re-triggering the
	// Anthropic 400 this PR exists to fix. Tracking by ToolCall identity
	// instead lets the second pending call run independently.
	const resolvedToolCalls = new WeakSet<ToolCall>();

	// When a real `tool_result` lands at its original iteration position (i.e.
	// it was NOT pulled forward into an earlier slot by `flushPendingToolCalls`),
	// remove it from the FIFO queue so a subsequent flush doesn't pull it
	// forward again as a duplicate. The queue is encounter-ordered and we
	// process messages in the same order, so the natural-land message is always
	// at the front of its per-id queue. No-op for non-Anthropic flows because
	// the queue is empty (pull-forward disabled).
	const shiftQueueAt = (msg: ToolResultMessage): void => {
		const queue = realToolResultQueue.get(msg.toolCallId);
		if (queue && queue[0] === msg) queue.shift();
	};

	const flushPendingToolCalls = (timestamp: number): void => {
		if (pendingToolCalls.length === 0) return;
		for (const tc of pendingToolCalls) {
			if (resolvedToolCalls.has(tc)) continue;
			const queue = realToolResultQueue.get(tc.id);
			const realResult = queue?.shift();
			if (realResult) {
				// A real result exists later in history and pull-forward is
				// enabled (Anthropic): pull it forward so the `tool_use` is
				// immediately followed by its `tool_result`. Use the front of
				// the queue so collided ids retain their natural pairing (Nth
				// tool_use ↔ Nth tool_result).
				result.push(realResult);
				consumedRealToolResults.add(realResult);
				resolvedToolCalls.add(tc);
				toolCallStatus.set(tc.id, ToolCallStatus.Resolved);
				continue;
			}
			if (realToolResultIds.has(tc.id)) {
				// A real result exists later in history but pull-forward is
				// disabled (non-Anthropic provider) or every queued result for
				// this id was already consumed by an earlier pull-forward.
				// Either way: let the real result land at its original
				// position — do NOT synthesize a placeholder, that would
				// duplicate the tool result and (worse, for non-Anthropic)
				// silently reorder history.
				resolvedToolCalls.add(tc);
				continue;
			}
			// No real result anywhere in history. Synthesize a placeholder so
			// the wire format stays valid for the model and we don't silently
			// drop the tool call.
			result.push({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: tc.name,
				content: [{ type: "text", text: "No result provided" }],
				isError: true,
				timestamp,
			} as ToolResultMessage);
			resolvedToolCalls.add(tc);
			toolCallStatus.set(tc.id, ToolCallStatus.Resolved);
		}
		pendingToolCalls = [];
	};

	const flushPendingAbortedToolCalls = (): void => {
		if (pendingAbortedTimestamp === undefined) return;
		for (const tc of pendingAbortedToolCalls.values()) {
			// Identity-based skip for the same reason as `flushPendingToolCalls`:
			// a normalized-id collision with a previously resolved/aborted call
			// would otherwise drop this distinct pending call's synthetic
			// `aborted` result.
			if (resolvedToolCalls.has(tc)) continue;
			result.push({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: tc.name,
				content: [{ type: "text", text: "aborted" }],
				isError: true,
				timestamp: pendingAbortedTimestamp,
			} as ToolResultMessage);
			resolvedToolCalls.add(tc);
			toolCallStatus.set(tc.id, ToolCallStatus.Aborted);
		}
		result.push({
			role: "developer",
			content: turnAbortedGuidance,
			timestamp: pendingAbortedTimestamp + 1,
		} as DeveloperMessage);
		pendingAbortedToolCalls = new Map();
		pendingAbortedTimestamp = undefined;
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];
		const messageTimestamp = "timestamp" in msg && typeof msg.timestamp === "number" ? msg.timestamp : Date.now();

		if (msg.role === "assistant") {
			flushPendingToolCalls(messageTimestamp);
			flushPendingAbortedToolCalls();

			const assistantMsg = msg as AssistantMessage;
			const toolCalls = assistantMsg.content.filter(b => b.type === "toolCall") as ToolCall[];

			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				// Keep the assistant message with tool calls intact. If real tool results follow, preserve them;
				// otherwise synthesize aborted results before the next turn boundary.
				result.push(msg);
				pendingAbortedToolCalls = new Map(toolCalls.map(toolCall => [toolCall.id, toolCall] as const));
				pendingAbortedTimestamp = assistantMsg.timestamp;
				continue;
			}

			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			if (consumedRealToolResults.has(msg)) {
				// This specific tool_result instance was already pulled forward
				// during a flush; skip its original position. Other
				// tool_results sharing the same (potentially collided) id are
				// untouched.
				continue;
			}
			if (pendingAbortedToolCalls.has(msg.toolCallId)) {
				pendingAbortedToolCalls.delete(msg.toolCallId);
				toolCallStatus.set(msg.toolCallId, ToolCallStatus.Resolved);
				shiftQueueAt(msg);
				result.push(msg);
				continue;
			}

			if (toolCallStatus.get(msg.toolCallId) === ToolCallStatus.Aborted) continue;

			if (!validToolUseIds.has(msg.toolCallId)) {
				// Orphan `tool_result`: the originating `tool_use` is not present in the
				// transformed history (typically because handoff/compaction folded the
				// assistant message into a summary string while the user-side result
				// survived). Sending the block as-is would 400 the request, so it must
				// be dropped.
				//
				// If a pending tool-call window is still open (either normal or
				// aborted), the orphan cannot be replaced with a developer note here:
				//
				// * Anthropic requires the next message after an assistant `tool_use`
				//   to be the matching `tool_result`. Inserting a developer message
				//   would break that contiguity.
				// * `flushPendingAbortedToolCalls` synthesizes "aborted" results
				//   without checking whether a real result lands later in history
				//   (unlike `flushPendingToolCalls`, which is gated by
				//   `realToolResultIds`). Calling it here would convert a legitimate
				//   later `tool_result` into a synthetic "aborted" one via the
				//   `ToolCallStatus.Aborted` skip-guard.
				//
				// Drop the orphan silently in that case; the upcoming real
				// `tool_result` will land normally on the next iteration.
				if (pendingToolCalls.length > 0 || pendingAbortedToolCalls.size > 0) {
					continue;
				}
				// No pending tool-call window: safe to preserve the text payload so the
				// model still sees what the tool returned.
				//
				// The note is emitted with `role: "user"` rather than `role: "developer"`
				// because the developer role is elevated by some providers:
				//
				// * Ollama maps `developer` -> `system` (highest instruction priority).
				// * OpenAI chat-completions reasoning models forward `developer` as
				//   `developer` (above-user instruction priority).
				//
				// Stale, model-untrusted tool output must not gain instruction priority
				// above user/developer messages it lived alongside before compaction.
				// `user` role is mapped to plain user content by every provider, so the
				// content survives without ever being treated as an instruction the
				// model should obey.
				const textParts: string[] = [];
				for (const part of msg.content) {
					if (part.type === "text" && part.text.trim() !== "") textParts.push(part.text);
				}
				if (textParts.length > 0) {
					const errorAttr = msg.isError ? ' is-error="true"' : "";
					result.push({
						role: "user",
						content: `<stale-tool-result tool="${msg.toolName}" id="${msg.toolCallId}"${errorAttr}>\n${textParts.join("\n")}\n</stale-tool-result>`,
						timestamp: messageTimestamp,
					} as UserMessage);
				}
				continue;
			}

			toolCallStatus.set(msg.toolCallId, ToolCallStatus.Resolved);
			shiftQueueAt(msg);
			result.push(msg);
		} else if (msg.role === "user" || msg.role === "developer") {
			flushPendingToolCalls(messageTimestamp);
			flushPendingAbortedToolCalls();
			result.push(msg);
		} else {
			flushPendingToolCalls(messageTimestamp);
			flushPendingAbortedToolCalls();
			result.push(msg);
		}
	}

	flushPendingToolCalls(Date.now());
	flushPendingAbortedToolCalls();

	return result;
}
