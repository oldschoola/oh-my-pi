import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { getMemoryRoot } from "../memories";
import { AgentRegistry } from "../registry/agent-registry";
import { validateRelativePath } from "./skill-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

const DEFAULT_MEMORY_FILE = "memory/memory_summary.md";
const LEGACY_DEFAULT_MEMORY_FILE = "memory_summary.md";
const MEMORY_NAMESPACE = "root";

/**
 * Returns alternative paths under `memoryRoot` to try after the primary
 * resolution missed. Mirrors the layout migration: requests for old-shape
 * paths fall through to new-shape paths and vice versa.
 */
function legacyRedirectsFor(targetPath: string, memoryRoot: string): string[] {
	const rel = path.relative(memoryRoot, targetPath).split(path.sep).join("/");
	if (!rel || rel.startsWith("..")) return [];

	// New shape primary → legacy fallback
	if (rel === "memory/memory_summary.md") {
		return [path.join(memoryRoot, "memory_summary.md")];
	}
	if (rel === "memory/MEMORY.md") {
		return [path.join(memoryRoot, "MEMORY.md")];
	}
	if (rel.startsWith("skill/")) {
		return [path.join(memoryRoot, "skills", ...rel.slice("skill/".length).split("/"))];
	}

	// Legacy primary → new-shape fallback
	if (rel === "memory_summary.md") {
		return [path.join(memoryRoot, "memory", "memory_summary.md")];
	}
	if (rel === "MEMORY.md") {
		return [path.join(memoryRoot, "memory", "MEMORY.md")];
	}
	if (rel.startsWith("skills/")) {
		return [path.join(memoryRoot, "skill", ...rel.slice("skills/".length).split("/"))];
	}
	return [];
}

/**
 * Snapshot of memory roots for every registered session, deduped.
 * Each session has its own cwd (possibly a worktree), so subagents and main
 * may see different roots.
 */
export function memoryRootsFromRegistry(): string[] {
	const agentDir = getAgentDir();
	const roots: string[] = [];
	for (const ref of AgentRegistry.global().list()) {
		const sm = ref.session?.sessionManager;
		if (!sm) continue;
		const root = getMemoryRoot(agentDir, sm.getCwd());
		if (root && !roots.includes(root)) roots.push(root);
	}
	return roots;
}

function ensureWithinRoot(targetPath: string, rootPath: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error("memory:// URL escapes memory root");
	}
}

/**
 * Resolve a memory:// URL to an absolute filesystem path under memory root.
 */
export function resolveMemoryUrlToPath(url: InternalUrl, memoryRoot: string): string {
	const namespace = url.rawHost || url.hostname;
	if (!namespace) {
		throw new Error("memory:// URL requires a namespace: memory://root");
	}
	if (namespace !== MEMORY_NAMESPACE) {
		throw new Error(`Unknown memory namespace: ${namespace}. Supported: ${MEMORY_NAMESPACE}`);
	}

	const rawPathname = url.rawPathname ?? url.pathname;
	const hasPath = rawPathname && rawPathname !== "/" && rawPathname !== "";
	if (!hasPath) {
		// Default file is the new-shape summary. Back-compat fallback happens
		// in tryResolveInRoot: if the new path is missing, the legacy path is
		// tried.
		return path.resolve(memoryRoot, DEFAULT_MEMORY_FILE);
	}
	let relativePath: string;
	try {
		relativePath = decodeURIComponent(rawPathname.slice(1));
	} catch {
		throw new Error(`Invalid URL encoding in memory:// path: ${url.href}`);
	}

	validateRelativePath(relativePath, "memory");

	return path.resolve(memoryRoot, relativePath);
}

async function tryResolveInRoot(url: InternalUrl, memoryRoot: string): Promise<InternalResource | undefined> {
	const resolved = path.resolve(memoryRoot);
	let resolvedRoot: string;
	try {
		resolvedRoot = await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}

	const targetPath = resolveMemoryUrlToPath(url, resolvedRoot);
	ensureWithinRoot(targetPath, resolvedRoot);

	const parentDir = path.dirname(targetPath);
	try {
		const realParent = await fs.realpath(parentDir);
		ensureWithinRoot(realParent, resolvedRoot);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	let realTargetPath: string;
	try {
		realTargetPath = await fs.realpath(targetPath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		// Primary missed — walk legacy/new fallbacks before giving up.
		const fallbacks = legacyRedirectsFor(targetPath, resolvedRoot);
		let fallbackResolved: string | undefined;
		for (const fallback of fallbacks) {
			ensureWithinRoot(fallback, resolvedRoot);
			try {
				fallbackResolved = await fs.realpath(fallback);
				break;
			} catch (innerErr) {
				if (!isEnoent(innerErr)) throw innerErr;
			}
		}
		if (!fallbackResolved) {
			// Bare `memory://root` with no explicit path and nothing on disk:
			// some callers depend on this missing → undefined contract.
			const rawPathname = url.rawPathname ?? url.pathname;
			const hasPath = rawPathname && rawPathname !== "/" && rawPathname !== "";
			if (!hasPath) {
				// Try legacy default too — `tryResolveInRoot` returns undefined,
				// the handler then raises a clear error.
				const legacyDefault = path.resolve(resolvedRoot, LEGACY_DEFAULT_MEMORY_FILE);
				try {
					fallbackResolved = await fs.realpath(legacyDefault);
				} catch (legacyErr) {
					if (!isEnoent(legacyErr)) throw legacyErr;
				}
			}
		}
		if (!fallbackResolved) return undefined;
		realTargetPath = fallbackResolved;
	}

	ensureWithinRoot(realTargetPath, resolvedRoot);

	const stat = await fs.stat(realTargetPath);
	if (!stat.isFile()) {
		throw new Error(`memory:// URL must resolve to a file: ${url.href}`);
	}

	const content = await Bun.file(realTargetPath).text();
	const ext = path.extname(realTargetPath).toLowerCase();
	// .md → text/markdown; .omp-meta / .yaml / .yml / everything else →
	// text/plain (the InternalResource union does not currently include
	// text/yaml; consumers can detect YAML by extension).
	const contentType: InternalResource["contentType"] = ext === ".md" ? "text/markdown" : "text/plain";

	return {
		url: url.href,
		content,
		contentType,
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: realTargetPath,
		notes: [],
	};
}

/**
 * Protocol handler for memory:// URLs.
 *
 * Walks every active session's memory root. Worktree-based subagents have
 * their own root; first one containing the file wins. Parent and subagent
 * sharing a cwd see the same file regardless of order.
 */
export class MemoryProtocolHandler implements ProtocolHandler {
	readonly scheme = "memory";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const roots = memoryRootsFromRegistry();

		if (roots.length === 0) {
			throw new Error(
				"Memory artifacts are not available for this project yet. Run a session with memories enabled first.",
			);
		}

		let anyExists = false;
		for (const root of roots) {
			try {
				await fs.stat(root);
				anyExists = true;
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
			const result = await tryResolveInRoot(url, root);
			if (result) return result;
		}

		if (!anyExists) {
			throw new Error(
				"Memory artifacts are not available for this project yet. Run a session with memories enabled first.",
			);
		}

		throw new Error(`Memory file not found: ${url.href}`);
	}
}
