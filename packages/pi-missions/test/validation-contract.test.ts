/**
 * Unit tests for the validation contract data layer (Track A1).
 *
 * Covers validateAssertionId, validateContractShape, createEmptyContract,
 * addAssertion, loadValidationContract, saveValidationContract, findAssertion,
 * and assertionsForMilestone.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	addAssertion,
	assertionsForMilestone,
	type BehavioralAssertion,
	createEmptyContract,
	findAssertion,
	loadValidationContract,
	saveValidationContract,
	VALIDATION_CONTRACT_FILENAME,
	VALIDATION_CONTRACT_SCHEMA_VERSION,
	type ValidationContract,
	validateAssertionId,
	validateContractShape,
	validationContractPath,
} from "../src/missioncontrol";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "omp-validation-contract-"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function assertion(overrides: Partial<BehavioralAssertion> = {}): BehavioralAssertion {
	return {
		id: "VA-001",
		area: "cli",
		title: "Creates hello-mission.md",
		description: "The CLI must produce a hello-mission.md file at the project root.",
		acceptanceCriteria: ["`hello-mission.md` exists", "File contains today's date"],
		...overrides,
	};
}

describe("validateAssertionId", () => {
	test("accepts well-formed VA-001", () => {
		expect(validateAssertionId("VA-001")).toBeNull();
		expect(validateAssertionId("VA-123")).toBeNull();
		expect(validateAssertionId("SEC-001")).toBeNull();
	});

	test("rejects non-string input", () => {
		expect(validateAssertionId(123)).not.toBeNull();
		expect(validateAssertionId(undefined)).not.toBeNull();
	});

	test("rejects lowercase or malformed ids", () => {
		expect(validateAssertionId("va-001")).not.toBeNull();
		expect(validateAssertionId("VA001")).not.toBeNull();
		expect(validateAssertionId("VA-1")).not.toBeNull(); // <3 digits
		expect(validateAssertionId("")).not.toBeNull();
	});
});

describe("validateContractShape", () => {
	test("accepts a minimal empty contract", () => {
		const c = createEmptyContract("batch-1");
		expect(() => validateContractShape(c)).not.toThrow();
	});

	test("rejects non-object input", () => {
		expect(() => validateContractShape(null)).toThrow();
		expect(() => validateContractShape("string")).toThrow();
		expect(() => validateContractShape([])).toThrow();
	});

	test("rejects wrong schema version", () => {
		const bad = { ...createEmptyContract("b-1"), schemaVersion: 2 } as unknown;
		expect(() => validateContractShape(bad)).toThrow(/schemaVersion/);
	});

	test("rejects missing missionId", () => {
		const c = createEmptyContract("b-1") as unknown as Record<string, unknown>;
		delete c.missionId;
		expect(() => validateContractShape(c)).toThrow(/missionId/);
	});

	test("rejects duplicate assertion ids", () => {
		const c = createEmptyContract("b-1");
		c.assertions = [assertion({ id: "VA-001" }), assertion({ id: "VA-001", title: "dup" })];
		expect(() => validateContractShape(c)).toThrow(/duplicate assertion id/);
	});

	test("rejects empty acceptanceCriteria", () => {
		const c = createEmptyContract("b-1");
		c.assertions = [assertion({ acceptanceCriteria: [] })];
		expect(() => validateContractShape(c)).toThrow(/acceptanceCriteria/);
	});

	test("rejects non-string acceptanceCriteria entries", () => {
		const c = createEmptyContract("b-1");
		(c.assertions as unknown as BehavioralAssertion[]).push(
			assertion({ acceptanceCriteria: ["ok", 42 as unknown as string] }),
		);
		expect(() => validateContractShape(c)).toThrow(/acceptanceCriteria\[1\]/);
	});

	test("rejects malformed assertion id", () => {
		const c = createEmptyContract("b-1");
		c.assertions = [assertion({ id: "not-an-id" })];
		expect(() => validateContractShape(c)).toThrow(/must match/);
	});
});

describe("createEmptyContract", () => {
	test("produces a valid contract with zero assertions", () => {
		const c = createEmptyContract("batch-42", 1000);
		expect(c.schemaVersion).toBe(VALIDATION_CONTRACT_SCHEMA_VERSION);
		expect(c.missionId).toBe("batch-42");
		expect(c.createdAt).toBe(1000);
		expect(c.updatedAt).toBe(1000);
		expect(c.assertions).toEqual([]);
	});

	test("refuses empty missionId", () => {
		expect(() => createEmptyContract("")).toThrow();
	});
});

describe("addAssertion", () => {
	test("appends to an empty contract", () => {
		const base = createEmptyContract("b", 1);
		const next = addAssertion(base, assertion(), 2);
		expect(next.assertions).toHaveLength(1);
		expect(next.assertions[0]?.id).toBe("VA-001");
		expect(next.updatedAt).toBe(2);
		expect(base.assertions).toHaveLength(0); // immutable
	});

	test("replaces an existing assertion by id", () => {
		const base = addAssertion(createEmptyContract("b"), assertion({ title: "v1" }));
		const next = addAssertion(base, assertion({ title: "v2" }));
		expect(next.assertions).toHaveLength(1);
		expect(next.assertions[0]?.title).toBe("v2");
	});

	test("appends distinct ids without collision", () => {
		let c = createEmptyContract("b");
		c = addAssertion(c, assertion({ id: "VA-001" }));
		c = addAssertion(c, assertion({ id: "VA-002", title: "another" }));
		expect(c.assertions.map(a => a.id)).toEqual(["VA-001", "VA-002"]);
	});

	test("rejects malformed id without mutating input", () => {
		const base = createEmptyContract("b");
		expect(() => addAssertion(base, assertion({ id: "bad-id" }))).toThrow();
		expect(base.assertions).toHaveLength(0);
	});
});

describe("validationContractPath", () => {
	test("resolves under the project's agent dir", () => {
		const p = validationContractPath(sandbox);
		expect(p.endsWith(VALIDATION_CONTRACT_FILENAME)).toBe(true);
		expect(p.startsWith(sandbox)).toBe(true);
	});
});

describe("saveValidationContract / loadValidationContract", () => {
	test("round-trips a contract with multiple assertions", async () => {
		const contract: ValidationContract = {
			schemaVersion: VALIDATION_CONTRACT_SCHEMA_VERSION,
			missionId: "batch-xyz",
			createdAt: 1,
			updatedAt: 2,
			assertions: [assertion({ id: "VA-001" }), assertion({ id: "VA-002", area: "api", title: "b" })],
		};
		await saveValidationContract(sandbox, contract);
		const loaded = await loadValidationContract(sandbox);
		expect(loaded).toEqual(contract);
	});

	test("loadValidationContract returns null when file is missing", async () => {
		const result = await loadValidationContract(sandbox);
		expect(result).toBeNull();
	});

	test("rejects saving an invalid contract", async () => {
		const bad = { ...createEmptyContract("b"), assertions: [assertion({ id: "bad" })] };
		await expect(saveValidationContract(sandbox, bad)).rejects.toThrow();
	});

	test("loadValidationContract throws on malformed JSON", async () => {
		const path = validationContractPath(sandbox);
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const { dirname } = await import("node:path");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{not-json", "utf-8");
		await expect(loadValidationContract(sandbox)).rejects.toThrow(/not valid JSON/);
	});
});

describe("findAssertion + assertionsForMilestone", () => {
	test("findAssertion returns undefined for absent id", () => {
		const c = createEmptyContract("b");
		expect(findAssertion(c, "VA-001")).toBeUndefined();
	});

	test("findAssertion returns the assertion when present", () => {
		let c = createEmptyContract("b");
		c = addAssertion(c, assertion({ id: "VA-042" }));
		expect(findAssertion(c, "VA-042")?.id).toBe("VA-042");
	});

	test("assertionsForMilestone returns unbound + milestone-bound entries", () => {
		let c = createEmptyContract("b");
		c = addAssertion(c, assertion({ id: "VA-001" })); // unbound
		c = addAssertion(c, assertion({ id: "VA-002", milestoneId: "M-001" }));
		c = addAssertion(c, assertion({ id: "VA-003", milestoneId: "M-002" }));
		const m1 = assertionsForMilestone(c, "M-001");
		expect(m1.map(a => a.id)).toEqual(["VA-001", "VA-002"]);
		const m2 = assertionsForMilestone(c, "M-002");
		expect(m2.map(a => a.id)).toEqual(["VA-001", "VA-003"]);
	});

	test("assertionsForMilestone returns empty array for empty milestoneId", () => {
		let c = createEmptyContract("b");
		c = addAssertion(c, assertion({ id: "VA-001" }));
		expect(assertionsForMilestone(c, "")).toEqual([]);
	});
});
