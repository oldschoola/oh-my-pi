/**
 * Tests the lazy-load contract on the CLI help renderer.
 *
 * The renderer reads only `static description` and `static hidden` from every
 * non-default command. When an entry carries a static `description` in the
 * registry, `loadAllCommands` MUST NOT call its `load()` — that's the
 * entire point of the optimization. If a refactor accidentally re-introduces
 * an unconditional `await e.load()`, every `<bin> --help` invocation will
 * silently regress to importing the full transitive module graph for every
 * subcommand.
 */
import { describe, expect, it } from "bun:test";
import { Command, type CommandCtor, type CommandEntry, run } from "../src/cli";

class FakeDefault extends Command {
	static description = "default desc";
	static hidden = true;
	async run(): Promise<void> {}
}

class FakeLoaded extends Command {
	static description = "loaded desc";
	async run(): Promise<void> {}
}

function entry(name: string, opts: Partial<CommandEntry> & { Ctor?: CommandCtor } = {}): {
	entry: CommandEntry;
	loadCount: () => number;
} {
	let loaded = 0;
	const Ctor = opts.Ctor ?? FakeLoaded;
	return {
		entry: {
			name,
			description: opts.description,
			default: opts.default,
			aliases: opts.aliases,
			load: async () => {
				loaded++;
				return Ctor;
			},
		},
		loadCount: () => loaded,
	};
}

function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
	const chunks: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((data: string | Uint8Array) => {
		chunks.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
		return true;
	}) as typeof process.stdout.write;
	return fn()
		.then(result => ({ result, out: chunks.join("") }))
		.finally(() => {
			process.stdout.write = original;
		});
}

describe("root-help lazy load", () => {
	it("does NOT call load() for entries that carry a static description", async () => {
		const def = entry("launch", { default: true, Ctor: FakeDefault });
		const a = entry("acp", { description: "acp desc" });
		const b = entry("stats", { description: "stats desc" });

		await captureStdout(() =>
			run({
				bin: "omp",
				version: "0.0.0",
				argv: ["--help"],
				commands: [def.entry, a.entry, b.entry],
			}),
		);

		// Default is always loaded so its body can be rendered inline.
		expect(def.loadCount()).toBe(1);
		// Non-default entries with static description must be metadata-only.
		expect(a.loadCount()).toBe(0);
		expect(b.loadCount()).toBe(0);
	});

	it("falls back to load() for entries WITHOUT a static description (backward compat)", async () => {
		const def = entry("launch", { default: true, Ctor: FakeDefault });
		// `acp` has no description on the entry — renderer must load the module
		// to read `static description` off the class. Preserves behavior for
		// consumers that haven't migrated their registry yet.
		const a = entry("acp");

		await captureStdout(() =>
			run({
				bin: "omp",
				version: "0.0.0",
				argv: ["--help"],
				commands: [def.entry, a.entry],
			}),
		);

		expect(def.loadCount()).toBe(1);
		expect(a.loadCount()).toBe(1);
	});

	it("renders the same command list regardless of metadata source", async () => {
		const def = entry("launch", { default: true, Ctor: FakeDefault });
		const fromMeta = entry("acp", { description: "loaded desc" }); // matches FakeLoaded.description
		const { out } = await captureStdout(() =>
			run({
				bin: "omp",
				version: "0.0.0",
				argv: ["--help"],
				commands: [def.entry, fromMeta.entry],
			}),
		);

		// The command list section must show acp's description regardless of
		// whether the renderer pulled it from the registry or the class.
		expect(out).toContain("acp");
		expect(out).toContain("loaded desc");
	});

	it("loads the default command's module so the renderer can show its body", async () => {
		const def = entry("launch", { default: true, Ctor: FakeDefault });
		const { out } = await captureStdout(() =>
			run({
				bin: "omp",
				version: "0.0.0",
				argv: ["--help"],
				commands: [def.entry],
			}),
		);

		expect(def.loadCount()).toBe(1);
		// The default's body is rendered inline (FakeDefault has the
		// `hidden = true` marker the renderer searches for).
		expect(out).toContain("omp v0.0.0");
		expect(out).toContain("USAGE");
	});
});

describe("per-subcommand help", () => {
	it("loads ONLY the targeted subcommand (no traversal of the registry)", async () => {
		const def = entry("launch", { default: true, Ctor: FakeDefault });
		const a = entry("acp", { description: "acp desc" });
		const target = entry("stats", { description: "stats desc" });

		await captureStdout(() =>
			run({
				bin: "omp",
				version: "0.0.0",
				argv: ["stats", "--help"],
				commands: [def.entry, a.entry, target.entry],
			}),
		);

		// Old behavior called `loadAllCommands` which would have loaded def
		// alongside the target. The new behavior only loads the target — the
		// renderer never reads anything off the other entries on this path.
		expect(def.loadCount()).toBe(0);
		expect(a.loadCount()).toBe(0);
		expect(target.loadCount()).toBe(1);
	});

	it("resolves aliases when picking the target", async () => {
		const def = entry("launch", { default: true, Ctor: FakeDefault });
		const target = entry("search", { description: "search desc", aliases: ["q"] });

		await captureStdout(() =>
			run({
				bin: "omp",
				version: "0.0.0",
				argv: ["q", "--help"],
				commands: [def.entry, target.entry],
			}),
		);

		expect(def.loadCount()).toBe(0);
		expect(target.loadCount()).toBe(1);
	});
});
