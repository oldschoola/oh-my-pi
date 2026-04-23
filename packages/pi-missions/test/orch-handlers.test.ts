/**
 * Unit tests for shared orch handlers (Track J1).
 *
 * These handlers are the backend for both the CLI supervisor tools and
 * the dashboard HTTP endpoints \u2014 a regression here means the two
 * surfaces diverge.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectAgentDir } from "@oh-my-pi/pi-utils";
import type { PersistedBatchState } from "../src/missioncontrol";
import {
	handleAddAssertion,
	handleApprovePlan,
	handleCreateMilestone,
	handleListSkills,
	handleLoadMilestones,
	handleReadPlanManifest,
	handleReadRoleModels,
	handleReadValidationContract,
	handleReadValidationStatus,
	handleSetRoleModel,
	handleTelemetryRollup,
	handleWriteValidationContract,
	missionBatchPath,
	missionsDir,
} from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-orch-handlers-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function seedBatchState(overrides: Partial<PersistedBatchState> = {}): PersistedBatchState {
	const state: PersistedBatchState = {
		schemaVersion: 5,
		phase: "executing",
		batchId: "batch-1",
		baseBranch: "main",
		orchBranch: "",
		mode: "repo",
		startedAt: 100,
		updatedAt: 200,
		endedAt: null,
		currentWaveIndex: 0,
		totalWaves: 1,
		totalTasks: 1,
		succeededTasks: 0,
		failedTasks: 0,
		skippedTasks: 0,
		blockedTasks: 0,
		blockedTaskIds: [],
		lanes: [
			{
				laneNumber: 1,
				laneId: "l-1",
				laneSessionId: "sess-1",
				worktreePath: "/wt/1",
				branch: "b-1",
				taskIds: ["T-001"],
			},
		],
		tasks: [
			{
				taskId: "T-001",
				laneNumber: 1,
				sessionName: "sess-1",
				status: "pending",
				taskFolder: "tasks/T-001",
				startedAt: null,
				endedAt: null,
				doneFileFound: false,
				exitReason: "",
			},
		],
		wavePlan: [["T-001"]],
		mergeResults: [],
		errors: [],
		resilience: {
			resumeForced: false,
			retryCountByScope: {},
			lastFailureClass: null,
			repairHistory: [],
		},
		diagnostics: { taskExits: {}, batchCost: 0 },
		segments: [],
		lastError: null,
		...overrides,
	};
	const filePath = missionBatchPath(sandbox);
	mkdirSyncSafe(getProjectAgentDir(sandbox));
	writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
	return state;
}

function mkdirSyncSafe(dir: string): void {
	try {
		require("node:fs").mkdirSync(dir, { recursive: true });
	} catch {}
}

describe("validation contract handlers", () => {
	test("write + read round-trips the contract", async () => {
		const contract = await handleWriteValidationContract({
			cwd: sandbox,
			missionId: "m-1",
			assertions: [
				{
					id: "VA-001",
					area: "cli",
					title: "help",
					description: "cli help",
					acceptanceCriteria: ["exit 0"],
				},
			],
		});
		expect(contract.assertions).toHaveLength(1);
		const read = await handleReadValidationContract(sandbox);
		expect(read?.missionId).toBe(contract.missionId);
	});

	test("addAssertion appends / replaces", async () => {
		await handleAddAssertion({
			cwd: sandbox,
			missionId: "m-1",
			assertion: {
				id: "VA-001",
				area: "cli",
				title: "help",
				description: "d",
				acceptanceCriteria: ["exit 0"],
			},
		});
		const updated = await handleAddAssertion({
			cwd: sandbox,
			missionId: "m-1",
			assertion: {
				id: "VA-001",
				area: "cli",
				title: "help v2",
				description: "d",
				acceptanceCriteria: ["exit 0"],
			},
		});
		expect(updated.assertions).toHaveLength(1);
		expect(updated.assertions[0]?.title).toBe("help v2");
	});

	test("write rejects duplicate ids", async () => {
		await expect(
			handleWriteValidationContract({
				cwd: sandbox,
				missionId: "m-1",
				assertions: [
					{ id: "VA-001", area: "cli", title: "a", description: "d", acceptanceCriteria: ["x"] },
					{ id: "VA-001", area: "cli", title: "b", description: "d", acceptanceCriteria: ["x"] },
				],
			}),
		).rejects.toThrow(/Duplicate assertion/);
	});
});

describe("milestone handlers", () => {
	test("createMilestone updates persisted state", async () => {
		seedBatchState();
		const result = await handleCreateMilestone({
			cwd: sandbox,
			id: "M-002",
			name: "Milestone two",
			featureIds: ["T-001"],
			assertionIds: ["VA-001"],
		});
		expect(result.milestone.id).toBe("M-002");
		expect(result.milestoneCount).toBe(1);
		const milestones = await handleLoadMilestones(sandbox);
		expect(milestones[0]?.featureIds).toEqual(["T-001"]);
	});

	test("createMilestone preserves existing milestone when id matches", async () => {
		seedBatchState();
		await handleCreateMilestone({
			cwd: sandbox,
			id: "M-001",
			name: "first",
			featureIds: ["T-001"],
		});
		const result = await handleCreateMilestone({
			cwd: sandbox,
			id: "M-001",
			name: "renamed",
		});
		expect(result.milestoneCount).toBe(1);
		expect(result.milestone.name).toBe("renamed");
	});

	test("createMilestone fails when no batch state", async () => {
		await expect(handleCreateMilestone({ cwd: sandbox, id: "M-001", name: "a" })).rejects.toThrow(
			/No persisted batch state/,
		);
	});

	test("readValidationStatus returns milestones + bound assertions", async () => {
		seedBatchState();
		await handleWriteValidationContract({
			cwd: sandbox,
			missionId: "batch-1",
			assertions: [{ id: "VA-001", area: "cli", title: "a", description: "d", acceptanceCriteria: ["x"] }],
		});
		await handleCreateMilestone({
			cwd: sandbox,
			id: "M-007",
			name: "seven",
			featureIds: ["T-001"],
			assertionIds: ["VA-001"],
		});
		const status = await handleReadValidationStatus(sandbox, "M-007");
		expect(status?.rows[0]?.milestone.id).toBe("M-007");
		expect(status?.rows[0]?.boundAssertions[0]?.id).toBe("VA-001");
	});
});

describe("plan manifest handlers", () => {
	test("approvePlan writes approved manifest", async () => {
		const manifest = await handleApprovePlan({
			cwd: sandbox,
			missionId: "batch-1",
			milestoneIds: ["M-001"],
			featureIds: ["F-001"],
			approvedBy: "alice",
		});
		expect(manifest.status).toBe("approved");
		expect(manifest.approvedBy).toBe("alice");
		const read = await handleReadPlanManifest(sandbox);
		expect(read?.approvedAt).toBe(manifest.approvedAt);
	});
});

describe("role model handlers", () => {
	test("setRoleModel persists override and describes it", async () => {
		const result = handleSetRoleModel({
			cwd: sandbox,
			role: "worker",
			model: "claude-haiku",
		});
		expect(result.cleared).toBe(false);
		expect(result.model).toBe("claude-haiku");
		const roles = await handleReadRoleModels(sandbox);
		const worker = roles.find(r => r.role === "worker");
		expect(worker?.model).toBe("claude-haiku");
		expect(worker?.source).toBe("missions-override");
	});

	test("setRoleModel with blank clears the override", async () => {
		handleSetRoleModel({ cwd: sandbox, role: "worker", model: "claude-haiku" });
		const cleared = handleSetRoleModel({ cwd: sandbox, role: "worker", model: "" });
		expect(cleared.cleared).toBe(true);
	});

	test("invalid role rejected", () => {
		expect(() => handleSetRoleModel({ cwd: sandbox, role: "planner", model: "x" })).toThrow(/Invalid role/);
	});
});

describe("telemetry handlers", () => {
	test("telemetryRollup returns null when no batch state", async () => {
		expect(await handleTelemetryRollup(sandbox)).toBeNull();
	});

	test("telemetryRollup returns a rollup when batch state exists", async () => {
		seedBatchState();
		const rollup = await handleTelemetryRollup(sandbox);
		expect(rollup).not.toBeNull();
		expect(rollup?.perRole.length).toBeGreaterThan(0);
	});
});

describe("path helpers", () => {
	test("missionsDir resolves under the project", () => {
		expect(missionsDir(sandbox).startsWith(sandbox)).toBe(true);
	});

	test("seedBatchState writes an accessible mission-batch.json", async () => {
		seedBatchState();
		expect(existsSync(missionBatchPath(sandbox))).toBe(true);
	});
});

describe("handleListSkills", () => {
	test("returns empty arrays when skills root is absent", async () => {
		const result = await handleListSkills(sandbox);
		expect(result.promoted).toEqual([]);
		expect(result.drafts).toEqual([]);
	});

	test("discovers promoted + draft skills", async () => {
		const skillsDir = join(getProjectAgentDir(sandbox), "skills");
		await mkdir(join(skillsDir, "mission-control"), { recursive: true });
		writeFileSync(
			join(skillsDir, "mission-control", "SKILL.md"),
			`---\nname: mission-control\nversion: 1.0.0\ndescription: Orchestrate batches\n---\n\nbody\n`,
			"utf-8",
		);
		await mkdir(join(skillsDir, "drafts", "exp-a"), { recursive: true });
		writeFileSync(
			join(skillsDir, "drafts", "exp-a", "SKILL.md"),
			`---\nname: exp-a\nversion: 0.1.0\ndescription: Experimental skill\n---\n\nbody\n`,
			"utf-8",
		);
		const result = await handleListSkills(sandbox);
		expect(result.promoted.map(s => s.name)).toEqual(["mission-control"]);
		expect(result.drafts.map(s => s.name)).toEqual(["exp-a"]);
		expect(result.promoted[0]?.origin).toBe("promoted");
		expect(result.drafts[0]?.origin).toBe("draft");
	});
});

// silence unused imports from node:fs/promises and mkdir
void mkdir;
