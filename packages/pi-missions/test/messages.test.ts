import { describe, expect, test } from "bun:test";
import { MISSION_MESSAGES } from "../src/missioncontrol/messages";

describe("MISSION_MESSAGES templates", () => {
	test("batchStarting formats batch id + counts", () => {
		expect(MISSION_MESSAGES.batchStarting("b-1", 2, 7)).toBe("🚀 Starting batch b-1: 2 wave(s), 7 task(s)");
	});
	test("waveStart mentions wave/total and lane count", () => {
		const out = MISSION_MESSAGES.waveStart(1, 3, 4, 2);
		expect(out).toContain("Wave 1/3");
		expect(out).toContain("4 task(s)");
		expect(out).toContain("2 lane(s)");
	});
	test("mergeLaneSuccess truncates commit to 8 chars", () => {
		const out = MISSION_MESSAGES.mergeLaneSuccess(1, "abcdef1234567890", 5);
		expect(out).toContain("abcdef12");
		expect(out).not.toContain("abcdef1234567890");
	});
	test("batchComplete without failures omits next-steps block", () => {
		const out = MISSION_MESSAGES.batchComplete("b-1", 3, 0, 0, 0, 42);
		expect(out).not.toContain("/mission-status");
		expect(out).not.toContain("/mission-batch-resume");
	});
	test("batchComplete with failures suggests mission commands", () => {
		const out = MISSION_MESSAGES.batchComplete("b-1", 1, 2, 0, 0, 42);
		expect(out).toContain("/mission-status");
		expect(out).toContain("/mission-batch-resume");
		expect(out).toContain("/mission-abort");
	});
	test("batchComplete with mission branch shows integrate guidance", () => {
		const out = MISSION_MESSAGES.batchComplete("b-1", 3, 0, 0, 0, 42, "omp/mission-b-1", "main");
		expect(out).toContain("omp/mission-b-1");
		expect(out).toContain("git log main..omp/mission-b-1");
		expect(out).toContain("/mission-integrate");
	});
	test("resumeNoState references .omp path, not .pi", () => {
		const out = MISSION_MESSAGES.resumeNoState();
		expect(out).not.toContain(".pi/");
		expect(out).toContain("/mission-batch");
	});
	test("resumeInvalidState points at .omp/mission-batch.json", () => {
		expect(MISSION_MESSAGES.resumeInvalidState("bad json")).toContain(".omp/mission-batch.json");
	});
	test("abortComplete narrates mode", () => {
		expect(MISSION_MESSAGES.abortComplete("graceful", 3)).toContain("(graceful)");
		expect(MISSION_MESSAGES.abortComplete("hard", 3)).toContain("(hard)");
	});
	test("integrationManual renders preview commands", () => {
		const out = MISSION_MESSAGES.integrationManual("omp/mission-b-1", "main", 5);
		expect(out).toContain("5 merged task(s)");
		expect(out).toContain("git log main..omp/mission-b-1");
		expect(out).toContain("git merge omp/mission-b-1");
	});
});
