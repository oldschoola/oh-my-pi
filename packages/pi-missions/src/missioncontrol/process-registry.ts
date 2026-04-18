/**
 * Process Registry — Runtime V2 agent lifecycle management.
 *
 * File-backed registry that replaces legacy session discovery as the
 * authoritative source of truth for agent liveness, identity, and
 * attribution.
 *
 * Key design rules:
 *   1. Parent writes manifest BEFORE child is considered visible.
 *   2. Parent updates manifest on every status transition.
 *   3. Operator tools read the registry, not terminal-session probes.
 *   4. Resume/cleanup validates pid + startedAt for orphan detection.
 *
 * File locations (rebased to oh-my-pi):
 *   .omp/runtime/{batchId}/registry.json          — batch-level snapshot
 *   .omp/runtime/{batchId}/agents/{agentId}/manifest.json — per-agent
 *
 * Ported from taskplane `extensions/taskplane/process-registry.ts`
 * (@since TP-104).
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	type PacketPaths,
	type RuntimeAgentId,
	type RuntimeAgentManifest,
	type RuntimeAgentRole,
	type RuntimeAgentStatus,
	type RuntimeMergeSnapshot,
	type RuntimeRegistry,
	runtimeAgentDir,
	runtimeAgentEventsPath,
	runtimeLaneSnapshotPath,
	runtimeManifestPath,
	runtimeMergeSnapshotPath,
	runtimeRegistryPath,
	runtimeRoot,
	TERMINAL_AGENT_STATUSES,
	validateAgentManifest,
} from "./types";

// ── Manifest Lifecycle ───────────────────────────────────────────────

/**
 * Write or update an agent manifest atomically.
 *
 * Uses write-to-temp + rename for crash safety.
 */
export function writeManifest(stateRoot: string, manifest: RuntimeAgentManifest): void {
	const dir = runtimeAgentDir(stateRoot, manifest.batchId, manifest.agentId);
	mkdirSync(dir, { recursive: true });
	const path = runtimeManifestPath(stateRoot, manifest.batchId, manifest.agentId);
	const tmpPath = `${path}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
	renameSync(tmpPath, path);
}

/**
 * Read an agent manifest. Returns null if not found or malformed.
 */
export function readManifest(stateRoot: string, batchId: string, agentId: RuntimeAgentId): RuntimeAgentManifest | null {
	const path = runtimeManifestPath(stateRoot, batchId, agentId);
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		const errors = validateAgentManifest(parsed);
		if (errors.length > 0) {
			console.error(`[process-registry] invalid manifest ${agentId}: ${errors.join(", ")}`);
			return null;
		}
		return parsed as RuntimeAgentManifest;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[process-registry] failed to read manifest ${agentId}: ${msg}`);
		return null;
	}
}

/**
 * Update an agent's status in its manifest.
 */
export function updateManifestStatus(
	stateRoot: string,
	batchId: string,
	agentId: RuntimeAgentId,
	status: RuntimeAgentStatus,
): void {
	const manifest = readManifest(stateRoot, batchId, agentId);
	if (!manifest) return;
	manifest.status = status;
	writeManifest(stateRoot, manifest);
}

/**
 * Create a fresh RuntimeAgentManifest with required fields.
 */
export function createManifest(opts: {
	batchId: string;
	agentId: RuntimeAgentId;
	role: RuntimeAgentRole;
	laneNumber: number | null;
	taskId: string | null;
	repoId: string;
	pid: number;
	parentPid: number;
	cwd: string;
	packet: PacketPaths | null;
}): RuntimeAgentManifest {
	return {
		batchId: opts.batchId,
		agentId: opts.agentId,
		role: opts.role,
		laneNumber: opts.laneNumber,
		taskId: opts.taskId,
		repoId: opts.repoId,
		pid: opts.pid,
		parentPid: opts.parentPid,
		startedAt: Date.now(),
		status: "spawning",
		cwd: opts.cwd,
		packet: opts.packet,
	};
}

// ── Registry Snapshot ────────────────────────────────────────────────

/**
 * Build a registry snapshot from all agent manifests in a batch.
 */
export function buildRegistrySnapshot(stateRoot: string, batchId: string): RuntimeRegistry {
	const agentsDir = join(runtimeRoot(stateRoot, batchId), "agents");
	const agents: Record<RuntimeAgentId, RuntimeAgentManifest> = {};

	if (existsSync(agentsDir)) {
		try {
			const entries = readdirSync(agentsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const agentId = entry.name;
				const manifest = readManifest(stateRoot, batchId, agentId);
				if (manifest) {
					agents[agentId] = manifest;
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[process-registry] failed to scan agents dir: ${msg}`);
		}
	}

	return {
		batchId,
		updatedAt: Date.now(),
		agents,
	};
}

/**
 * Write the registry snapshot to disk.
 */
export function writeRegistrySnapshot(stateRoot: string, registry: RuntimeRegistry): void {
	const path = runtimeRegistryPath(stateRoot, registry.batchId);
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
	renameSync(tmpPath, path);
}

/**
 * Read the registry snapshot from disk. Returns null if not found.
 */
export function readRegistrySnapshot(stateRoot: string, batchId: string): RuntimeRegistry | null {
	const path = runtimeRegistryPath(stateRoot, batchId);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

// ── Liveness Checks ──────────────────────────────────────────────────

/**
 * Check whether a process with the given PID is still alive.
 *
 * Uses `process.kill(pid, 0)` which sends no signal but checks existence.
 * Returns false for PID 0, negative PIDs, and dead processes.
 */
export function isProcessAlive(pid: number): boolean {
	if (!pid || pid <= 0 || !Number.isFinite(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Determine if an agent is in a terminal (non-alive) state.
 */
export function isTerminalStatus(status: RuntimeAgentStatus): boolean {
	return TERMINAL_AGENT_STATUSES.has(status);
}

/**
 * Get all live (non-terminal) agents from a registry snapshot.
 */
export function getLiveAgents(registry: RuntimeRegistry): RuntimeAgentManifest[] {
	return Object.values(registry.agents).filter(m => !isTerminalStatus(m.status));
}

/**
 * Get all agents matching a specific role from a registry snapshot.
 */
export function getAgentsByRole(registry: RuntimeRegistry, role: RuntimeAgentRole): RuntimeAgentManifest[] {
	return Object.values(registry.agents).filter(m => m.role === role);
}

// ── Orphan Detection ─────────────────────────────────────────────────

/**
 * Detect orphaned agents — manifests that claim to be running but whose
 * process is no longer alive.
 */
export function detectOrphans(registry: RuntimeRegistry): RuntimeAgentId[] {
	const orphans: RuntimeAgentId[] = [];
	for (const manifest of Object.values(registry.agents)) {
		if (isTerminalStatus(manifest.status)) continue;
		if (!isProcessAlive(manifest.pid)) {
			orphans.push(manifest.agentId);
		}
	}
	return orphans;
}

/**
 * Mark detected orphans as crashed in their manifests.
 */
export function markOrphansCrashed(stateRoot: string, batchId: string, orphanIds: RuntimeAgentId[]): void {
	for (const agentId of orphanIds) {
		updateManifestStatus(stateRoot, batchId, agentId, "crashed");
	}
}

// ── Cleanup ──────────────────────────────────────────────────────────

/**
 * Remove all runtime artifacts for a batch.
 *
 * Best-effort: logs errors but doesn't throw.
 */
export function cleanupBatchRuntime(stateRoot: string, batchId: string): { removed: boolean; error?: string } {
	const root = runtimeRoot(stateRoot, batchId);
	if (!existsSync(root)) return { removed: false };
	try {
		rmSync(root, { recursive: true, force: true });
		return { removed: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[process-registry] failed to cleanup batch runtime: ${msg}`);
		return { removed: false, error: msg };
	}
}

// ── Normalized Event Helpers ─────────────────────────────────────────

/**
 * Append a normalized event to an agent's event log.
 *
 * Creates the events file and parent directories if they don't exist.
 * Best-effort: logs errors but doesn't throw.
 */
export function appendAgentEvent(
	stateRoot: string,
	batchId: string,
	agentId: RuntimeAgentId,
	event: Record<string, unknown>,
): void {
	const path = runtimeAgentEventsPath(stateRoot, batchId, agentId);
	mkdirSync(dirname(path), { recursive: true });
	try {
		appendFileSync(path, `${JSON.stringify(event)}\n`, "utf-8");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[process-registry] failed to append event for ${agentId}: ${msg}`);
	}
}

/**
 * Write a lane snapshot to disk.
 */
export function writeLaneSnapshot(
	stateRoot: string,
	batchId: string,
	laneNumber: number,
	snapshot: Record<string, unknown>,
): void {
	const path = runtimeLaneSnapshotPath(stateRoot, batchId, laneNumber);
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
	renameSync(tmpPath, path);
}

/**
 * Read a V2 lane snapshot from disk.
 * Returns null if the file doesn't exist or is unreadable.
 */
export function readLaneSnapshot(
	stateRoot: string,
	batchId: string,
	laneNumber: number,
): { taskId?: string | null; status: string; updatedAt?: number } | null {
	try {
		const p = runtimeLaneSnapshotPath(stateRoot, batchId, laneNumber);
		if (!existsSync(p)) return null;
		return JSON.parse(readFileSync(p, "utf-8"));
	} catch {
		return null;
	}
}

/**
 * Write a V2 merge agent snapshot to disk (atomic rename).
 */
export function writeMergeSnapshot(
	stateRoot: string,
	batchId: string,
	mergeNumber: number,
	snapshot: RuntimeMergeSnapshot,
): void {
	const path = runtimeMergeSnapshotPath(stateRoot, batchId, mergeNumber);
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
	renameSync(tmpPath, path);
}

/**
 * Read a V2 merge agent snapshot from disk.
 */
export function readMergeSnapshot(
	stateRoot: string,
	batchId: string,
	mergeNumber: number,
): RuntimeMergeSnapshot | null {
	try {
		const p = runtimeMergeSnapshotPath(stateRoot, batchId, mergeNumber);
		if (!existsSync(p)) return null;
		return JSON.parse(readFileSync(p, "utf-8")) as RuntimeMergeSnapshot;
	} catch {
		return null;
	}
}
