/**
 * Built-in seed docs and directory seeds.
 *
 * On first session (or whenever `MEMORY_BUILTIN_SEED_VERSION` bumps), seeds
 * are materialized under `memory_root/memory/`:
 *
 *   - **Doc seeds** create a markdown file with frontmatter + body markers.
 *     On a version bump, the frontmatter, summary, and maintenance rules
 *     are refreshed in-place while the body bytes between markers survive.
 *   - **Directory seeds** create an empty directory plus an `.omp-meta`
 *     sidecar carrying inject mode, summary, and maintenance rules. The
 *     directory's children are written by the AI as it explores.
 *
 * In both cases, user customization is preserved:
 *   - A doc with stripped body markers is treated as user-owned (no touch).
 *   - A sidecar with `explicitMaintenanceRules: true` keeps its
 *     user-customized rules across refreshes.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { type DirectoryConfigFile, readSidecar, sidecarPathForDirectory, stringifySidecar } from "./directory-config";
import {
	buildMemoryDoc,
	deriveDocId,
	type InjectMode,
	MEMORY_BUILTIN_SEED_VERSION,
	type MemoryDocFrontmatter,
	parseMemoryDoc,
} from "./document";

/** Common fields shared by every seed kind. */
interface BuiltinSeedCommon {
	/** Slug relative to `memory/` (filename for docs, dirname for directories). */
	name: string;
	title: string;
	summary: string;
	injectMode: InjectMode;
	maintenanceRules: readonly string[];
}

interface BuiltinDocSeed extends BuiltinSeedCommon {
	kind: "doc";
	initialBody: string;
}

interface BuiltinDirectorySeed extends BuiltinSeedCommon {
	kind: "directory";
}

type BuiltinSeedSpec = BuiltinDocSeed | BuiltinDirectorySeed;

/**
 * The embedded seed catalog. Edit a spec → bump
 * `MEMORY_BUILTIN_SEED_VERSION` in `document.ts` so existing seeds refresh.
 */
const SEEDS: readonly BuiltinSeedSpec[] = [
	{
		kind: "doc",
		name: "user-preference.md",
		title: "User Preferences",
		summary: "Durable, user-stated preferences the agent must respect across sessions.",
		injectMode: "rule",
		maintenanceRules: [
			"Capture only explicit user-stated preferences, not inferred defaults.",
			"Phrase each entry as an imperative rule the agent will follow.",
			"Drop any rule the user contradicts; replace, do not append.",
			"Keep rules orthogonal — split compound preferences into separate lines.",
		],
		initialBody:
			"<!-- No preferences captured yet. The consolidator fills this section as the user states preferences. -->",
	},
	{
		kind: "doc",
		name: "project-mistake-note.md",
		title: "Project Mistake Notes",
		summary: "Patterns of failure observed in this project and the resolutions that fixed them.",
		injectMode: "full",
		maintenanceRules: [
			"Record each mistake as `Symptom → Root cause → Fix` so the next run can pattern-match.",
			"Prefer resolved failures with verified fixes; drop entries that turned out to be no-ops.",
			"Cite the file path or callsite involved when relevant.",
			"Consolidate near-duplicate entries; do not let the list grow unbounded.",
		],
		initialBody: "<!-- No mistake notes captured yet. The consolidator records resolved failures here. -->",
	},
	{
		kind: "directory",
		name: "project-understanding",
		title: "Project Understanding",
		summary:
			"Cached, AI-maintained understanding of the project layout: directory roles, module boundaries, ownership notes, and structural shortcuts learned during exploration.",
		// path-mode keeps the index light: only the directory + child titles
		// surface in injection, never their bodies.
		injectMode: "path",
		maintenanceRules: [
			"Capture durable structural facts: directory roles, module boundaries, ownership.",
			"One topic per file; nest sub-areas as child directories.",
			"Drop entries the codebase contradicts. Current code wins; never let the cache drift.",
			"Prefer concise paragraphs over exhaustive listings — link to the code paths that prove the claim.",
		],
	},
];

/**
 * Ensure every built-in seed exists under `memory_root/memory/`.
 *
 * Doc seeds:
 *   - Missing file → create with frontmatter + body markers.
 *   - Existing file with older `seedVersion` → refresh non-body regions.
 *   - Existing file with stripped body markers → leave alone (user-owned).
 *
 * Directory seeds:
 *   - Missing dir → create dir + `.omp-meta` sidecar with the seed payload.
 *   - Existing dir without sidecar → write the sidecar.
 *   - Existing sidecar with older `seedVersion` → refresh, but never
 *     overwrite a sidecar carrying `explicitMaintenanceRules: true`
 *     (treat the user's edits as ownership).
 */
export async function seedBuiltinDocs(memoryRoot: string): Promise<void> {
	const memoryDir = path.join(memoryRoot, "memory");
	await fs.mkdir(memoryDir, { recursive: true });

	for (const seed of SEEDS) {
		if (seed.kind === "doc") {
			await seedDoc(memoryDir, seed);
		} else {
			await seedDirectory(memoryDir, seed);
		}
	}
}

async function seedDoc(memoryDir: string, seed: BuiltinDocSeed): Promise<void> {
	const absPath = path.join(memoryDir, seed.name);
	const relative = path.posix.join("memory", seed.name);

	let existing: string | undefined;
	try {
		existing = await Bun.file(absPath).text();
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to read built-in seed doc", { path: absPath, error: String(error) });
			return;
		}
	}

	if (existing === undefined) {
		const content = buildMemoryDoc({
			frontmatter: buildSeedFrontmatter(seed, relative),
			title: seed.title,
			summary: seed.summary,
			maintenanceRules: seed.maintenanceRules,
			body: seed.initialBody,
		});
		await Bun.write(absPath, content);
		return;
	}

	const doc = parseMemoryDoc(existing);
	const recordedVersion = typeof doc.frontmatter.seedVersion === "number" ? doc.frontmatter.seedVersion : 0;
	if (recordedVersion >= MEMORY_BUILTIN_SEED_VERSION) return;
	if (!doc.hasBodyMarkers) return; // user stripped markers — they own it now

	const refreshed = buildMemoryDoc({
		frontmatter: buildSeedFrontmatter(seed, relative, doc.frontmatter),
		title: seed.title,
		summary: seed.summary,
		maintenanceRules: seed.maintenanceRules,
		body: doc.body.trim(),
	});
	await Bun.write(absPath, refreshed);
}

async function seedDirectory(memoryDir: string, seed: BuiltinDirectorySeed): Promise<void> {
	const dir = path.join(memoryDir, seed.name);
	const sidecarPath = sidecarPathForDirectory(dir);
	await fs.mkdir(dir, { recursive: true });

	const existing = await readSidecar(sidecarPath);
	const recordedVersion = typeof existing?.seedVersion === "number" ? existing.seedVersion : 0;
	if (existing && recordedVersion >= MEMORY_BUILTIN_SEED_VERSION) return;
	// Preserve user-customized rules; only refresh the descriptive fields.
	const preserveRules = existing?.explicitMaintenanceRules === true;
	const sidecar: DirectoryConfigFile = {
		...(existing ?? {}),
		version: 1,
		summary: seed.summary,
		injectMode: seed.injectMode,
		inheritToChildren: true,
		aiMaintained: existing?.aiMaintained ?? true,
		seedVersion: MEMORY_BUILTIN_SEED_VERSION,
		maintenanceRules: preserveRules
			? existing?.maintenanceRules
			: seed.maintenanceRules.map(rule => `- ${rule}`).join("\n"),
		explicitMaintenanceRules: preserveRules,
	};
	await Bun.write(sidecarPath, stringifySidecar(sidecar));
}

function buildSeedFrontmatter(
	seed: BuiltinDocSeed,
	relative: string,
	existing?: MemoryDocFrontmatter,
): MemoryDocFrontmatter {
	const now = Math.floor(Date.now() / 1000);
	const createdAt = typeof existing?.createdAt === "number" ? existing.createdAt : now;
	return {
		id: deriveDocId(relative),
		type: "memory",
		path: relative,
		title: seed.title,
		injectMode: seed.injectMode,
		inheritInjectMode: false,
		inheritAiConfig: false,
		summaryEnabled: true,
		aiMaintained: true,
		readOnly: false,
		explicitMaintenanceRules: true,
		seedVersion: MEMORY_BUILTIN_SEED_VERSION,
		createdAt,
		updatedAt: now,
	};
}
