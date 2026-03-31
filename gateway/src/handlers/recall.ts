import type { RecallRequest, RecallResponse, RecallResult } from "../types.js";
import { searchNodes, getNodeById } from "../upper-layer/index.js";

/**
 * POST /recall
 *
 * Two modes:
 *   1. query search — semantic search
 *   2. entryId fetch — single node by ID
 *
 * hitCount++ happens inside UpperLayer (fire-and-forget).
 */
export async function handleRecall(body: RecallRequest): Promise<RecallResponse> {
  const { query, entryId, projectId, limit = 10, minWeight, status, queryType } = body;

  // ---- sense mode: single node by ID ----
  if (entryId) {
    try {
      const node = await getNodeById(entryId);
      if (node) {
        return { results: [maybeStripForAgent(node, queryType)], source: "engram" };
      }
    } catch (err) {
      console.warn(`[recall] getById failed: ${(err as Error).message}`);
    }
    return { results: [], source: "engram", message: `Node ${entryId} not found` };
  }

  // ---- search mode ----
  if (!query || query.trim().length === 0) {
    return { results: [], source: "engram", message: "Empty query" };
  }

  try {
    const results = await searchNodes({ query, projectId, limit, minWeight, status });
    return {
      results: results.map((r) => maybeStripForAgent(r, queryType)),
      source: "engram",
    };
  } catch (err) {
    return {
      results: [],
      source: "engram",
      message: `Recall failed: ${(err as Error).message}`,
    };
  }
}

/**
 * For queryType "agent": if native exists, strip summary/content to reduce token cost.
 * For "human" or unset: return full result (backward compatible).
 */
function maybeStripForAgent(
  result: RecallResult,
  queryType?: "human" | "agent",
): RecallResult {
  if (queryType !== "agent" || !result.native) return result;

  // Agent mode with native: return native + index, omit verbose natural language
  return {
    ...result,
    summary: result.index ?? result.summary,  // prefer index as compact summary
    content: undefined,                        // strip natural language content
  };
}
