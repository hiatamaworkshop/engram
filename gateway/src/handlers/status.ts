import type { StatusResponse } from "../types.js";
import { getUpperLayerStats, getNodeCounts } from "../upper-layer/index.js";

/**
 * GET /status
 */
export async function handleStatus(_projectId?: string): Promise<StatusResponse> {
  const counts = await getNodeCounts();

  return {
    store: getUpperLayerStats(),
    totalNodes: counts.total,
    recentNodes: counts.recent,
    fixedNodes: counts.fixed,
  };
}
