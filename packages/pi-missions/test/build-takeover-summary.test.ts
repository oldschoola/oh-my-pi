/**
 * Tests for `buildTakeoverSummary` ported from taskplane
 * `extensions/taskplane/supervisor.ts:3446-3501`.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendAuditEntry,
	buildTakeoverSummary,
	type PersistedBatchState,
	projectDir,
	supervisorEventsPath,
} from "../src/missioncontrol";

function sandbox(label: string): string {
	return mkdtempSync(join(tmpdir(), `omp-takeover-${label}-`));
}

function state(overrides?: Partial<PersistedBatchState>): PersistedBatchState {
	return {
		batchId: "b-1",
		phase: "running",
		currentWaveIndex: 1,
		totalWaves: 3,
		baseBranch: "main",
		tasks: [],
		...overrides,
	} as PersistedBatchState;
}

describe("buildTakeoverSummary", () => {
	test("renders header with batch id, phase, wave, base branch", () => {
		const dir = sandbox("header");
		try {
			const out = buildTakeoverSummary(dir, state());
			expect(out).toContain("Taking over batch b-1");
			expect(out).toContain("**Phase:** running");
			expect(out).toContain("**Wave:** 2/3");
			expect(out).toContain("**Base branch:** main");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("prefers wavePlan length over totalWaves for denominator", () => {
		const dir = sandbox("wave-plan");
		try {
			const out = buildTakeoverSummary(
				dir,
				state({
					currentWaveIndex: 0,
					totalWaves: 99,
					wavePlan: [{} as never, {} as never, {} as never, {} as never, {} as never],
				}),
			);
			expect(out).toContain("**Wave:** 1/5");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("falls back to ? when no wave info is present", () => {
		const dir = sandbox("no-wave");
		try {
			const out = buildTakeoverSummary(
				dir,
				state({ currentWaveIndex: undefined, totalWaves: undefined, wavePlan: undefined }),
			);
			expect(out).toContain("**Wave:** 1/?");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("counts task statuses", () => {
		const dir = sandbox("counts");
		try {
			const tasks = [
				{ status: "succeeded" },
				{ status: "succeeded" },
				{ status: "failed" },
				{ status: "running" },
				{ status: "pending" },
				{ status: "pending" },
				{ status: "pending" },
			] as PersistedBatchState["tasks"];
			const out = buildTakeoverSummary(dir, state({ tasks }));
			expect(out).toContain("**Tasks:** 2 succeeded, 1 failed, 1 running, 3 pending");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("appends the last 5 audit entries", () => {
		const dir = sandbox("audit");
		try {
			for (let i = 0; i < 7; i++) {
				appendAuditEntry(dir, {
					ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
					batchId: "b-1",
					action: `action-${i}`,
					context: `ctx-${i}`,
					classification: "diagnostic",
					result: "success",
					command: "noop",
					detail: "",
				});
			}
			const out = buildTakeoverSummary(dir, state());
			expect(out).toContain("Previous supervisor actions");
			expect(out).toContain("action-2");
			expect(out).toContain("action-6");
			expect(out).not.toContain("action-0");
			expect(out).not.toContain("action-1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("renders last 5 supervisor events, handles unparseable lines", () => {
		const dir = sandbox("events");
		try {
			const eventsPath = supervisorEventsPath(dir);
			mkdirSync(projectDir(dir), { recursive: true });
			mkdirSync(join(projectDir(dir), "supervisor"), { recursive: true });
			const lines = [
				'{"type":"a","message":"first"}',
				'{"type":"b","taskId":"T-1"}',
				"not json",
				'{"type":"c","message":"third"}',
				'{"type":"d","message":"fourth"}',
				'{"type":"e","message":"fifth"}',
			];
			writeFileSync(eventsPath, `${lines.join("\n")}\n`, "utf-8");
			const out = buildTakeoverSummary(dir, state());
			expect(out).toContain("Recent engine events");
			expect(out).toContain("(last 5)");
			expect(out).toContain("[b] T-1");
			expect(out).toContain("(unparseable event)");
			expect(out).toContain("[e] fifth");
			expect(out).not.toContain("[a] first");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("omits audit + events sections when files missing", () => {
		const dir = sandbox("missing");
		try {
			const out = buildTakeoverSummary(dir, state());
			expect(out).not.toContain("Previous supervisor actions");
			expect(out).not.toContain("Recent engine events");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
