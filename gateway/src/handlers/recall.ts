import type { RecallRequest, RecallResponse } from "../types.js";
import { searchRecent, getRecentById } from "../upper-layer/index.js";

/**
 * POST /recall
 *
 * Two modes:
 *   1. query search — semantic search (UpperLayer only)
 *   2. entryId fetch — single node by ID
 *
 * hitCount++ happens inside UpperLayer (fire-and-forget).
 */
export async function handleRecall(body: RecallRequest): Promise<RecallResponse> {
  const { query, entryId, projectId, limit = 10 } = body;

  // ---- sense mode: single node by ID ----
  if (entryId) {
    try {
      const recent = await getRecentById(entryId);
      if (recent) {
        return { results: [recent], source: "upper-layer" };
      }
    } catch (err) {
      console.warn(`[recall] getById failed: ${(err as Error).message}`);
    }
    return { results: [], source: "stub", message: `Node ${entryId} not found` };
  }

  // ---- search mode ----
  if (!query || query.trim().length === 0) {
    return { results: [], source: "stub", message: "Empty query" };
  }

  try {
    const results = await searchRecent({ query, projectId, limit });
    return { results, source: "upper-layer" };
  } catch (err) {
    return {
      results: [],
      source: "stub",
      message: `Recall failed: ${(err as Error).message}`,
    };
  }
}
