import * as fs from "node:fs";
import * as path from "node:path";
import { findLatestConfigEntry, JSONL_FILENAME, readJsonlEntries, reconstructStateFromJsonl } from "./jsonl";
import type { SessionSnapshot } from "./types";

export function buildCompactionSummary(cwd: string): string | null {
	const jsonlPath = path.join(cwd, JSONL_FILENAME);
	if (!fs.existsSync(jsonlPath)) return null;

	const entries = readJsonlEntries(cwd);
	const snapshot = reconstructStateFromJsonl(entries);
	if (!snapshot) return null;

	const lines: string[] = [];
	lines.push(`# Autoresearch Session Summary`);
	lines.push("");
	if (snapshot.name) lines.push(`**Name:** ${snapshot.name}`);
	if (snapshot.goal) lines.push(`**Goal:** ${snapshot.goal}`);
	lines.push(
		`**Metric:** ${snapshot.metricName} (${snapshot.metricUnit || "unitless"}, ${snapshot.bestDirection} is better)`,
	);
	lines.push(`**Segment:** ${snapshot.currentSegment}`);
	lines.push(`**Max experiments:** ${snapshot.maxExperiments ?? "unlimited"}`);
	lines.push("");

	const results = snapshot.results;
	const current = results.filter(r => r.segment === snapshot.currentSegment);
	const kept = current.filter(r => r.status === "keep" && !r.flagged);
	const discarded = current.filter(r => r.status === "discard");
	const crashed = current.filter(r => r.status === "crash" || r.status === "checks_failed");

	lines.push(`## Current Segment Stats`);
	lines.push(`- Total runs: ${current.length}`);
	lines.push(`- Kept: ${kept.length}`);
	lines.push(`- Discarded: ${discarded.length}`);
	lines.push(`- Crashed: ${crashed.length}`);
	if (snapshot.confidence !== null) {
		lines.push(`- Confidence: ${snapshot.confidence.toFixed(1)}x noise floor`);
	}
	lines.push("");

	if (kept.length > 0) {
		lines.push(`## Kept Runs`);
		for (const result of kept) {
			lines.push(`- Run #${result.runNumber}: ${result.metric} — ${result.description}`);
			if (result.asi && Object.keys(result.asi).length > 0) {
				lines.push(`  ASI: ${JSON.stringify(result.asi)}`);
			}
		}
		lines.push("");
	}

	if (results.length > current.length) {
		lines.push(`## Archived Segments`);
		lines.push(`- ${results.length - current.length} runs from earlier segments`);
		lines.push("");
	}

	if (snapshot.notes) {
		lines.push(`## Notes`);
		lines.push(snapshot.notes);
		lines.push("");
	}

	lines.push(`*Generated from ${entries.length} JSONL entries*`);
	return lines.join("\n");
}

export function compactJsonl(cwd: string): void {
	const jsonlPath = path.join(cwd, JSONL_FILENAME);
	if (!fs.existsSync(jsonlPath)) return;

	const entries = readJsonlEntries(cwd);
	const snapshot = reconstructStateFromJsonl(entries);
	if (!snapshot) return;

	// Write a compacted version: config + latest session + all runs
	const compacted: unknown[] = [];
	const configEntry = findLatestConfigEntry(entries);
	if (configEntry) compacted.push(configEntry);
	compacted.push({
		type: "session",
		timestamp: Date.now(),
		data: snapshot,
	});
	for (const result of snapshot.results) {
		compacted.push({
			type: "run",
			timestamp: result.timestamp,
			runId: result.runNumber ?? 0,
			data: {
				segment: result.segment,
				command: "",
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
		});
	}

	fs.writeFileSync(jsonlPath, `${compacted.map(e => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

export function sessionSnapshotToMarkdown(snapshot: SessionSnapshot): string {
	const lines: string[] = [];
	lines.push(`# Autoresearch Summary`);
	lines.push("");
	if (snapshot.name) lines.push(`**Name:** ${snapshot.name}`);
	if (snapshot.goal) lines.push(`**Goal:** ${snapshot.goal}`);
	lines.push(
		`**Metric:** ${snapshot.metricName} (${snapshot.metricUnit || "unitless"}, ${snapshot.bestDirection} is better)`,
	);
	lines.push(`**Segment:** ${snapshot.currentSegment}`);
	lines.push("");
	lines.push(`## Results`);
	for (const result of snapshot.results) {
		const emoji = result.status === "keep" ? "✅" : result.status === "discard" ? "❌" : "💥";
		lines.push(`${emoji} Run #${result.runNumber}: ${result.metric} — ${result.description}`);
	}
	return lines.join("\n");
}
