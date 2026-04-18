import { expect, test } from "bun:test";
import { createGuiBridge, dispatchStartRequest, type MissionStartRequest, pendingBridgeCount } from "./gui-bridge";

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
