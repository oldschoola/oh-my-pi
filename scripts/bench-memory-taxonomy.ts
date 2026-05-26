// Head-to-head benchmark: baseline (upstream/main) vs new four-bucket
// taxonomy. Both implementations run against identical scenarios that
// model what Phase-2 actually does in practice. We report:
//
//   - User-content preservation: bytes of user-authored files that
//     survived a consolidation pass that did NOT mention them. A
//     correct system should preserve 100%.
//   - Throughput: wall-clock per applyConsolidation call.
//
// The baseline is reimplemented inline because the original
// `applyConsolidation` is module-private; the body below matches
// `fb863a590:packages/coding-agent/src/memories/index.ts` byte-for-byte
// in behaviour.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyConsolidation } from "../packages/coding-agent/src/memories";

interface ConsolidationSkillFile {
	path: string;
	content: string;
}
interface ConsolidationSkill {
	name: string;
	content: string;
	scripts: ConsolidationSkillFile[];
	templates: ConsolidationSkillFile[];
	examples: ConsolidationSkillFile[];
}
interface ConsolidationInput {
	memoryMd: string;
	memorySummary: string;
	skills: ConsolidationSkill[];
	designDrafts: ConsolidationSkillFile[];
}

// ------- BASELINE (verbatim port of fb863a590 behaviour) -----------

async function listRelativeFiles(rootDir: string, prefix = ""): Promise<string[]> {
	const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
	const files: string[] = [];
	for (const entry of entries) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...(await listRelativeFiles(path.join(rootDir, entry.name), relative)));
			continue;
		}
		if (entry.isFile()) files.push(relative);
	}
	return files;
}

async function pruneEmptyDirectories(rootDir: string): Promise<void> {
	const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const child = path.join(rootDir, entry.name);
		await pruneEmptyDirectories(child);
		const childEntries = await fs.readdir(child).catch(() => []);
		if (childEntries.length === 0) {
			await fs.rm(child, { recursive: true, force: true });
		}
	}
}

async function applyConsolidationBaseline(memoryRoot: string, c: ConsolidationInput): Promise<void> {
	await fs.mkdir(memoryRoot, { recursive: true });
	await Bun.write(path.join(memoryRoot, "MEMORY.md"), `${c.memoryMd.trim()}\n`);
	await Bun.write(path.join(memoryRoot, "memory_summary.md"), `${c.memorySummary.trim()}\n`);
	const skillsDir = path.join(memoryRoot, "skills");
	await fs.mkdir(skillsDir, { recursive: true });
	const keep = new Set<string>();
	for (const skill of c.skills) {
		const dir = path.join(skillsDir, skill.name);
		keep.add(skill.name);
		await fs.mkdir(dir, { recursive: true });
		const files = new Map<string, string>();
		files.set("SKILL.md", `${skill.content.trim()}\n`);
		for (const item of skill.scripts)
			files.set(path.posix.join("scripts", item.path), `${item.content.trim()}\n`);
		for (const item of skill.templates)
			files.set(path.posix.join("templates", item.path), `${item.content.trim()}\n`);
		for (const item of skill.examples)
			files.set(path.posix.join("examples", item.path), `${item.content.trim()}\n`);
		for (const [rel, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			await Bun.write(path.join(dir, ...rel.split("/")), content);
		}
		const keepFiles = new Set(files.keys());
		const existingFiles = await listRelativeFiles(dir);
		for (const rel of existingFiles) {
			if (keepFiles.has(rel)) continue;
			await fs.rm(path.join(dir, ...rel.split("/")), { force: true });
		}
		await pruneEmptyDirectories(dir);
	}
	const dirs = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
	for (const dirent of dirs) {
		if (!dirent.isDirectory()) continue;
		if (keep.has(dirent.name)) continue;
		await fs.rm(path.join(skillsDir, dirent.name), { recursive: true, force: true });
	}
}

// ------- Scenarios -------------------------------------------------

interface Scenario {
	id: string;
	description: string;
	/**
	 * Pre-populate the memory root with user-authored content. Returns
	 * the unique "marker" substrings the test asserts must still appear
	 * somewhere in the tree after consolidation.
	 */
	seed: (memoryRoot: string) => Promise<{ markers: string[] }>;
	/** Consolidation input the model emits (does not mention user files). */
	consolidation: ConsolidationInput;
}

const noConsolidation: ConsolidationInput = {
	memoryMd: "ai-generated memory body",
	memorySummary: "ai-generated summary body",
	skills: [],
	designDrafts: [],
};

const scenarios: Scenario[] = [
	{
		id: "user-edited-memory-md",
		description: "User has hand-edited MEMORY.md with notes the model has never seen",
		async seed(root) {
			const p = path.join(root, "MEMORY.md");
			await fs.mkdir(root, { recursive: true });
			const marker = "The webhook secret rotates weekly";
			const body = `# Hand-curated facts\n\n- ${marker}.\n- Never call deploy.sh in CI.\n- Production DB lives in eu-west-1.\n`;
			await Bun.write(p, body);
			return { markers: [marker] };
		},
		consolidation: noConsolidation,
	},
	{
		id: "user-protected-skill",
		description: "User-owned skill with aiMaintained: false in frontmatter",
		async seed(root) {
			// Legacy `skills/` path so both impls see the same input.
			const p = path.join(root, "skills", "deploy-runbook", "SKILL.md");
			await fs.mkdir(path.dirname(p), { recursive: true });
			const marker = "My hand-curated runbook. Do not rewrite.";
			const body = `---\naiMaintained: false\n---\n# Deploy Runbook\n\n${marker}\n`;
			await Bun.write(p, body);
			return { markers: [marker] };
		},
		consolidation: noConsolidation,
	},
	{
		id: "user-design-notes",
		description: "User stores design notes; the consolidator never proposes drafts for them",
		async seed(root) {
			const a = path.join(root, "design", "rfc-001.md");
			const b = path.join(root, "design", "subsystems", "auth.md");
			await fs.mkdir(path.dirname(a), { recursive: true });
			await fs.mkdir(path.dirname(b), { recursive: true });
			const markerA = "Phase A → Phase B → Phase C";
			const markerB = "OIDC + WebAuthn fallback";
			await Bun.write(a, `# RFC 001 — Cutover plan\n\n${markerA}.\n`);
			await Bun.write(b, `# Auth subsystem\n\n${markerB}.\n`);
			return { markers: [markerA, markerB] };
		},
		consolidation: noConsolidation,
	},
	{
		id: "user-reference-material",
		description: "User curated reference material under reference/ — must never be touched",
		async seed(root) {
			const p = path.join(root, "reference", "vendor-api.md");
			await fs.mkdir(path.dirname(p), { recursive: true });
			const marker = "POST /v1/widgets {sku}";
			await Bun.write(p, `# Vendor API quickref\n\n- ${marker}\n- GET /v1/widgets/{id}\n`);
			return { markers: [marker] };
		},
		consolidation: noConsolidation,
	},
	{
		id: "mixed-cold-start",
		description: "Cold root, large consolidation (10 skills, 50 KB body) — throughput check",
		async seed() {
			return { markers: [] };
		},
		consolidation: {
			memoryMd: "x".repeat(25_000),
			memorySummary: "y".repeat(25_000),
			skills: Array.from({ length: 10 }, (_, i) => ({
				name: `skill-${i}`,
				content: `# Skill ${i}\n\n${"z".repeat(5_000)}`,
				scripts: [],
				templates: [],
				examples: [],
			})),
			designDrafts: [],
		},
	},
];

// ------- Driver ----------------------------------------------------

async function readPreservation(
	root: string,
	markers: string[],
): Promise<{ surviving: number; total: number }> {
	// Path-agnostic: the new impl migrates legacy paths under typed
	// buckets, so the marker should still show up somewhere even if the
	// file moved.
	const allFiles = await listAllFiles(root);
	const contents: string[] = [];
	for (const file of allFiles) {
		const text = await Bun.file(file)
			.text()
			.catch(() => undefined);
		if (text) contents.push(text);
	}
	let surviving = 0;
	let total = 0;
	for (const marker of markers) {
		const bytes = Buffer.byteLength(marker, "utf8");
		total += bytes;
		if (contents.some(c => c.includes(marker))) surviving += bytes;
	}
	return { surviving, total };
}

async function listAllFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) stack.push(full);
			else if (e.isFile()) out.push(full);
		}
	}
	return out;
}

interface Result {
	scenario: string;
	impl: "baseline" | "new";
	userBytes: number;
	preservedBytes: number;
	ms: number;
}

async function runScenario(scenario: Scenario, impl: "baseline" | "new"): Promise<Result> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `bench-mem-${impl}-`));
	try {
		const { markers } = await scenario.seed(root);

		const before = performance.now();
		if (impl === "baseline") {
			await applyConsolidationBaseline(root, scenario.consolidation);
		} else {
			await applyConsolidation(root, scenario.consolidation);
		}
		const elapsed = performance.now() - before;

		const { surviving, total } = await readPreservation(root, markers);
		return { scenario: scenario.id, impl, userBytes: total, preservedBytes: surviving, ms: elapsed };
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

function pct(n: number, d: number): string {
	if (d === 0) return "n/a";
	return `${((100 * n) / d).toFixed(1)}%`;
}

async function main() {
	const rows: Result[] = [];
	for (const s of scenarios) {
		for (const impl of ["baseline", "new"] as const) {
			// Warm + 3 timed runs; report best.
			await runScenario(s, impl);
			let best: Result | undefined;
			for (let i = 0; i < 3; i++) {
				const r = await runScenario(s, impl);
				if (!best || r.ms < best.ms) best = r;
			}
			rows.push(best!);
		}
	}

	console.log("scenario                          impl       userKB  preserved   ms");
	console.log("-".repeat(78));
	for (const r of rows) {
		const userKB = (r.userBytes / 1024).toFixed(2).padStart(7);
		const preserved = pct(r.preservedBytes, r.userBytes).padStart(9);
		const ms = r.ms.toFixed(1).padStart(6);
		console.log(`${r.scenario.padEnd(33)} ${r.impl.padEnd(9)} ${userKB}  ${preserved}  ${ms}`);
	}

	// Pairwise summary
	console.log("\nPreservation delta (new − baseline):");
	const byScen = new Map<string, { baseline: Result; new: Result }>();
	for (const r of rows) {
		const e = byScen.get(r.scenario) ?? ({} as { baseline: Result; new: Result });
		// biome-ignore lint/suspicious/noExplicitAny: dynamic write
		(e as any)[r.impl] = r;
		byScen.set(r.scenario, e);
	}
	let netDelta = 0;
	for (const [id, { baseline, new: nu }] of byScen) {
		if (baseline.userBytes === 0) {
			console.log(`  ${id.padEnd(33)} — no user content`);
			continue;
		}
		const delta = nu.preservedBytes - baseline.preservedBytes;
		netDelta += delta;
		const sign = delta >= 0 ? "+" : "";
		console.log(
			`  ${id.padEnd(33)} baseline=${pct(baseline.preservedBytes, baseline.userBytes).padStart(6)}  new=${pct(nu.preservedBytes, nu.userBytes).padStart(6)}  Δ=${sign}${delta}B`,
		);
	}
	console.log(`\nNet preserved-bytes delta: ${netDelta >= 0 ? "+" : ""}${netDelta}B`);
}

await main();
