import { getPlanManifest } from "../api";
import type { PlanManifest } from "../types";
import { usePolledApi } from "./usePolledApi";

export function usePlanManifest(missionId: string | null) {
	return usePolledApi<PlanManifest | null>(missionId, getPlanManifest);
}
