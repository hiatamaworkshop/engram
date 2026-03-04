// ============================================================
// UpperLayer — types (Engram v2)
// ============================================================

import type { NodeStatus } from "../types.js";

export interface UpperLayerConfig {
  qdrantUrl: string;            // default: "http://localhost:6333"
  collection: string;           // default: "engram"
  embeddingModel: string;       // default: "Xenova/all-MiniLM-L6-v2"
  embeddingDimension: number;   // default: 384
  maxDistance: number;           // default: 0.8 — discard results beyond this cosine distance
}

export const DEFAULT_UPPER_LAYER_CONFIG: UpperLayerConfig = {
  qdrantUrl: "http://localhost:6333",
  collection: "engram",
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  embeddingDimension: 384,
  maxDistance: 0.8,
};

export interface UpperLayerPointPayload {
  summary: string;
  tags: string[];
  content: string;
  projectId: string;
  source: string;         // "mcp-ingest"
  trigger: string;        // "session-end" | "milestone" | ...
  sessionId: string;      // for cross-session tracking
  status: NodeStatus;     // "recent" | "fixed"
  hitCount: number;       // recall hit counter (informational)
  weight: number;         // survival score (Digestor uses for promotion/expiry)
  ingestedAt: number;     // Date.now() at ingestion
  lastAccessedAt: number; // Date.now() at last recall hit
}

export interface SearchOptions {
  query: string;
  projectId?: string;
  limit?: number;         // default: 10
}
