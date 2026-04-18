/**
 * Unit tests for `executeIntegration` — drives the ff/merge/pr paths,
 * already-merged short-circuit, stash-around-merge behavior, protection
 * hint, and post-cleanup warning folding.
 *
 * Uses a scripted git runner: each test supplies a sequence of responses
 * keyed by the first arg of each `runGit` call, so the test can assert
 * on the exact command sequence.
 */

import { describe, expect, test } from "bun:test";

import { executeIntegration } from "../src/missioncontrol/execute-integration";
import type { IntegrationContext, IntegrationExecDeps } from "../src/missioncontrol/types";

type GitResult = { ok: boolean; stdout: string; stderr: string };

const OK: GitResult = { ok: true, stdout: "", stderr: "" };
const FAIL: GitResult = { ok: false, stdout: "", stderr: "boom" };

const CTX: IntegrationContext = {
	orchBranch: "orch/b1",
	baseBranch: "main",
	batchId: "b1",
	currentBranch: "main",
	notices: [],
};

function makeDeps(opts: {
	git: (args: string[]) => GitResult;
	cmd?: (cmd: string, args: string[]) => GitResult;
	onDelete?: () => void;
}): { deps: IntegrationExecDeps; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		deps: {
			runGit: args => {
				calls.push(args);
				return opts.git(args);
			},
			runCommand: opts.cmd ?? (() => OK),
			deleteBatchState: opts.onDelete ?? (() => {}),
		},
	};
}

describe("executeIntegration — already-merged short-circuit", () => {
	test("returns success + cleanup when orch is ancestor of HEAD", () => {
		const { deps, calls } = makeDeps({
			git: args => {
				if (args[0] === "merge-base") return OK;
				return OK;
			},
		});
		const result = executeIntegration("ff", CTX, deps);
		expect(result.success).toBe(true);
		expect(result.integratedLocally).toBe(true);
		expect(result.message).toContain("Already integrated");
		expect(calls[0]).toEqual(["merge-base", "--is-ancestor", "orch/b1", "HEAD"]);
		// Should also run cleanup branch-D
		expect(calls.some(c => c[0] === "branch" && c[1] === "-D")).toBe(true);
	});
});

describe("executeIntegration — ff mode", () => {
	test("clean working tree: no stash, merge --ff-only, cleanup on success", () => {
		let deleted = false;
		const { deps, calls } = makeDeps({
			git: args => {
				if (args[0] === "merge-base") return FAIL;
				if (args[0] === "status") return { ok: true, stdout: "", stderr: "" };
				if (args[0] === "merge") return OK;
				return OK;
			},
			onDelete: () => {
				deleted = true;
			},
		});
		const result = executeIntegration("ff", CTX, deps);
		expect(result.success).toBe(true);
		expect(result.integratedLocally).toBe(true);
		expect(result.message).toContain("Fast-forwarded main to orch/b1");
		expect(calls.some(c => c[0] === "stash" && c[1] === "push")).toBe(false);
		expect(calls.some(c => c[0] === "stash" && c[1] === "pop")).toBe(false);
		expect(deleted).toBe(true);
	});

	test("dirty working tree: autostash + pop bracket the merge", () => {
		const order: string[] = [];
		const { deps } = makeDeps({
			git: args => {
				if (args[0] === "merge-base") return FAIL;
				if (args[0] === "status") return { ok: true, stdout: " M foo.ts\n", stderr: "" };
				if (args[0] === "stash") {
					order.push(`stash-${args[1]}`);
					return OK;
				}
				if (args[0] === "merge") {
					order.push("merge");
					return OK;
				}
				return OK;
			},
		});
		executeIntegration("ff", CTX, deps);
		expect(order).toEqual(["stash-push", "merge", "stash-pop"]);
	});

	test("dirty tree + ff fails: pop still runs, error reports divergence", () => {
		const popped: boolean[] = [];
		const { deps } = makeDeps({
			git: args => {
				if (args[0] === "merge-base") return FAIL;
				if (args[0] === "status") return { ok: true, stdout: " M foo.ts\n", stderr: "" };
				if (args[0] === "merge") return { ok: false, stdout: "", stderr: "non-fast-forward" };
				if (args[0] === "stash" && args[1] === "pop") {
					popped.push(true);
					return OK;
				}
				return OK;
			},
		});
		const result = executeIntegration("ff", CTX, deps);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Fast-forward failed");
		expect(result.error).toContain("/mission-integrate --merge");
		expect(result.error).toContain("/mission-integrate --pr");
		expect(popped).toEqual([true]);
	});

	test("protection error surfaces PR hint", () => {
		const { deps } = makeDeps({
			git: args => {
				if (args[0] === "merge-base") return FAIL;
				if (args[0] === "status") return { ok: true, stdout: "", stderr: "" };
				if (args[0] === "merge") return { ok: false, stdout: "", stderr: "branch is protected" };
				return OK;
			},
		});
		const result = executeIntegration("ff", CTX, deps);
		expect(result.error).toContain("branch is protected");
		expect(result.error).toContain("💡 If the branch is protected");
	});

	test("autostash message embeds batchId for downstream cleanup", () => {
		const stashPushes: string[][] = [];
		const { deps } = makeDeps({
			git: args => {
				if (args[0] === "merge-base") return FAIL;
				if (args[0] === "status") return { ok: true, stdout: " M x\n", stderr: "" };
				if (args[0] === "stash" && args[1] === "push") {
					stashPushes.push(args);
					return OK;
				}
				return OK;
			},
		});
		executeIntegration("ff", CTX, deps);
		expect(stashPushes).toHaveLength(1);
		expect(stashPushes[0]).toContain("orch-integrate-autostash-b1");
	});

	test("cleanup branch-delete failure folds warning into message", () => {
		const { deps } = makeDeps({
			git: args => {
				if (args[0] === "merge-base") return FAIL;
				if (args[0] === "status") return { ok: true, stdout: "", stderr: "" };
				if (args[0] === "merge") return OK;
				if (args[0] === "branch" && args[1] === "-D")
					return { ok: false, stdout: "", stderr: "branch is checked out" };
				return OK;
			},
		});
		const result = executeIntegration("ff", CTX, deps);
		expect(result.success).toBe(true);
		expect(result.message).toContain("Could not delete local branch");
		expect(result.message).toContain("branch is checked out");
	});

	test("deleteBatchState throw folds warning into message", () => {
		const { deps } = makeDeps({
			git: args => {
				if (args[0] === "merge-base") return FAIL;
				if (args[0] === "status") return { ok: true, stdout: "", stderr: "" };
				if (args[0] === "merge") return OK;
				return OK;
			},
			onDelete: () => {
				throw new Error("disk full");
			},
		});
		const result = executeIntegration("ff", CTX, deps);
		expect(result.success).toBe(true);
		expect(result.message).toContain("Could not clean up batch state");
		expect(result.message).toContain("disk full");
	});
});

describe("executeIntegration — merge mode", () => {
	test("success path runs merge --no-edit + cleanup", () => {
		const mergeArgs: string[][] = [];
		const { deps } = makeDeps({
			git: args => {
				if (args[0] === "merge-base") return FAIL;
				if (args[0] === "status") return { ok: true, stdout: "", stderr: "" };
				if (args[0] === "merge") {
					mergeArgs.push(args);
					return OK;
				}
				return OK;
			},
		});
		const result = executeIntegration("merge", CTX, deps);
		expect(result.success).toBe(true);
		expect(result.message).toContain("Merged orch/b1 into main");
		expect(mergeArgs[0]).toEqual(["merge", "orch/b1", "--no-edit"]);
	});

	test("conflict rejects with /mission-integrate --pr hint", () => {
		const { deps } = makeDeps({
			git: args => {
				if (args[0] === "merge-base") return FAIL;
				if (args[0] === "status") return { ok: true, stdout: "", stderr: "" };
				if (args[0] === "merge") return { ok: false, stdout: "", stderr: "CONFLICT (content)" };
				return OK;
			},
		});
		const result = executeIntegration("merge", CTX, deps);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Merge failed");
		expect(result.error).toContain("/mission-integrate --pr");
	});
});

describe("executeIntegration — pr mode", () => {
	test("push + gh pr create success returns PR url, keeps branch", () => {
		const cmdCalls: Array<[string, string[]]> = [];
		const { deps } = makeDeps({
			git: args => {
				if (args[0] === "merge-base") return FAIL;
				if (args[0] === "push") return OK;
				return OK;
			},
			cmd: (cmd, args) => {
				cmdCalls.push([cmd, args]);
				return { ok: true, stdout: "https://github.com/org/repo/pull/42\n", stderr: "" };
			},
		});
		const result = executeIntegration("pr", CTX, deps);
		expect(result.success).toBe(true);
		expect(result.integratedLocally).toBe(false);
		expect(result.message).toContain("Pull request created");
		expect(result.message).toContain("https://github.com/org/repo/pull/42");
		expect(result.message).toContain("mission branch has been kept");
		expect(cmdCalls[0]?.[0]).toBe("gh");
		const ghArgs = cmdCalls[0]?.[1] ?? [];
		expect(ghArgs).toContain("--title");
		expect(ghArgs.join(" ")).toContain("Integrate mission batch b1");
	});

	test("push failure aborts before gh runs", () => {
		let ghInvoked = false;
		const { deps } = makeDeps({
			git: args => {
				if (args[0] === "merge-base") return FAIL;
				if (args[0] === "push") return { ok: false, stdout: "", stderr: "auth required" };
				return OK;
			},
			cmd: () => {
				ghInvoked = true;
				return OK;
			},
		});
		const result = executeIntegration("pr", CTX, deps);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Failed to push orch/b1 to origin");
		expect(result.error).toContain("auth required");
		expect(ghInvoked).toBe(false);
	});

	test("gh failure reports manual-PR fallback", () => {
		const { deps } = makeDeps({
			git: args => {
				if (args[0] === "merge-base") return FAIL;
				if (args[0] === "push") return OK;
				return OK;
			},
			cmd: () => ({ ok: false, stdout: "", stderr: "gh: not authenticated" }),
		});
		const result = executeIntegration("pr", CTX, deps);
		expect(result.success).toBe(false);
		expect(result.error).toContain("PR creation failed");
		expect(result.error).toContain("create the PR manually");
	});

	test("pr title falls back to branch name when batchId empty", () => {
		let capturedTitle = "";
		const ctx: IntegrationContext = { ...CTX, batchId: "" };
		const { deps } = makeDeps({
			git: args => {
				if (args[0] === "merge-base") return FAIL;
				if (args[0] === "push") return OK;
				return OK;
			},
			cmd: (_cmd, args) => {
				const titleIdx = args.indexOf("--title");
				capturedTitle = args[titleIdx + 1] ?? "";
				return { ok: true, stdout: "", stderr: "" };
			},
		});
		executeIntegration("pr", ctx, deps);
		expect(capturedTitle).toBe("Integrate orch/b1");
	});
});
