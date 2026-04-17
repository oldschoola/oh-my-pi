/**
 * Incremental sidecar JSONL tailer — polls live worker telemetry written
 * by the RPC wrapper (token usage, tool calls, retries, context %).
 *
 * Ported from taskplane `extensions/taskplane/sidecar-telemetry.ts` with
 * the fs-sync I/O preserved: byte-offset reads are the cheapest way to
 * poll a growing file without re-parsing the whole thing. Bun supports
 * `node:fs` sync calls natively.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface SidecarTailState {
	offset: number;
	partial: string;
	retryActive: boolean;
}

export function createSidecarTailState(): SidecarTailState {
	return { offset: 0, partial: "", retryActive: false };
}

export interface SidecarTelemetryDelta {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
	latestTotalTokens: number;
	toolCalls: number;
	lastTool: string;
	retryActive: boolean;
	retriesStarted: number;
	lastRetryError: string;
	hadEvents: boolean;
	contextUsage: { percent: number; totalTokens: number; maxTokens: number } | null;
	sawStatsResponseWithoutContextUsage: boolean;
}

interface SidecarUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: number | { total?: number };
}

interface SidecarEvent {
	type?: string;
	message?: { usage?: SidecarUsage };
	toolName?: string;
	args?: string | Record<string, unknown>;
	errorMessage?: string;
	error?: string;
	success?: boolean;
	data?: {
		contextUsage?: {
			percent?: number;
			percentUsed?: number;
			totalTokens?: number;
			maxTokens?: number;
		};
	};
}

export function tailSidecarJsonl(filePath: string, tailState: SidecarTailState): SidecarTelemetryDelta {
	const delta: SidecarTelemetryDelta = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: 0,
		latestTotalTokens: 0,
		toolCalls: 0,
		lastTool: "",
		retryActive: tailState.retryActive,
		retriesStarted: 0,
		lastRetryError: "",
		hadEvents: false,
		contextUsage: null,
		sawStatsResponseWithoutContextUsage: false,
	};

	let fileSize: number;
	try {
		fileSize = statSync(filePath).size;
	} catch {
		return delta;
	}

	if (fileSize <= tailState.offset) return delta;

	const bytesToRead = fileSize - tailState.offset;
	const buf = Buffer.alloc(bytesToRead);
	let fd: number;
	try {
		fd = openSync(filePath, "r");
	} catch {
		return delta;
	}
	try {
		readSync(fd, buf, 0, bytesToRead, tailState.offset);
	} catch {
		closeSync(fd);
		return delta;
	}
	closeSync(fd);
	tailState.offset = fileSize;

	const chunk = tailState.partial + buf.toString("utf-8");
	const lines = chunk.split("\n");
	tailState.partial = lines.pop() || "";

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let event: SidecarEvent;
		try {
			event = JSON.parse(trimmed) as SidecarEvent;
		} catch {
			continue;
		}

		if (!event?.type) continue;
		delta.hadEvents = true;

		switch (event.type) {
			case "message_end": {
				const usage = event.message?.usage;
				if (!usage) break;
				delta.inputTokens += usage.input || 0;
				delta.outputTokens += usage.output || 0;
				delta.cacheReadTokens += usage.cacheRead || 0;
				delta.cacheWriteTokens += usage.cacheWrite || 0;
				if (usage.cost !== undefined) {
					delta.cost +=
						typeof usage.cost === "object"
							? usage.cost.total || 0
							: typeof usage.cost === "number"
								? usage.cost
								: 0;
				}
				const rawTotal = usage.totalTokens || (usage.input || 0) + (usage.output || 0);
				const totalTokens = rawTotal + (usage.cacheRead || 0);
				if (totalTokens > delta.latestTotalTokens) delta.latestTotalTokens = totalTokens;
				break;
			}

			case "tool_execution_start": {
				delta.toolCalls++;
				const toolDesc = event.toolName || "unknown";
				let argPreview = "";
				if (event.args) {
					if (typeof event.args === "string") {
						argPreview = event.args.slice(0, 80);
					} else if (typeof event.args === "object") {
						const firstVal = Object.values(event.args)[0];
						if (typeof firstVal === "string") argPreview = firstVal.slice(0, 80);
					}
				}
				delta.lastTool = argPreview ? `${toolDesc} ${argPreview}` : toolDesc;
				break;
			}

			case "auto_retry_start": {
				delta.retriesStarted++;
				delta.lastRetryError = event.errorMessage || event.error || "unknown";
				tailState.retryActive = true;
				break;
			}

			case "auto_retry_end": {
				tailState.retryActive = false;
				break;
			}

			case "response": {
				if (event.success === true && event.data?.contextUsage) {
					const cu = event.data.contextUsage;
					const pctValue = cu.percent ?? cu.percentUsed;
					if (typeof pctValue === "number") {
						delta.contextUsage = {
							percent: pctValue,
							totalTokens: cu.totalTokens || 0,
							maxTokens: cu.maxTokens || 0,
						};
					}
				} else if (event.success === true && event.data && !event.data.contextUsage) {
					delta.sawStatsResponseWithoutContextUsage = true;
				}
				break;
			}
		}
	}

	delta.retryActive = tailState.retryActive;
	return delta;
}
