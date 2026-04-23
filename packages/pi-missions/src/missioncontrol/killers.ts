/**
 * Merge-agent kill helpers (Runtime V2).
 *
 * `killMergeAgentV2` / `killAllMergeAgentsV2` terminate merge worker processes
 * via the Runtime V2 process registry. Called by `abort.ts` during graceful +
 * hard abort flows. The full `merge.ts` port (spawn + wait + health monitor)
 * has not landed yet; these helpers work directly against the registry so
 * operator-initiated aborts can already clean up merger agents.
 *
 * Registry rule: only kill agents with role `merger` that are not in a
 * terminal status. PIDs we fail to kill (already dead, permission denied)
 * are still marked `killed` in the manifest so subsequent reads match the
 * operator's intent — we do not perpetually retry a dead PID.
 *
 * Session-name matching: taskplane's merge agents are registered with an
 * `agentId` that includes the base session name (e.g. `mission-merge-1`).
 * `killMergeAgentV2` matches any merger manifest whose `agentId` contains
 * the provided `baseSessionName` substring — covers both exact-match and
 * suffix patterns (`-merger`, `-merge-worker`).
 */

import { execLog } from "./log";
import { isProcessAlive, isTerminalStatus, readRegistrySnapshot, updateManifestStatus } from "./process-registry";
import type { RuntimeAgentManifest } from "./types";

function killManifest(manifest: RuntimeAgentManifest, logTag: string): boolean {
	const alive = isProcessAlive(manifest.pid);
	if (alive) {
		try {
			process.kill(manifest.pid, "SIGTERM");
			execLog("killer", manifest.agentId, `${logTag}: killed PID ${manifest.pid}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			execLog("killer", manifest.agentId, `${logTag}: process.kill failed (${msg})`);
			return false;
		}
	} else {
		execLog("killer", manifest.agentId, `${logTag}: PID ${manifest.pid} already dead`);
	}
	return true;
}

/**
 * Kill a single merge agent identified by its base session name.
 *
 * Walks the runtime registry for role=`merger` manifests whose `agentId`
 * contains `baseSessionName` and is not already terminal. Sends SIGTERM and
 * flips the manifest status to `killed`. Returns `true` iff at least one
 * matching agent was signalled (regardless of whether the process was still
 * alive — the status update is the source of truth downstream).
 */
export function killMergeAgentV2(stateRoot: string, batchId: string, baseSessionName: string): boolean {
	if (!baseSessionName) return false;
	const registry = readRegistrySnapshot(stateRoot, batchId);
	if (!registry) return false;

	let killedAny = false;
	for (const manifest of Object.values(registry.agents)) {
		if (manifest.role !== "merger") continue;
		if (isTerminalStatus(manifest.status)) continue;
		if (!manifest.agentId.includes(baseSessionName)) continue;

		killManifest(manifest, `kill merge agent for ${baseSessionName}`);
		updateManifestStatus(stateRoot, batchId, manifest.agentId, "killed");
		killedAny = true;
	}
	return killedAny;
}

/**
 * Kill every live merge agent in the batch.
 *
 * Iterates role=`merger` manifests in the registry, sends SIGTERM to each,
 * and flips every manifest to `killed`. Returns the count of manifests we
 * attempted to kill (terminal-status manifests are skipped and not counted).
 */
export function killAllMergeAgentsV2(stateRoot: string, batchId: string): number {
	const registry = readRegistrySnapshot(stateRoot, batchId);
	if (!registry) return 0;

	let count = 0;
	for (const manifest of Object.values(registry.agents)) {
		if (manifest.role !== "merger") continue;
		if (isTerminalStatus(manifest.status)) continue;

		killManifest(manifest, "kill all merge agents");
		updateManifestStatus(stateRoot, batchId, manifest.agentId, "killed");
		count += 1;
	}
	return count;
}
