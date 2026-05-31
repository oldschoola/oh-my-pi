/**
 * Contract tests for the CLI command registry.
 *
 * Static command metadata (`description`, `default`) in `cli-commands.ts`
 * exists to let the root-help renderer build its command list WITHOUT
 * importing every command module — the dominant savings on `omp --help`
 * cold start (~1.5 s on this host). The trade-off is duplication: each
 * registry entry's `description` must match the class's
 * `static description`, with no runtime cross-check.
 *
 * These tests load every module once at test time (the work we're
 * intentionally avoiding at runtime) and assert the contract. They are
 * the safety net against silent drift when someone updates a class
 * description without touching the registry, or vice versa.
 */
import { describe, expect, it } from "bun:test";
import { commands } from "../src/cli-commands";

describe("cli-commands registry contract", () => {
	it("every entry that declares a static `description` matches its class's `static description`", async () => {
		const mismatches: string[] = [];
		for (const entry of commands) {
			if (entry.description === undefined) continue;
			const Cmd = await entry.load();
			const classDescription = Cmd.description;
			if (classDescription !== entry.description) {
				mismatches.push(
					`  ${entry.name}: registry="${entry.description}" class="${classDescription ?? "<undefined>"}"`,
				);
			}
		}
		// Single combined message so all drifted entries surface in one run
		// instead of a stop-on-first failure.
		expect(mismatches.join("\n")).toBe("");
	});

	it("exactly one entry is marked `default: true` and its class is hidden", async () => {
		const defaults = commands.filter(e => e.default === true);
		expect(defaults).toHaveLength(1);
		const Cmd = await defaults[0].load();
		// The root-help renderer uses `find(C => C.hidden)` to locate the
		// default command for inline body rendering; `default: true` and
		// `static hidden = true` must agree or the renderer falls back to
		// loading every module (loses the cold-start win).
		expect(Cmd.hidden).toBe(true);
	});

	it("every non-default entry either carries a static description OR loads to a hidden class", async () => {
		// Cold-start invariant: a non-default entry without a registry
		// `description` forces the root-help renderer to import the module
		// just to read `.description`/`.hidden`. The ONLY acceptable
		// exception is an entry whose class is `static hidden = true` —
		// e.g. `__complete`, a hidden internal helper not shown in the
		// command list. For those, the module load IS the mechanism that
		// tells the renderer "don't list me", and the module must be kept
		// deliberately thin.
		const offenders: string[] = [];
		for (const entry of commands) {
			if (entry.default === true) continue;
			if (entry.description !== undefined) continue;
			const Cmd = await entry.load();
			if (Cmd.hidden !== true) {
				offenders.push(`${entry.name} (no description AND class is not hidden)`);
			}
		}
		expect(offenders.join(", ")).toBe("");
	});

	it("all entry names are unique (registry-level guarantee, not enforced elsewhere)", () => {
		const seen = new Set<string>();
		const dupes: string[] = [];
		for (const e of commands) {
			if (seen.has(e.name)) dupes.push(e.name);
			seen.add(e.name);
		}
		expect(dupes).toEqual([]);
	});
});
