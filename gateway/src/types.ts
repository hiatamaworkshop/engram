// ============================================================
// Engram Gateway — shared types (v2)
// ============================================================

// ---- Node status ----

export type NodeStatus = "recent" | "fixed";

// ---- Ingest trigger types ----

export type IngestTrigger =
  | "session-end"
  | "milestone"
  | "git-commit"
  | "error-resolved"
  | "manual"
  | "convention"
  | "environment";

// ---- NodeSeed (from Claude session — pre-extracted knowledge unit) ----

export interface NodeSeed {
  summary: string;
  tags: string[];
  content?: string;
}

// ---- Request types ----

export interface RecallRequest {
  query?: string;
  entryId?: string;
  projectId?: string;
  limit?: number;
  minWeight?: number;
  status?: NodeStatus;
}

export interface IngestRequest {
  capsuleSeeds: NodeSeed[];
  projectId: string;
  trigger?: IngestTrigger;
  sessionId?: string;
  userId?: string;
}

// ---- Feedback ----

export type FeedbackSignal = "outdated" | "incorrect" | "superseded" | "merged";

export interface FeedbackRequest {
  entryId: string;
  signal: FeedbackSignal;
  reason?: string;
}

export interface FeedbackResponse {
  status: "applied" | "not-found" | "error";
  entryId: string;
  signal: FeedbackSignal;
  newWeight?: number;
  summary?: string;
}

// ---- Response types ----

export interface RecallResult {
  id: string;
  relevance: number;
  summary: string;
  tags: string[];
  hitCount: number;
  weight: number;
  status: NodeStatus;
  content?: string;
}

export interface RecallResponse {
  results: RecallResult[];
  source: string;
  message?: string;
}

export interface IngestResponse {
  status: "accepted" | "rejected";
  reason?: string;
  projectId?: string;
  nodesIngested?: number;
  merged?: number;
}

export interface StatusResponse {
  store: {
    initialized: boolean;
    embeddingReady: boolean;
    collection: string;
  } | null;
  totalNodes: number | null;
  recentNodes: number | null;
  fixedNodes: number | null;
  projects?: Array<{ projectId: string; count: number }>;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  service: "engram-gateway";
  uptime: number;
  downstream: {
    qdrant: "ok" | "unreachable";
    embedding: "ok" | "not-ready";
  };
}

// ---- Activate / Deactivate (Digestor project scope) ----

export interface ActivateRequest {
  projectId: string;
  ttlSeconds?: number;
}

export interface DeactivateRequest {
  projectId: string;
}

// ---- Scan (lightweight listing) ----

export interface ScanEntry {
  id: string;
  summary: string;
  tags: string[];
  hitCount: number;
  weight: number;
  status: NodeStatus;
}

export interface ScanResponse {
  entries: ScanEntry[];
  total: number;
}
