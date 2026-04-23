import { getRoleModels } from "../api";
import type { RoleModelsResponse } from "../types";
import { usePolledApi } from "./usePolledApi";

export function useRoleModels(missionId: string | null) {
	return usePolledApi<RoleModelsResponse>(missionId, getRoleModels, 5000);
}
