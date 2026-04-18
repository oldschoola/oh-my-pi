import { describe, expect, test } from "bun:test";

import type { ParsedTask } from "../src/missioncontrol/discovery";
import { DEFAULT_ORCHESTRATOR_CONFIG, type OrchestratorConfig } from "../src/missioncontrol/types";
import { validateAllocationInputs } from "../src/missioncontrol/waves";

function mkTask(taskId: string): ParsedTask {
	return {
		taskId,
		taskName: taskId.toLowerCase(),
		folderPath: `/repo/tasks/${taskId}`,
		promptPath: `/repo/tasks/${taskId}/PROMPT.md`,
		prompt: "",
		dependencies: [],
		size: "M",
	};
}

function mkPending(ids: string[]): Map<string, ParsedTask> {
	const map = new Map<string, ParsedTask>();
	for (const id of ids) map.set(id, mkTask(id));
	return map;
}

function mkConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
	return {
		...DEFAULT_ORCHESTRATOR_CONFIG,
		...overrides,
		orchestrator: { ...DEFAULT_ORCHESTRATOR_CONFIG.orchestrator, ...(overrides.orchestrator ?? {}) },
		assignment: { ...DEFAULT_ORCHESTRATOR_CONFIG.assignment, ...(overrides.assignment ?? {}) },
	};
}

describe("validateAllocationInputs", () => {
	test("returns null for valid inputs", () => {
		const err = validateAllocationInputs(["T-1"], mkPending(["T-1"]), mkConfig());
		expect(err).toBeNull();
	});

	test("rejects max_lanes = 0 with ALLOC_INVALID_CONFIG", () => {
		const err = validateAllocationInputs(
			["T-1"],
			mkPending(["T-1"]),
			mkConfig({ orchestrator: { ...DEFAULT_ORCHESTRATOR_CONFIG.orchestrator, max_lanes: 0 } }),
		);
		expect(err?.code).toBe("ALLOC_INVALID_CONFIG");
		expect(err?.message).toContain("max_lanes");
	});

	test("rejects negative max_lanes", () => {
		const err = validateAllocationInputs(
			["T-1"],
			mkPending(["T-1"]),
			mkConfig({ orchestrator: { ...DEFAULT_ORCHESTRATOR_CONFIG.orchestrator, max_lanes: -1 } }),
		);
		expect(err?.code).toBe("ALLOC_INVALID_CONFIG");
	});

	test("rejects non-integer max_lanes", () => {
		const err = validateAllocationInputs(
			["T-1"],
			mkPending(["T-1"]),
			mkConfig({ orchestrator: { ...DEFAULT_ORCHESTRATOR_CONFIG.orchestrator, max_lanes: 2.5 } }),
		);
		expect(err?.code).toBe("ALLOC_INVALID_CONFIG");
		expect(err?.message).toContain("positive integer");
	});

	test("rejects empty wave with ALLOC_EMPTY_WAVE", () => {
		const err = validateAllocationInputs([], mkPending(["T-1"]), mkConfig());
		expect(err?.code).toBe("ALLOC_EMPTY_WAVE");
	});

	test("rejects missing tasks with ALLOC_TASK_NOT_FOUND", () => {
		const err = validateAllocationInputs(["T-1", "T-99"], mkPending(["T-1"]), mkConfig());
		expect(err?.code).toBe("ALLOC_TASK_NOT_FOUND");
		expect(err?.message).toContain("T-99");
		expect(err?.details).toContain("completed or removed");
	});

	test("lists every missing task id in the error message", () => {
		const err = validateAllocationInputs(["A", "B", "C"], mkPending(["A"]), mkConfig());
		expect(err?.code).toBe("ALLOC_TASK_NOT_FOUND");
		expect(err?.message).toContain("B");
		expect(err?.message).toContain("C");
	});

	test("rejects unknown strategy with ALLOC_INVALID_CONFIG", () => {
		const err = validateAllocationInputs(
			["T-1"],
			mkPending(["T-1"]),
			mkConfig({
				assignment: {
					...DEFAULT_ORCHESTRATOR_CONFIG.assignment,
					strategy: "totally-bogus" as unknown as OrchestratorConfig["assignment"]["strategy"],
				},
			}),
		);
		expect(err?.code).toBe("ALLOC_INVALID_CONFIG");
		expect(err?.message).toContain("totally-bogus");
	});

	test("accepts each valid strategy", () => {
		for (const strategy of ["affinity-first", "round-robin", "load-balanced"] as const) {
			const err = validateAllocationInputs(
				["T-1"],
				mkPending(["T-1"]),
				mkConfig({
					assignment: { ...DEFAULT_ORCHESTRATOR_CONFIG.assignment, strategy },
				}),
			);
			expect(err).toBeNull();
		}
	});

	test("rejects empty worktree_prefix", () => {
		const err = validateAllocationInputs(
			["T-1"],
			mkPending(["T-1"]),
			mkConfig({ orchestrator: { ...DEFAULT_ORCHESTRATOR_CONFIG.orchestrator, worktree_prefix: "" } }),
		);
		expect(err?.code).toBe("ALLOC_INVALID_CONFIG");
		expect(err?.message).toContain("worktree_prefix");
	});

	test("rejects whitespace-only worktree_prefix", () => {
		const err = validateAllocationInputs(
			["T-1"],
			mkPending(["T-1"]),
			mkConfig({ orchestrator: { ...DEFAULT_ORCHESTRATOR_CONFIG.orchestrator, worktree_prefix: "   " } }),
		);
		expect(err?.code).toBe("ALLOC_INVALID_CONFIG");
	});

	test("max_lanes error reported before empty-wave error", () => {
		const err = validateAllocationInputs(
			[],
			mkPending([]),
			mkConfig({ orchestrator: { ...DEFAULT_ORCHESTRATOR_CONFIG.orchestrator, max_lanes: 0 } }),
		);
		expect(err?.code).toBe("ALLOC_INVALID_CONFIG");
		expect(err?.message).toContain("max_lanes");
	});
});
