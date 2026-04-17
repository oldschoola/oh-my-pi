/**
 * Artifact cleanup and log rotation for MissionControl runtime files.
 *
 * Ported from taskplane `extensions/taskplane/cleanup.ts`. All path references
 * route through `projectDir()` so artifacts land under `.omp/` instead of
 * `.pi/`. Five cleanup layers prevent unbounded disk growth:
 *
 * 1. **Post-Integrate Cleanup** — Deletes batch-specific telemetry and merge
 *    result files after successful /mission-integrate. Scoped by batchId.
 *
 * 2. **Age-Based Preflight Sweep** — On /mission start, removes telemetry,
 *    verification, conversation, lane-state, and merge artifacts older than
 *    3 days.
 *
 * 3. **Size-Capped Log Rotation** — Rotates append-only supervisor logs
 *    (events.jsonl, actions.jsonl) at a 5MB threshold.
 *
 * 4. **Telemetry Size Cap** — Enforces a 500MB cap on `.omp/telemetry/`
 *    by evicting oldest files first.
 *
 * 5. **Batch-Start Cleanup** — Removes artifacts from prior completed
 *    batches when a new batch starts, protecting the current batch.
 *
 * All cleanup is non-fatal — failures warn but never block execution.
 */

import { existsSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { projectDir } from "./adapter";
import { MAILBOX_DIR_NAME } from "./mailbox";

// ── Layer 1: Post-Integrate Cleanup ─────────────────────────────────

export interface PostIntegrateCleanupResult {
	telemetryFilesDeleted: number;
	mergeFilesDeleted: number;
	promptFilesDeleted: number;
	mailboxDirsDeleted: number;
	snapshotDirsDeleted: number;
	warnings: string[];
}

/**
 * Clean up batch-specific telemetry and merge result files after integrate.
 *
 * Targets files whose names contain the batchId:
 * - `.omp/telemetry/*-{batchId}-*.jsonl` — worker/merger sidecar files
 * - `.omp/telemetry/*-{batchId}-*-exit.json` — exit summaries
 * - `.omp/telemetry/lane-prompt-*.txt` — temporary prompt files (all, not scoped)
 * - `.omp/merge-result-*-{batchId}.json` — merge result files
 * - `.omp/merge-request-*-{batchId}.txt` — merge request files
 */
export function cleanupPostIntegrate(stateRoot: string, batchId: string): PostIntegrateCleanupResult {
	const result: PostIntegrateCleanupResult = {
		telemetryFilesDeleted: 0,
		mergeFilesDeleted: 0,
		promptFilesDeleted: 0,
		mailboxDirsDeleted: 0,
		snapshotDirsDeleted: 0,
		warnings: [],
	};

	if (!batchId) {
		result.warnings.push("No batchId provided — skipping post-integrate cleanup");
		return result;
	}

	const base = projectDir(stateRoot);

	// Telemetry files
	const telemetryDir = join(base, "telemetry");
	if (existsSync(telemetryDir)) {
		try {
			const entries = readdirSync(telemetryDir);
			for (const entry of entries) {
				if (entry.includes(batchId) && (entry.endsWith(".jsonl") || entry.endsWith("-exit.json"))) {
					try {
						unlinkSync(join(telemetryDir, entry));
						result.telemetryFilesDeleted++;
					} catch (err: unknown) {
						result.warnings.push(`Failed to delete telemetry file ${entry}: ${(err as Error).message}`);
					}
				}
				if (entry.startsWith("lane-prompt-") && entry.endsWith(".txt")) {
					try {
						unlinkSync(join(telemetryDir, entry));
						result.promptFilesDeleted++;
					} catch (err: unknown) {
						result.warnings.push(`Failed to delete prompt file ${entry}: ${(err as Error).message}`);
					}
				}
			}
		} catch (err: unknown) {
			result.warnings.push(`Failed to read telemetry directory: ${(err as Error).message}`);
		}
	}

	// Merge result/request files
	if (existsSync(base)) {
		try {
			const entries = readdirSync(base);
			for (const entry of entries) {
				if (
					entry.includes(batchId) &&
					((entry.startsWith("merge-result-") && entry.endsWith(".json")) ||
						(entry.startsWith("merge-request-") && entry.endsWith(".txt")))
				) {
					try {
						unlinkSync(join(base, entry));
						result.mergeFilesDeleted++;
					} catch (err: unknown) {
						result.warnings.push(`Failed to delete merge file ${entry}: ${(err as Error).message}`);
					}
				}
			}
		} catch (err: unknown) {
			result.warnings.push(`Failed to read .omp directory: ${(err as Error).message}`);
		}
	}

	// Mailbox directory
	const mailboxBatchDir = join(base, MAILBOX_DIR_NAME, batchId);
	if (existsSync(mailboxBatchDir)) {
		try {
			rmSync(mailboxBatchDir, { recursive: true, force: true });
			result.mailboxDirsDeleted = 1;
		} catch (err: unknown) {
			result.warnings.push(`Failed to delete mailbox directory ${mailboxBatchDir}: ${(err as Error).message}`);
		}
	}

	// Context snapshots directory
	const snapshotBatchDir = join(base, "context-snapshots", batchId);
	if (existsSync(snapshotBatchDir)) {
		try {
			rmSync(snapshotBatchDir, { recursive: true, force: true });
			result.snapshotDirsDeleted = 1;
		} catch (err: unknown) {
			result.warnings.push(
				`Failed to delete context-snapshots directory ${snapshotBatchDir}: ${(err as Error).message}`,
			);
		}
	}

	return result;
}

export function formatPostIntegrateCleanup(result: PostIntegrateCleanupResult): string {
	const parts: string[] = [];
	const totalDeleted =
		result.telemetryFilesDeleted +
		result.mergeFilesDeleted +
		result.promptFilesDeleted +
		result.mailboxDirsDeleted +
		result.snapshotDirsDeleted;

	if (totalDeleted > 0) {
		const segments: string[] = [];
		if (result.telemetryFilesDeleted > 0) segments.push(`${result.telemetryFilesDeleted} telemetry`);
		if (result.mergeFilesDeleted > 0) segments.push(`${result.mergeFilesDeleted} merge`);
		if (result.promptFilesDeleted > 0) segments.push(`${result.promptFilesDeleted} prompt`);
		if (result.mailboxDirsDeleted > 0) segments.push(`${result.mailboxDirsDeleted} mailbox`);
		if (result.snapshotDirsDeleted > 0) segments.push(`${result.snapshotDirsDeleted} snapshots`);
		parts.push(`🧹 Cleaned up ${totalDeleted} artifact file(s): ${segments.join(", ")}`);
	}

	for (const warning of result.warnings) {
		parts.push(`  ⚠️ ${warning}`);
	}

	return parts.join("\n");
}

// ── Layer 2: Age-Based Preflight Sweep ──────────────────────────────

/** Default max age for stale artifacts (3 days in milliseconds). */
export const STALE_ARTIFACT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export interface PreflightSweepResult {
	staleFilesDeleted: number;
	staleDirsDeleted: number;
	skipped: boolean;
	skipReason?: string;
	warnings: string[];
}

export interface SweepDeps {
	/** Check if a batch is currently active (phase is not terminal). */
	isBatchActive: () => boolean;
	/** Get the current timestamp (for deterministic testing). */
	now: () => number;
}

/**
 * Sweep stale artifacts older than maxAgeMs during preflight.
 *
 * Uses file mtime for age detection. If a batch is currently active, skips all cleanup.
 */
export function sweepStaleArtifacts(
	stateRoot: string,
	deps: SweepDeps,
	maxAgeMs: number = STALE_ARTIFACT_MAX_AGE_MS,
): PreflightSweepResult {
	const result: PreflightSweepResult = {
		staleFilesDeleted: 0,
		staleDirsDeleted: 0,
		skipped: false,
		warnings: [],
	};

	try {
		if (deps.isBatchActive()) {
			result.skipped = true;
			result.skipReason = "Active batch detected — skipping stale artifact sweep";
			return result;
		}
	} catch {
		// Proceed cautiously if we can't determine batch state
	}

	const now = deps.now();
	const cutoff = now - maxAgeMs;
	const base = projectDir(stateRoot);

	const sweepDir = (dir: string, filter: (name: string) => boolean): void => {
		if (!existsSync(dir)) return;
		try {
			const entries = readdirSync(dir);
			for (const entry of entries) {
				if (!filter(entry)) continue;
				const filePath = join(dir, entry);
				try {
					const stat = statSync(filePath);
					if (!stat.isFile()) continue;
					if (stat.mtimeMs < cutoff) {
						unlinkSync(filePath);
						result.staleFilesDeleted++;
					}
				} catch (err: unknown) {
					result.warnings.push(`Failed to process ${entry}: ${(err as Error).message}`);
				}
			}
		} catch (err: unknown) {
			result.warnings.push(`Failed to read directory ${dir}: ${(err as Error).message}`);
		}
	};

	sweepDir(
		join(base, "telemetry"),
		name =>
			name.endsWith(".jsonl") ||
			name.endsWith("-exit.json") ||
			(name.startsWith("lane-prompt-") && name.endsWith(".txt")),
	);

	sweepDir(
		base,
		name =>
			(name.startsWith("merge-result-") && name.endsWith(".json")) ||
			(name.startsWith("merge-request-") && name.endsWith(".txt")),
	);

	sweepDir(base, name => name.startsWith("worker-conversation-") && name.endsWith(".jsonl"));

	sweepDir(base, name => name.startsWith("lane-state-") && name.endsWith(".json"));

	const sweepBatchDirs = (parentDir: string, label: string): void => {
		if (!existsSync(parentDir)) return;
		try {
			const entries = readdirSync(parentDir);
			for (const entry of entries) {
				const entryPath = join(parentDir, entry);
				try {
					const stat = statSync(entryPath);
					if (!stat.isDirectory()) continue;
					if (stat.mtimeMs < cutoff) {
						rmSync(entryPath, { recursive: true, force: true });
						result.staleDirsDeleted++;
					}
				} catch (err: unknown) {
					result.warnings.push(`Failed to process ${label} dir ${entry}: ${(err as Error).message}`);
				}
			}
		} catch (err: unknown) {
			result.warnings.push(`Failed to read ${label} directory ${parentDir}: ${(err as Error).message}`);
		}
	};

	sweepBatchDirs(join(base, MAILBOX_DIR_NAME), "mailbox");
	sweepBatchDirs(join(base, "context-snapshots"), "context-snapshots");
	sweepBatchDirs(join(base, "verification"), "verification");

	return result;
}

export function formatPreflightSweep(result: PreflightSweepResult): string {
	if (result.skipped) {
		return `ℹ️ Preflight sweep skipped: ${result.skipReason}`;
	}
	if (result.staleFilesDeleted === 0 && result.staleDirsDeleted === 0 && result.warnings.length === 0) {
		return "";
	}
	const parts: string[] = [];
	if (result.staleFilesDeleted > 0 || result.staleDirsDeleted > 0) {
		const segments: string[] = [];
		if (result.staleFilesDeleted > 0) segments.push(`${result.staleFilesDeleted} stale artifact(s)`);
		if (result.staleDirsDeleted > 0) segments.push(`${result.staleDirsDeleted} stale mailbox dir(s)`);
		parts.push(`🧹 Preflight cleanup: removed ${segments.join(" and ")} (>3 days old)`);
	}
	for (const warning of result.warnings) {
		parts.push(`  ⚠️ ${warning}`);
	}
	return parts.join("\n");
}

// ── Layer 3: Size-Capped Log Rotation ───────────────────────────────

/** Default rotation threshold: 5MB. */
export const LOG_ROTATION_THRESHOLD_BYTES = 5 * 1024 * 1024;

export interface LogRotationResult {
	rotated: string[];
	warnings: string[];
}

/**
 * Rotate supervisor append-only logs at a size threshold.
 *
 * If a file exceeds the threshold, renames it to `.old` (overwriting any existing `.old`).
 */
export function rotateSupervisorLogs(
	stateRoot: string,
	thresholdBytes: number = LOG_ROTATION_THRESHOLD_BYTES,
): LogRotationResult {
	const result: LogRotationResult = { rotated: [], warnings: [] };

	const supervisorDir = join(projectDir(stateRoot), "supervisor");
	if (!existsSync(supervisorDir)) return result;

	const filesToRotate = ["events.jsonl", "actions.jsonl"];

	for (const fileName of filesToRotate) {
		const filePath = join(supervisorDir, fileName);
		if (!existsSync(filePath)) continue;

		try {
			const stat = statSync(filePath);
			if (!stat.isFile() || stat.size <= thresholdBytes) continue;

			const oldPath = `${filePath}.old`;
			renameSync(filePath, oldPath);
			result.rotated.push(fileName);
		} catch (err: unknown) {
			result.warnings.push(`Failed to rotate ${fileName}: ${(err as Error).message}`);
		}
	}

	return result;
}

export function formatLogRotation(result: LogRotationResult): string {
	if (result.rotated.length === 0 && result.warnings.length === 0) return "";
	const parts: string[] = [];
	if (result.rotated.length > 0) {
		parts.push(`🔄 Rotated ${result.rotated.length} supervisor log(s): ${result.rotated.join(", ")}`);
	}
	for (const warning of result.warnings) {
		parts.push(`  ⚠️ ${warning}`);
	}
	return parts.join("\n");
}

// ── Layer 4: Telemetry Directory Size Cap ─────────────────────────────

/** Default telemetry directory size cap: 500 MB. */
export const TELEMETRY_SIZE_CAP_BYTES = 500 * 1024 * 1024;

export interface SizeCapResult {
	filesDeleted: number;
	bytesFreed: number;
	warnings: string[];
}

/**
 * Enforce a size cap on the telemetry directory by evicting oldest files first.
 */
export function enforceTelemetrySizeCap(stateRoot: string, capBytes: number = TELEMETRY_SIZE_CAP_BYTES): SizeCapResult {
	const result: SizeCapResult = { filesDeleted: 0, bytesFreed: 0, warnings: [] };

	const telemetryDir = join(projectDir(stateRoot), "telemetry");
	if (!existsSync(telemetryDir)) return result;

	interface FileEntry {
		name: string;
		path: string;
		size: number;
		mtimeMs: number;
	}

	const files: FileEntry[] = [];
	let totalSize = 0;

	try {
		const entries = readdirSync(telemetryDir);
		for (const entry of entries) {
			const filePath = join(telemetryDir, entry);
			try {
				const stat = statSync(filePath);
				if (!stat.isFile()) continue;
				files.push({ name: entry, path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
				totalSize += stat.size;
			} catch (err: unknown) {
				result.warnings.push(`Failed to stat ${entry}: ${(err as Error).message}`);
			}
		}
	} catch (err: unknown) {
		result.warnings.push(`Failed to read telemetry directory: ${(err as Error).message}`);
		return result;
	}

	if (totalSize <= capBytes) return result;

	files.sort((a, b) => a.mtimeMs - b.mtimeMs);

	for (const file of files) {
		if (totalSize <= capBytes) break;
		try {
			unlinkSync(file.path);
			totalSize -= file.size;
			result.filesDeleted++;
			result.bytesFreed += file.size;
		} catch (err: unknown) {
			result.warnings.push(`Failed to delete ${file.name}: ${(err as Error).message}`);
		}
	}

	return result;
}

export function formatSizeCap(result: SizeCapResult): string {
	if (result.filesDeleted === 0 && result.warnings.length === 0) return "";
	const parts: string[] = [];
	if (result.filesDeleted > 0) {
		const mbFreed = (result.bytesFreed / (1024 * 1024)).toFixed(1);
		parts.push(`🧹 Telemetry size cap: deleted ${result.filesDeleted} file(s), freed ${mbFreed} MB`);
	}
	for (const warning of result.warnings) {
		parts.push(`  ⚠️ ${warning}`);
	}
	return parts.join("\n");
}

// ── Layer 5: Batch-Start Cleanup of Prior Batch Artifacts ─────────────

export interface PriorBatchCleanupResult {
	itemsDeleted: number;
	warnings: string[];
}

/**
 * Clean up artifacts from prior completed batches when a new batch starts.
 *
 * Only cleans artifacts from batches that are NOT the currently active batch.
 */
export function cleanupPriorBatchArtifacts(stateRoot: string, currentBatchId: string): PriorBatchCleanupResult {
	const result: PriorBatchCleanupResult = { itemsDeleted: 0, warnings: [] };

	if (!currentBatchId) {
		result.warnings.push("No currentBatchId provided — skipping prior batch cleanup");
		return result;
	}

	const base = projectDir(stateRoot);
	if (!existsSync(base)) return result;

	const cleanDir = (dir: string, filter: (name: string) => boolean): void => {
		if (!existsSync(dir)) return;
		try {
			const entries = readdirSync(dir);
			for (const entry of entries) {
				if (!filter(entry)) continue;
				if (entry.includes(currentBatchId)) continue;
				const filePath = join(dir, entry);
				try {
					const stat = statSync(filePath);
					if (stat.isFile()) {
						unlinkSync(filePath);
						result.itemsDeleted++;
					}
				} catch (err: unknown) {
					result.warnings.push(`Failed to delete ${entry}: ${(err as Error).message}`);
				}
			}
		} catch (err: unknown) {
			result.warnings.push(`Failed to read directory ${dir}: ${(err as Error).message}`);
		}
	};

	cleanDir(
		join(base, "telemetry"),
		name =>
			name.endsWith(".jsonl") ||
			name.endsWith("-exit.json") ||
			(name.startsWith("lane-prompt-") && name.endsWith(".txt")),
	);

	cleanDir(
		base,
		name =>
			(name.startsWith("merge-result-") && name.endsWith(".json")) ||
			(name.startsWith("merge-request-") && name.endsWith(".txt")),
	);

	cleanDir(base, name => name.startsWith("worker-conversation-") && name.endsWith(".jsonl"));

	cleanDir(base, name => name.startsWith("lane-state-") && name.endsWith(".json"));

	const cleanBatchDirs = (parentDir: string): void => {
		if (!existsSync(parentDir)) return;
		try {
			const entries = readdirSync(parentDir);
			for (const entry of entries) {
				if (entry === currentBatchId) continue;
				const entryPath = join(parentDir, entry);
				try {
					const stat = statSync(entryPath);
					if (!stat.isDirectory()) continue;
					rmSync(entryPath, { recursive: true, force: true });
					result.itemsDeleted++;
				} catch (err: unknown) {
					result.warnings.push(`Failed to delete batch dir ${entry}: ${(err as Error).message}`);
				}
			}
		} catch (err: unknown) {
			result.warnings.push(`Failed to read directory ${parentDir}: ${(err as Error).message}`);
		}
	};

	cleanBatchDirs(join(base, MAILBOX_DIR_NAME));
	cleanBatchDirs(join(base, "context-snapshots"));

	return result;
}

export function formatPriorBatchCleanup(result: PriorBatchCleanupResult): string {
	if (result.itemsDeleted === 0 && result.warnings.length === 0) return "";
	const parts: string[] = [];
	if (result.itemsDeleted > 0) {
		parts.push(`🧹 Prior batch cleanup: removed ${result.itemsDeleted} artifact(s) from previous batch(es)`);
	}
	for (const warning of result.warnings) {
		parts.push(`  ⚠️ ${warning}`);
	}
	return parts.join("\n");
}

// ── Combined Preflight Cleanup ──────────────────────────────────────

export interface PreflightCleanupResult {
	sweep: PreflightSweepResult;
	rotation: LogRotationResult;
}

/**
 * Run all preflight cleanup operations (Layer 2 + Layer 3).
 */
export function runPreflightCleanup(stateRoot: string, deps: SweepDeps): PreflightCleanupResult {
	const sweep = sweepStaleArtifacts(stateRoot, deps);
	const rotation = rotateSupervisorLogs(stateRoot);
	return { sweep, rotation };
}

export function formatPreflightCleanup(result: PreflightCleanupResult): string {
	const parts: string[] = [];

	if (!result.sweep.skipped && (result.sweep.staleFilesDeleted > 0 || result.sweep.staleDirsDeleted > 0)) {
		const segments: string[] = [];
		if (result.sweep.staleFilesDeleted > 0) segments.push(`${result.sweep.staleFilesDeleted} stale artifact(s)`);
		if (result.sweep.staleDirsDeleted > 0) segments.push(`${result.sweep.staleDirsDeleted} stale mailbox dir(s)`);
		parts.push(`removed ${segments.join(" and ")} (>3 days old)`);
	}

	if (result.rotation.rotated.length > 0) {
		parts.push(`rotated ${result.rotation.rotated.join(", ")} (>5 MB)`);
	}

	const warnings = [...result.sweep.warnings, ...result.rotation.warnings];
	if (warnings.length > 0) {
		parts.push(`⚠️ ${warnings.length} cleanup warning(s)`);
	}

	if (parts.length === 0) return "";
	return `🧹 Preflight cleanup: ${parts.join("; ")}`;
}
