import type { ScanResponse, NodeStatus } from "../types.js";
import { listNodes } from "../upper-layer/index.js";

/**
 * GET /scan/:projectId?limit=10&tag=docker&status=fixed
 */
export async function handleScan(
  projectId: string,
  limit = 10,
  tag?: string,
  status?: NodeStatus,
): Promise<ScanResponse> {
  try {
    const filters = (tag || status) ? { tag, status } : undefined;
    const entries = await listNodes(projectId, limit, filters);
    return { entries, total: entries.length };
  } catch {
    return { entries: [], total: 0 };
  }
}
