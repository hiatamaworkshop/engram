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

/**
 * Usage-side fuel signal for the mycelium filter (fuel loop F2).
 * Read by mycelium_universal's nutrition-resolver as an additive bias
 * on initial node conditions — absence means no-op on that side.
 */
export interface MyceliumMetrics {
  /** Count of past mycelium runs this point survived as pure or merged. */
  survived: number;
  /** Classification from the most recent mycelium run. */
  lastClass: "pure" | "merged" | "loner" | "redundant" | "dead";
  /** Focused accesses (getNodeById) — strong usage signal. EMA-decayed. */
  hits: number;
  /** Recall search appearances — weak usage signal. EMA-decayed. */
  reads: number;
  /** Epoch ms of last metrics update — EMA decay reference point. */
  updatedAt: number;
}

export interface UpperLayerPointPayload {
  summary: string;
  tags: string[];
  content: string;
  projectId: string;
  source: string;         // "mcp-ingest"
  trigger: string;        // "session-end" | "milestone" | ...
  sessionId: string;      // for cross-session tracking
  userId?: string;        // optional — who pushed this node (for multi-user filtering)
  status: NodeStatus;     // "recent" | "fixed"
  hitCount: number;       // recall hit counter (informational)
  weight: number;         // survival score (Digestor uses for promotion/expiry)
  ttl?: number;           // countdown in seconds — set by Digestor on first batch, decremented each tick
  ingestedAt: number;     // Unix ms timestamp — set on ingest, used for sort=recent
  // DCP native fields
  native?: unknown[];     // compact positional array (DCP payload)
  schema?: string;        // schema ID e.g. "knowledge:v1"
  index?: string;         // human-readable restore key
  autoEncoded?: boolean;  // true if system converted from natural language (Phase 1 fallback)
  // Fuel loop (mycelium F2)
  myceliumMetrics?: MyceliumMetrics;
}

export interface SearchOptions {
  query: string;
  projectId?: string;
  limit?: number;         // default: 10
  minWeight?: number;     // filter: only nodes with weight >= this value
  status?: "recent" | "fixed";  // filter: only nodes with this status
}
