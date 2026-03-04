import type { ScanResponse } from "../types.js";
import { listRecent } from "../upper-layer/index.js";

/**
 * GET /scan/:projectId?limit=10
 *
 * Lightweight listing (scanL1 pattern): id, summary, tags, weight, hitCount, status.
 */
export async function handleScan(
  projectId: string,
  limit = 10,
): Promise<ScanResponse> {
  try {
    const entries = await listRecent(projectId, limit);
    return { entries, total: entries.length, source: "upper-layer" };
  } catch {
    return { entries: [], total: 0, source: "stub" };
  }
}
