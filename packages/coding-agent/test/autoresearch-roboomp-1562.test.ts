import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { createBrowserDashboardController } from "../src/autoresearch/browser-dashboard";
import { compactJsonl } from "../src/autoresearch/compaction";
import {
	findLatestConfigEntry,
	JSONL_FILENAME,
	type JsonlEntry,
	readJsonlEntries,
	reconstructStateFromJsonl,
} from "../src/autoresearch/jsonl";
import { createSessionRuntime } from "../src/autoresearch/state";
import { closeAllAutoresearchStorages } from "../src/autoresearch/storage";
import { createInitExperimentTool } from "../src/autoresearch/tools/init-experiment";
import { createLogExperimentTool } from "../src/autoresearch/tools/log-experiment";
import { createRunExperimentTool, runChecksScript } from "../src/autoresearch/tools/run-experiment";
import type { ExperimentResult, SessionSnapshot } from "../src/autoresearch/types";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";

afterEach(() => {
	vi.restoreAllMocks();
});

function makeTempDir(prefix: string): string {
	const dir = path.join(os.tmpdir(), `${prefix}-${Snowflake.next()}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function dashboardStub() {
	return {
		clear(): void {},
		requestRender(): void {},
		showOverlay: async (): Promise<void> => {},
		updateWidget(): void {},
	};
}

function createCtx(cwd: string): ExtensionContext {
	return { cwd, hasUI: false } as ExtensionContext;
}

interface PiHarness {
	api: ExtensionAPI;
}

function createPiHarness(): PiHarness {
	const activeTools: string[] = [];
	const api = {
		appendEntry: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		getActiveTools: () => [...activeTools],
		setActiveTools: async (toolNames: string[]) => {
			activeTools.splice(0, activeTools.length, ...toolNames);
		},
	} as unknown as ExtensionAPI;
	return { api };
}

async function initGitRepo(dir: string): Promise<void> {
	await $`git init --initial-branch=main`.cwd(dir).quiet();
	await $`git config user.email tester@example.com`.cwd(dir).quiet();
	await $`git config user.name Tester`.cwd(dir).quiet();
	await Bun.write(path.join(dir, "README.md"), "# baseline\n");
	await $`git add -A`.cwd(dir).quiet();
	await $`git commit -m baseline`.cwd(dir).quiet();
}

async function checkoutBranch(dir: string, name: string): Promise<void> {
	await $`git checkout -b ${name}`.cwd(dir).quiet();
}

async function writeHarnessStub(dir: string, body = "echo METRIC m=1"): Promise<void> {
	await Bun.write(path.join(dir, "autoresearch.sh"), `#!/usr/bin/env bash\n${body}\n`);
}

function syntheticResult(partial: Partial<ExperimentResult>): ExperimentResult {
	return {
		runNumber: partial.runNumber ?? null,
		commit: partial.commit ?? "deadbeef",
		metric: partial.metric ?? 0,
		metrics: partial.metrics ?? {},
		status: partial.status ?? "keep",
		description: partial.description ?? "",
		timestamp: partial.timestamp ?? 0,
		segment: partial.segment ?? 0,
		confidence: partial.confidence ?? null,
		asi: partial.asi,
		modifiedPaths: partial.modifiedPaths ?? [],
		scopeDeviations: partial.scopeDeviations ?? [],
		justification: partial.justification ?? null,
		flagged: partial.flagged ?? false,
		flaggedReason: partial.flaggedReason ?? null,
	};
}

function writeSyntheticJsonl(cwd: string, entries: JsonlEntry[]): void {
	const lines = entries.map(e => JSON.stringify(e)).join("\n");
	fs.writeFileSync(path.join(cwd, JSONL_FILENAME), `${lines}\n`, "utf8");
}

describe("autoresearch jsonl multi-config symmetry (roboomp #1562)", () => {
	it("reconstruct and compact agree on the latest config — compaction is fixed-point", () => {
		const dir = makeTempDir("pi-autoresearch-1562-jsonl");
		try {
			const entries: JsonlEntry[] = [
				{ type: "config", timestamp: 1, data: { maxIterations: 3 } },
				{
					type: "run",
					timestamp: 10,
					runId: 1,
					data: {
						segment: 0,
						command: "bash autoresearch.sh",
						status: "keep",
						metric: 50,
						metrics: { m: 50 },
						description: "first",
						commit: "aaaa",
						modifiedPaths: [],
						scopeDeviations: [],
						justification: null,
						asi: null,
						confidence: null,
						flagged: false,
						flaggedReason: null,
					},
				},
				// A newer config overrides the original maxIterations.
				{ type: "config", timestamp: 20, data: { maxIterations: 9, enableHooks: true } },
				{
					type: "session",
					timestamp: 30,
					data: {
						name: "speed",
						goal: "make x fast",
						metricName: "m",
						metricUnit: "ms",
						bestDirection: "lower",
						currentSegment: 0,
						maxExperiments: 9,
						results: [],
						confidence: null,
						branch: "autoresearch/x",
						baselineCommit: "aaaa",
						notes: "",
					},
				},
				{
					type: "run",
					timestamp: 40,
					runId: 2,
					data: {
						segment: 0,
						command: "bash autoresearch.sh",
						status: "discard",
						metric: 80,
						metrics: { m: 80 },
						description: "second",
						commit: "bbbb",
						modifiedPaths: [],
						scopeDeviations: [],
						justification: null,
						asi: null,
						confidence: null,
						flagged: false,
						flaggedReason: null,
					},
				},
			];
			writeSyntheticJsonl(dir, entries);

			const allEntries = readJsonlEntries(dir);
			expect(findLatestConfigEntry(allEntries)?.data.maxIterations).toBe(9);

			const before = reconstructStateFromJsonl(allEntries) as SessionSnapshot;
			expect(before.maxExperiments).toBe(9);
			expect(before.results.map(r => r.runNumber)).toEqual([1, 2]);

			compactJsonl(dir);

			const afterEntries = readJsonlEntries(dir);
			// Compaction drops stale configs but keeps the LAST one — so a second
			// reconstruct yields the same snapshot.
			const configs = afterEntries.filter(e => e.type === "config");
			expect(configs).toHaveLength(1);
			expect(findLatestConfigEntry(afterEntries)?.data.maxIterations).toBe(9);

			const after = reconstructStateFromJsonl(afterEntries) as SessionSnapshot;
			expect(after.maxExperiments).toBe(before.maxExperiments);
			expect(after.results.map(r => r.runNumber)).toEqual(before.results.map(r => r.runNumber));
			expect(after.results.map(r => r.status)).toEqual(before.results.map(r => r.status));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("autoresearch browser dashboard SSE init (roboomp #1562)", () => {
	it("emits {type:'init', data:{state, results}} that satisfies the client parser", async () => {
		const dir = makeTempDir("pi-autoresearch-1562-sse");
		const controller = createBrowserDashboardController();
		try {
			// Port 0 lets the OS assign a free port — required for parallel test runs.
			await controller.start(dir, { port: 0 });
			const url = controller.getUrl();
			expect(url).not.toBeNull();

			const sessionPayload: SessionSnapshot = {
				name: "speed",
				goal: "make x fast",
				metricName: "runtime_ms",
				metricUnit: "ms",
				bestDirection: "lower",
				currentSegment: 0,
				maxExperiments: 5,
				results: [syntheticResult({ runNumber: 1, metric: 42, status: "keep", description: "baseline" })],
				confidence: null,
				branch: null,
				baselineCommit: null,
				notes: "",
			};
			controller.broadcast("session", sessionPayload);

			// Read the very first SSE data frame and parse it the way the
			// browser client does.
			const response = await fetch(`${url}/events`, { headers: { Accept: "text/event-stream" } });
			expect(response.ok).toBe(true);
			expect(response.body).not.toBeNull();
			const reader = (response.body as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let frame: string | null = null;
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const idx = buffer.indexOf("\n\n");
				if (idx !== -1) {
					frame = buffer.slice(0, idx);
					break;
				}
			}
			try {
				await reader.cancel();
			} catch {
				// ignore
			}
			expect(frame).not.toBeNull();
			const dataLine = (frame ?? "").split("\n").find(line => line.startsWith("data:"));
			expect(dataLine).toBeDefined();
			const payload = JSON.parse((dataLine ?? "").slice("data:".length).trim()) as {
				type: string;
				data: { state: SessionSnapshot | null; results: ExperimentResult[] };
			};
			expect(payload.type).toBe("init");
			// Exactly the parse the client does: `session = data.data.state; runs = session.results || []`.
			const session = payload.data.state;
			expect(session).not.toBeNull();
			expect(session?.metricName).toBe("runtime_ms");
			const runs = session?.results ?? [];
			expect(runs).toHaveLength(1);
			expect(runs[0].runNumber).toBe(1);
			// Top-level `results` mirrors `state.results` so future client variants can read either.
			expect(payload.data.results.map(r => r.runNumber)).toEqual(runs.map(r => r.runNumber));
		} finally {
			controller.stop();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("autoresearch revert preserves autoresearch.hooks/ (roboomp #1562)", () => {
	let dbOverride: string;

	beforeEach(() => {
		dbOverride = makeTempDir("pi-autoresearch-1562-revert-db");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbOverride;
	});

	afterEach(async () => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		await Bun.sleep(500);
		try {
			fs.rmSync(dbOverride, { recursive: true, force: true });
		} catch {
			// Windows file locking is best-effort on cleanup.
		}
	});

	it("restores autoresearch.hooks/ (and other autoresearch.* dirs) across a discard", async () => {
		const dir = makeTempDir("pi-autoresearch-1562-revert");
		try {
			await initGitRepo(dir);
			await writeHarnessStub(dir);
			await $`git add -A`.cwd(dir).quiet();
			await $`git commit -m harness`.cwd(dir).quiet();
			await checkoutBranch(dir, "autoresearch/hooks-survival");

			const runtime = createSessionRuntime();
			const harness = createPiHarness();
			const init = createInitExperimentTool({
				dashboard: dashboardStub(),
				getRuntime: () => runtime,
				pi: harness.api,
			});
			await init.execute("i", { name: "x", primary_metric: "m" }, undefined, undefined, createCtx(dir));

			// Author hook + a sibling autoresearch.* dir that the legacy implementation
			// would have wiped because its filter rejected directories outright.
			const hooksDir = path.join(dir, "autoresearch.hooks");
			fs.mkdirSync(hooksDir, { recursive: true });
			const hookPath = path.join(hooksDir, "before-log.sh");
			await Bun.write(hookPath, "#!/usr/bin/env bash\nexit 0\n");
			fs.chmodSync(hookPath, 0o755);
			const sidecarDir = path.join(dir, "autoresearch.notes");
			fs.mkdirSync(sidecarDir, { recursive: true });
			await Bun.write(path.join(sidecarDir, "scratch.md"), "draft\n");

			const run = createRunExperimentTool({
				dashboard: dashboardStub(),
				getRuntime: () => runtime,
				pi: harness.api,
			});
			await run.execute("r", {}, undefined, undefined, createCtx(dir));

			// Iteration edits that the discard will throw away.
			await Bun.write(path.join(dir, "scratch.ts"), "// junk\n");

			const log = createLogExperimentTool({
				dashboard: dashboardStub(),
				getRuntime: () => runtime,
				pi: harness.api,
			});
			await log.execute(
				"l",
				{ metric: 99, status: "discard", description: "drop" },
				undefined,
				undefined,
				createCtx(dir),
			);
			await Bun.sleep(200);

			expect(fs.existsSync(hookPath)).toBe(true);
			expect(fs.readFileSync(hookPath, "utf8")).toContain("exit 0");
			expect(fs.existsSync(path.join(sidecarDir, "scratch.md"))).toBe(true);
			// And the discarded scratch must be gone.
			expect(fs.existsSync(path.join(dir, "scratch.ts"))).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("runChecksScript stderr flooding (roboomp #1562)", () => {
	// On Windows, `bash` in PATH usually resolves to the WSL launcher; resolve
	// an explicit Git-for-Windows bash so the test exercises the helper on a
	// real shell. On Linux/macOS the default `bash` is fine.
	const bashCommand = resolveBashForTests();

	it.skipIf(!bashCommand)(
		"returns within seconds when the checks script floods stderr past the OS pipe buffer",
		async () => {
			const dir = makeTempDir("pi-autoresearch-1562-checks");
			try {
				const checksPath = path.join(dir, "autoresearch.checks.sh");
				// Pure-bash loop avoids relying on `seq`/`yes` and writes well past the
				// Linux default 64 KiB pipe buffer and the Windows ~4 KiB one. With the
				// pre-fix sequential-await pattern this would deadlock; the test caps
				// itself at 15 s as a hard deadlock guard.
				const checksScript = [
					"#!/usr/bin/env bash",
					"i=0",
					"while [ $i -lt 1500 ]; do",
					'  printf "flood line %d padding padding padding padding padding padding padding\\n" "$i" 1>&2',
					"  i=$((i+1))",
					"done",
					"exit 0",
				].join("\n");
				await Bun.write(checksPath, `${checksScript}\n`);
				fs.chmodSync(checksPath, 0o755);

				const start = Date.now();
				const result = await runChecksScript(dir, checksPath, { bashCommand: bashCommand as string });
				const elapsed = Date.now() - start;
				expect(elapsed).toBeLessThan(15_000);
				expect(result.passed).toBe(true);
				// Stderr is preserved (capped) so the script's signal isn't lost.
				expect(result.output).toContain("flood line");
				expect(result.output).toContain("[stderr]");
				// Cap is applied — output stays under ~9 KiB (stdout cap + stderr cap + header).
				expect(result.output.length).toBeLessThan(10 * 1024);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it.skipIf(!bashCommand)("reports failure when the checks script exits non-zero", async () => {
		const dir = makeTempDir("pi-autoresearch-1562-checks-fail");
		try {
			const checksPath = path.join(dir, "autoresearch.checks.sh");
			await Bun.write(checksPath, "#!/usr/bin/env bash\necho hello\nexit 7\n");
			fs.chmodSync(checksPath, 0o755);
			const result = await runChecksScript(dir, checksPath, { bashCommand: bashCommand as string });
			expect(result.passed).toBe(false);
			expect(result.output).toContain("hello");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

function resolveBashForTests(): string | null {
	if (process.platform !== "win32") {
		return Bun.which("bash") ?? "bash";
	}
	// Bun.which("bash") on Windows returns the WSL launcher even when Git for
	// Windows is installed; consult well-known locations first.
	const candidates = [
		"C:\\Program Files\\Git\\bin\\bash.exe",
		"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
		"C:\\Program Files (x86)\\Git\\bin\\bash.exe",
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	// Fall back to scanning PATH explicitly for a non-System32 bash.
	const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
	for (const dir of pathDirs) {
		if (dir.toLowerCase().includes("system32")) continue;
		const candidate = path.join(dir, "bash.exe");
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}
