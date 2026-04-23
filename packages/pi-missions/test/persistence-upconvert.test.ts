import { describe, expect, test } from "bun:test";

import {
	BATCH_STATE_SCHEMA_VERSION,
	StateFileError,
	upconvertV1toV2,
	upconvertV2toV3,
	upconvertV3toV4,
} from "../src/missioncontrol";

function v1(): Record<string, unknown> {
	return {
		schemaVersion: 1,
		phase: "idle",
		batchId: "b-1",
		lanes: [],
		tasks: [],
		wavePlan: [],
	};
}

describe("upconvertV1toV2", () => {
	test("bumps schemaVersion to 2 and fills baseBranch + mode defaults", () => {
		const obj = v1();
		upconvertV1toV2(obj);
		expect(obj.schemaVersion).toBe(2);
		expect(obj.baseBranch).toBe("");
		expect(obj.mode).toBe("repo");
	});

	test("preserves existing baseBranch and mode when already present", () => {
		const obj = { ...v1(), baseBranch: "main", mode: "workspace" };
		upconvertV1toV2(obj);
		expect(obj.baseBranch).toBe("main");
		expect(obj.mode).toBe("workspace");
	});

	test("is a no-op on already-v2 object", () => {
		const obj = { ...v1(), schemaVersion: 2, baseBranch: "dev", mode: "workspace" };
		upconvertV1toV2(obj);
		expect(obj.schemaVersion).toBe(2);
		expect(obj.baseBranch).toBe("dev");
		expect(obj.mode).toBe("workspace");
	});

	test("is a no-op on v3+ object (does not downgrade)", () => {
		const obj = { ...v1(), schemaVersion: 3 };
		upconvertV1toV2(obj);
		expect(obj.schemaVersion).toBe(3);
	});

	test("is idempotent when called twice", () => {
		const obj = v1();
		upconvertV1toV2(obj);
		const snapshot = { ...obj };
		upconvertV1toV2(obj);
		expect(obj).toEqual(snapshot);
	});
});

describe("upconvertV2toV3", () => {
	function v2(): Record<string, unknown> {
		const obj = v1();
		upconvertV1toV2(obj);
		return obj;
	}

	test("bumps schemaVersion to 3 and fills resilience + diagnostics defaults", () => {
		const obj = v2();
		upconvertV2toV3(obj);
		expect(obj.schemaVersion).toBe(3);
		expect(obj.resilience).toEqual({
			resumeForced: false,
			retryCountByScope: {},
			lastFailureClass: null,
			repairHistory: [],
		});
		expect(obj.diagnostics).toEqual({ taskExits: {}, batchCost: 0 });
	});

	test("preserves existing resilience and diagnostics sections", () => {
		const existingResilience = {
			resumeForced: true,
			retryCountByScope: { "TP-001:w0:l1": 2 },
			lastFailureClass: null,
			repairHistory: [],
		};
		const existingDiagnostics = { taskExits: {}, batchCost: 4.2 };
		const obj = { ...v2(), resilience: existingResilience, diagnostics: existingDiagnostics };
		upconvertV2toV3(obj);
		expect(obj.resilience).toBe(existingResilience);
		expect(obj.diagnostics).toBe(existingDiagnostics);
	});

	test("is a no-op on already-v3 object", () => {
		const obj: Record<string, unknown> = { ...v2(), schemaVersion: 3 };
		upconvertV2toV3(obj);
		expect(obj.schemaVersion).toBe(3);
		expect(obj.resilience).toBeUndefined();
		expect(obj.diagnostics).toBeUndefined();
	});

	test("is a no-op on v4+ object", () => {
		const obj = { ...v2(), schemaVersion: 4 };
		upconvertV2toV3(obj);
		expect(obj.schemaVersion).toBe(4);
	});

	test("is idempotent when called twice", () => {
		const obj = v2();
		upconvertV2toV3(obj);
		const snapshot = JSON.parse(JSON.stringify(obj));
		upconvertV2toV3(obj);
		expect(obj).toEqual(snapshot);
	});
});

describe("upconvertV3toV4", () => {
	function v3(): Record<string, unknown> {
		const obj = v1();
		upconvertV1toV2(obj);
		upconvertV2toV3(obj);
		return obj;
	}

	test("bumps schemaVersion to 4 and fills segments: []", () => {
		const obj = v3();
		upconvertV3toV4(obj);
		expect(obj.schemaVersion).toBe(4);
		expect(obj.segments).toEqual([]);
	});

	test("preserves existing segments array", () => {
		const existing = [{ segmentId: "s-1", taskId: "TP-001" }];
		const obj = { ...v3(), segments: existing };
		upconvertV3toV4(obj);
		expect(obj.segments).toBe(existing);
	});

	test("is a no-op on already-v4 object", () => {
		const obj: Record<string, unknown> = { ...v3(), schemaVersion: 4 };
		upconvertV3toV4(obj);
		expect(obj.schemaVersion).toBe(4);
		expect(obj.segments).toBeUndefined();
	});

	test("is a no-op on v5+ object (future-proof)", () => {
		const obj = { ...v3(), schemaVersion: 5 };
		upconvertV3toV4(obj);
		expect(obj.schemaVersion).toBe(5);
	});

	test("is idempotent when called twice", () => {
		const obj = v3();
		upconvertV3toV4(obj);
		const snapshot = JSON.parse(JSON.stringify(obj));
		upconvertV3toV4(obj);
		expect(obj).toEqual(snapshot);
	});
});

describe("chained upconvert v1 → v2 → v3 → v4 (partial chain)", () => {
	test("produces a fully populated v4 object from a v1 object", () => {
		const obj = v1();
		upconvertV1toV2(obj);
		upconvertV2toV3(obj);
		upconvertV3toV4(obj);

		expect(obj.schemaVersion).toBe(4);
		expect(obj.baseBranch).toBe("");
		expect(obj.mode).toBe("repo");
		expect(obj.resilience).toEqual({
			resumeForced: false,
			retryCountByScope: {},
			lastFailureClass: null,
			repairHistory: [],
		});
		expect(obj.diagnostics).toEqual({ taskExits: {}, batchCost: 0 });
		expect(obj.segments).toEqual([]);
	});

	test("re-running v1→v4 is idempotent", () => {
		const obj = v1();
		upconvertV1toV2(obj);
		upconvertV2toV3(obj);
		upconvertV3toV4(obj);
		const snapshot = JSON.parse(JSON.stringify(obj));

		upconvertV1toV2(obj);
		upconvertV2toV3(obj);
		upconvertV3toV4(obj);

		expect(obj).toEqual(snapshot);
	});

	test("BATCH_STATE_SCHEMA_VERSION constant is 5 (current)", () => {
		expect(BATCH_STATE_SCHEMA_VERSION).toBe(5);
	});
});

describe("StateFileError", () => {
	test("carries code + message and sets name to StateFileError", () => {
		const err = new StateFileError("STATE_FILE_IO_ERROR", "disk full");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(StateFileError);
		expect(err.code).toBe("STATE_FILE_IO_ERROR");
		expect(err.message).toBe("disk full");
		expect(err.name).toBe("StateFileError");
	});

	test("accepts all three known error codes", () => {
		const codes: Array<ConstructorParameters<typeof StateFileError>[0]> = [
			"STATE_FILE_IO_ERROR",
			"STATE_FILE_PARSE_ERROR",
			"STATE_SCHEMA_INVALID",
		];
		for (const code of codes) {
			const err = new StateFileError(code, "x");
			expect(err.code).toBe(code);
		}
	});
});
