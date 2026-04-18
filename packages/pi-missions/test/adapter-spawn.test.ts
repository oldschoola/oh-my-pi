import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnAgent } from "../src/missioncontrol/adapter";

describe("adapter.spawnAgent stub mode", () => {
	const previous = process.env.OMP_MISSION_STUB_AGENT;

	beforeEach(() => {
		process.env.OMP_MISSION_STUB_AGENT = "1";
	});

	afterEach(() => {
		if (previous === undefined) delete process.env.OMP_MISSION_STUB_AGENT;
		else process.env.OMP_MISSION_STUB_AGENT = previous;
	});

	it("returns a no-op handle when stub env flag is set", async () => {
		const handle = await spawnAgent({
			cwd: process.cwd(),
			modelId: "claude-sonnet-4-6",
			prompt: "hello",
		});

		expect(handle.pid).toBeNull();
		await expect(handle.done).resolves.toBeUndefined();
	});

	it("stop() is idempotent on the stub handle", async () => {
		const handle = await spawnAgent({
			cwd: process.cwd(),
			modelId: "claude-sonnet-4-6",
			prompt: "hello",
		});

		await handle.stop();
		await handle.stop();
		await expect(handle.done).resolves.toBeUndefined();
	});

	it("does not invoke onEvent in stub mode", async () => {
		let called = 0;
		const handle = await spawnAgent({
			cwd: process.cwd(),
			modelId: "claude-sonnet-4-6",
			prompt: "hello",
			onEvent: () => {
				called += 1;
			},
		});

		await handle.done;
		expect(called).toBe(0);
	});
});
