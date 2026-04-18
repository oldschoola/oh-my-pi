import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupPostIntegrate,
	cleanupPriorBatchArtifacts,
	enforceTelemetrySizeCap,
	formatLogRotation,
	formatPostIntegrateCleanup,
	formatPreflightSweep,
	formatPriorBatchCleanup,
	formatSizeCap,
	LOG_ROTATION_THRESHOLD_BYTES,
	rotateSupervisorLogs,
	runPreflightCleanup,
	STALE_ARTIFACT_MAX_AGE_MS,
	sweepStaleArtifacts,
	TELEMETRY_SIZE_CAP_BYTES,
} from "../src/missioncontrol/cleanup";

function makeRoot(): string {
	return mkdtempSync(join(tmpdir(), "mc-cleanup-"));
}

function write(path: string, content = "x"): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function setMtime(path: string, ageMs: number): void {
	const then = new Date(Date.now() - ageMs);
	utimesSync(path, then, then);
}

describe("cleanupPostIntegrate", () => {
	test("returns empty result when batchId missing", () => {
		const root = makeRoot();
		try {
			const r = cleanupPostIntegrate(root, "");
			expect(r.warnings[0]).toContain("No batchId");
			expect(r.telemetryFilesDeleted).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("deletes batch-scoped telemetry + merge + mailbox artifacts", () => {
		const root = makeRoot();
		try {
			const omp = join(root, ".omp");
			const tele = join(omp, "telemetry");
			write(join(tele, "worker-b1-1.jsonl"));
			write(join(tele, "reviewer-b1-1-exit.json"));
			write(join(tele, "worker-OTHER-1.jsonl")); // not scoped — kept
			write(join(tele, "lane-prompt-abc.txt")); // prompt — always cleaned
			write(join(omp, "merge-result-lane-1-b1.json"));
			write(join(omp, "merge-request-lane-1-b1.txt"));
			mkdirSync(join(omp, "mailbox", "b1"), { recursive: true });
			mkdirSync(join(omp, "mailbox", "other"), { recursive: true });
			mkdirSync(join(omp, "context-snapshots", "b1"), { recursive: true });

			const r = cleanupPostIntegrate(root, "b1");
			expect(r.telemetryFilesDeleted).toBe(2);
			expect(r.promptFilesDeleted).toBe(1);
			expect(r.mergeFilesDeleted).toBe(2);
			expect(r.mailboxDirsDeleted).toBe(1);
			expect(r.snapshotDirsDeleted).toBe(1);
			expect(existsSync(join(tele, "worker-OTHER-1.jsonl"))).toBe(true);
			expect(existsSync(join(omp, "mailbox", "other"))).toBe(true);
			expect(existsSync(join(omp, "mailbox", "b1"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("formatPostIntegrateCleanup", () => {
	test("returns empty when nothing deleted", () => {
		const r = formatPostIntegrateCleanup({
			telemetryFilesDeleted: 0,
			mergeFilesDeleted: 0,
			promptFilesDeleted: 0,
			mailboxDirsDeleted: 0,
			snapshotDirsDeleted: 0,
			warnings: [],
		});
		expect(r).toBe("");
	});

	test("summarizes counts", () => {
		const r = formatPostIntegrateCleanup({
			telemetryFilesDeleted: 2,
			mergeFilesDeleted: 1,
			promptFilesDeleted: 0,
			mailboxDirsDeleted: 1,
			snapshotDirsDeleted: 0,
			warnings: [],
		});
		expect(r).toContain("4 artifact");
		expect(r).toContain("2 telemetry");
		expect(r).toContain("1 merge");
		expect(r).toContain("1 mailbox");
	});
});

describe("sweepStaleArtifacts", () => {
	test("skips when batch is active", () => {
		const root = makeRoot();
		try {
			const r = sweepStaleArtifacts(root, { isBatchActive: () => true, now: () => Date.now() });
			expect(r.skipped).toBe(true);
			expect(r.skipReason).toBeDefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("deletes files older than cutoff; preserves fresh ones", () => {
		const root = makeRoot();
		try {
			const omp = join(root, ".omp");
			const tele = join(omp, "telemetry");
			write(join(tele, "old.jsonl"));
			write(join(tele, "fresh.jsonl"));
			write(join(omp, "worker-conversation-old.jsonl"));
			write(join(omp, "lane-state-stale.json"));
			setMtime(join(tele, "old.jsonl"), 10 * 24 * 60 * 60 * 1000);
			setMtime(join(omp, "worker-conversation-old.jsonl"), 10 * 24 * 60 * 60 * 1000);
			setMtime(join(omp, "lane-state-stale.json"), 10 * 24 * 60 * 60 * 1000);

			// Stale mailbox directory
			const staleDir = join(omp, "mailbox", "old-batch");
			mkdirSync(staleDir, { recursive: true });
			setMtime(staleDir, 10 * 24 * 60 * 60 * 1000);

			const r = sweepStaleArtifacts(root, { isBatchActive: () => false, now: () => Date.now() });
			expect(r.skipped).toBe(false);
			expect(r.staleFilesDeleted).toBeGreaterThanOrEqual(3);
			expect(r.staleDirsDeleted).toBeGreaterThanOrEqual(1);
			expect(existsSync(join(tele, "fresh.jsonl"))).toBe(true);
			expect(existsSync(join(tele, "old.jsonl"))).toBe(false);
			expect(existsSync(staleDir)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("handles missing .omp dir gracefully", () => {
		const root = makeRoot();
		try {
			const r = sweepStaleArtifacts(root, { isBatchActive: () => false, now: () => Date.now() });
			expect(r.staleFilesDeleted).toBe(0);
			expect(r.warnings).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("uses STALE_ARTIFACT_MAX_AGE_MS by default", () => {
		expect(STALE_ARTIFACT_MAX_AGE_MS).toBe(3 * 24 * 60 * 60 * 1000);
	});
});

describe("formatPreflightSweep", () => {
	test("returns skip reason when skipped", () => {
		const r = formatPreflightSweep({
			staleFilesDeleted: 0,
			staleDirsDeleted: 0,
			skipped: true,
			skipReason: "active batch",
			warnings: [],
		});
		expect(r).toContain("skipped");
		expect(r).toContain("active batch");
	});

	test("empty when nothing happened", () => {
		const r = formatPreflightSweep({
			staleFilesDeleted: 0,
			staleDirsDeleted: 0,
			skipped: false,
			warnings: [],
		});
		expect(r).toBe("");
	});
});

describe("rotateSupervisorLogs", () => {
	test("rotates files exceeding threshold", () => {
		const root = makeRoot();
		try {
			const sup = join(root, ".omp", "supervisor");
			mkdirSync(sup, { recursive: true });
			const big = "a".repeat(6 * 1024 * 1024); // 6 MB
			writeFileSync(join(sup, "events.jsonl"), big);
			writeFileSync(join(sup, "actions.jsonl"), "small");

			const r = rotateSupervisorLogs(root);
			expect(r.rotated).toContain("events.jsonl");
			expect(r.rotated).not.toContain("actions.jsonl");
			expect(existsSync(join(sup, "events.jsonl.old"))).toBe(true);
			expect(existsSync(join(sup, "events.jsonl"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("no-op when supervisor dir missing", () => {
		const root = makeRoot();
		try {
			const r = rotateSupervisorLogs(root);
			expect(r.rotated).toEqual([]);
			expect(r.warnings).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("LOG_ROTATION_THRESHOLD_BYTES default", () => {
		expect(LOG_ROTATION_THRESHOLD_BYTES).toBe(5 * 1024 * 1024);
	});
});

describe("formatLogRotation", () => {
	test("summarizes rotated file list", () => {
		const r = formatLogRotation({ rotated: ["events.jsonl", "actions.jsonl"], warnings: [] });
		expect(r).toContain("Rotated 2");
		expect(r).toContain("events.jsonl");
	});
});

describe("enforceTelemetrySizeCap", () => {
	test("evicts oldest files first until under cap", () => {
		const root = makeRoot();
		try {
			const tele = join(root, ".omp", "telemetry");
			mkdirSync(tele, { recursive: true });
			const big = "x".repeat(100);
			for (let i = 0; i < 5; i++) {
				const path = join(tele, `file-${i}.jsonl`);
				writeFileSync(path, big);
				setMtime(path, (5 - i) * 1000); // file-0 oldest, file-4 newest
			}
			// Cap at 300 bytes → need to delete at least 2 files (each 100 bytes)
			const r = enforceTelemetrySizeCap(root, 300);
			expect(r.filesDeleted).toBeGreaterThanOrEqual(2);
			expect(r.bytesFreed).toBeGreaterThanOrEqual(200);
			// The newest should survive
			expect(existsSync(join(tele, "file-4.jsonl"))).toBe(true);
			// The oldest should be gone
			expect(existsSync(join(tele, "file-0.jsonl"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("no-op when under cap", () => {
		const root = makeRoot();
		try {
			const tele = join(root, ".omp", "telemetry");
			mkdirSync(tele, { recursive: true });
			writeFileSync(join(tele, "a.jsonl"), "small");

			const r = enforceTelemetrySizeCap(root, 1024);
			expect(r.filesDeleted).toBe(0);
			expect(existsSync(join(tele, "a.jsonl"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("TELEMETRY_SIZE_CAP_BYTES default", () => {
		expect(TELEMETRY_SIZE_CAP_BYTES).toBe(500 * 1024 * 1024);
	});
});

describe("formatSizeCap", () => {
	test("summarizes MB freed", () => {
		const r = formatSizeCap({ filesDeleted: 3, bytesFreed: 2 * 1024 * 1024, warnings: [] });
		expect(r).toContain("3 file");
		expect(r).toContain("2.0 MB");
	});
});

describe("cleanupPriorBatchArtifacts", () => {
	test("protects current batch", () => {
		const root = makeRoot();
		try {
			const omp = join(root, ".omp");
			const tele = join(omp, "telemetry");
			write(join(tele, "worker-current-1.jsonl"));
			write(join(tele, "worker-prior-1.jsonl"));
			mkdirSync(join(omp, "mailbox", "current"), { recursive: true });
			mkdirSync(join(omp, "mailbox", "prior"), { recursive: true });

			const r = cleanupPriorBatchArtifacts(root, "current");
			expect(existsSync(join(tele, "worker-current-1.jsonl"))).toBe(true);
			expect(existsSync(join(tele, "worker-prior-1.jsonl"))).toBe(false);
			expect(existsSync(join(omp, "mailbox", "current"))).toBe(true);
			expect(existsSync(join(omp, "mailbox", "prior"))).toBe(false);
			expect(r.itemsDeleted).toBeGreaterThanOrEqual(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("warns when currentBatchId missing", () => {
		const root = makeRoot();
		try {
			const r = cleanupPriorBatchArtifacts(root, "");
			expect(r.warnings[0]).toContain("No currentBatchId");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("formatPriorBatchCleanup", () => {
	test("summarizes count", () => {
		const r = formatPriorBatchCleanup({ itemsDeleted: 5, warnings: [] });
		expect(r).toContain("5 artifact");
	});

	test("empty when nothing done", () => {
		const r = formatPriorBatchCleanup({ itemsDeleted: 0, warnings: [] });
		expect(r).toBe("");
	});
});

describe("runPreflightCleanup", () => {
	test("combines sweep + rotation", () => {
		const root = makeRoot();
		try {
			const omp = join(root, ".omp");
			const tele = join(omp, "telemetry");
			write(join(tele, "old.jsonl"));
			setMtime(join(tele, "old.jsonl"), 10 * 24 * 60 * 60 * 1000);

			const sup = join(omp, "supervisor");
			mkdirSync(sup, { recursive: true });
			writeFileSync(join(sup, "events.jsonl"), "x".repeat(6 * 1024 * 1024));

			const r = runPreflightCleanup(root, { isBatchActive: () => false, now: () => Date.now() });
			expect(r.sweep.staleFilesDeleted).toBeGreaterThanOrEqual(1);
			expect(r.rotation.rotated).toContain("events.jsonl");

			// Confirm rotated file is readable (not corrupted)
			const rotated = readFileSync(join(sup, "events.jsonl.old"), "utf-8");
			expect(rotated.length).toBe(6 * 1024 * 1024);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
