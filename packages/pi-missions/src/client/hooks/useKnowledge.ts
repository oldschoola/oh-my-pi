import { useCallback } from "react";
import { getKnowledge } from "../api";
import type { KnowledgeResponse } from "../types";
import { usePolledApi } from "./usePolledApi";

export function useKnowledge(missionId: string | null, scope?: string, limit?: number) {
	const fetcher = useCallback((id: string) => getKnowledge(id, scope, limit), [scope, limit]);
	return usePolledApi<KnowledgeResponse | null>(missionId, fetcher, 3000);
}
