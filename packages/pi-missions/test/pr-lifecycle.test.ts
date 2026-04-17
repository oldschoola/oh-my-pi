/**
 * Tests for `pollPrCiStatus` + `mergePr` ported from taskplane
 * `extensions/taskplane/supervisor.ts:625,709`.
 */

import { describe, expect, test } from "bun:test";
import { type CiDeps, mergePr, pollPrCiStatus } from "../src/missioncontrol";

type CmdResult = { ok: boolean; stdout: string; stderr: string };

function stubDeps(results: CmdResult[]): { deps: CiDeps; calls: Array<{ cmd: string; args: string[] }> } {
	const calls: Array<{ cmd: string; args: string[] }> = [];
	let i = 0;
	const deps: CiDeps = {
		runCommand: (cmd, args) => {
			calls.push({ cmd, args });
			const next = results[i++];
			if (!next) throw new Error(`stubDeps: exhausted after ${calls.length} call(s)`);
			return next;
		},
		runGit: () => ({ ok: true, stdout: "", stderr: "" }),
		deleteBatchState: () => {},
	};
	return { deps, calls };
}

describe("pollPrCiStatus", () => {
	test("returns pass when all checks SUCCESS", async () => {
		const { deps } = stubDeps([
			{
				ok: true,
				stdout: JSON.stringify([
					{ name: "lint", state: "COMPLETED", conclusion: "SUCCESS" },
					{ name: "test", state: "COMPLETED", conclusion: "SUCCESS" },
				]),
				stderr: "",
			},
		]);
		const res = await pollPrCiStatus("mission/b-1", deps, 1, 0);
		expect(res.status).toBe("pass");
		expect(res.detail).toContain("2 CI check(s) passed");
	});

	test("treats NEUTRAL + SKIPPED as passing", async () => {
		const { deps } = stubDeps([
			{
				ok: true,
				stdout: JSON.stringify([
					{ name: "a", state: "COMPLETED", conclusion: "NEUTRAL" },
					{ name: "b", state: "COMPLETED", conclusion: "SKIPPED" },
				]),
				stderr: "",
			},
		]);
		const res = await pollPrCiStatus("mission/b-1", deps, 1, 0);
		expect(res.status).toBe("pass");
	});

	test("returns fail with names when any check FAILURE", async () => {
		const { deps } = stubDeps([
			{
				ok: true,
				stdout: JSON.stringify([
					{ name: "lint", state: "COMPLETED", conclusion: "SUCCESS" },
					{ name: "test", state: "COMPLETED", conclusion: "FAILURE" },
				]),
				stderr: "",
			},
		]);
		const res = await pollPrCiStatus("mission/b-1", deps, 1, 0);
		expect(res.status).toBe("fail");
		expect(res.detail).toContain("test: FAILURE");
	});

	test("returns no-checks when stderr mentions 'no checks'", async () => {
		const { deps } = stubDeps([{ ok: false, stdout: "", stderr: "no checks reported" }]);
		const res = await pollPrCiStatus("mission/b-1", deps, 1, 0);
		expect(res.status).toBe("no-checks");
	});

	test("returns no-checks when result is empty array", async () => {
		const { deps } = stubDeps([{ ok: true, stdout: "[]", stderr: "" }]);
		const res = await pollPrCiStatus("mission/b-1", deps, 1, 0);
		expect(res.status).toBe("no-checks");
	});

	test("retries on first failure then succeeds", async () => {
		const { deps, calls } = stubDeps([
			{ ok: false, stdout: "", stderr: "temp unavailable" },
			{
				ok: true,
				stdout: JSON.stringify([{ name: "lint", state: "COMPLETED", conclusion: "SUCCESS" }]),
				stderr: "",
			},
		]);
		const res = await pollPrCiStatus("mission/b-1", deps, 2, 0);
		expect(res.status).toBe("pass");
		expect(calls.length).toBe(2);
	});

	test("returns fail after second consecutive command failure", async () => {
		const { deps } = stubDeps([
			{ ok: false, stdout: "", stderr: "auth bad" },
			{ ok: false, stdout: "", stderr: "auth bad" },
		]);
		const res = await pollPrCiStatus("mission/b-1", deps, 2, 0);
		expect(res.status).toBe("fail");
		expect(res.detail).toContain("auth bad");
	});

	test("returns timeout when checks never complete", async () => {
		const pending = {
			ok: true,
			stdout: JSON.stringify([{ name: "lint", state: "IN_PROGRESS", conclusion: "" }]),
			stderr: "",
		};
		const { deps } = stubDeps([pending, pending]);
		const res = await pollPrCiStatus("mission/b-1", deps, 2, 0);
		expect(res.status).toBe("timeout");
	});
});

describe("mergePr", () => {
	test("success via regular --merge", () => {
		const { deps, calls } = stubDeps([{ ok: true, stdout: "merged", stderr: "" }]);
		const res = mergePr("mission/b-1", deps);
		expect(res.success).toBe(true);
		expect(res.detail).toContain("merged");
		expect(calls[0]?.args).toContain("--merge");
	});

	test("falls back to --squash on first failure", () => {
		const { deps, calls } = stubDeps([
			{ ok: false, stdout: "", stderr: "merge commits not allowed" },
			{ ok: true, stdout: "squashed", stderr: "" },
		]);
		const res = mergePr("mission/b-1", deps);
		expect(res.success).toBe(true);
		expect(res.detail).toContain("squash");
		expect(calls[1]?.args).toContain("--squash");
	});

	test("returns failure when both merge + squash fail", () => {
		const { deps } = stubDeps([
			{ ok: false, stdout: "", stderr: "merge blocked" },
			{ ok: false, stdout: "", stderr: "squash blocked too" },
		]);
		const res = mergePr("mission/b-1", deps);
		expect(res.success).toBe(false);
		expect(res.detail).toContain("squash blocked too");
	});
});
