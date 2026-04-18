/**
 * Package path resolver — locates files shipped inside `@oh-my-pi/pi-missions`.
 *
 * Replaces taskplane's `path-resolver.ts` (237 LOC). Taskplane was installed
 * as a global npm package and needed `npm root -g` gymnastics to locate its
 * templates across Windows/macOS/Linux. `pi-missions` is a workspace package
 * consumed via bun's resolver, so the only thing we need is the package
 * root — everything else lives under it.
 *
 * `packageRoot()` resolves up from this file's directory. The layout is:
 *   packages/pi-missions/
 *   ├── src/missioncontrol/paths.ts   ← this file
 *   ├── templates/agents/*.md
 *   └── templates/tasks/*.md
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let _packageRoot: string | null = null;

/** Absolute path to the `packages/pi-missions` root. */
export function packageRoot(): string {
	if (_packageRoot !== null) return _packageRoot;
	const here = dirname(fileURLToPath(import.meta.url));
	// here = .../packages/pi-missions/src/missioncontrol → up two → package root
	_packageRoot = resolve(here, "..", "..");
	return _packageRoot;
}

/**
 * Resolve a file shipped inside the pi-missions package.
 *
 * Returns the absolute path regardless of existence; callers can assert
 * with {@link packageFileExists} first.
 */
export function resolvePackageFile(relPath: string): string {
	return join(packageRoot(), relPath);
}

/** True if the relative path exists under the package. */
export function packageFileExists(relPath: string): boolean {
	return existsSync(resolvePackageFile(relPath));
}

/**
 * Path to a template in `templates/agents/{agentName}.md`.
 *
 * Taskplane shipped this for `task-worker`, `task-reviewer`, `task-merger`.
 * The ported skills under `pi-missions/templates/agents/` use the same names.
 */
export function resolveAgentTemplate(agentName: string): string {
	return resolvePackageFile(join("templates", "agents", `${agentName}.md`));
}

/** Path to a task template in `templates/tasks/{templateName}.md`. */
export function resolveTaskTemplate(templateName: string): string {
	return resolvePackageFile(join("templates", "tasks", `${templateName}.md`));
}
