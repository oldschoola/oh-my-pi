/**
 * Contract tests for the /mission-integrate slash command handler.
 *
 * The command closes gap C of round 6: it parses args, resolves the
 * integration context, builds an executor, invokes it, and surfaces the
 * result through ctx.ui.notify. These tests exercise the four surfaces
 * that matter for callers (operators invoking the command):
 *
 *  1. --help / -h prints usage without touching git.
 *  2. Invalid flag produces a user-facing error with the usage hint.
 *  3. Successful executor result becomes an info-level notify.
 *  4. Failed executor result becomes an error-level notify.
 *
 * Git and persistence I/O are stubbed via vi-style spies on the exported
 * helpers — no temp repo required.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as missioncontrol from "../src/missioncontrol";

type MissionExtensionFactory = (pi: ExtensionAPI) => void;

interface StubCommand {
	description?: string;
	handler: (args: string, ctx: unknown) => unknown;
}

interface NotifyCall {
	message: string;
	level: "info" | "warning" | "error";
}

interface StubApi {
	registerCommand(name: string, options: StubCommand): void;
	registerShortcut(shortcut: string, options: { handler: (ctx: unknown) => unknown }): void;
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
	appendEntry(customType: string, data: unknown): void;
	setSessionName(name: string): Promise<void>;
	sendUserMessage(): void;
	setLabel(): void;
	setModel(): Promise<boolean>;
	registerTool(options: unknown): void;
}

interface StubPi {
	api: StubApi;
	commands: Map<string, StubCommand>;
}

function makeStubPi(): StubPi {
	const commands = new Map<string, StubCommand>();
	const api: StubApi = {
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerShortcut() {},
		on() {},
		appendEntry() {},
		setSessionName() {
			return Promise.resolve();
		},
		sendUserMessage() {},
		setLabel() {},
		setModel() {
			return Promise.resolve(true);
		},
		registerTool() {},
	};
	return { api, commands };
}

async function loadFactory(): Promise<MissionExtensionFactory> {
	const mod = await import("../src/index");
	return (mod.default ?? mod) as MissionExtensionFactory;
}

async function registerAndGetIntegrate(): Promise<{
	handler: (args: string, ctx: unknown) => unknown;
	notifyCalls: NotifyCall[];
	ctx: { cwd: string; ui: { notify: (m: string, l: NotifyCall["level"]) => void } };
}> {
	const factory = await loadFactory();
	const stub = makeStubPi();
	factory(stub.api as unknown as ExtensionAPI);
	const cmd = stub.commands.get("mission-integrate");
	if (!cmd) throw new Error("mission-integrate command was not registered");
	const notifyCalls: NotifyCall[] = [];
	const ctx = {
		cwd: "/tmp/does-not-exist",
		ui: {
			notify(message: string, level: NotifyCall["level"]) {
				notifyCalls.push({ message, level });
			},
		},
	};
	return { handler: cmd.handler, notifyCalls, ctx };
}

describe("/mission-integrate command", () => {
	afterEach(() => {
		// Restore every spy installed in the tests below. Keeps full-suite
		// runs deterministic — a leaked stub in one file would poison later
		// tests that call the real git runner or loadBatchState.
		mock.restore();
	});

	test("--help prints usage at info level without touching git or state", async () => {
		// If git or state were touched, these spies would record calls and
		// let the assertion fail loudly — instead of silently passing.
		const runGitSpy = spyReturning<ReturnType<typeof missioncontrol.runGit>>(missioncontrol, "runGit", {
			ok: true,
			stdout: "",
			stderr: "",
		});
		const loadSpy = spyAsyncReturning(missioncontrol, "loadBatchState", null);

		const { handler, notifyCalls, ctx } = await registerAndGetIntegrate();
		await handler("--help", ctx);

		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0].level).toBe("info");
		expect(notifyCalls[0].message).toContain("Usage:");
		expect(notifyCalls[0].message).toContain("/mission-integrate");
		expect(runGitSpy).not.toHaveBeenCalled();
		expect(loadSpy).not.toHaveBeenCalled();
	});

	test("-h short form also prints usage", async () => {
		const { handler, notifyCalls, ctx } = await registerAndGetIntegrate();
		await handler("-h", ctx);
		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0].level).toBe("info");
		expect(notifyCalls[0].message).toContain("Usage:");
	});

	test("unknown flag yields a user-facing error (not a throw)", async () => {
		const { handler, notifyCalls, ctx } = await registerAndGetIntegrate();
		// Must not throw — parseIntegrateArgs returns { error } which the
		// handler converts to an error-level notify plus a usage hint.
		await expect(handler("--bogus", ctx)).resolves.toBeUndefined();
		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0].level).toBe("error");
		expect(notifyCalls[0].message).toContain("Unknown flag");
		expect(notifyCalls[0].message).toContain("--help");
	});

	test("--merge and --pr together yields a user-facing error", async () => {
		const { handler, notifyCalls, ctx } = await registerAndGetIntegrate();
		await handler("--merge --pr", ctx);
		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0].level).toBe("error");
		expect(notifyCalls[0].message).toContain("--merge and --pr");
	});

	test("successful executor result becomes an info notify", async () => {
		// Stub the full resolution + execution pipeline so no git or FS
		// calls happen. The contract under test is: when the executor
		// returns success, the handler surfaces its message as info.
		spyAsyncReturning(missioncontrol, "loadBatchState", {
			phase: "completed",
			batchId: "batch-42",
			baseBranch: "main",
			orchBranch: "orch/batch-42",
			lanes: [],
			tasks: [],
			wavePlan: [],
		} as unknown as import("../src/missioncontrol/types").PersistedBatchState);
		spyReturning(missioncontrol, "resolveIntegrationContext", {
			orchBranch: "orch/batch-42",
			baseBranch: "main",
			batchId: "batch-42",
			currentBranch: "main",
			notices: [],
		});
		spyReturning(missioncontrol, "buildIntegrationExecutor", () => ({
			success: true,
			integratedLocally: true,
			commitCount: "3",
			message: "Fast-forwarded main to orch/batch-42 (3 commits).",
		}));
		spyReturning(missioncontrol, "resolveOperatorId", "opid");

		const { handler, notifyCalls, ctx } = await registerAndGetIntegrate();
		await handler("", ctx);

		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0].level).toBe("info");
		expect(notifyCalls[0].message).toContain("Fast-forwarded");
	});

	test("failed executor result becomes an error notify carrying the error text", async () => {
		spyAsyncReturning(missioncontrol, "loadBatchState", {
			phase: "completed",
			batchId: "batch-99",
			baseBranch: "main",
			orchBranch: "orch/batch-99",
			lanes: [],
			tasks: [],
			wavePlan: [],
		} as unknown as import("../src/missioncontrol/types").PersistedBatchState);
		spyReturning(missioncontrol, "resolveIntegrationContext", {
			orchBranch: "orch/batch-99",
			baseBranch: "main",
			batchId: "batch-99",
			currentBranch: "main",
			notices: [],
		});
		spyReturning(missioncontrol, "buildIntegrationExecutor", () => ({
			success: false,
			integratedLocally: false,
			commitCount: "0",
			message: "",
			error: "Refusing to fast-forward: base branch has diverged.",
		}));
		spyReturning(missioncontrol, "resolveOperatorId", "opid");

		const { handler, notifyCalls, ctx } = await registerAndGetIntegrate();
		await handler("", ctx);

		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0].level).toBe("error");
		expect(notifyCalls[0].message).toContain("Refusing to fast-forward");
	});

	test("resolution-level 'info' error routes to info notify (legacy merge-mode batch)", async () => {
		// resolveIntegrationContext can return { error, severity: "info" }
		// for soft rejections (e.g. legacy merge mode where there's no
		// mission branch to integrate). These must not be shown as errors.
		spyAsyncReturning(missioncontrol, "loadBatchState", {
			phase: "completed",
			batchId: "legacy",
			baseBranch: "main",
			orchBranch: "",
			lanes: [],
			tasks: [],
			wavePlan: [],
		} as unknown as import("../src/missioncontrol/types").PersistedBatchState);
		spyReturning(missioncontrol, "resolveIntegrationContext", {
			error: "Batch already merged directly into main.",
			severity: "info" as const,
		});

		const { handler, notifyCalls, ctx } = await registerAndGetIntegrate();
		await handler("", ctx);

		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0].level).toBe("info");
		expect(notifyCalls[0].message).toContain("already merged");
	});
});

// ── Spy helpers ────────────────────────────────────────────────────────
//
// AGENTS.md bans mock.module and demands vi.spyOn equivalents with
// restoration. Bun exposes `spyOn` + `mockReturnValue` on the test
// runtime; we thin-wrap them here so the tests above read like intent
// rather than spy plumbing. The afterEach restores all spies so tests
// in other files don't see a mutated module.

type AnyRecord = Record<string, any>;

function spyReturning<R>(target: AnyRecord, key: string, value: R): ReturnType<typeof spyOn> {
	const spy = spyOn(target, key);
	spy.mockReturnValue(value);
	return spy;
}

function spyAsyncReturning<R>(target: AnyRecord, key: string, value: R): ReturnType<typeof spyOn> {
	const spy = spyOn(target, key);
	spy.mockResolvedValue(value);
	return spy;
}

// Bring bun:test's spyOn/mock into scope. Top-level import keeps the
// helpers above unpolluted by runtime-specific imports.
import { spyOn } from "bun:test";
