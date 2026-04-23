import { afterEach, expect, test } from "bun:test";
import {
	createGuiBridge,
	dispatchStartRequest,
	getDefaultToken,
	type MissionStartRequest,
	pendingBridgeCount,
	registerDefaultBridge,
	removeDefaultBridge,
} from "./gui-bridge";

function sampleRequest(token: string): MissionStartRequest {
	return {
		token,
		templateKey: "minimal",
		description: "test mission",
		autonomy: "medium",
		modelAssignment: { planner: "claude-sonnet-4-6", worker: "claude-sonnet-4-6" },
		laneCount: 2,
		waveSize: 2,
	};
}

afterEach(() => {
	removeDefaultBridge();
});

test("createGuiBridge issues a UUID token", () => {
	const bridge = createGuiBridge();
	expect(bridge.token).toMatch(/[0-9a-f-]{36}/);
	bridge.close();
});

test("dispatchStartRequest rejects unknown token", () => {
	const bridge = createGuiBridge();
	const result = dispatchStartRequest(sampleRequest("00000000-0000-0000-0000-000000000000"));
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe("unknown_token");
	bridge.close();
});

test("dispatchStartRequest rejects malformed payload", () => {
	const bridge = createGuiBridge();
	// Missing required fields.
	const result = dispatchStartRequest({ token: bridge.token } as MissionStartRequest);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.reason).toBe("invalid_payload");
	bridge.close();
});

test("dispatchStartRequest resolves the bridge promise on valid submit", async () => {
	const bridge = createGuiBridge();
	const pending = bridge.waitForStart();
	const result = dispatchStartRequest(sampleRequest(bridge.token));
	expect(result.ok).toBe(true);
	if (result.ok) expect(result.kind).toBe("explicit");
	const received = await pending;
	expect(received.description).toBe("test mission");
	expect(pendingBridgeCount()).toBe(0);
});

test("close cleans up pending bridges without resolving", () => {
	const bridge = createGuiBridge();
	expect(pendingBridgeCount()).toBeGreaterThan(0);
	bridge.close();
	// close is idempotent
	bridge.close();
	// After close, dispatch with the same token should fail.
	const result = dispatchStartRequest(sampleRequest(bridge.token));
	expect(result.ok).toBe(false);
});

test("registerDefaultBridge routes submits through the handler without clearing the bridge", async () => {
	const received: MissionStartRequest[] = [];
	const token = registerDefaultBridge(req => {
		received.push(req);
	});
	expect(token).toMatch(/[0-9a-f-]{36}/);
	expect(getDefaultToken()).toBe(token);

	const first = dispatchStartRequest(sampleRequest(token));
	expect(first.ok).toBe(true);
	if (first.ok) expect(first.kind).toBe("default");

	// The default bridge must persist across submits.
	const second = dispatchStartRequest({ ...sampleRequest(token), description: "second" });
	expect(second.ok).toBe(true);

	// Let the microtask queue flush so handler calls resolve.
	await Promise.resolve();
	await Promise.resolve();
	expect(received.map(r => r.description)).toEqual(["test mission", "second"]);
	expect(getDefaultToken()).toBe(token);
});

test("registering a new default bridge replaces the previous one", () => {
	const firstToken = registerDefaultBridge(() => {});
	const secondToken = registerDefaultBridge(() => {});
	expect(secondToken).not.toBe(firstToken);
	expect(getDefaultToken()).toBe(secondToken);
	const stale = dispatchStartRequest(sampleRequest(firstToken));
	expect(stale.ok).toBe(false);
});

test("explicit bridges win over the default bridge", async () => {
	let defaultCalls = 0;
	registerDefaultBridge(() => {
		defaultCalls += 1;
	});
	const bridge = createGuiBridge();
	const pending = bridge.waitForStart();
	const result = dispatchStartRequest(sampleRequest(bridge.token));
	expect(result.ok).toBe(true);
	if (result.ok) expect(result.kind).toBe("explicit");
	await pending;
	expect(defaultCalls).toBe(0);
});
