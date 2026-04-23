import { getMilestones, getValidationStatus } from "../api";
import type { ClientMilestone, ValidationStatusResult } from "../types";
import { usePolledApi } from "./usePolledApi";

export function useMilestones(missionId: string | null) {
	return usePolledApi<ClientMilestone[]>(missionId, getMilestones);
}

export function useValidationStatus(missionId: string | null) {
	return usePolledApi<ValidationStatusResult | null>(missionId, id => getValidationStatus(id));
}
