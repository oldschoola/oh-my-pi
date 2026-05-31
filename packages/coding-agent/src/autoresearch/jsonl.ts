import * as fs from "node:fs";
import * as path from "node:path";
import type { ASIData, EvoResearchConfig, ExperimentResult, ExperimentStatus, SessionSnapshot } from "./types";

export const JSONL_FILENAME = "autoresearch.jsonl";
export const CONFIG_FILENAME = "autoresearch.config.json";
export const POPULATION_FILENAME = "autoresearch.population.json";

export type JsonlEntry =
	| { type: "config"; timestamp: number; data: EvoResearchConfig }
	| { type: "run"; timestamp: number; runId: number; data: JsonlRunEntry }
	| { type: "session"; timestamp: number; data: SessionSnapshot };

interface JsonlRunEntry {
	segment: number;
	command: string;
	status: ExperimentStatus;
	metric: number;
	metrics: { [key: string]: number };
	description: string;
	commit: string;
	modifiedPaths: string[];
	scopeDeviations: string[];
	justification: string | null;
	asi: ASIData | null;
	confidence: number | null;
	flagged: boolean;
	flaggedReason: string | null;
}

export function appendJsonlEntry(cwd: string, entry: JsonlEntry): void {
	const jsonlPath = path.join(cwd, JSONL_FILENAME);
	const line = `${JSON.stringify(entry)}\n`;
	fs.appendFileSync(jsonlPath, line, "utf8");
}

export function writeJsonlConfig(cwd: string, config: EvoResearchConfig): void {
	const entry: JsonlEntry = {
		type: "config",
		timestamp: Date.now(),
		data: config,
	};
	appendJsonlEntry(cwd, entry);
}

export function writeJsonlRun(cwd: string, result: ExperimentResult, command: string): void {
	const entry: JsonlEntry = {
		type: "run",
		timestamp: result.timestamp,
		runId: result.runNumber ?? 0,
		data: {
			segment: result.segment,
			command,
			status: result.status,
			metric: result.metric,
			metrics: result.metrics,
			description: result.description,
			commit: result.commit,
			modifiedPaths: result.modifiedPaths,
			scopeDeviations: result.scopeDeviations,
			justification: result.justification,
			asi: result.asi ?? null,
			confidence: result.confidence,
			flagged: result.flagged,
			flaggedReason: result.flaggedReason,
		},
	};
	appendJsonlEntry(cwd, entry);
}

export function writeJsonlSession(cwd: string, snapshot: SessionSnapshot): void {
	const entry: JsonlEntry = {
		type: "session",
		timestamp: Date.now(),
		data: snapshot,
	};
	appendJsonlEntry(cwd, entry);
}

export function readJsonlEntries(cwd: string): JsonlEntry[] {
	const jsonlPath = path.join(cwd, JSONL_FILENAME);
	if (!fs.existsSync(jsonlPath)) return [];
	const text = fs.readFileSync(jsonlPath, "utf8");
	const entries: JsonlEntry[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (isJsonlEntry(parsed)) {
				entries.push(parsed);
			}
		} catch {
			// Skip corrupted lines
		}
	}
	return entries;
}

export function reconstructStateFromJsonl(entries: JsonlEntry[]): SessionSnapshot | null {
	const configEntries = entries.filter((e): e is JsonlEntry & { type: "config" } => e.type === "config");
	const runEntries = entries.filter((e): e is JsonlEntry & { type: "run" } => e.type === "run");
	const sessionEntries = entries.filter((e): e is JsonlEntry & { type: "session" } => e.type === "session");

	const lastSession = sessionEntries[sessionEntries.length - 1];
	const lastConfig = configEntries[configEntries.length - 1];

	const results: ExperimentResult[] = [];
	for (const run of runEntries) {
		const r = run.data;
		results.push({
			runNumber: run.runId,
			commit: r.commit,
			metric: r.metric,
			metrics: r.metrics,
			status: r.status,
			description: r.description,
			timestamp: run.timestamp,
			segment: r.segment,
			confidence: r.confidence,
			asi: r.asi ?? undefined,
			modifiedPaths: r.modifiedPaths,
			scopeDeviations: r.scopeDeviations,
			justification: r.justification,
			flagged: r.flagged,
			flaggedReason: r.flaggedReason,
		});
	}

	const snapshot: SessionSnapshot = {
		name: lastSession?.data.name ?? null,
		goal: lastSession?.data.goal ?? null,
		metricName: lastSession?.data.metricName ?? "metric",
		metricUnit: lastSession?.data.metricUnit ?? "",
		bestDirection: lastSession?.data.bestDirection ?? "lower",
		currentSegment: lastSession?.data.currentSegment ?? 0,
		maxExperiments: lastConfig?.data.maxIterations ?? lastSession?.data.maxExperiments ?? null,
		results,
		confidence: lastSession?.data.confidence ?? null,
		branch: lastSession?.data.branch ?? null,
		baselineCommit: lastSession?.data.baselineCommit ?? null,
		notes: lastSession?.data.notes ?? "",
	};

	return snapshot;
}

export function readEvoConfig(cwd: string): EvoResearchConfig | null {
	const configPath = path.join(cwd, CONFIG_FILENAME);
	if (!fs.existsSync(configPath)) return null;
	try {
		const text = fs.readFileSync(configPath, "utf8");
		const parsed = JSON.parse(text) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as EvoResearchConfig;
	} catch {
		return null;
	}
}

export function writeEvoConfig(cwd: string, config: EvoResearchConfig): void {
	const configPath = path.join(cwd, CONFIG_FILENAME);
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
}

function isJsonlEntry(value: unknown): value is JsonlEntry {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as { type?: unknown };
	return obj.type === "config" || obj.type === "run" || obj.type === "session";
}
