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
export async function handleRecall(body) {
    const { query, entryId, projectId, limit = 10, minWeight, status } = body;
    // ---- sense mode: single node by ID ----
    if (entryId) {
        try {
            const node = await getNodeById(entryId);
            if (node) {
                return { results: [node], source: "engram" };
            }
        }
        catch (err) {
            console.warn(`[recall] getById failed: ${err.message}`);
        }
        return { results: [], source: "engram", message: `Node ${entryId} not found` };
    }
    // ---- search mode ----
    if (!query || query.trim().length === 0) {
        return { results: [], source: "engram", message: "Empty query" };
    }
    try {
        const results = await searchNodes({ query, projectId, limit, minWeight, status });
        return { results, source: "engram" };
    }
    catch (err) {
        return {
            results: [],
            source: "engram",
            message: `Recall failed: ${err.message}`,
        };
    }
}
//# sourceMappingURL=recall.js.map