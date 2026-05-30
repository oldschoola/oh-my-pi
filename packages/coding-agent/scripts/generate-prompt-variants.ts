#!/usr/bin/env bun
/**
 * Generator for the System Prompt Style mechanism.
 *
 * Walks the diff between the pre-gentle parent commit and HEAD, collects every
 * runtime prompt `.md` the gentle rewrite touched, then materializes per-style
 * variant trees and the registration TypeScript that wires them through
 * `prompt.registerPromptVariants`.
 *
 * For each gentle prompt at <pkg>/src/<rel>.md the generator produces:
 *   - <pkg>/src/_variants/default/<rel>.md   ← exact pre-gentle text
 *   - <pkg>/src/_variants/caveman/<rel>.md   ← authored caveman voice
 * and a single `<pkg>/src/prompts-variants.generated.ts` (coding-agent)
 *  / `<pkg>/src/compaction-variants.generated.ts` (agent) that static-imports
 * the gentle + default + caveman texts and registers them in one call.
 *
 * `default/` is always rewritten from git so accidental hand-edits cannot
 * drift. `caveman/` is preserved if it already exists (only seeded with the
 * default text on first creation) so authored caveman variants are never
 * clobbered. Pass `--reset-caveman` to overwrite caveman placeholders too.
 *
 * Re-run after rebasing onto a new gentle baseline:
 *   bun --cwd=packages/coding-agent run generate-prompt-variants
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { $ } from "bun";

// Anchors from the plan; both verified against the repo on 2026-05-30.
const PRE_GENTLE_COMMIT = "3f073b82d";
const GENTLE_COMMIT = "e7375d2c5";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

interface PackageSpec {
	/** Package name for error messages. */
	id: "coding-agent" | "agent";
	/** Path from repo root to the package's src/ directory. */
	srcDir: string;
	/** Path the variants tree is rooted at, relative to repo root. */
	variantsDir: string;
	/** Path of the generated registration TS file, relative to repo root. */
	registrationFile: string;
	/**
	 * Returns true if the path (relative to repo root) belongs to this
	 * package's runtime prompts.
	 */
	owns: (relPath: string) => boolean;
	/**
	 * Convert a repo-relative prompt path to (a) the path relative to the
	 * package's src/ (used in variant mirror layout) and (b) the import
	 * specifier used to reach the gentle file from the registration TS.
	 */
	rel: (relPath: string) => { mirror: string; gentleImport: string };
}

const PACKAGES: PackageSpec[] = [
	{
		id: "coding-agent",
		srcDir: "packages/coding-agent/src",
		variantsDir: "packages/coding-agent/src/_variants",
		registrationFile: "packages/coding-agent/src/prompts-variants.generated.ts",
		owns: rel => rel.startsWith("packages/coding-agent/src/"),
		rel: relPath => {
			const mirror = relPath.slice("packages/coding-agent/src/".length);
			// registrationFile sits at packages/coding-agent/src/, so it can
			// reach the gentle file with a relative `./` import.
			return { mirror, gentleImport: `./${mirror}` };
		},
	},
	{
		id: "agent",
		srcDir: "packages/agent/src",
		variantsDir: "packages/agent/src/_variants",
		registrationFile: "packages/agent/src/compaction-variants.generated.ts",
		owns: rel => rel.startsWith("packages/agent/src/"),
		rel: relPath => {
			const mirror = relPath.slice("packages/agent/src/".length);
			return { mirror, gentleImport: `./${mirror}` };
		},
	},
];

/** Paths the gentle rewrite touched that we explicitly do NOT treat as runtime prompts. */
const EXCLUDE_PREFIXES = [".omp/", "docs/", "packages/coding-agent/CHANGELOG.md", "README.md"];

function shouldIncludePath(relPath: string): boolean {
	if (!relPath.endsWith(".md")) return false;
	for (const ex of EXCLUDE_PREFIXES) {
		if (relPath.startsWith(ex)) return false;
	}
	return true;
}

async function listGentlePrompts(): Promise<string[]> {
	const result = await $`git diff --name-only ${PRE_GENTLE_COMMIT} ${GENTLE_COMMIT}`.cwd(REPO_ROOT).quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`git diff failed (${result.exitCode}): ${result.stderr.toString()}`);
	}
	const paths = result.stdout
		.toString()
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && shouldIncludePath(line));
	paths.sort();
	return paths;
}

async function readGitFile(rev: string, repoRelPath: string): Promise<string> {
	// `git show <rev>:<path>` is bytes-faithful for text blobs in the repo;
	// trailing newline behavior matches what the working-tree file has.
	const result = await $`git show ${`${rev}:${repoRelPath}`}`.cwd(REPO_ROOT).quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`git show ${rev}:${repoRelPath} failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString();
}

interface PromptEntry {
	pkg: PackageSpec;
	repoRelPath: string;
	mirror: string;
	gentleImport: string;
	defaultRelImport: string;
	cavemanRelImport: string;
	identifier: string;
}

function makeIdentifier(mirror: string, used: Set<string>): string {
	// Convert e.g. `prompts/tools/web-search.md` → `promptsToolsWebSearchMd`.
	// Suffix with the file's relative directory components if the bare basename
	// would collide (e.g. tools/read.md and memories/read-path.md ⇒ no clash,
	// but commit/prompts/file-observer-system.md vs commit/agentic/prompts/
	// system.md would). The collision avoidance below guarantees uniqueness.
	const cleaned = mirror.replace(/[^A-Za-z0-9]+/g, " ").trim();
	const parts = cleaned.split(" ");
	let id = parts
		.map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1)))
		.join("");
	if (!/^[a-z]/i.test(id)) id = `_${id}`;
	let candidate = id;
	let counter = 2;
	while (used.has(candidate)) {
		candidate = `${id}${counter++}`;
	}
	used.add(candidate);
	return candidate;
}

async function ensureDir(absDir: string): Promise<void> {
	await fs.mkdir(absDir, { recursive: true });
}

async function fileExists(absPath: string): Promise<boolean> {
	try {
		await fs.access(absPath);
		return true;
	} catch {
		return false;
	}
}

async function writeIfChanged(absPath: string, content: string): Promise<boolean> {
	try {
		const existing = await Bun.file(absPath).text();
		if (existing === content) return false;
	} catch {
		// fall through to write
	}
	await ensureDir(path.dirname(absPath));
	await Bun.write(absPath, content);
	return true;
}

interface GenerateOptions {
	resetCaveman: boolean;
}

async function generate(options: GenerateOptions): Promise<void> {
	const prompts = await listGentlePrompts();
	console.log(`Found ${prompts.length} gentle-touched prompt files`);

	const entriesByPkg = new Map<PackageSpec, PromptEntry[]>();
	const identifierUsage = new Map<PackageSpec, Set<string>>();
	const seenMirrors = new Map<PackageSpec, Map<string, string>>();

	for (const repoRelPath of prompts) {
		const pkg = PACKAGES.find(p => p.owns(repoRelPath));
		if (!pkg) {
			console.warn(`SKIP no package owns ${repoRelPath}`);
			continue;
		}
		const { mirror, gentleImport } = pkg.rel(repoRelPath);

		// Defensive: catch two source paths colliding to the same mirror.
		let seen = seenMirrors.get(pkg);
		if (!seen) {
			seen = new Map();
			seenMirrors.set(pkg, seen);
		}
		const prior = seen.get(mirror);
		if (prior && prior !== repoRelPath) {
			throw new Error(`Mirror collision in ${pkg.id}: ${prior} and ${repoRelPath} both map to ${mirror}`);
		}
		seen.set(mirror, repoRelPath);

		let usage = identifierUsage.get(pkg);
		if (!usage) {
			usage = new Set();
			identifierUsage.set(pkg, usage);
		}
		const identifier = makeIdentifier(mirror, usage);

		// Import specifiers in the generated TS file are relative to its
		// location at <pkg>/src/<registration>.ts. `path.posix.join` drops
		// leading `./`, which Bun would then resolve as a bare package
		// specifier — keep the explicit prefix.
		const mirrorPosix = mirror.replace(/\\/g, "/");
		const defaultRel = `./_variants/default/${mirrorPosix}`;
		const cavemanRel = `./_variants/caveman/${mirrorPosix}`;

		const defaultAbs = path.join(REPO_ROOT, pkg.variantsDir, "default", mirror);
		const cavemanAbs = path.join(REPO_ROOT, pkg.variantsDir, "caveman", mirror);
		const defaultText = await readGitFile(PRE_GENTLE_COMMIT, repoRelPath);
		await writeIfChanged(defaultAbs, defaultText);
		// Caveman defaults to the same as default the first time; authoring
		// rewrites it later. Never clobber an existing caveman file unless
		// --reset-caveman was passed.
		if (options.resetCaveman || !(await fileExists(cavemanAbs))) {
			await writeIfChanged(cavemanAbs, defaultText);
		}

		const list = entriesByPkg.get(pkg) ?? [];
		list.push({
			pkg,
			repoRelPath,
			mirror,
			gentleImport: gentleImport.replace(/\\/g, "/"),
			defaultRelImport: defaultRel,
			cavemanRelImport: cavemanRel,
			identifier,
		});
		entriesByPkg.set(pkg, list);
	}

	for (const pkg of PACKAGES) {
		const entries = entriesByPkg.get(pkg) ?? [];
		entries.sort((a, b) => a.mirror.localeCompare(b.mirror));
		const ts = renderRegistrationFile(pkg, entries);
		const abs = path.join(REPO_ROOT, pkg.registrationFile);
		await writeIfChanged(abs, ts);
		console.log(`Wrote ${pkg.registrationFile} (${entries.length} prompts)`);
	}
}

function renderRegistrationFile(_pkg: PackageSpec, entries: PromptEntry[]): string {
	const header = [
		"// AUTOGENERATED by packages/coding-agent/scripts/generate-prompt-variants.ts",
		"// Do not edit by hand. Re-run the generator to refresh.",
		"//",
		`// Source baseline: gentle commit text (current source files).`,
		`// Pre-gentle baseline: commit ${PRE_GENTLE_COMMIT}.`,
		`// Caveman baseline: hand-authored in _variants/caveman/.`,
		"",
		// Import the prompt module directly rather than via the `pi-utils`
		// barrel — the barrel re-exports `procmgr`/`ptree`, which load the
		// `@oh-my-pi/pi-natives` N-API addon. Pulling natives in just to
		// register a variant map forces every consumer (including tests)
		// to have a built native binary on hand. The submodule import has
		// no native dependency.
		'import { registerPromptVariants } from "@oh-my-pi/pi-utils/prompt";',
		"",
	].join("\n");

	const importLines: string[] = [];
	for (const e of entries) {
		importLines.push(`import gentle_${e.identifier} from "${e.gentleImport}" with { type: "text" };`);
		importLines.push(`import default_${e.identifier} from "${e.defaultRelImport}" with { type: "text" };`);
		importLines.push(`import caveman_${e.identifier} from "${e.cavemanRelImport}" with { type: "text" };`);
	}

	const registrationBody = entries
		.map(
			e =>
				`\t[gentle_${e.identifier}, { default: default_${e.identifier}, caveman: caveman_${e.identifier} }] as const,`,
		)
		.join("\n");

	const footer = [
		"",
		`// ${entries.length} prompt${entries.length === 1 ? "" : "s"} registered.`,
		"registerPromptVariants([",
		registrationBody,
		"]);",
		"",
	].join("\n");

	return `${header}${importLines.join("\n")}\n${footer}`;
}

const args = process.argv.slice(2);
const options: GenerateOptions = {
	resetCaveman: args.includes("--reset-caveman"),
};

await generate(options);
