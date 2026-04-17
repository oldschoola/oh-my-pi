/**
 * Widget rendering contract tests. The widget reports mission progress to
 * the user, so changes in how it labels the current phase (e.g. "Phase 1/N"
 * vs "Planning") must be exercised end-to-end through `updateWidget` so
 * regressions in the factory boundary surface here.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { MissionState } from "../src/types";
import { updateWidget } from "../src/widget";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** Minimal theme surface used by `buildMissionLine`. */
interface StubTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
	bg: (color: string, text: string) => string;
}

/** Identity theme — returns text unchanged so assertions see the raw line. */
function makeStubTheme(): StubTheme {
	return {
		fg: (_color, text) => text,
		bold: text => text,
		bg: (_color, text) => text,
	};
}

type RenderedFactory = (tui: unknown, theme: StubTheme) => { render: (width: number) => string[] };

/** Drive `updateWidget` with the given state and return the rendered bar text. */
function renderBar(state: MissionState | null): string {
	const theme = makeStubTheme();
	let factory: RenderedFactory | undefined;
	const ctx = {
		ui: {
			setWidget: (_name: string, f: unknown) => {
				if (typeof f === "function") factory = f as RenderedFactory;
			},
			theme,
		},
	};
	updateWidget(ctx as never, state);
	if (!factory) return "";
	const comp = factory(null, theme);
	return comp.render(400).join("");
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeAdaptiveSeed(overrides: Partial<MissionState> = {}): MissionState {
	const nowIso = new Date().toISOString();
	return {
		description: "Adaptive mission",
		mode: "simple",
		templateKey: "adaptive",
		phases: [{ name: "Plan", emoji: "📐", status: "active", startedAt: nowIso }],
		autonomy: "medium",
		modelAssignment: {},
		paused: false,
		pauseHistory: [],
		progressLog: [],
		startedAt: nowIso,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("widget buildMissionLine", () => {
	afterEach(() => {
		// Clear any running tickers so they don't leak across tests.
		updateWidget({ ui: { setWidget: () => {}, theme: makeStubTheme() } } as never, null);
	});

	it("renders 'Planning' for an unexpanded adaptive seed", () => {
		const bar = renderBar(makeAdaptiveSeed());
		expect(bar).toContain("Planning");
		expect(bar).toContain("📐 Plan");
		// Must not misrepresent the mission as a one-phase job.
		expect(bar).not.toContain("Phase 1/1");
	});

	it("renders 'Phase N/M' for an expanded adaptive mission", () => {
		const nowIso = new Date().toISOString();
		const bar = renderBar(
			makeAdaptiveSeed({
				phasesExpanded: true,
				phases: [
					{ name: "Plan", emoji: "📐", status: "done", startedAt: nowIso, completedAt: nowIso },
					{ name: "Implement", emoji: "🔨", status: "active", startedAt: nowIso },
					{ name: "Verify", emoji: "✅", status: "pending" },
				],
			}),
		);
		expect(bar).toContain("Phase 2/3");
		expect(bar).toContain("🔨 Implement");
		expect(bar).not.toContain("Planning:");
	});

	it("renders 'Phase N/M' for a non-adaptive mission even without phasesExpanded", () => {
		const nowIso = new Date().toISOString();
		const bar = renderBar({
			description: "Standard mission",
			mode: "simple",
			templateKey: "standard",
			phases: [
				{ name: "Architect", emoji: "📐", status: "active", startedAt: nowIso },
				{ name: "Implement", emoji: "🔨", status: "pending" },
			],
			autonomy: "medium",
			modelAssignment: {},
			paused: false,
			pauseHistory: [],
			progressLog: [],
			startedAt: nowIso,
		});
		expect(bar).toContain("Phase 1/2");
		expect(bar).not.toContain("Planning:");
	});
});
