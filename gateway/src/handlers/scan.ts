import type { ScanResponse, NodeStatus } from "../types.js";
import { listNodes } from "../upper-layer/index.js";

type SortOption = "recent" | "weight";

/**
 * GET /scan/:projectId?limit=10&tag=docker&status=fixed&sort=recent
 */
export async function handleScan(
  projectId: string,
  limit = 10,
  tag?: string,
  status?: NodeStatus,
  sort?: SortOption,
): Promise<ScanResponse> {
  try {
    const filters = (tag || status || sort) ? { tag, status, sort } : undefined;
    const entries = await listNodes(projectId, limit, filters);
    return { entries, total: entries.length };
  } catch (err) {
    console.warn(`[scan] failed for project=${projectId}: ${(err as Error).message}`);
    return { entries: [], total: 0 };
  }
}
