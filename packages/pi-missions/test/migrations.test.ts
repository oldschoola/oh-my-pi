import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadMissionMeta,
	MIGRATION_REGISTRY,
	type Migration,
	runMigrations,
	saveMissionMeta,
} from "../src/missioncontrol/migrations";

let ROOT: string;

beforeEach(() => {
	ROOT = mkdtempSync(join(tmpdir(), "mc-migrations-"));
});
afterEach(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

describe("loadMissionMeta", () => {
	test("returns {} on missing file", () => {
		expect(loadMissionMeta(ROOT)).toEqual({});
	});

	test("returns {} on malformed JSON", () => {
		mkdirSync(join(ROOT, ".omp"), { recursive: true });
		writeFileSync(join(ROOT, ".omp", "mission.json"), "{not json");
		expect(loadMissionMeta(ROOT)).toEqual({});
	});

	test("returns parsed object", () => {
		mkdirSync(join(ROOT, ".omp"), { recursive: true });
		writeFileSync(join(ROOT, ".omp", "mission.json"), JSON.stringify({ version: 1, custom: "x" }));
		expect(loadMissionMeta(ROOT)).toEqual({ version: 1, custom: "x" });
	});
});

describe("saveMissionMeta", () => {
	test("creates .omp dir and writes merged meta", () => {
		saveMissionMeta(ROOT, { custom: "a" });
		const path = join(ROOT, ".omp", "mission.json");
		expect(existsSync(path)).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ custom: "a" });
	});

	test("preserves unrelated top-level keys", () => {
		saveMissionMeta(ROOT, { version: 1, installedAt: "2025-01-01" });
		saveMissionMeta(ROOT, { custom: "b" });
		const parsed = JSON.parse(readFileSync(join(ROOT, ".omp", "mission.json"), "utf-8"));
		expect(parsed.version).toBe(1);
		expect(parsed.installedAt).toBe("2025-01-01");
		expect(parsed.custom).toBe("b");
	});
});

describe("runMigrations", () => {
	test("applies the supervisor-template migration when missing", () => {
		const result = runMigrations(ROOT);
		// Registry ships a single supervisor template migration — either
		// applied (created file) or errored (template missing).
		expect(result.errors).toEqual([]);
		expect(result.applied).toContain("add-supervisor-local-template-v1");
		expect(existsSync(join(ROOT, ".omp", "agents", "supervisor.md"))).toBe(true);
	});

	test("skips migrations that have already been recorded", () => {
		runMigrations(ROOT);
		const second = runMigrations(ROOT);
		expect(second.applied).toEqual([]);
		expect(second.skipped).toContain("add-supervisor-local-template-v1");
	});

	test("custom registry + custom roots", () => {
		// Drive runMigrations with a synthetic registry via module mutation
		const original = [...MIGRATION_REGISTRY];
		MIGRATION_REGISTRY.length = 0;
		try {
			const marker = join(ROOT, ".omp", "marker.txt");
			const custom: Migration = {
				id: "test-custom-v1",
				description: "Drop a marker file",
				run(_projectRoot, _pkgRoot, configRoot) {
					const target = join(configRoot, "marker.txt");
					if (existsSync(target)) return null;
					mkdirSync(configRoot, { recursive: true });
					writeFileSync(target, "hello");
					return `Created ${target}`;
				},
			};
			MIGRATION_REGISTRY.push(custom);

			const first = runMigrations(ROOT);
			expect(first.applied).toEqual(["test-custom-v1"]);
			expect(existsSync(marker)).toBe(true);

			const second = runMigrations(ROOT);
			expect(second.applied).toEqual([]);
			expect(second.skipped).toContain("test-custom-v1");
		} finally {
			MIGRATION_REGISTRY.length = 0;
			MIGRATION_REGISTRY.push(...original);
		}
	});

	test("records errors without marking migration applied", () => {
		const original = [...MIGRATION_REGISTRY];
		MIGRATION_REGISTRY.length = 0;
		try {
			MIGRATION_REGISTRY.push({
				id: "always-fails-v1",
				description: "Throws",
				run() {
					throw new Error("boom");
				},
			});
			const first = runMigrations(ROOT);
			expect(first.errors).toHaveLength(1);
			expect(first.errors[0]?.id).toBe("always-fails-v1");
			expect(first.applied).toEqual([]);

			// Retries on the next run (not persisted as applied)
			const second = runMigrations(ROOT);
			expect(second.errors).toHaveLength(1);
		} finally {
			MIGRATION_REGISTRY.length = 0;
			MIGRATION_REGISTRY.push(...original);
		}
	});
});
