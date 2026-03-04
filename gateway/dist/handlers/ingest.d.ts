import type { IngestRequest, IngestResponse } from "../types.js";
/**
 * POST /ingest — capsuleSeeds → validate → embed → Qdrant
 */
export declare function handleIngest(body: IngestRequest): Promise<IngestResponse>;
