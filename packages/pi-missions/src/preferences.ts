/**
 * Dashboard preferences — small free-form JSON blob persisted to
 * `<cwd>/.omp/dashboard-preferences.json`. The client mirrors the same fields
 * in `localStorage` for offline resilience; this file is the canonical copy
 * other sessions/devices can read.
 */

import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

export interface DashboardPreferences {
	theme?: "dark" | "light";
	rightRailCollapsed?: Record<string, boolean>;
	lastSelectedMissionId?: string;
	followStatusMd?: boolean;
	[key: string]: unknown;
}

function preferencesPath(cwd: string): string {
	return path.join(cwd, ".omp", "dashboard-preferences.json");
}

export async function readDashboardPreferences(cwd: string): Promise<DashboardPreferences> {
	try {
		return (await Bun.file(preferencesPath(cwd)).json()) as DashboardPreferences;
	} catch (err) {
		if (isEnoent(err)) return {};
		logger.warn("[missioncontrol] readDashboardPreferences failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return {};
	}
}

/**
 * Shallow-merge the incoming patch into the current preferences file and
 * return the result. Arrays and nested objects are replaced, not merged —
 * the dashboard only ships flat-ish preferences, and Object.assign keeps
 * the file format predictable.
 */
export async function writeDashboardPreferences(
	cwd: string,
	patch: Record<string, unknown>,
): Promise<DashboardPreferences> {
	const current = await readDashboardPreferences(cwd);
	const merged: DashboardPreferences = { ...current, ...patch };
	await Bun.write(preferencesPath(cwd), `${JSON.stringify(merged, null, 2)}\n`);
	return merged;
}
