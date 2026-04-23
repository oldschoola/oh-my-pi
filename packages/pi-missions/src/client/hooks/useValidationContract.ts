import { getValidationContract } from "../api";
import type { ValidationContract } from "../types";
import { usePolledApi } from "./usePolledApi";

export function useValidationContract(missionId: string | null) {
	return usePolledApi<ValidationContract | null>(missionId, getValidationContract);
}
