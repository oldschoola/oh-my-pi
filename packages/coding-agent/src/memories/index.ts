import type { Database } from "bun:sqlite";
import type * as fsNode from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { completeSimple, Effort, type Model } from "@oh-my-pi/pi-ai";
import { getAgentDbPath, getMemoriesDir, isEnoent, logger, parseJsonlLenient, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import knowledgeMaintenanceTemplate from "../prompts/knowledge/maintenance.md" with { type: "text" };
import knowledgeUsageTemplate from "../prompts/knowledge/usage.md" with { type: "text" };
import consolidationTemplate from "../prompts/memories/consolidation.md" with { type: "text" };
import readPathTemplate from "../prompts/memories/read-path.md" with { type: "text" };
import stageOneInputTemplate from "../prompts/memories/stage_one_input.md" with { type: "text" };
import stageOneSystemTemplate from "../prompts/memories/stage_one_system.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { checkWritePermission, resolveDirectoryConfig, resolveDocConfig, TYPE_DIRS } from "./directory-config";
import {
	buildMemoryDoc,
	deriveDocId,
	type InjectMode,
	type MemoryDocFrontmatter,
	type MemoryDocType,
	parseMemoryDoc,
	rewriteDocBody,
} from "./document";
import { seedBuiltinDocs } from "./seed-docs";
import {
	claimStage1Jobs,
	clearMemoryData as clearMemoryDataInDb,
	closeMemoryDb,
	enqueueGlobalWatermark,
	heartbeatGlobalJob,
	listStage1OutputsForGlobal,
	type MemoryThread,
	markGlobalPhase2Failed,
	markGlobalPhase2FailedUnowned,
	markGlobalPhase2Succeeded,
	markStage1Failed,
	markStage1SucceededNoOutput,
	markStage1SucceededWithOutput,
	openMemoryDb,
	type Stage1Claim,
	type Stage1OutputRow,
	tryClaimGlobalPhase2Job,
	upsertThreads,
} from "./storage";

interface MemoryRuntimeConfig {
	enabled: boolean;
	maxRolloutsPerStartup: number;
	maxRolloutAgeDays: number;
	minRolloutIdleHours: number;
	threadScanLimit: number;
	maxRawMemoriesForGlobal: number;
	stage1Concurrency: number;
	stage1LeaseSeconds: number;
	stage1RetryDelaySeconds: number;
	phase2LeaseSeconds: number;
	phase2RetryDelaySeconds: number;
	phase2HeartbeatSeconds: number;
	rolloutPayloadPercent: number;
	phase1InputTokenLimit: number;
	fallbackTokenLimit: number;
	summaryInjectionTokenLimit: number;
}

const DEFAULTS: MemoryRuntimeConfig = {
	enabled: false,
	maxRolloutsPerStartup: 64,
	maxRolloutAgeDays: 30,
	minRolloutIdleHours: 12,
	threadScanLimit: 300,
	maxRawMemoriesForGlobal: 200,
	stage1Concurrency: 8,
	stage1LeaseSeconds: 120,
	stage1RetryDelaySeconds: 120,
	phase2LeaseSeconds: 180,
	phase2RetryDelaySeconds: 180,
	phase2HeartbeatSeconds: 30,
	rolloutPayloadPercent: 0.7,
	phase1InputTokenLimit: 4_000,
	fallbackTokenLimit: 16_000,
	summaryInjectionTokenLimit: 5_000,
};

interface Stage1Stats {
	claimed: number;
	succeeded: number;
	succeededNoOutput: number;
	failed: number;
	produced: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

interface Stage1OutputSchema {
	raw_memory: string;
	rollout_summary: string;
	rollout_slug: string | null;
}

interface ConsolidationSkillFileSchema {
	path: string;
	content: string;
}

interface ConsolidationSkillSchema {
	name: string;
	content?: string;
	scripts?: ConsolidationSkillFileSchema[];
	templates?: ConsolidationSkillFileSchema[];
	examples?: ConsolidationSkillFileSchema[];
}
interface ConsolidationDesignDraftSchema {
	path: string;
	content: string;
}
interface ConsolidationOutputSchema {
	memory_md: string;
	memory_summary: string;
	skills: ConsolidationSkillSchema[];
	design_drafts: ConsolidationDesignDraftSchema[];
}

/**
 * Start the background memory startup pipeline.
 *
 * Skips for ephemeral sessions, subagent sessions, disabled settings, or DB failures.
 */
export function startMemoryStartupTask(options: {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	taskDepth: number;
}): void {
	const { session, settings, modelRegistry, agentDir, taskDepth } = options;
	const cfg = loadMemoryConfig(settings);
	if (!cfg.enabled) return;
	if (taskDepth > 0) return;
	if (!session.sessionManager.getSessionFile()) return;

	const dbPath = getAgentDbPath(agentDir);
	try {
		const db = openMemoryDb(dbPath);
		closeMemoryDb(db);
	} catch (error) {
		logger.debug("Memory startup skipped: state DB unavailable", { error: String(error) });
		return;
	}

	void runMemoryStartup({ session, settings, modelRegistry, agentDir, config: cfg }).catch(error => {
		logger.warn("Memory startup failed", { error: String(error) });
	});
}

/**
 * Build memory usage instructions for prompt injection.
 */
export async function buildMemoryToolDeveloperInstructions(
	agentDir: string,
	settings: Settings,
): Promise<string | undefined> {
	const cfg = loadMemoryConfig(settings);
	if (!cfg.enabled) return undefined;
	const memoryRoot = getMemoryRoot(agentDir, settings.getCwd());
	const summary = await readMemorySummaryWithLegacyFallback(memoryRoot);
	const knowledgeEnabled = settings.get("knowledge.enabled") === true;

	const sections: string[] = [];
	if (summary) {
		const truncated = truncateByApproxTokens(summary, cfg.summaryInjectionTokenLimit);
		if (truncated.trim()) {
			sections.push(prompt.render(readPathTemplate, { memory_summary: truncated }));
		}
	}
	if (knowledgeEnabled) {
		// Always inject the usage + maintenance rules when the knowledge
		// tools are on, regardless of whether a summary exists yet.
		sections.push(knowledgeUsageTemplate.trim(), knowledgeMaintenanceTemplate.trim());
	}
	if (sections.length === 0) return undefined;
	return sections.join("\n\n");
}

/**
 * Clear all persisted memory state and generated artifacts.
 */
export async function clearMemoryData(agentDir: string, cwd: string): Promise<void> {
	const db = openMemoryDb(getAgentDbPath(agentDir));
	try {
		clearMemoryDataInDb(db);
	} finally {
		closeMemoryDb(db);
	}
	await fs.rm(getMemoryRoot(agentDir, cwd), { recursive: true, force: true });
}

/**
 * Force-enqueue global consolidation maintenance work.
 */
export function enqueueMemoryConsolidation(agentDir: string, cwd: string, sourceUpdatedAt = unixNow()): void {
	const db = openMemoryDb(getAgentDbPath(agentDir));
	try {
		enqueueGlobalWatermark(db, sourceUpdatedAt, cwd, { forceDirtyWhenNotAdvanced: true });
	} finally {
		closeMemoryDb(db);
	}
}

async function runMemoryStartup(options: {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	config: MemoryRuntimeConfig;
}): Promise<void> {
	await runPhase1(options);
	await runPhase2(options);
	await options.session.refreshBaseSystemPrompt?.();
}

async function runPhase1(options: {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	config: MemoryRuntimeConfig;
}): Promise<void> {
	const { session, modelRegistry, agentDir, config } = options;
	const db = openMemoryDb(getAgentDbPath(agentDir));
	const nowSec = unixNow();
	const workerId = `memory-${process.pid}`;
	const memoryRoot = getMemoryRoot(agentDir, session.sessionManager.getCwd());
	const currentThreadId = session.sessionManager.getSessionId();

	try {
		const threads = await collectThreads(session, currentThreadId);
		upsertThreads(db, threads);

		const phase1Model = await resolveMemoryModel({
			modelRegistry,
			session,
			fallbackRole: "default",
		});
		if (!phase1Model) {
			logger.debug("Phase1 skipped: no model available");
			return;
		}
		const phase1ApiKey = await modelRegistry.getApiKey(phase1Model, session.sessionId);
		if (!phase1ApiKey) {
			logger.debug("Phase1 skipped: no API key for phase1 model", {
				provider: phase1Model.provider,
				model: phase1Model.id,
			});
			return;
		}

		const claims = claimStage1Jobs(db, {
			nowSec,
			threadScanLimit: config.threadScanLimit,
			maxRolloutsPerStartup: config.maxRolloutsPerStartup,
			maxRolloutAgeDays: config.maxRolloutAgeDays,
			minRolloutIdleHours: config.minRolloutIdleHours,
			leaseSeconds: config.stage1LeaseSeconds,
			runningConcurrencyCap: config.stage1Concurrency,
			workerId,
			excludeThreadIds: currentThreadId ? [currentThreadId] : [],
		});
		if (claims.length === 0) return;

		const stats: Stage1Stats = {
			claimed: claims.length,
			succeeded: 0,
			succeededNoOutput: 0,
			failed: 0,
			produced: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		await runWithConcurrency(claims, config.stage1Concurrency, async claim => {
			const result = await runStage1Job({
				claim,
				model: phase1Model,
				apiKey: phase1ApiKey,
				modelMaxTokens: computeModelTokenBudget(phase1Model, config),
				config,
				metadata: session.agent?.metadataForProvider(phase1Model.provider),
			});

			if (result.kind === "failed") {
				logger.error("Memory phase1 stage1 job failed", {
					threadId: claim.threadId,
					rolloutPath: claim.rolloutPath,
					reason: result.reason,
				});
				markStage1Failed(db, {
					threadId: claim.threadId,
					ownershipToken: claim.ownershipToken,
					retryDelaySeconds: config.stage1RetryDelaySeconds,
					reason: result.reason,
					nowSec: unixNow(),
				});
				stats.failed += 1;
				return;
			}

			if (result.kind === "no_output") {
				markStage1SucceededNoOutput(db, {
					threadId: claim.threadId,
					ownershipToken: claim.ownershipToken,
					sourceUpdatedAt: claim.sourceUpdatedAt,
					nowSec: unixNow(),
					cwd: claim.cwd,
				});
				stats.succeededNoOutput += 1;
				return;
			}

			markStage1SucceededWithOutput(db, {
				threadId: claim.threadId,
				ownershipToken: claim.ownershipToken,
				sourceUpdatedAt: claim.sourceUpdatedAt,
				rawMemory: result.output.rawMemory,
				rolloutSummary: result.output.rolloutSummary,
				rolloutSlug: result.output.rolloutSlug,
				nowSec: unixNow(),
				cwd: claim.cwd,
			});
			stats.succeeded += 1;
			stats.produced += 1;
			if (result.usage) {
				stats.usage.input += result.usage.input;
				stats.usage.output += result.usage.output;
				stats.usage.cacheRead += result.usage.cacheRead;
				stats.usage.cacheWrite += result.usage.cacheWrite;
				stats.usage.total += result.usage.totalTokens || 0;
			}
		});

		logger.debug("Memory phase1 completed", {
			memoryRoot,
			claimed: stats.claimed,
			succeeded: stats.succeeded,
			succeededNoOutput: stats.succeededNoOutput,
			failed: stats.failed,
			produced: stats.produced,
			usage: stats.usage,
		});
	} finally {
		closeMemoryDb(db);
	}
}

async function runPhase2(options: {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	config: MemoryRuntimeConfig;
}): Promise<void> {
	const { session, modelRegistry, agentDir, config } = options;
	const cwd = session.sessionManager.getCwd();
	const db = openMemoryDb(getAgentDbPath(agentDir));
	const nowSec = unixNow();
	const workerId = `memory-${process.pid}`;
	const memoryRoot = getMemoryRoot(agentDir, cwd);

	try {
		const claimResult = tryClaimGlobalPhase2Job(db, {
			workerId,
			leaseSeconds: config.phase2LeaseSeconds,
			nowSec,
			cwd,
		});
		if (claimResult.kind !== "claimed") return;

		const claim = claimResult.claim;
		const outputs = listStage1OutputsForGlobal(db, config.maxRawMemoriesForGlobal, cwd);
		const newWatermark = computeCompletionWatermark(claim.inputWatermark, outputs);

		await migrateLegacyMemoryLayout(memoryRoot);
		await seedBuiltinDocs(memoryRoot);
		await syncPhase2Artifacts(memoryRoot, outputs);
		if (outputs.length === 0) {
			await cleanupConsolidatedArtifacts(memoryRoot);
			const marked = markGlobalPhase2Succeeded(db, {
				ownershipToken: claim.ownershipToken,
				newWatermark,
				nowSec: unixNow(),
				cwd,
			});
			if (!marked) {
				logger.warn("Phase2 empty-input completion lost ownership", { memoryRoot });
			}
			return;
		}

		const phase2Model = await resolveMemoryModel({
			modelRegistry,
			session,
			fallbackRole: "smol",
		});
		if (!phase2Model) {
			markPhase2FailureWithFallback(db, {
				claim,
				retryDelaySeconds: config.phase2RetryDelaySeconds,
				reason: "No model available for phase2",
				memoryRoot,
				cwd,
			});
			return;
		}
		const phase2ApiKey = await modelRegistry.getApiKey(phase2Model, session.sessionId);
		if (!phase2ApiKey) {
			markPhase2FailureWithFallback(db, {
				claim,
				retryDelaySeconds: config.phase2RetryDelaySeconds,
				reason: "No API key available for phase2",
				memoryRoot,
				cwd,
			});
			return;
		}

		let heartbeatLostOwnership = false;
		const heartbeat = setInterval(() => {
			const ok = heartbeatGlobalJob(db, {
				ownershipToken: claim.ownershipToken,
				leaseSeconds: config.phase2LeaseSeconds,
				nowSec: unixNow(),
				cwd,
			});
			if (!ok) {
				heartbeatLostOwnership = true;
				clearInterval(heartbeat);
			}
		}, config.phase2HeartbeatSeconds * 1000);

		try {
			const consolidated = await runConsolidationModel({
				memoryRoot,
				model: phase2Model,
				apiKey: phase2ApiKey,
				metadata: session.agent?.metadataForProvider(phase2Model.provider),
			});
			await applyConsolidation(memoryRoot, consolidated);
			if (heartbeatLostOwnership) {
				throw new Error("Phase2 lease ownership lost before completion");
			}
			const marked = markGlobalPhase2Succeeded(db, {
				ownershipToken: claim.ownershipToken,
				newWatermark,
				nowSec: unixNow(),
				cwd,
			});
			if (!marked) {
				throw new Error("Phase2 could not mark success: ownership lost");
			}
		} catch (error) {
			markPhase2FailureWithFallback(db, {
				claim,
				retryDelaySeconds: config.phase2RetryDelaySeconds,
				reason: String(error),
				memoryRoot,
				cwd,
				error,
			});
		} finally {
			clearInterval(heartbeat);
		}
	} finally {
		closeMemoryDb(db);
	}
}

function markPhase2FailureWithFallback(
	db: Database,
	params: {
		claim: { ownershipToken: string; inputWatermark: number };
		retryDelaySeconds: number;
		reason: string;
		memoryRoot: string;
		cwd: string;
		error?: unknown;
	},
): void {
	const { claim, retryDelaySeconds, reason, memoryRoot, cwd, error } = params;
	const nowSec = unixNow();
	const strictFailed = markGlobalPhase2Failed(db, {
		ownershipToken: claim.ownershipToken,
		retryDelaySeconds,
		reason,
		nowSec,
		cwd,
	});
	if (strictFailed) return;

	const unownedFailed = markGlobalPhase2FailedUnowned(db, {
		retryDelaySeconds,
		reason,
		nowSec,
		cwd,
	});
	if (!unownedFailed) {
		logger.warn("Phase2 could not mark failure (ownership lost and unowned fallback skipped)", {
			error: error ? String(error) : undefined,
			memoryRoot,
			reason,
			inputWatermark: claim.inputWatermark,
		});
	}
}

async function collectThreads(session: AgentSession, currentThreadId?: string): Promise<MemoryThread[]> {
	const sessionDir = session.sessionManager.getSessionDir();
	const files = await fs.readdir(sessionDir);
	const threads: MemoryThread[] = [];
	for (const name of files) {
		if (!name.endsWith(".jsonl")) continue;
		const fullPath = path.join(sessionDir, name);
		let stat: fsNode.Stats;
		try {
			stat = await fs.stat(fullPath);
		} catch {
			continue;
		}
		let cwd = "";
		let id = name.slice(0, -6);
		try {
			const fileText = await Bun.file(fullPath).text();
			const firstLine = fileText.split("\n", 1)[0] ?? "";
			const parsed = parseJsonlLenient(firstLine);
			const header = Array.isArray(parsed) && parsed.length > 0 ? (parsed[0] as Record<string, unknown>) : undefined;
			if (header && header.type === "session") {
				if (typeof header.cwd === "string") cwd = header.cwd;
				if (typeof header.id === "string") id = header.id;
			}
		} catch {
			// ignore malformed session files
		}

		if (currentThreadId && id === currentThreadId) continue;
		threads.push({
			id,
			updatedAt: Math.floor(stat.mtimeMs / 1000),
			rolloutPath: fullPath,
			cwd,
			sourceKind: "cli",
		});
	}
	return threads;
}

function shouldPersistResponseItemForMemories(message: AgentMessage): boolean {
	const role = (message as { role: string }).role;
	if (role === "system" || role === "developer" || role === "user" || role === "assistant") {
		return true;
	}
	if (role !== "toolResult") return false;
	const toolName = (message as { toolName?: string }).toolName;
	if (toolName === "bash" || toolName === "eval" || toolName === "read" || toolName === "search") {
		const text = extractMessageText(message);
		return text.length > 0 && text.length <= 32_000;
	}
	return false;
}

function extractPersistableMessages(payload: string): AgentMessage[] {
	const rows = parseJsonlLenient(payload);
	if (!Array.isArray(rows)) return [];
	const messages: AgentMessage[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const entry = row as Record<string, unknown>;
		if (entry.type !== "message") continue;
		const maybeMessage = entry.message;
		if (!maybeMessage || typeof maybeMessage !== "object") continue;
		const message = maybeMessage as AgentMessage;
		if (shouldPersistResponseItemForMemories(message)) {
			messages.push(message);
		}
	}
	return messages;
}

async function runStage1Job(options: {
	claim: Stage1Claim;
	model: Model;
	apiKey: string;
	modelMaxTokens: number;
	config: MemoryRuntimeConfig;
	metadata?: Record<string, unknown>;
}): Promise<
	| {
			kind: "output";
			output: { rawMemory: string; rolloutSummary: string; rolloutSlug: string | null };
			usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number };
	  }
	| { kind: "no_output" }
	| { kind: "failed"; reason: string }
> {
	const { claim, model, apiKey, modelMaxTokens, config } = options;
	try {
		const rolloutRaw = await Bun.file(claim.rolloutPath).text();
		const persisted = extractPersistableMessages(rolloutRaw);
		const serializedItems = JSON.stringify(persisted);
		const budgetTokens = Math.min(
			config.phase1InputTokenLimit,
			Math.floor(modelMaxTokens * config.rolloutPayloadPercent),
		);
		const truncatedItems = truncateByApproxTokens(serializedItems, budgetTokens);
		const inputPrompt = prompt.render(stageOneInputTemplate, {
			thread_id: claim.threadId,
			response_items_json: truncatedItems,
		});

		const response = await completeSimple(
			model,
			{
				systemPrompt: [stageOneSystemTemplate],
				messages: [{ role: "user", content: [{ type: "text", text: inputPrompt }], timestamp: Date.now() }],
			},
			{
				apiKey,
				metadata: options.metadata,
				maxTokens: Math.max(1024, Math.min(4096, Math.floor(modelMaxTokens * 0.2))),
				reasoning: Effort.Low,
			},
		);

		if (response.stopReason === "error") {
			return { kind: "failed", reason: response.errorMessage || "stage1 model error" };
		}
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n")
			.trim();
		const parsed = parseJsonObject(text);
		if (!parsed) {
			return { kind: "failed", reason: "stage1 JSON parse failure" };
		}
		const schemaOutput = parseStage1OutputSchema(parsed);
		if (!schemaOutput) {
			return { kind: "failed", reason: "stage1 JSON schema validation failure" };
		}

		const rawMemory = redactSecrets(schemaOutput.raw_memory).trim();
		const rolloutSummary = redactSecrets(schemaOutput.rollout_summary).trim();
		const rolloutSlug = schemaOutput.rollout_slug === null ? null : redactSecrets(schemaOutput.rollout_slug).trim();
		if (!rawMemory || !rolloutSummary) {
			return { kind: "no_output" };
		}
		return {
			kind: "output",
			output: {
				rawMemory,
				rolloutSummary,
				rolloutSlug: rolloutSlug || null,
			},
			usage: response.usage,
		};
	} catch (error) {
		return { kind: "failed", reason: String(error) };
	}
}

async function syncPhase2Artifacts(memoryRoot: string, outputs: Stage1OutputRow[]): Promise<void> {
	const summariesDir = path.join(memoryRoot, "rollout_summaries");
	await fs.mkdir(summariesDir, { recursive: true });

	const keepFiles = new Set<string>();
	for (const row of outputs) {
		const stem = formatRolloutFilename(row.threadId, row.rolloutSlug);
		const filename = `${stem}.md`;
		keepFiles.add(filename);
		const body = [`thread_id: ${row.threadId}`, `updated_at: ${row.sourceUpdatedAt}`, "", row.rolloutSummary].join(
			"\n",
		);
		await Bun.write(path.join(summariesDir, filename), `${body.trim()}\n`);
	}

	const currentFiles = await fs.readdir(summariesDir).catch(() => [] as string[]);
	for (const file of currentFiles) {
		if (!file.endsWith(".md")) continue;
		if (keepFiles.has(file)) continue;
		await fs.rm(path.join(summariesDir, file), { force: true });
	}

	const rawBody = buildRawMemoriesMarkdown(outputs);
	await Bun.write(path.join(memoryRoot, "raw_memories.md"), rawBody);
}

/** @internal Exported for tests. */
export async function cleanupConsolidatedArtifacts(memoryRoot: string): Promise<void> {
	// Only remove AI-maintained artifacts. design/ and reference/ stay
	// untouched — they are user-owned. Inside skill/, only directories whose
	// effective config still says aiMaintained: true are eligible for delete.
	await removeIfAiMaintained(memoryRoot, path.join(memoryRoot, "memory", "MEMORY.md"));
	await removeIfAiMaintained(memoryRoot, path.join(memoryRoot, "memory", "memory_summary.md"));
	await pruneSkillsDir(memoryRoot, path.join(memoryRoot, "skill"));

	// Legacy locations: clean up only when no taxonomy override blocks them.
	// Old roots have no .omp-meta files, so this is effectively unconditional
	// for installs that never upgraded.
	await fs.rm(path.join(memoryRoot, "MEMORY.md"), { force: true });
	await fs.rm(path.join(memoryRoot, "memory_summary.md"), { force: true });
	await pruneSkillsDir(memoryRoot, path.join(memoryRoot, "skills"));
}

/** Remove a file iff its effective config still permits AI deletion. */
async function removeIfAiMaintained(memoryRoot: string, absPath: string): Promise<void> {
	const exists = await Bun.file(absPath)
		.exists()
		.catch(() => false);
	if (!exists) return;
	let frontmatter: MemoryDocFrontmatter = {};
	try {
		const text = await Bun.file(absPath).text();
		frontmatter = parseMemoryDoc(text).frontmatter;
	} catch {
		// fall through with empty frontmatter
	}
	// If the doc is outside the taxonomy (legacy path), unconditional remove.
	// Otherwise consult the doc-level config.
	const config = await resolveDirectoryConfig(memoryRoot, path.dirname(absPath));
	if (config) {
		const aiMaintained = frontmatter.aiMaintained ?? config.aiMaintained;
		const readOnly = frontmatter.readOnly ?? config.readOnly;
		if (!aiMaintained || readOnly) return;
	}
	await fs.rm(absPath, { force: true });
}

/** Remove only AI-maintained skill directories under `skillsDir`. */
async function pruneSkillsDir(memoryRoot: string, skillsDir: string): Promise<void> {
	const entries = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(skillsDir, entry.name);
		const skillFile = path.join(dir, "SKILL.md");
		let frontmatter: MemoryDocFrontmatter = {};
		try {
			const text = await Bun.file(skillFile).text();
			frontmatter = parseMemoryDoc(text).frontmatter;
		} catch {
			// no SKILL.md or unparsable — fall through with empty frontmatter
		}
		const config = await resolveDirectoryConfig(memoryRoot, dir);
		if (config) {
			const aiMaintained = frontmatter.aiMaintained ?? config.aiMaintained;
			const readOnly = frontmatter.readOnly ?? config.readOnly;
			if (!aiMaintained || readOnly) continue;
		}
		await fs.rm(dir, { recursive: true, force: true });
	}
	// Drop the dir itself if it's now empty.
	const remaining = await fs.readdir(skillsDir).catch(() => [] as string[]);
	if (remaining.length === 0) {
		await fs.rm(skillsDir, { recursive: true, force: true });
	}
}

function buildRawMemoriesMarkdown(outputs: Stage1OutputRow[]): string {
	if (outputs.length === 0) {
		return "# Raw Memories\n\nNo raw memories yet.\n";
	}

	const blocks = outputs.map(row => {
		const header = [`## ${row.threadId}`, `updated_at: ${row.sourceUpdatedAt}`, ""].join("\n");
		return `${header}${row.rawMemory.trim()}\n`;
	});
	return `# Raw Memories\n\n${blocks.join("\n")}`;
}

async function readRolloutSummaries(memoryRoot: string): Promise<string> {
	const summariesDir = path.join(memoryRoot, "rollout_summaries");
	const names = await fs.readdir(summariesDir).catch(() => [] as string[]);
	const summaryNames = names.filter(name => name.endsWith(".md")).sort((a, b) => a.localeCompare(b));
	if (summaryNames.length === 0) return "No rollout summaries yet.";

	const blocks: string[] = [];
	for (const name of summaryNames) {
		const text = await Bun.file(path.join(summariesDir, name))
			.text()
			.catch(() => "");
		if (!text.trim()) continue;
		blocks.push(`--- ${name} ---\n${text.trim()}`);
	}
	if (blocks.length === 0) return "No rollout summaries yet.";
	return blocks.join("\n\n");
}

async function runConsolidationModel(options: {
	memoryRoot: string;
	model: Model;
	apiKey: string;
	metadata?: Record<string, unknown>;
}): Promise<{
	memoryMd: string;
	memorySummary: string;
	skills: Array<{
		name: string;
		content: string;
		scripts: ConsolidationSkillFileSchema[];
		templates: ConsolidationSkillFileSchema[];
		examples: ConsolidationSkillFileSchema[];
	}>;
	designDrafts: ConsolidationDesignDraftSchema[];
}> {
	const { memoryRoot, model, apiKey } = options;
	const rawMemories = await Bun.file(path.join(memoryRoot, "raw_memories.md")).text();
	const rolloutSummaries = await readRolloutSummaries(memoryRoot);
	const input = prompt.render(consolidationTemplate, {
		raw_memories: truncateByApproxTokens(rawMemories, 20_000),
		rollout_summaries: truncateByApproxTokens(rolloutSummaries, 12_000),
	});

	const response = await completeSimple(
		model,
		{
			messages: [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }],
		},
		{ apiKey, metadata: options.metadata, maxTokens: 8192, reasoning: Effort.Medium },
	);
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "phase2 model error");
	}
	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n")
		.trim();
	const parsed = parseJsonObject(text);
	if (!parsed) throw new Error("phase2 JSON parse failure");
	const schemaOutput = parseConsolidationOutputSchema(parsed);
	if (!schemaOutput) throw new Error("phase2 JSON schema validation failure");
	const memoryMd = redactSecrets(schemaOutput.memory_md).trim();
	const memorySummary = redactSecrets(schemaOutput.memory_summary).trim();
	const skills = schemaOutput.skills
		.map(item => {
			const name = sanitizeSkillName(item.name.trim());
			const content = redactSecrets(item.content ?? "").trim();
			if (!name || !content) return null;
			return {
				name,
				content,
				scripts: sanitizeConsolidationSkillFiles(item.scripts, "scripts"),
				templates: sanitizeConsolidationSkillFiles(item.templates, "templates"),
				examples: sanitizeConsolidationSkillFiles(item.examples, "examples"),
			};
		})
		.filter(
			(
				item,
			): item is {
				name: string;
				content: string;
				scripts: ConsolidationSkillFileSchema[];
				templates: ConsolidationSkillFileSchema[];
				examples: ConsolidationSkillFileSchema[];
			} => item !== null,
		);
	if (!memoryMd || !memorySummary) {
		throw new Error("phase2 returned empty consolidated memory");
	}
	const designDrafts = sanitizeDesignDrafts(schemaOutput.design_drafts);
	return { memoryMd, memorySummary, skills, designDrafts };
}

/** @internal Exported for tests. */
export async function applyConsolidation(
	memoryRoot: string,
	consolidated: {
		memoryMd: string;
		memorySummary: string;
		skills: Array<{
			name: string;
			content: string;
			scripts: ConsolidationSkillFileSchema[];
			templates: ConsolidationSkillFileSchema[];
			examples: ConsolidationSkillFileSchema[];
		}>;
		designDrafts: ConsolidationDesignDraftSchema[];
	},
): Promise<void> {
	await migrateLegacyMemoryLayout(memoryRoot);
	await seedBuiltinDocs(memoryRoot);

	const memoryDir = path.join(memoryRoot, TYPE_DIRS.memory);
	await fs.mkdir(memoryDir, { recursive: true });

	await writeMemoryDoc(memoryRoot, path.join(memoryDir, "MEMORY.md"), {
		type: "memory",
		title: "Project Memory",
		injectMode: "none",
		summary: "Long-term project memory.",
		body: consolidated.memoryMd,
	});
	await writeMemoryDoc(memoryRoot, path.join(memoryDir, "memory_summary.md"), {
		type: "memory",
		title: "Memory Summary",
		injectMode: "summary",
		summary: "Prompt-time guidance auto-injected each session.",
		body: consolidated.memorySummary,
	});

	const skillsRoot = path.join(memoryRoot, TYPE_DIRS.skill);
	await fs.mkdir(skillsRoot, { recursive: true });
	const skillsRootConfig = await resolveDirectoryConfig(memoryRoot, skillsRoot);
	const skillsRootAllowsCreate = skillsRootConfig?.allowCreateDirectories !== false;
	const keep = new Set<string>();
	for (const skill of consolidated.skills) {
		const dir = path.join(skillsRoot, skill.name);
		keep.add(skill.name);
		const dirAlreadyExists = await fs
			.stat(dir)
			.then(s => s.isDirectory())
			.catch(() => false);
		if (!dirAlreadyExists && !skillsRootAllowsCreate) {
			logger.debug("Skipped skill dir create: allowCreateDirectories=false at skills root", {
				skill: skill.name,
			});
			continue;
		}
		await fs.mkdir(dir, { recursive: true });
		const skillPath = path.join(dir, "SKILL.md");
		await writeMemoryDoc(memoryRoot, skillPath, {
			type: "skill",
			title: skill.name,
			injectMode: "none",
			summary: `Skill playbook: ${skill.name}`,
			body: skill.content,
		});

		// Asset buckets (scripts/templates/examples) are not body-marker docs;
		// they are written verbatim and pruned to match the consolidator output.
		// Both writes and the trailing prune are gated on the skill dir's
		// effective `aiMaintained` AND `readOnly`: a user-protected or
		// read-only skill keeps its assets intact even when the consolidator
		// emits a same-named skill.
		const gate = await resolveSkillGate(memoryRoot, dir, skillPath);
		if (!gate.aiMaintained || gate.readOnly) {
			logger.debug("Skipped skill asset writes: user-protected", {
				skill: skill.name,
				aiMaintained: gate.aiMaintained,
				readOnly: gate.readOnly,
			});
			continue;
		}

		const assetFiles = new Map<string, string>();
		for (const item of skill.scripts) {
			assetFiles.set(path.posix.join("scripts", item.path), `${item.content.trim()}\n`);
		}
		for (const item of skill.templates) {
			assetFiles.set(path.posix.join("templates", item.path), `${item.content.trim()}\n`);
		}
		for (const item of skill.examples) {
			assetFiles.set(path.posix.join("examples", item.path), `${item.content.trim()}\n`);
		}
		for (const [relativePath, content] of [...assetFiles.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			await Bun.write(path.join(dir, ...relativePath.split("/")), content);
		}
		const existingFiles = await listRelativeFiles(dir);
		const keepFiles = new Set<string>(["SKILL.md", ...assetFiles.keys()]);
		for (const relativePath of existingFiles) {
			if (keepFiles.has(relativePath)) continue;
			await fs.rm(path.join(dir, ...relativePath.split("/")), { force: true });
		}
		await pruneEmptyDirectories(dir);
	}

	// Prune skill dirs the consolidator no longer emits — but only when the
	// dir is AI-maintained. User-protected skills survive.
	const dirs = await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
	for (const dirent of dirs) {
		if (!dirent.isDirectory()) continue;
		if (keep.has(dirent.name)) continue;
		const dir = path.join(skillsRoot, dirent.name);
		const skillFile = path.join(dir, "SKILL.md");
		const gate = await resolveSkillGate(memoryRoot, dir, skillFile);
		if (!gate.aiMaintained || gate.readOnly) continue;
		await fs.rm(dir, { recursive: true, force: true });
	}

	// Drafts surfaced for user review go to design/_drafts/. They are
	// frontmatter-tagged aiMaintained: false so the next pass refuses to
	// touch them — drafts are write-once until the user promotes them.
	if (consolidated.designDrafts.length > 0) {
		const draftsDir = path.join(memoryRoot, TYPE_DIRS.design, "_drafts");
		await fs.mkdir(draftsDir, { recursive: true });
		for (const draft of consolidated.designDrafts) {
			const safeRel = sanitizeSkillRelativePath(draft.path);
			if (!safeRel) continue;
			const absPath = path.join(draftsDir, ...safeRel.split("/"));
			// Already-existing drafts are user-owned (or refused on prior pass).
			const exists = await Bun.file(absPath)
				.exists()
				.catch(() => false);
			if (exists) continue;
			await fs.mkdir(path.dirname(absPath), { recursive: true });
			const denied = await checkWritePermission(memoryRoot, absPath, "create", { aiMaintained: false });
			if (denied) {
				logger.debug("Skipped design_drafts write: permission denied", { path: absPath, reason: denied });
				continue;
			}
			const relFromTypeRoot = path.posix.join("_drafts", safeRel);
			const now = unixNow();
			const content = buildMemoryDoc({
				frontmatter: {
					id: deriveDocId(relFromTypeRoot),
					type: "design",
					path: relFromTypeRoot,
					title: safeRel.replace(/\.md$/i, ""),
					injectMode: "none",
					aiMaintained: false,
					readOnly: false,
					summaryEnabled: false,
					explicitMaintenanceRules: false,
					createdAt: now,
					updatedAt: now,
				},
				title: safeRel.replace(/\.md$/i, ""),
				summary: "Proposed design note — review and promote out of `_drafts/` to accept.",
				body: draft.content,
			});
			await Bun.write(absPath, content);
		}
	}
}

/**
 * Write a memory doc, honouring body markers and per-dir permissions.
 *
 * - If the doc already exists with `<!-- omp:body:start -->` markers, only
 *   the body region is rewritten.
 * - If the doc exists without markers, it is treated as user-authored and
 *   left alone (writer logs and returns).
 * - If the doc is missing, a fresh frontmatter + body-marker doc is written.
 */
async function writeMemoryDoc(
	memoryRoot: string,
	absPath: string,
	spec: {
		type: MemoryDocType;
		title: string;
		injectMode: InjectMode;
		summary?: string;
		maintenanceRules?: readonly string[];
		body: string;
	},
): Promise<void> {
	const trimmedBody = spec.body.trim();
	if (!trimmedBody) return;

	let existing: string | undefined;
	try {
		existing = await Bun.file(absPath).text();
	} catch {
		existing = undefined;
	}

	if (existing !== undefined) {
		const doc = parseMemoryDoc(existing);
		if (!doc.hasBodyMarkers) {
			logger.debug("Skipped memory write: doc lacks body markers (user-authored)", { path: absPath });
			return;
		}
		const denied = await checkWritePermission(memoryRoot, absPath, "update", doc.frontmatter);
		if (denied) {
			logger.debug("Skipped memory write: permission denied", { path: absPath, reason: denied });
			return;
		}
		// Phase-2 routes only to `aiMaintained: true` paths. `aiMaintained: false`
		// docs are user-protected — direct edits flow through the knowledge tools
		// with user approval, not through the consolidator.
		const docConfig = await resolveDocConfig(memoryRoot, absPath, doc.frontmatter);
		if (docConfig && !docConfig.aiMaintained) {
			logger.debug("Skipped memory write: target is not AI-maintained", { path: absPath });
			return;
		}
		const rewritten = rewriteDocBody(doc, trimmedBody);
		if (rewritten === undefined) return;
		await Bun.write(absPath, rewritten);
		return;
	}

	const denied = await checkWritePermission(memoryRoot, absPath, "create");
	if (denied) {
		logger.debug("Skipped memory write: permission denied", { path: absPath, reason: denied });
		return;
	}

	// Same routing rule as the update branch: Phase-2 only creates docs in
	// AI-maintained directories. `aiMaintained: false` targets are user-owned
	// and must flow through the knowledge tools' approval sink, not the
	// consolidator. `checkWritePermission` deliberately does not block this
	// (it gates `readOnly` and `allowCreateDocuments` only), so the check is
	// explicit here.
	const parentConfig = await resolveDirectoryConfig(memoryRoot, path.dirname(absPath));
	if (parentConfig && !parentConfig.aiMaintained) {
		logger.debug("Skipped memory create: target dir is not AI-maintained", { path: absPath });
		return;
	}
	const rel = computeRelativeFromTypeRoot(memoryRoot, absPath, spec.type);
	const now = unixNow();
	const content = buildMemoryDoc({
		frontmatter: {
			id: deriveDocId(rel),
			type: spec.type,
			path: rel,
			title: spec.title,
			injectMode: spec.injectMode,
			inheritInjectMode: false,
			inheritAiConfig: false,
			aiMaintained: true,
			readOnly: false,
			summaryEnabled: true,
			explicitMaintenanceRules: false,
			createdAt: now,
			updatedAt: now,
		},
		title: spec.title,
		summary: spec.summary,
		maintenanceRules: spec.maintenanceRules,
		body: trimmedBody,
	});
	await Bun.write(absPath, content);
}

/**
 * Resolve the effective `aiMaintained` / `readOnly` for a skill directory
 * by reading SKILL.md frontmatter first and falling back to the directory's
 * sidecar-resolved config. Missing / unparseable SKILL.md falls through to
 * the dir config; missing dir config falls through to the skill type-default
 * (`aiMaintained: true`, `readOnly: false`).
 *
 * Used to gate asset writes/prunes that bypass `writeMemoryDoc` — `readOnly`
 * here is the hard refusal, mirroring `checkWritePermission` for the
 * SKILL.md write path.
 */
async function resolveSkillGate(
	memoryRoot: string,
	skillDir: string,
	skillFile: string,
): Promise<{ aiMaintained: boolean; readOnly: boolean }> {
	let frontmatter: MemoryDocFrontmatter = {};
	let hasBodyMarkers = true;
	let skillFileExists = true;
	try {
		const text = await Bun.file(skillFile).text();
		const parsed = parseMemoryDoc(text);
		frontmatter = parsed.frontmatter;
		hasBodyMarkers = parsed.hasBodyMarkers;
	} catch {
		// missing or unparseable — defer to dir config. A truly absent
		// SKILL.md is fine (fresh skill dir); a markerless one signals
		// user-authored content that the consolidator must not touch.
		skillFileExists = false;
	}
	const config = await resolveDirectoryConfig(memoryRoot, skillDir);
	// A markerless SKILL.md is treated by `writeMemoryDoc` as user-authored
	// and skipped. Mirror that here so the surrounding asset writes and the
	// trailing skill prune cannot mutate `scripts/`, `templates/`, or
	// `examples/` under a user-owned skill — even when frontmatter is
	// silent and the dir config still defaults to `aiMaintained: true`.
	if (skillFileExists && !hasBodyMarkers) {
		return { aiMaintained: false, readOnly: frontmatter.readOnly ?? config?.readOnly ?? false };
	}
	const aiMaintained = frontmatter.aiMaintained ?? config?.aiMaintained ?? true;
	const readOnly = frontmatter.readOnly ?? config?.readOnly ?? false;
	return { aiMaintained, readOnly };
}

function computeRelativeFromTypeRoot(memoryRoot: string, absPath: string, type: MemoryDocType): string {
	const typeRoot = path.join(memoryRoot, TYPE_DIRS[type]);
	const rel = path.relative(typeRoot, absPath).split(path.sep).join("/");
	return rel || path.basename(absPath);
}

async function readMemorySummaryWithLegacyFallback(memoryRoot: string): Promise<string | undefined> {
	const candidates = [
		path.join(memoryRoot, TYPE_DIRS.memory, "memory_summary.md"),
		path.join(memoryRoot, "memory_summary.md"),
	];
	for (const candidate of candidates) {
		let raw: string;
		try {
			raw = await Bun.file(candidate).text();
		} catch {
			continue;
		}
		// For new-shape docs with body markers we surface only the body
		// region; legacy docs flow through verbatim.
		const doc = parseMemoryDoc(raw);
		const summary = doc.hasBodyMarkers ? doc.body.trim() : raw.trim();
		if (summary) return summary;
	}
	return undefined;
}

/**
 * One-shot best-effort migration of an old-shape memory root to the new
 * taxonomy. Idempotent: safe to call on every Phase-2.
 *
 *   memory_root/MEMORY.md         → memory_root/memory/MEMORY.md
 *   memory_root/memory_summary.md → memory_root/memory/memory_summary.md
 *   memory_root/skills/<n>/       → memory_root/skill/<n>/
 *
 * Migrated files were AI-authored by the pre-PR consolidator, which wrote
 * plain markdown without body markers. After the rename we promote each
 * migrated `.md` into a marker-wrapped doc so subsequent Phase-2 runs
 * recognize the file as AI-maintained and refresh the body region;
 * otherwise `writeMemoryDoc` would treat the marker-less file as
 * user-authored and the consolidator would silently no-op against it.
 *
 * If both old and new exist for the same artifact, the new shape wins and
 * the old is left alone (the user may have intentionally written to it).
 */
async function migrateLegacyMemoryLayout(memoryRoot: string): Promise<void> {
	const memoryDir = path.join(memoryRoot, TYPE_DIRS.memory);
	const moves: Array<{
		from: string;
		to: string;
		isDir: boolean;
		type: MemoryDocType;
		title: string;
		summary?: string;
	}> = [
		{
			from: path.join(memoryRoot, "MEMORY.md"),
			to: path.join(memoryDir, "MEMORY.md"),
			isDir: false,
			type: "memory",
			title: "Project Memory",
			summary: "Long-term project memory.",
		},
		{
			from: path.join(memoryRoot, "memory_summary.md"),
			to: path.join(memoryDir, "memory_summary.md"),
			isDir: false,
			type: "memory",
			title: "Memory Summary",
			summary: "Prompt-time guidance auto-injected each session.",
		},
		{
			from: path.join(memoryRoot, "skills"),
			to: path.join(memoryRoot, TYPE_DIRS.skill),
			isDir: true,
			type: "skill",
			title: "skill",
		},
	];
	for (const move of moves) {
		const fromExists = await Bun.file(move.from)
			.exists()
			.catch(() => false);
		if (!fromExists && move.isDir) {
			const stat = await fs.stat(move.from).catch(() => undefined);
			if (!stat) continue;
		} else if (!fromExists) {
			continue;
		}
		const toExists = await Bun.file(move.to)
			.exists()
			.catch(() => false);
		const toStat = move.isDir ? await fs.stat(move.to).catch(() => undefined) : undefined;
		if (toExists || toStat) continue;
		await fs.mkdir(path.dirname(move.to), { recursive: true });
		try {
			await fs.rename(move.from, move.to);
		} catch (error) {
			logger.warn("Memory layout migration step failed", {
				from: move.from,
				to: move.to,
				error: String(error),
			});
			continue;
		}
		if (move.isDir) {
			// Wrap every SKILL.md under the migrated skill tree. The
			// consolidator overwrites these files on every Phase-2; without
			// markers `writeMemoryDoc` treats them as user-authored.
			await promoteLegacySkillDir(memoryRoot, move.to);
		} else {
			await promoteLegacyMemoryFile(memoryRoot, move.to, move.type, move.title, move.summary);
		}
	}
}

/**
 * Wrap a marker-less legacy memory doc in body markers + frontmatter so the
 * next consolidator pass can refresh its body region. Idempotent: already
 * marker-wrapped docs are left untouched.
 */
async function promoteLegacyMemoryFile(
	memoryRoot: string,
	absPath: string,
	type: MemoryDocType,
	title: string,
	summary: string | undefined,
): Promise<void> {
	let raw: string;
	try {
		raw = await Bun.file(absPath).text();
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	const existing = parseMemoryDoc(raw);
	if (existing.hasBodyMarkers) return;
	// User-protected docs (`aiMaintained: false` / `readOnly: true`) keep
	// their pre-PR shape — promoting them would force them under the
	// consolidator's refresh path, defeating the user's protection.
	if (existing.frontmatter.aiMaintained === false || existing.frontmatter.readOnly === true) {
		return;
	}
	const rel = computeRelativeFromTypeRoot(memoryRoot, absPath, type);
	const now = unixNow();
	const body = raw.trim() || "<!-- Empty memory body. Replace with project content. -->";
	const wrapped = buildMemoryDoc({
		frontmatter: {
			id: deriveDocId(rel),
			type,
			path: rel,
			title,
			injectMode: type === "memory" && path.basename(absPath) === "memory_summary.md" ? "summary" : "none",
			inheritInjectMode: false,
			inheritAiConfig: false,
			aiMaintained: true,
			readOnly: false,
			summaryEnabled: true,
			explicitMaintenanceRules: false,
			createdAt: now,
			updatedAt: now,
		},
		title,
		summary,
		body,
	});
	await Bun.write(absPath, wrapped);
}

/**
 * Walk a migrated `skill/` directory and promote every marker-less
 * `<n>/SKILL.md` so subsequent consolidations can refresh them.
 */
async function promoteLegacySkillDir(memoryRoot: string, skillsRoot: string): Promise<void> {
	const entries = await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skillFile = path.join(skillsRoot, entry.name, "SKILL.md");
		const exists = await Bun.file(skillFile)
			.exists()
			.catch(() => false);
		if (!exists) continue;
		await promoteLegacyMemoryFile(memoryRoot, skillFile, "skill", entry.name, `Skill playbook: ${entry.name}`);
	}
}

async function listRelativeFiles(rootDir: string, prefix = ""): Promise<string[]> {
	const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
	const files: string[] = [];
	for (const entry of entries) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...(await listRelativeFiles(path.join(rootDir, entry.name), relative)));
			continue;
		}
		if (entry.isFile()) files.push(relative);
	}
	return files;
}

async function pruneEmptyDirectories(rootDir: string): Promise<void> {
	const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const child = path.join(rootDir, entry.name);
		await pruneEmptyDirectories(child);
		const childEntries = await fs.readdir(child).catch(() => []);
		if (childEntries.length === 0) {
			await fs.rm(child, { recursive: true, force: true });
		}
	}
}

function computeCompletionWatermark(claimedInputWatermark: number, outputs: Stage1OutputRow[]): number {
	const maxOutputWatermark = outputs.reduce((max, row) => Math.max(max, row.sourceUpdatedAt), claimedInputWatermark);
	return Math.max(claimedInputWatermark, maxOutputWatermark);
}

function formatRolloutFilename(threadId: string, rolloutSlug: string | null): string {
	if (!rolloutSlug) return threadId;
	const normalized = rolloutSlug
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/_+$/g, "")
		.slice(0, 20);
	if (!normalized) return threadId;
	return `${threadId}-${normalized}`;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		const match = text.match(/\{[\s\S]*\}/);
		if (!match) return undefined;
		try {
			const parsed = JSON.parse(match[0]) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function parseStage1OutputSchema(value: Record<string, unknown>): Stage1OutputSchema | undefined {
	if (!hasExactKeys(value, ["rollout_summary", "rollout_slug", "raw_memory"])) return undefined;
	if (typeof value.rollout_summary !== "string") return undefined;
	if (!(typeof value.rollout_slug === "string" || value.rollout_slug === null)) return undefined;
	if (typeof value.raw_memory !== "string") return undefined;
	return {
		rollout_summary: value.rollout_summary,
		rollout_slug: value.rollout_slug,
		raw_memory: value.raw_memory,
	};
}

function parseConsolidationOutputSchema(value: Record<string, unknown>): ConsolidationOutputSchema | undefined {
	const allowedKeys = ["memory_md", "memory_summary", "skills", "design_drafts"];
	const sortedKeys = Object.keys(value).sort();
	for (const key of sortedKeys) {
		if (!allowedKeys.includes(key)) return undefined;
	}
	if (typeof value.memory_md !== "string") return undefined;
	if (typeof value.memory_summary !== "string") return undefined;
	if (!Array.isArray(value.skills)) return undefined;
	if (value.design_drafts !== undefined && !Array.isArray(value.design_drafts)) return undefined;
	const skills: ConsolidationSkillSchema[] = [];
	for (const item of value.skills) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
		const data = item as Record<string, unknown>;
		if (!hasExactKeys(data, ["name", "content", "scripts", "templates", "examples"], true)) return undefined;
		if (typeof data.name !== "string") return undefined;
		if (!(typeof data.content === "string" || data.content === undefined)) return undefined;
		const scripts = parseConsolidationSkillFileArray(data.scripts);
		const templates = parseConsolidationSkillFileArray(data.templates);
		const examples = parseConsolidationSkillFileArray(data.examples);
		if (!scripts || !templates || !examples) return undefined;
		skills.push({
			name: data.name,
			content: data.content,
			scripts,
			templates,
			examples,
		});
	}

	const designDrafts: ConsolidationDesignDraftSchema[] = [];
	if (Array.isArray(value.design_drafts)) {
		for (const item of value.design_drafts) {
			if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
			const data = item as Record<string, unknown>;
			if (!hasExactKeys(data, ["path", "content"])) return undefined;
			if (typeof data.path !== "string" || typeof data.content !== "string") return undefined;
			designDrafts.push({ path: data.path, content: data.content });
		}
	}

	return {
		memory_md: value.memory_md,
		memory_summary: value.memory_summary,
		skills,
		design_drafts: designDrafts,
	};
}

/** Strip empty/invalid draft entries; the schema parser already type-validates. */
function sanitizeDesignDrafts(drafts: ConsolidationDesignDraftSchema[]): ConsolidationDesignDraftSchema[] {
	const out: ConsolidationDesignDraftSchema[] = [];
	for (const draft of drafts) {
		const safe = sanitizeSkillRelativePath(draft.path);
		if (!safe) continue;
		const body = redactSecrets(draft.content).trim();
		if (!body) continue;
		out.push({ path: safe, content: body });
	}
	return out;
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[], allowMissing = false): boolean {
	const sortedKeys = Object.keys(value).sort();
	const sortedExpected = [...expectedKeys].sort();
	if (!allowMissing && sortedKeys.length !== sortedExpected.length) return false;
	for (const key of sortedKeys) {
		if (!sortedExpected.includes(key)) return false;
	}
	if (allowMissing) return true;
	for (let i = 0; i < sortedExpected.length; i += 1) {
		if (sortedKeys[i] !== sortedExpected[i]) return false;
	}
	return true;
}

function redactSecrets(input: string): string {
	let out = input;
	const patterns = [
		/(?:sk|pk|rk|tok|key|secret|token|password)[-_A-Za-z0-9]{12,}/g,
		/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
		/(?:AKIA|ASIA)[A-Z0-9]{16}/g,
	];
	for (const pattern of patterns) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}

function sanitizeSkillName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function parseConsolidationSkillFileArray(value: unknown): ConsolidationSkillFileSchema[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return undefined;
	const files: ConsolidationSkillFileSchema[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
		const data = item as Record<string, unknown>;
		if (!hasExactKeys(data, ["path", "content"])) return undefined;
		if (typeof data.path !== "string" || typeof data.content !== "string") return undefined;
		files.push({ path: data.path, content: data.content });
	}
	return files;
}

function sanitizeConsolidationSkillFiles(
	files: ConsolidationSkillFileSchema[] | undefined,
	bucket: "scripts" | "templates" | "examples",
): ConsolidationSkillFileSchema[] {
	if (!files || files.length === 0) return [];
	const sanitized = new Map<string, string>();
	for (const file of files) {
		const relativePath = sanitizeSkillRelativePath(file.path);
		if (!relativePath) continue;
		const content = redactSecrets(file.content).trim();
		if (!content) continue;
		sanitized.set(path.posix.join(bucket, relativePath), content);
	}
	return [...sanitized.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([fullPath, content]) => ({
			path: fullPath.slice(bucket.length + 1),
			content,
		}));
}

function sanitizeSkillRelativePath(rawPath: string): string | undefined {
	const normalized = rawPath.replace(/\\/g, "/").trim();
	if (!normalized) return undefined;
	if (normalized.startsWith("/")) return undefined;
	if (normalized.includes("\0")) return undefined;
	if (normalized.includes(":")) return undefined;
	const parts = normalized.split("/").filter(Boolean);
	if (parts.length === 0) return undefined;
	for (const part of parts) {
		if (part === "." || part === "..") return undefined;
		if (!/^[A-Za-z0-9._-]+$/.test(part)) return undefined;
	}
	return parts.join("/");
}

function extractMessageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(item => {
			if (item.type === "text") return item.text;
			if (item.type === "toolCall") return `${item.toolName} ${JSON.stringify(item.arguments)}`;
			return "";
		})
		.join("\n");
}

function truncateByApproxTokens(text: string, tokenLimit: number): string {
	if (tokenLimit <= 0) return "";
	const maxChars = tokenLimit * 4;
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.6);
	const tail = maxChars - head;
	return `${text.slice(0, head)}\n\n...[truncated]...\n\n${text.slice(-tail)}`;
}

function computeModelTokenBudget(model: Model, config: MemoryRuntimeConfig): number {
	const maxTokens =
		Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : config.fallbackTokenLimit;
	return Math.max(2048, Math.floor(maxTokens));
}

async function resolveMemoryModel(options: {
	modelRegistry: ModelRegistry;
	session: AgentSession;
	fallbackRole: string;
}): Promise<Model | undefined> {
	const { modelRegistry, session, fallbackRole } = options;
	const requestedModel = session.settings.getModelRole(fallbackRole) || session.settings.getModelRole("default");
	if (requestedModel) {
		const resolved = resolveModelRoleValue(requestedModel, modelRegistry.getAll(), {
			settings: session.settings,
			matchPreferences: { usageOrder: session.settings.getStorage()?.getModelUsageOrder() },
			modelRegistry,
		});
		if (resolved.model) return resolved.model;
	}
	return session.model ?? modelRegistry.getAll()[0];
}

function loadMemoryConfig(settings: Settings): MemoryRuntimeConfig {
	return {
		enabled: settings.get("memory.backend") === "local" || settings.get("memories.enabled") === true,
		maxRolloutsPerStartup: settings.get("memories.maxRolloutsPerStartup") ?? DEFAULTS.maxRolloutsPerStartup,
		maxRolloutAgeDays: settings.get("memories.maxRolloutAgeDays") ?? DEFAULTS.maxRolloutAgeDays,
		minRolloutIdleHours: settings.get("memories.minRolloutIdleHours") ?? DEFAULTS.minRolloutIdleHours,
		threadScanLimit: settings.get("memories.threadScanLimit") ?? DEFAULTS.threadScanLimit,
		maxRawMemoriesForGlobal: settings.get("memories.maxRawMemoriesForGlobal") ?? DEFAULTS.maxRawMemoriesForGlobal,
		stage1Concurrency: settings.get("memories.stage1Concurrency") ?? DEFAULTS.stage1Concurrency,
		stage1LeaseSeconds: settings.get("memories.stage1LeaseSeconds") ?? DEFAULTS.stage1LeaseSeconds,
		stage1RetryDelaySeconds: settings.get("memories.stage1RetryDelaySeconds") ?? DEFAULTS.stage1RetryDelaySeconds,
		phase2LeaseSeconds: settings.get("memories.phase2LeaseSeconds") ?? DEFAULTS.phase2LeaseSeconds,
		phase2RetryDelaySeconds: settings.get("memories.phase2RetryDelaySeconds") ?? DEFAULTS.phase2RetryDelaySeconds,
		phase2HeartbeatSeconds: settings.get("memories.phase2HeartbeatSeconds") ?? DEFAULTS.phase2HeartbeatSeconds,
		rolloutPayloadPercent: settings.get("memories.rolloutPayloadPercent") ?? DEFAULTS.rolloutPayloadPercent,
		phase1InputTokenLimit: settings.get("memories.phase1InputTokenLimit") ?? DEFAULTS.phase1InputTokenLimit,
		fallbackTokenLimit: settings.get("memories.fallbackTokenLimit") ?? DEFAULTS.fallbackTokenLimit,
		summaryInjectionTokenLimit:
			settings.get("memories.summaryInjectionTokenLimit") ?? DEFAULTS.summaryInjectionTokenLimit,
	};
}

export function getMemoryRoot(agentDir: string, cwd: string): string {
	return path.join(getMemoriesDir(agentDir), encodeProjectPath(cwd));
}

function encodeProjectPath(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function unixNow(): number {
	return Math.floor(Date.now() / 1000);
}

async function runWithConcurrency<T>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	const queue = [...items];
	const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
		while (queue.length > 0) {
			const item = queue.shift();
			if (!item) return;
			await worker(item);
		}
	});
	await Promise.all(workers);
}
