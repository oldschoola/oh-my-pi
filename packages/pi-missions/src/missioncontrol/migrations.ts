/**
 * Additive Upgrade Migrations for pi-missions / MissionControl.
 *
 * Ported from taskplane `extensions/taskplane/migrations.ts` (278 LOC).
 * Renames:
 *   `.pi/taskplane.json` → `.omp/mission.json` (via projectDir() helper)
 *   `TaskplaneMeta`      → `MissionMeta`
 *
 * The migration runner applies additive-only changes (e.g., scaffolding
 * missing template files) whenever the engine starts. Migrations never
 * overwrite existing files.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectDir } from "./adapter";
import { packageRoot } from "./paths";

// ── Types ────────────────────────────────────────────────────────────

export interface Migration {
	id: string;
	description: string;
	/**
	 * Run the migration. Returns a short message on success, or null if the
	 * target already exists (skip). Throw for unrecoverable errors.
	 */
	run(projectRoot: string, pkgRoot: string, configRoot: string): string | null;
}

export interface AppliedMigration {
	appliedAt: string;
}

export interface MigrationState {
	applied: Record<string, AppliedMigration>;
}

export interface MissionMeta {
	[key: string]: unknown;
	migrations?: MigrationState;
}

export interface MigrationRunResult {
	applied: string[];
	skipped: string[];
	errors: Array<{ id: string; error: string }>;
	messages: string[];
}

// ── Meta File Helpers ────────────────────────────────────────────────

const MISSION_META_FILENAME = "mission.json";

function metaPath(projectRoot: string): string {
	return join(projectDir(projectRoot), MISSION_META_FILENAME);
}

/** Load `.omp/mission.json`; return `{}` on any read/parse error. */
export function loadMissionMeta(projectRoot: string): MissionMeta {
	const path = metaPath(projectRoot);
	try {
		if (!existsSync(path)) return {};
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed as MissionMeta;
	} catch {
		return {};
	}
}

/**
 * Save `.omp/mission.json`, shallow-merging with existing content so
 * unrelated top-level keys survive.
 */
export function saveMissionMeta(projectRoot: string, meta: MissionMeta): void {
	const configDir = projectDir(projectRoot);
	mkdirSync(configDir, { recursive: true });
	const path = metaPath(projectRoot);

	let existing: MissionMeta = {};
	try {
		if (existsSync(path)) {
			const raw = readFileSync(path, "utf-8");
			const parsed = JSON.parse(raw);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				existing = parsed as MissionMeta;
			}
		}
	} catch {
		// Unreadable — start fresh but keep our keys
	}

	const merged = { ...existing, ...meta };
	writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
}

// ── Migration Registry ──────────────────────────────────────────────

export const MIGRATION_REGISTRY: Migration[] = [
	{
		id: "add-supervisor-local-template-v1",
		description: "Create agents/supervisor.md from template if missing",
		run(_projectRoot: string, pkgRoot: string, configRoot: string): string | null {
			const targetPath = join(configRoot, "agents", "supervisor.md");
			if (existsSync(targetPath)) return null;

			const templatePath = join(pkgRoot, "templates", "agents", "local", "supervisor.md");
			if (!existsSync(templatePath)) {
				throw new Error(
					`Migration template not found: ${templatePath}. ` +
						`This may indicate a packaging issue with @oh-my-pi/pi-missions.`,
				);
			}

			mkdirSync(dirname(targetPath), { recursive: true });
			copyFileSync(templatePath, targetPath);
			return `Created ${targetPath} from template`;
		},
	},
];

// ── Migration Runner ─────────────────────────────────────────────────

/**
 * Run all pending additive migrations.
 *
 * @param projectRoot  Project root directory.
 * @param pkgRoot      Override for pi-missions package root (defaults to `packageRoot()`).
 * @param configRoot   Override for config root (defaults to `.omp/` under projectRoot).
 */
export function runMigrations(projectRoot: string, pkgRoot?: string, configRoot?: string): MigrationRunResult {
	const resolvedPkgRoot = pkgRoot ?? packageRoot();
	const resolvedConfigRoot = configRoot ?? projectDir(projectRoot);

	const result: MigrationRunResult = {
		applied: [],
		skipped: [],
		errors: [],
		messages: [],
	};

	const meta = loadMissionMeta(projectRoot);
	const migrationState: MigrationState = meta.migrations ?? { applied: {} };

	let stateChanged = false;

	for (const migration of MIGRATION_REGISTRY) {
		if (migrationState.applied[migration.id]) {
			result.skipped.push(migration.id);
			continue;
		}

		try {
			const message = migration.run(projectRoot, resolvedPkgRoot, resolvedConfigRoot);
			migrationState.applied[migration.id] = { appliedAt: new Date().toISOString() };
			stateChanged = true;

			if (message) {
				result.applied.push(migration.id);
				result.messages.push(`📦 Migration: ${message}`);
			} else {
				result.skipped.push(migration.id);
			}
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			result.errors.push({ id: migration.id, error: errMsg });
		}
	}

	if (stateChanged) {
		try {
			saveMissionMeta(projectRoot, { ...meta, migrations: migrationState });
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			result.errors.push({
				id: "__state_save",
				error: `Failed to persist migration state: ${errMsg}`,
			});
		}
	}

	return result;
}
