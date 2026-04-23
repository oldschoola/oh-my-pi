/**
 * Track #4 (J2\u2013J10): client API fetcher unit tests.
 *
 * Each fetcher is a thin wrapper over `fetch`. The tests stub
 * `globalThis.fetch` to assert: (a) the correct URL + method; (b) the
 * happy-path JSON payload is returned verbatim; (c) 404s fall back to
 * the documented default (null / empty object / empty array) instead
 * of throwing. This is the "fetch-mock unit test" the plan calls for;
 * the polling hooks themselves are thin wrappers around these so their
 * contract is indirectly exercised.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	approvePlan,
	getKnowledge,
	getMilestones,
	getPlanManifest,
	getRoleModels,
	getSkills,
	getTelemetryRollup,
	getValidationContract,
	getValidationStatus,
	setRoleModel,
} from "./api";

type FetchCall = { url: string; method: string; body?: string };

let calls: FetchCall[];
let originalFetch: typeof globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? init.body : undefined;
		calls.push({ url, method, ...(body !== undefined ? { body } : {}) });
		return handler(url, init);
	}) as typeof globalThis.fetch;
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function notFound(): Response {
	return new Response("Not found", { status: 404 });
}

beforeEach(() => {
	calls = [];
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("getValidationContract", () => {
	test("returns parsed contract on happy path", async () => {
		mockFetch(() =>
			jsonResponse({
				schemaVersion: 1,
				missionId: "m1",
				assertions: [{ id: "VA-001", area: "a", title: "t", description: "d", acceptanceCriteria: ["c1"] }],
			}),
		);
		const result = await getValidationContract("m1");
		expect(result?.assertions[0]?.id).toBe("VA-001");
		expect(calls[0]?.url).toBe("/api/mission/m1/validation-contract");
		expect(calls[0]?.method).toBe("GET");
	});

	test("returns null on 404", async () => {
		mockFetch(() => notFound());
		expect(await getValidationContract("missing")).toBeNull();
	});
});

describe("getMilestones", () => {
	test("unwraps { milestones } envelope on happy path", async () => {
		mockFetch(() =>
			jsonResponse({
				milestones: [
					{
						id: "M-001",
						name: "Mission",
						featureIds: [],
						assertionIds: [],
						status: "pending",
						validationRounds: 0,
						maxValidationRounds: 4,
					},
				],
			}),
		);
		const result = await getMilestones("m1");
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("M-001");
	});

	test("returns [] on 404", async () => {
		mockFetch(() => notFound());
		expect(await getMilestones("m1")).toEqual([]);
	});
});

describe("getValidationStatus", () => {
	test("appends milestoneId query param when supplied", async () => {
		mockFetch(() => jsonResponse({ batchId: "b1", contract: null, rows: [] }));
		await getValidationStatus("m1", "M-007");
		expect(calls[0]?.url).toBe("/api/mission/m1/validation-status?milestoneId=M-007");
	});

	test("no milestoneId omits the query string", async () => {
		mockFetch(() => jsonResponse({ batchId: "b1", contract: null, rows: [] }));
		await getValidationStatus("m1");
		expect(calls[0]?.url).toBe("/api/mission/m1/validation-status");
	});

	test("returns the server-aligned { batchId, contract, rows } shape", async () => {
		const payload = {
			batchId: "batch-1",
			contract: null,
			rows: [
				{
					milestone: {
						id: "M-001",
						name: "M-001",
						featureIds: [],
						assertionIds: ["VA-001"],
						status: "validating",
						validationRounds: 1,
						maxValidationRounds: 4,
					},
					boundAssertions: [{ id: "VA-001", area: "cli", title: "t", description: "d", acceptanceCriteria: [] }],
				},
			],
		};
		mockFetch(() => jsonResponse(payload));
		const result = await getValidationStatus("m1");
		expect(result?.batchId).toBe("batch-1");
		expect(result?.rows).toHaveLength(1);
		expect(result?.rows[0]?.milestone.id).toBe("M-001");
		expect(result?.rows[0]?.boundAssertions[0]?.id).toBe("VA-001");
	});

	test("returns null on 404", async () => {
		mockFetch(() => notFound());
		expect(await getValidationStatus("m1")).toBeNull();
	});
});

describe("getKnowledge", () => {
	test("passes scope + limit as query params", async () => {
		mockFetch(() => jsonResponse({ entries: [], summary: "none" }));
		await getKnowledge("m1", "M-001", 10);
		expect(calls[0]?.url).toMatch(/scope=M-001/);
		expect(calls[0]?.url).toMatch(/limit=10/);
	});

	test("returns null on 404", async () => {
		mockFetch(() => notFound());
		expect(await getKnowledge("m1")).toBeNull();
	});
});

describe("getPlanManifest", () => {
	test("returns parsed manifest", async () => {
		mockFetch(() =>
			jsonResponse({
				schemaVersion: 1,
				missionId: "m1",
				createdAt: 1,
				status: "approved",
				milestoneIds: ["M-001"],
				featureIds: ["F-001"],
			}),
		);
		const result = await getPlanManifest("m1");
		expect(result?.status).toBe("approved");
	});

	test("returns null on 404", async () => {
		mockFetch(() => notFound());
		expect(await getPlanManifest("m1")).toBeNull();
	});
});

describe("approvePlan", () => {
	test("POSTs milestoneIds + featureIds + approvedBy", async () => {
		mockFetch(() => jsonResponse({ ok: true, manifest: { status: "approved" } }));
		const result = await approvePlan("m1", {
			milestoneIds: ["M-001"],
			featureIds: ["F-001"],
			approvedBy: "dashboard",
		});
		expect(result.ok).toBe(true);
		expect(calls[0]?.method).toBe("POST");
		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.milestoneIds).toEqual(["M-001"]);
		expect(body.approvedBy).toBe("dashboard");
	});

	test("returns { ok: false } when server responds 400", async () => {
		mockFetch(() => jsonResponse({ ok: false, reason: "invalid_payload" }, 400));
		const result = await approvePlan("m1", { milestoneIds: [], featureIds: [] });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("invalid_payload");
	});
});

describe("getTelemetryRollup", () => {
	test("returns parsed rollup", async () => {
		mockFetch(() =>
			jsonResponse({
				perRole: [],
				totals: { totalTokens: 0, costUsd: 0, durationMs: 0, toolCalls: 0 },
			}),
		);
		const result = await getTelemetryRollup("m1");
		expect(result?.totals.totalTokens).toBe(0);
	});

	test("returns null on 404", async () => {
		mockFetch(() => notFound());
		expect(await getTelemetryRollup("m1")).toBeNull();
	});
});

describe("getRoleModels / setRoleModel", () => {
	test("GET unwraps { roles } envelope", async () => {
		mockFetch(() => jsonResponse({ roles: [{ role: "worker", model: "sonnet-4", source: "legacy-seat" }] }));
		const result = await getRoleModels("m1");
		expect(result.roles[0]?.role).toBe("worker");
	});

	test("GET returns { roles: [] } on 404", async () => {
		mockFetch(() => notFound());
		expect(await getRoleModels("m1")).toEqual({ roles: [] });
	});

	test("POST sends role + model body", async () => {
		mockFetch(() => jsonResponse({ ok: true }));
		await setRoleModel("m1", "worker", "sonnet-4-5");
		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body).toEqual({ role: "worker", model: "sonnet-4-5" });
		expect(calls[0]?.method).toBe("POST");
	});
});

describe("getSkills", () => {
	test("returns parsed { promoted, drafts }", async () => {
		mockFetch(() =>
			jsonResponse({
				promoted: [
					{
						name: "mission-control",
						version: "1.0.0",
						description: "d",
						origin: "promoted",
						folderPath: "/x",
						skillPath: "/x/SKILL.md",
					},
				],
				drafts: [],
			}),
		);
		const result = await getSkills("m1");
		expect(result.promoted[0]?.name).toBe("mission-control");
		expect(result.drafts).toEqual([]);
	});

	test("returns empty shape on 404", async () => {
		mockFetch(() => notFound());
		expect(await getSkills("m1")).toEqual({ promoted: [], drafts: [] });
	});
});
