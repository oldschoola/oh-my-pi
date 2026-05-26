/**
 * Protocol handler for `knowledge://` URLs.
 *
 * Surfaces the four-bucket knowledge taxonomy directly to agents over the
 * shared internal-URL plumbing. URL grammar:
 *
 *   knowledge://<type>[/<path>][?part=body|summary|full][&frontmatter=1]
 *
 * `<type>` ∈ `memory | skill | design | reference`. `<path>` is the
 * type-root-relative document path; the `.md` suffix is auto-appended when
 * absent so the slug form (`knowledge://memory/foo`) matches the slash
 * command `/knowledge:memory/foo`.
 *
 * Selectors:
 *   - `?frontmatter=1` — emit the YAML frontmatter head only.
 *   - `?part=body`     — body region (between `omp:body` markers; falls
 *                        back to frontmatter-stripped content).
 *   - `?part=summary`  — frontmatter `summary` or the `## Summary` section.
 *   - `?part=full`     — raw bytes (default; also the fallback for unknown
 *                        `part` values).
 *
 * `frontmatter=1` wins over `part`. Sidecars (`*.omp-meta`) and non-`.md`
 * paths are refused; use `memory://` for sidecars.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { isSidecarPath, TYPE_DIRS } from "../memories/directory-config";
import type { MemoryDocType } from "../memories/document";
import { parseMemoryDoc } from "../memories/document";
import { extractSummarySection } from "../memories/knowledge-ops";
import { memoryRootsFromRegistry } from "./memory-protocol";
import { validateRelativePath } from "./skill-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

const KNOWN_TYPES = Object.keys(TYPE_DIRS) as MemoryDocType[];
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\n---\r?\n/;
const BODY_MARKER_LINE_RE = /^[ \t]*<!--\s*omp:body:(?:start|end)\s*-->[ \t]*\r?\n?/gm;

type KnowledgePart = "full" | "body" | "summary";

interface KnowledgeUrlParts {
	type: MemoryDocType;
	relFromTypeRoot: string;
	frontmatterOnly: boolean;
	part: KnowledgePart;
}

function parsePart(value: string | null): KnowledgePart {
	if (value === "body" || value === "summary" || value === "full") return value;
	return "full";
}

function parseFrontmatterFlag(value: string | null): boolean {
	if (value === null) return false;
	const lowered = value.toLowerCase();
	return lowered === "1" || lowered === "true";
}

function parseKnowledgeUrl(url: InternalUrl): KnowledgeUrlParts {
	const rawType = (url.rawHost || url.hostname).toLowerCase();
	if (!rawType) {
		throw new Error("knowledge:// URL requires a type bucket: knowledge://<type>/<doc>.md");
	}
	const type = rawType as MemoryDocType;
	if (!KNOWN_TYPES.includes(type)) {
		throw new Error(`Unknown knowledge type: ${rawType}. Supported: ${KNOWN_TYPES.join(", ")}`);
	}

	const rawPathname = url.rawPathname ?? url.pathname;
	const hasPath = rawPathname && rawPathname !== "/" && rawPathname !== "";
	if (!hasPath) {
		throw new Error(`knowledge:// requires a path: knowledge://${type}/<doc>.md`);
	}

	let relativePath: string;
	try {
		relativePath = decodeURIComponent(rawPathname.slice(1));
	} catch {
		throw new Error(`Invalid URL encoding in knowledge:// path: ${url.href}`);
	}
	if (!relativePath) {
		throw new Error(`knowledge:// requires a path: knowledge://${type}/<doc>.md`);
	}

	validateRelativePath(relativePath, "knowledge");

	if (relativePath.split("/").some(seg => isSidecarPath(seg.toLowerCase()))) {
		throw new Error(`knowledge:// only serves .md documents, not .omp-meta sidecars: ${url.href}`);
	}

	const ext = path.extname(relativePath).toLowerCase();
	if (ext === "") {
		relativePath += ".md";
	} else if (ext !== ".md") {
		throw new Error(`knowledge:// only serves .md documents: ${url.href}`);
	}

	return {
		type,
		relFromTypeRoot: relativePath,
		frontmatterOnly: parseFrontmatterFlag(url.searchParams.get("frontmatter")),
		part: parsePart(url.searchParams.get("part")),
	};
}

interface TransformOutput {
	content: string;
	contentType: InternalResource["contentType"];
	notes: string[];
}

function transformContent(raw: string, parts: KnowledgeUrlParts): TransformOutput {
	if (parts.frontmatterOnly) {
		const match = raw.match(FRONTMATTER_RE);
		if (!match) {
			return { content: "", contentType: "text/plain", notes: ["no frontmatter present"] };
		}
		return { content: match[0], contentType: "text/plain", notes: [] };
	}

	switch (parts.part) {
		case "body": {
			const doc = parseMemoryDoc(raw);
			if (doc.hasBodyMarkers) {
				return { content: doc.body.trim(), contentType: "text/markdown", notes: [] };
			}
			// Marker-less fallback: strip frontmatter and any dangling
			// marker lines (one-sided start/end markers from a partial
			// write or hand-edit). Operate on the CRLF-normalized text
			// so the regex behavior is uniform across line-endings.
			const stripped = doc.raw.replace(FRONTMATTER_RE, "").replace(BODY_MARKER_LINE_RE, "").trim();
			return { content: stripped, contentType: "text/markdown", notes: [] };
		}
		case "summary": {
			const doc = parseMemoryDoc(raw);
			const fmSummary = typeof doc.frontmatter.summary === "string" ? doc.frontmatter.summary.trim() : "";
			const summary = fmSummary || extractSummarySection(raw);
			if (!summary) {
				return { content: "", contentType: "text/markdown", notes: ["no summary present"] };
			}
			return { content: summary, contentType: "text/markdown", notes: [] };
		}
		default:
			return { content: raw, contentType: "text/markdown", notes: [] };
	}
}

async function tryResolveInRoot(
	url: InternalUrl,
	parts: KnowledgeUrlParts,
	memoryRoot: string,
): Promise<InternalResource | undefined> {
	const resolvedRoot = await fs.realpath(memoryRoot).catch(error => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!resolvedRoot) return undefined;

	const typeRoot = path.join(resolvedRoot, TYPE_DIRS[parts.type]);
	const targetPath = path.resolve(typeRoot, ...parts.relFromTypeRoot.split("/"));

	if (targetPath !== typeRoot && !targetPath.startsWith(`${typeRoot}${path.sep}`)) {
		throw new Error("knowledge:// URL escapes type root");
	}

	let realTargetPath: string;
	try {
		realTargetPath = await fs.realpath(targetPath);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}

	// Defense in depth: resolve the type root separately and require the
	// real target stays under it. If the type root itself is missing on
	// disk, treat this memory root as not carrying this bucket and bail —
	// NEVER fall back to the memory root as the perimeter (would silently
	// widen the check from one bucket to all four).
	let realTypeRoot: string;
	try {
		realTypeRoot = await fs.realpath(typeRoot);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	// If the type root itself is a symlink that redirects to a different
	// bucket (e.g. `memory/` -> `skill/`), `realTypeRoot` no longer points
	// at the canonical bucket directory. Refuse so a single misplaced
	// symlink cannot launder cross-bucket reads through the protocol.
	if (realTypeRoot !== typeRoot) {
		throw new Error("knowledge:// URL escapes type root");
	}
	if (realTargetPath !== realTypeRoot && !realTargetPath.startsWith(`${realTypeRoot}${path.sep}`)) {
		throw new Error("knowledge:// URL escapes type root");
	}

	// Single-fd open guarantees the stat and read see the same inode,
	// closing the realpath→stat→read TOCTOU window.
	let raw: string;
	const fh = await fs.open(realTargetPath, "r");
	try {
		const stat = await fh.stat();
		if (!stat.isFile()) {
			throw new Error(`knowledge:// URL must resolve to a file: ${url.href}`);
		}
		raw = await fh.readFile("utf-8");
	} finally {
		await fh.close();
	}

	const { content, contentType, notes } = transformContent(raw, parts);

	return {
		url: url.href,
		content,
		contentType,
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: realTargetPath,
		notes,
	};
}

/**
 * Protocol handler for `knowledge://` URLs. Walks every active session's
 * memory root (same semantics as `memory://`) and serves the first hit.
 */
export class KnowledgeProtocolHandler implements ProtocolHandler {
	readonly scheme = "knowledge";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const parts = parseKnowledgeUrl(url);
		const roots = memoryRootsFromRegistry();

		if (roots.length === 0) {
			throw new Error(
				"Knowledge artifacts are not available for this project yet. Run a session with memories enabled first.",
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
			const result = await tryResolveInRoot(url, parts, root);
			if (result) return result;
		}

		if (!anyExists) {
			throw new Error(
				"Knowledge artifacts are not available for this project yet. Run a session with memories enabled first.",
			);
		}

		throw new Error(`Knowledge document not found: ${url.href}`);
	}
}
