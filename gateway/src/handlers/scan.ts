import type { ScanResponse } from "../types.js";
import { listNodes } from "../upper-layer/index.js";

/**
 * GET /scan/:projectId?limit=10
 */
export async function handleScan(
  projectId: string,
  limit = 10,
): Promise<ScanResponse> {
  try {
    const entries = await listNodes(projectId, limit);
    return { entries, total: entries.length };
  } catch {
    return { entries: [], total: 0 };
  }
}
