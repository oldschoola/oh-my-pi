/**
 * Integration contract test for the extension factory.
 *
 * Mirrors what `packages/coding-agent/src/extensibility/extensions/loader.ts`
 * does when it dynamically imports an extension:
 *  1. `import(resolvedPath)` the entry file
 *  2. pick `module.default ?? module`
 *  3. require a function
 *  4. invoke it with a `ConcreteExtensionAPI` instance
 *
 * Without this, a regression in the entry contract (non-function default
 * export, throwing factory, event name typo) only surfaces when a real omp
 * session loads the extension.
 */

import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** The contract a mission extension's default export must satisfy. */
type MissionExtensionFactory = (pi: ExtensionAPI) => void;

/**
 * Load the extension module and return its factory, typed.
 * The stub returned by `makeStubPi` satisfies the subset of `ExtensionAPI`
 * the extension actually invokes during registration — cast via `unknown` at
 * the call boundary rather than scattering `as any` through the file.
 */
async function loadFactory(): Promise<MissionExtensionFactory> {
	const mod = await import("../src/index");
	return (mod.default ?? mod) as MissionExtensionFactory;
}

/** Subset of `ExtensionAPI` the mission extension actually invokes during registration. */
interface StubApi {
	registerCommand(name: string, options: Omit<StubCommand, "name">): void;
	registerShortcut(shortcut: string, options: Omit<StubShortcut, "shortcut">): void;
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
	appendEntry(customType: string, data: unknown): void;
	setSessionName(name: string): Promise<void>;
	sendUserMessage(): void;
	setLabel(): void;
	setModel(): Promise<boolean>;
}

/** One-liner to invoke the factory with the stub as a narrowed ExtensionAPI. */
function invoke(factory: MissionExtensionFactory, api: StubApi): void {
	factory(api as unknown as ExtensionAPI);
}

interface StubCommand {
	name: string;
	description?: string;
	handler: (args: string, ctx: unknown) => unknown;
}

interface StubShortcut {
	shortcut: string;
	description?: string;
	handler: (ctx: unknown) => unknown;
}

/**
 * Minimal stand-in for `ExtensionAPI`. Captures every call the extension
 * makes during registration so the test can assert on the observable
 * surface (registered commands, registered shortcut, subscribed events).
 */
function makeStubPi() {
	const commands = new Map<string, StubCommand>();
	const shortcuts: StubShortcut[] = [];
	const events = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	let sessionName = "";
	const entries: Array<[string, unknown]> = [];

	const api = {
		registerCommand(name: string, options: Omit<StubCommand, "name">) {
			commands.set(name, { name, ...options });
		},
		registerShortcut(shortcut: string, options: Omit<StubShortcut, "shortcut">) {
			shortcuts.push({ shortcut, ...options });
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = events.get(event) ?? [];
			list.push(handler);
			events.set(event, list);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push([customType, data]);
		},
		setSessionName(name: string) {
			sessionName = name;
			return Promise.resolve();
		},
		sendUserMessage: () => {},
		setLabel: () => {},
		setModel: () => Promise.resolve(true),
	};

	return {
		api,
		commands,
		shortcuts,
		events,
		getSessionName: () => sessionName,
		getEntries: () => entries,
	};
}

/**
 * Minimal Theme stand-in. Mission widget calls `theme.fg(color, text)` and
 * `theme.bg(color, text)` — we return the text unchanged so assertions don't
 * have to strip ANSI escapes.
 */
function makeStubTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
	};
}

describe("extension factory contract", () => {
	it("default export is a function invokable with a stub ExtensionAPI", async () => {
		const factory = await loadFactory();
		expect(typeof factory).toBe("function");

		const stub = makeStubPi();
		expect(() => invoke(factory, stub.api)).not.toThrow();
	});

	it("registers all documented /mission* commands", async () => {
		const factory = await loadFactory();
		const stub = makeStubPi();

		invoke(factory, stub.api);

		const expected = [
			"mission",
			"mission-status",
			"mission-skip",
			"mission-done",
			"mission-pause",
			"mission-next",
			"mission-reset",
		];
		for (const name of expected) {
			expect(stub.commands.has(name)).toBe(true);
			expect(typeof stub.commands.get(name)?.handler).toBe("function");
		}
	});

	it("registers Ctrl+Shift+M shortcut for Mission Control", async () => {
		const factory = await loadFactory();
		const stub = makeStubPi();

		invoke(factory, stub.api);

		const shortcut = stub.shortcuts.find(s => s.shortcut === "ctrl+shift+m");
		expect(shortcut).toBeDefined();
		expect(typeof shortcut?.handler).toBe("function");
	});

	it("subscribes only to events defined on the ExtensionAPI surface", async () => {
		const factory = await loadFactory();
		const stub = makeStubPi();

		invoke(factory, stub.api);

		// These are the documented events per packages/coding-agent/src/extensibility/extensions/types.ts.
		// If any subscribed event falls outside this set, the loader-level listener would never fire.
		const valid = new Set([
			"session_start",
			"session_switch",
			"session_tree",
			"session_compact",
			"session_shutdown",
			"message_end",
			"before_agent_start",
			"auto_retry_start",
			"auto_retry_end",
		]);

		for (const event of stub.events.keys()) {
			expect(valid.has(event)).toBe(true);
		}

		// Must at least restore from session start and inject protocol.
		expect(stub.events.has("session_start")).toBe(true);
		expect(stub.events.has("before_agent_start")).toBe(true);
	});

	it("before_agent_start injects nothing when no mission is active", async () => {
		const factory = await loadFactory();
		const stub = makeStubPi();

		invoke(factory, stub.api);

		const handlers = stub.events.get("before_agent_start") ?? [];
		expect(handlers.length).toBeGreaterThan(0);

		// Calling the handler when mission is null must return undefined (no systemPrompt override)
		const result = await handlers[0]({ systemPrompt: "base" }, {});
		expect(result).toBeUndefined();
	});

	it("session_start restore handles empty session entries without throwing", async () => {
		const factory = await loadFactory();
		const stub = makeStubPi();

		invoke(factory, stub.api);

		const handlers = stub.events.get("session_start") ?? [];
		expect(handlers.length).toBeGreaterThan(0);

		const setWidgetCalls: Array<[string, unknown]> = [];
		const ctx = {
			ui: {
				setWidget: (name: string, value: unknown) => setWidgetCalls.push([name, value]),

				theme: makeStubTheme(),
			},
			sessionManager: {
				getEntries: () => [],
			},
		};

		await expect(handlers[0]({}, ctx)).resolves.toBeUndefined();
		// With no mission state, widget should be cleared.
		expect(setWidgetCalls).toEqual([["mission", undefined]]);
	});

	it("before_agent_start returns injected systemPrompt when a mission is active", async () => {
		const factory = await loadFactory();
		const stub = makeStubPi();

		invoke(factory, stub.api);

		// Seed an active mission by firing session_start with a valid mission-state entry.
		const nowIso = new Date().toISOString();
		const missionData = {
			description: "Integration mission",
			mode: "simple" as const,
			phases: [
				{ name: "Architect", emoji: "📐", status: "active" as const, startedAt: nowIso },
				{ name: "Implement", emoji: "🔨", status: "pending" as const },
				{ name: "Verify", emoji: "✅", status: "pending" as const },
			],
			autonomy: "medium" as const,
			modelAssignment: {},
			paused: false,
			pauseHistory: [],
			progressLog: [],
			startedAt: nowIso,
		};

		const startHandlers = stub.events.get("session_start") ?? [];
		await startHandlers[0](
			{},
			{
				ui: {
					setWidget: () => {},

					theme: makeStubTheme(),
				},
				sessionManager: {
					getEntries: () => [{ type: "custom", customType: "mission-state", data: missionData }],
				},
			},
		);
		expect(stub.getSessionName()).toContain("Integration mission");

		// Now before_agent_start must attach protocol + status to the system prompt.
		const beforeHandlers = stub.events.get("before_agent_start") ?? [];
		const result = (await beforeHandlers[0]({ systemPrompt: "BASE_PROMPT" }, {})) as
			| { systemPrompt?: string }
			| undefined;

		expect(result).toBeDefined();
		expect(result?.systemPrompt).toContain("BASE_PROMPT");
		expect(result?.systemPrompt).toContain("Integration mission");
		expect(result?.systemPrompt).toContain("Current Phase:");
	});
});
