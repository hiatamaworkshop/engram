// ============================================================
// UpperLayer — types (Engram)
// ============================================================

import type { AmberStatus } from "../types.js";

export interface UpperLayerConfig {
  qdrantUrl: string;            // default: "http://localhost:6333"
  recentCollection: string;     // default: "recent"
  embeddingModel: string;       // default: "Xenova/all-MiniLM-L6-v2"
  embeddingDimension: number;   // default: 384
  maxNodesPerProject: number;   // FIFO cap per projectId, default: 500
}

export const DEFAULT_UPPER_LAYER_CONFIG: UpperLayerConfig = {
  qdrantUrl: "http://localhost:6333",
  recentCollection: "recent",
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  embeddingDimension: 384,
  maxNodesPerProject: 500,
};

export interface UpperLayerPointPayload {
  summary: string;
  tags: string[];
  content: string;
  projectId: string;
  source: string;         // "mcp-ingest"
  trigger: string;        // "session-end" | "milestone" | "git-commit" | "error-resolved"
  weight: number;         // 0.0 - 1.0
  hitCount: number;       // recall hit counter → amber promotion
  status: AmberStatus;    // "fresh" | "amber" | "fossil"
  ingestedAt: number;     // Date.now() at ingestion
  lastAccessedAt: number; // Date.now() at last recall hit (LRU)
}

export interface SearchOptions {
  query: string;
  projectId?: string;
  limit?: number;         // default: 10
}
