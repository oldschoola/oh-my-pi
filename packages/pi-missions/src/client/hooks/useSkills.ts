import { getSkills } from "../api";
import type { SkillsResponse } from "../types";
import { usePolledApi } from "./usePolledApi";

export function useSkills(missionId: string | null) {
	return usePolledApi<SkillsResponse>(missionId, getSkills, 5000);
}
