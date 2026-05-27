import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	__getReadUrlCacheSize,
	__lookupReadUrlCache,
	__primeReadUrlCacheForTest,
	__resetReadUrlCache,
	READ_URL_CACHE_CAP,
	type ReadUrlToolDetails,
} from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { Snowflake } from "@oh-my-pi/pi-utils";

const makeDetails = (requestedUrl: string, finalUrl: string): ReadUrlToolDetails => ({
	kind: "url",
	url: requestedUrl,
	finalUrl,
	contentType: "text/plain",
	method: "raw",
	truncated: false,
	notes: [],
});

const makeEntry = (requestedUrl: string, finalUrl: string = `${requestedUrl}#final`) => ({
	details: makeDetails(requestedUrl, finalUrl),
	output: `body for ${requestedUrl}`,
});

describe("read URL cache LRU cap", () => {
	let testDir: string;

	const createSession = (): ToolSession => {
		const sessionFile = path.join(testDir, "session.jsonl");
		const artifactsDir = sessionFile.slice(0, -6);
		let nextArtifactId = 0;
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => sessionFile,
			getArtifactsDir: () => artifactsDir,
			getSessionSpawns: () => null,
			allocateOutputArtifact: async toolType => {
				const id = String(nextArtifactId++);
				return {
					id,
					path: path.join(artifactsDir, `${id}.${toolType}.log`),
				};
			},
			settings: Settings.isolated({ "fetch.enabled": true }),
		};
	};

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `fetch-url-cache-cap-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		__resetReadUrlCache();
	});

	afterEach(() => {
		__resetReadUrlCache();
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("caps the URL cache at the LRU bound", () => {
		const session = createSession();
		const total = 100;
		for (let i = 0; i < total; i++) {
			const requested = `https://example.com/page-${i}`;
			__primeReadUrlCacheForTest(session, requested, false, makeEntry(requested));
		}
		expect(READ_URL_CACHE_CAP).toBeGreaterThan(0);
		// Each prime inserts two keys (requestedUrl + finalUrl).
		expect(__getReadUrlCacheSize()).toBeLessThanOrEqual(READ_URL_CACHE_CAP * 2);
	});

	it("evicts the oldest entry first (LRU semantics)", () => {
		const session = createSession();
		const cap = READ_URL_CACHE_CAP;
		// Prime exactly cap entries.
		for (let i = 0; i < cap; i++) {
			const requested = `https://example.com/lru-${i}`;
			__primeReadUrlCacheForTest(session, requested, false, makeEntry(requested));
		}
		// All cap entries currently retrievable.
		expect(__lookupReadUrlCache(session, "https://example.com/lru-0", false)).toBeDefined();
		// Re-prime them all (lookups above re-ordered them; re-establish a known insertion order).
		__resetReadUrlCache();
		for (let i = 0; i < cap; i++) {
			const requested = `https://example.com/lru-${i}`;
			__primeReadUrlCacheForTest(session, requested, false, makeEntry(requested));
		}
		// Add one more — must evict entry 0 (the oldest).
		const overflow = "https://example.com/lru-overflow";
		__primeReadUrlCacheForTest(session, overflow, false, makeEntry(overflow));

		expect(__lookupReadUrlCache(session, "https://example.com/lru-0", false)).toBeUndefined();
		expect(__lookupReadUrlCache(session, overflow, false)).toBeDefined();
	});

	it("touching an entry via lookup keeps it warm", () => {
		const session = createSession();
		const cap = READ_URL_CACHE_CAP;
		for (let i = 0; i < cap; i++) {
			const requested = `https://example.com/warm-${i}`;
			__primeReadUrlCacheForTest(session, requested, false, makeEntry(requested));
		}
		// Touch entry 0 so it becomes the most-recent.
		expect(__lookupReadUrlCache(session, "https://example.com/warm-0", false)).toBeDefined();
		// Prime 5 more entries — should evict the oldest untouched (entry 1, 2, ...), not entry 0.
		for (let i = 0; i < 5; i++) {
			const requested = `https://example.com/warm-extra-${i}`;
			__primeReadUrlCacheForTest(session, requested, false, makeEntry(requested));
		}
		expect(__lookupReadUrlCache(session, "https://example.com/warm-0", false)).toBeDefined();
		expect(__lookupReadUrlCache(session, "https://example.com/warm-1", false)).toBeUndefined();
	});
});
