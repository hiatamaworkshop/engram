import type { RecallRequest, RecallResponse } from "../types.js";
/**
 * POST /recall
 *
 * Two modes:
 *   1. query search — semantic search
 *   2. entryId fetch — single node by ID
 *
 * hitCount++ happens inside UpperLayer (fire-and-forget).
 */
export declare function handleRecall(body: RecallRequest): Promise<RecallResponse>;
