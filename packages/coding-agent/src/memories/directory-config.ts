/**
 * `.omp-meta` directory sidecars.
 *
 * For every directory inside the memory root, an optional sidecar file
 * lives **next to** the directory (NOT inside it), named
 * `<dirname>.omp-meta`. Three properties this layout preserves:
 *
 *   - Policy is a single stat away — no directory enumeration required.
 *   - Renaming a directory pairs `<name>/` and `<name>.omp-meta` as
 *     siblings, no orphaned config files.
 *   - The directory's children stay clean of policy artifacts.
 *
 * A doc's effective config is resolved in three tiers:
 *
 *   1. Type defaults (per top-level bucket: memory/skill/design/reference).
 *   2. Walk the parent chain, merging non-null fields from any sidecar with
 *      `inheritToChildren: true`. Stop at the first parent that opts out or
 *      at the type root.
 *   3. Per-doc frontmatter wins — except `inheritInjectMode: true` re-opts
 *      into the parent's `injectMode`, and `inheritAiConfig: true` re-opts
 *      into the parent's `aiMaintained` / `readOnly`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { InjectMode, MemoryDocType } from "./document";

/** Sidecar file suffix. */
export const SIDECAR_SUFFIX = ".omp-meta";

/** Top-level type directories under the memory root. */
export const TYPE_DIRS: Readonly<Record<MemoryDocType, string>> = Object.freeze({
	memory: "memory",
	skill: "skill",
	design: "design",
	reference: "reference",
});

/** Raw shape of a `.omp-meta` sidecar file on disk. */
export interface DirectoryConfigFile {
	version?: number;
	summary?: string;
	injectMode?: InjectMode;
	/**
	 * When `true`, this sidecar's own `injectMode` is ignored and the dir
	 * inherits from its parent chain instead. Symmetric counterpart of the
	 * doc-level `inheritInjectMode` frontmatter flag.
	 */
	inheritInjectMode?: boolean;
	inheritToChildren?: boolean;
	aiMaintained?: boolean;
	/**
	 * When `true`, this sidecar's own `aiMaintained` is ignored and the dir
	 * inherits from its parent chain instead.
	 */
	inheritAiConfig?: boolean;
	explicitMaintenanceRules?: boolean;
	allowCreateDocuments?: boolean;
	allowCreateDirectories?: boolean;
	allowMoveDocuments?: boolean;
	allowMoveDirectories?: boolean;
	maintenanceRules?: string;
	externalSources?: unknown[];
	[key: string]: unknown;
}

/**
 * Fully-resolved effective config for a directory or document. All fields
 * are present after resolution (defaults are filled in).
 *
 * Gate semantics:
 *   - `readOnly: true` is the **hard** write block. Writes are refused.
 *   - `aiMaintained: false` is **descriptive/routing** — it does NOT refuse AI
 *     writes by itself. It surfaces as `requiresApproval: true` so callers
 *     (knowledge tools) can route writes through a user-approval flow.
 *   - The consolidator still uses `aiMaintained` as a routing discriminator:
 *     Phase-2 writes only to `aiMaintained: true` paths.
 */
export interface EffectiveDirectoryConfig {
	type: MemoryDocType;
	injectMode: InjectMode;
	aiMaintained: boolean;
	readOnly: boolean;
	/** Derived: `!aiMaintained && !readOnly`. Callers route writes through user approval when set. */
	requiresApproval: boolean;
	allowCreateDocuments: boolean;
	allowCreateDirectories: boolean;
	allowMoveDocuments: boolean;
	allowMoveDirectories: boolean;
	maintenanceRules?: string;
	summary?: string;
	externalSources: unknown[];
}

interface TypeDefault {
	aiMaintained: boolean;
	readOnly: boolean;
	injectMode: InjectMode;
	allowCreateDocuments: boolean;
	allowCreateDirectories: boolean;
	allowMoveDocuments: boolean;
	allowMoveDirectories: boolean;
}

const TYPE_DEFAULTS: Readonly<Record<MemoryDocType, TypeDefault>> = Object.freeze({
	memory: {
		aiMaintained: true,
		readOnly: false,
		injectMode: "none",
		allowCreateDocuments: true,
		allowCreateDirectories: true,
		allowMoveDocuments: true,
		allowMoveDirectories: true,
	},
	skill: {
		aiMaintained: true,
		readOnly: false,
		injectMode: "none",
		allowCreateDocuments: true,
		allowCreateDirectories: true,
		allowMoveDocuments: true,
		allowMoveDirectories: true,
	},
	design: {
		// User-authored direction; AI may write through user approval.
		// `requiresApproval` is derived from `aiMaintained: false` on the resolved
		// config; the knowledge tools route through the resolve protocol.
		aiMaintained: false,
		readOnly: false,
		injectMode: "path",
		allowCreateDocuments: true,
		allowCreateDirectories: true,
		allowMoveDocuments: false,
		allowMoveDirectories: false,
	},
	reference: {
		// Read-only external material; user drops in, AI never mutates.
		aiMaintained: false,
		readOnly: true,
		injectMode: "none",
		allowCreateDocuments: true,
		allowCreateDirectories: true,
		allowMoveDocuments: false,
		allowMoveDirectories: false,
	},
});

/**
 * Sidecar file path **next to** the directory.
 *
 *   memoryRoot/memory/topic/        → memoryRoot/memory/topic.omp-meta
 */
export function sidecarPathForDirectory(dirPath: string): string {
	const parent = path.dirname(dirPath);
	const name = path.basename(dirPath);
	return path.join(parent, `${name}${SIDECAR_SUFFIX}`);
}

/** Is this an `.omp-meta` sidecar file path? */
export function isSidecarPath(filePath: string): boolean {
	return path.basename(filePath).endsWith(SIDECAR_SUFFIX);
}

/**
 * Resolve a path to its `(type, typeRoot, relativeFromTypeRoot)` tuple, or
 * `undefined` if the path is not under any known type root.
 */
export function classifyMemoryPath(
	memoryRoot: string,
	absPath: string,
): { type: MemoryDocType; typeRoot: string; rel: string } | undefined {
	const root = path.resolve(memoryRoot);
	const target = path.resolve(absPath);
	for (const type of Object.keys(TYPE_DIRS) as MemoryDocType[]) {
		const typeRoot = path.join(root, TYPE_DIRS[type]);
		if (target === typeRoot) {
			return { type, typeRoot, rel: "" };
		}
		const prefix = `${typeRoot}${path.sep}`;
		if (target.startsWith(prefix)) {
			return { type, typeRoot, rel: target.slice(prefix.length) };
		}
	}
	return undefined;
}

/** Read and parse a `.omp-meta` sidecar; returns `undefined` if missing. */
export async function readSidecar(sidecarPath: string): Promise<DirectoryConfigFile | undefined> {
	let text: string;
	try {
		text = await Bun.file(sidecarPath).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	try {
		const parsed = YAML.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as DirectoryConfigFile;
		}
		return undefined;
	} catch (error) {
		logger.warn("Failed to parse .omp-meta sidecar", { path: sidecarPath, error: String(error) });
		return undefined;
	}
}

/** Serialize a sidecar config back to YAML. */
export function stringifySidecar(config: DirectoryConfigFile): string {
	return `${YAML.stringify(config).trimEnd()}\n`;
}

/**
 * Resolve the effective config for a directory by walking parent
 * sidecars up to the type root, merging fields from any sidecar with
 * `inheritToChildren: true`.
 *
 * `inheritToChildren: false` on an ancestor acts as a **wall**: descendants
 * below that ancestor see only type defaults from there on, regardless of
 * what farther-up ancestors set. The walled-off ancestor's own sidecar
 * still applies *to itself* — `inheritToChildren` governs descendants, not
 * the directory it lives in.
 *
 * `dirPath` MUST be the absolute path of the directory whose config we
 * want — for a doc, pass its parent directory.
 */
export async function resolveDirectoryConfig(
	memoryRoot: string,
	dirPath: string,
): Promise<EffectiveDirectoryConfig | undefined> {
	const classified = classifyMemoryPath(memoryRoot, dirPath);
	if (!classified) return undefined;

	const { type, typeRoot } = classified;
	const defaults = TYPE_DEFAULTS[type];

	// Walk from the type root *down* to `dirPath`, collecting sidecars in
	// order. The type root is included so bucket-level sidecars (e.g.
	// `memory.omp-meta`) can drive policy for the entire bucket and its
	// descendants. The directory's own sidecar (if any) is the most specific.
	const chain: string[] = [];
	let cursor = path.resolve(dirPath);
	const root = path.resolve(typeRoot);
	while (true) {
		chain.push(cursor);
		if (cursor === root) break;
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	chain.reverse();

	let injectMode = defaults.injectMode;
	let aiMaintained = defaults.aiMaintained;
	const readOnly = defaults.readOnly;
	let allowCreateDocuments = defaults.allowCreateDocuments;
	let allowCreateDirectories = defaults.allowCreateDirectories;
	let allowMoveDocuments = defaults.allowMoveDocuments;
	let allowMoveDirectories = defaults.allowMoveDirectories;
	let maintenanceRules: string | undefined;
	let summary: string | undefined;
	let externalSources: unknown[] = [];

	const resetToDefaults = (): void => {
		injectMode = defaults.injectMode;
		aiMaintained = defaults.aiMaintained;
		allowCreateDocuments = defaults.allowCreateDocuments;
		allowCreateDirectories = defaults.allowCreateDirectories;
		allowMoveDocuments = defaults.allowMoveDocuments;
		allowMoveDirectories = defaults.allowMoveDirectories;
		maintenanceRules = undefined;
		summary = undefined;
		externalSources = [];
	};

	const applySidecar = (sidecar: DirectoryConfigFile): void => {
		if (sidecar.injectMode !== undefined && sidecar.inheritInjectMode !== true) {
			injectMode = sidecar.injectMode;
		}
		if (sidecar.aiMaintained !== undefined && sidecar.inheritAiConfig !== true) {
			aiMaintained = sidecar.aiMaintained;
		}
		if (sidecar.allowCreateDocuments !== undefined) allowCreateDocuments = sidecar.allowCreateDocuments;
		if (sidecar.allowCreateDirectories !== undefined) allowCreateDirectories = sidecar.allowCreateDirectories;
		if (sidecar.allowMoveDocuments !== undefined) allowMoveDocuments = sidecar.allowMoveDocuments;
		if (sidecar.allowMoveDirectories !== undefined) allowMoveDirectories = sidecar.allowMoveDirectories;
		if (sidecar.maintenanceRules !== undefined) maintenanceRules = sidecar.maintenanceRules;
		if (sidecar.summary !== undefined) summary = sidecar.summary;
		if (Array.isArray(sidecar.externalSources)) externalSources = sidecar.externalSources;
		// readOnly is type-default driven; sidecars do not currently override it.
		// Doc-level frontmatter is the override surface for readOnly.
	};

	for (let i = 0; i < chain.length; i++) {
		const dir = chain[i];
		const sidecar = await readSidecar(sidecarPathForDirectory(dir));
		const isLast = i === chain.length - 1;

		if (isLast) {
			// The directory's own sidecar always applies to itself.
			if (sidecar) applySidecar(sidecar);
			continue;
		}

		if (!sidecar) continue;

		if (sidecar.inheritToChildren !== true) {
			// Wall: drop everything from above. The walled-off ancestor's
			// own overrides do NOT reach the descendant (they apply only
			// at the ancestor itself).
			resetToDefaults();
			continue;
		}

		applySidecar(sidecar);
	}

	return {
		type,
		injectMode,
		aiMaintained,
		readOnly,
		requiresApproval: !aiMaintained && !readOnly,
		allowCreateDocuments,
		allowCreateDirectories,
		allowMoveDocuments,
		allowMoveDirectories,
		maintenanceRules,
		summary,
		externalSources,
	};
}

/**
 * Resolve the effective per-doc config, honouring frontmatter overrides.
 *
 * `inheritInjectMode: true` on the doc re-opts into the parent's
 * `injectMode` even when the doc also specifies its own value. Likewise,
 * `inheritAiConfig: true` ignores the doc's own `aiMaintained` / `readOnly`
 * and inherits both from the parent — useful when a doc moves under a
 * directory whose policy should now win.
 */
export async function resolveDocConfig(
	memoryRoot: string,
	absDocPath: string,
	docFrontmatter: {
		injectMode?: InjectMode;
		inheritInjectMode?: boolean;
		readOnly?: boolean;
		aiMaintained?: boolean;
		inheritAiConfig?: boolean;
	},
): Promise<EffectiveDirectoryConfig | undefined> {
	const parent = path.dirname(absDocPath);
	const dirConfig = await resolveDirectoryConfig(memoryRoot, parent);
	if (!dirConfig) return undefined;

	const config: EffectiveDirectoryConfig = { ...dirConfig };
	if (!docFrontmatter.inheritAiConfig) {
		if (docFrontmatter.aiMaintained !== undefined) config.aiMaintained = docFrontmatter.aiMaintained;
		if (docFrontmatter.readOnly !== undefined) config.readOnly = docFrontmatter.readOnly;
	}
	if (!docFrontmatter.inheritInjectMode && docFrontmatter.injectMode !== undefined) {
		config.injectMode = docFrontmatter.injectMode;
	}
	config.requiresApproval = !config.aiMaintained && !config.readOnly;
	return config;
}

/**
 * Check whether a write to `absDocPath` is allowed. Returns the reason
 * string if blocked, or `undefined` if allowed.
 *
 * Gate semantics:
 *   - `readOnly: true` is the **hard** block (returns a refusal).
 *   - `allowCreateDocuments: false` blocks create intent.
 *   - `aiMaintained: false` does NOT refuse here. Inspect `requiresApproval`
 *     on the resolved config (via `resolveDocConfig`) to route writes through
 *     a user-approval flow.
 *
 * `intent` is one of:
 *   - `"create"` — the doc does not yet exist on disk
 *   - `"update"` — the doc exists and we want to rewrite it
 */
export async function checkWritePermission(
	memoryRoot: string,
	absDocPath: string,
	intent: "create" | "update",
	docFrontmatter: {
		injectMode?: InjectMode;
		inheritInjectMode?: boolean;
		readOnly?: boolean;
		aiMaintained?: boolean;
		inheritAiConfig?: boolean;
	} = {},
): Promise<string | undefined> {
	const config = await resolveDocConfig(memoryRoot, absDocPath, docFrontmatter);
	if (!config) return undefined; // outside taxonomy (e.g. legacy paths) — no gating

	if (config.readOnly) {
		return `target is read-only: ${absDocPath}`;
	}
	if (intent === "create" && !config.allowCreateDocuments) {
		return `directory denies new docs: ${path.dirname(absDocPath)}`;
	}
	return undefined;
}

/**
 * Check whether deleting a doc/dir at `absPath` is allowed.
 *
 * Same gate semantics as `checkWritePermission`: `readOnly` is the hard
 * block, `aiMaintained: false` is routing-only.
 */
export async function checkDeletePermission(
	memoryRoot: string,
	absPath: string,
	docFrontmatter: { aiMaintained?: boolean; readOnly?: boolean; inheritAiConfig?: boolean } = {},
): Promise<string | undefined> {
	const stat = await fs.stat(absPath).catch(() => undefined);
	if (!stat) return undefined;

	if (stat.isDirectory()) {
		const config = await resolveDirectoryConfig(memoryRoot, absPath);
		if (config?.readOnly) return `target is read-only: ${absPath}`;
		return undefined;
	}

	const config = await resolveDocConfig(memoryRoot, absPath, docFrontmatter);
	if (!config) return undefined;
	if (config.readOnly) return `target is read-only: ${absPath}`;
	return undefined;
}

/**
 * Rename a directory and its paired sidecar atomically. Either both move
 * or neither does (the sidecar move is best-effort, but we restore the
 * directory if the sidecar move fails).
 */
export async function renameDirectoryWithSidecar(sourceDir: string, destDir: string): Promise<void> {
	const sourceSidecar = sidecarPathForDirectory(sourceDir);
	const destSidecar = sidecarPathForDirectory(destDir);

	const sourceSidecarExists = await fs.stat(sourceSidecar).then(
		() => true,
		() => false,
	);

	await fs.rename(sourceDir, destDir);
	if (!sourceSidecarExists) return;

	try {
		await fs.rename(sourceSidecar, destSidecar);
	} catch (error) {
		// Roll back the directory move so the pair stays consistent.
		await fs.rename(destDir, sourceDir).catch(() => undefined);
		throw error;
	}
}

/** Return the type defaults (read-only) — useful for tests and seed authoring. */
export function getTypeDefaults(type: MemoryDocType): TypeDefault {
	return TYPE_DEFAULTS[type];
}
