import { getTelemetryRollup } from "../api";
import type { MissionRollup } from "../types";
import { usePolledApi } from "./usePolledApi";

export function useTelemetryRollup(missionId: string | null) {
	return usePolledApi<MissionRollup | null>(missionId, getTelemetryRollup, 5000);
}
