import type { StatusResponse } from "../types.js";
import { getUpperLayerStats, getTotalNodeCount, getAmberNodeCount } from "../upper-layer/index.js";

/**
 * GET /status
 *
 * UpperLayer stats only — no external service dependencies.
 */
export async function handleStatus(_projectId?: string): Promise<StatusResponse> {
  const [total, amber] = await Promise.all([
    getTotalNodeCount(),
    getAmberNodeCount(),
  ]);

  return {
    upperLayer: getUpperLayerStats(),
    totalNodes: total,
    amberNodes: amber,
  };
}
