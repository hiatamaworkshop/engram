// ============================================================
// Engram Gateway — shared types
// ============================================================

// ---- Project metadata (mirrors mcp-server/src/types.ts) ----

export interface ProjectMeta {
  projectId: string;
  sessionId: string;
  timestamp: number;
  durationMinutes?: number;
  filesModified?: string[];
  toolSummary?: { edits: number; bashCommands: number; searches: number };
  userIntentFirstMessage?: string;
  outcome?: "completed" | "abandoned" | "partial";
  gitDiffStat?: string;
  commitMessages?: string[];
}

// ---- Ingest trigger types ----

export type IngestTrigger = "session-end" | "milestone" | "git-commit" | "error-resolved";

// ---- NodeSeed (from Claude session — pre-extracted knowledge unit) ----

export interface NodeSeed {
  summary: string;
  tags: string[];
  content?: string;
  weight?: number;        // 0.0 - 1.0 (default 0.5)
}

// ---- Request types ----

export interface RecallRequest {
  query?: string;
  entryId?: string;
  projectId?: string;
  limit?: number;
}

export interface IngestRequest {
  compactText: string;
  meta: ProjectMeta;
  trigger?: IngestTrigger;
  capsuleSeeds: NodeSeed[];   // required — Claude session extracts these
}

// ---- Response types ----

export interface RecallResult {
  id: string;
  distance: number;
  summary: string;
  tags: string[];
  weight: number;
  hitCount: number;
  status: AmberStatus;
  timestamp: number;
  content?: string;
}

export interface RecallResponse {
  results: RecallResult[];
  source: "upper-layer" | "stub";
  message?: string;
}

export interface IngestResponse {
  status: "accepted" | "rejected";
  reason?: string;
  sessionId?: string;
  projectId?: string;
  nodesIngested?: number;
}

export type AmberStatus = "fresh" | "amber" | "fossil";

export interface UpperLayerStatus {
  initialized: boolean;
  embeddingReady: boolean;
  qdrantUrl: string;
  collection: string;
}

export interface StatusResponse {
  upperLayer: UpperLayerStatus | null;
  totalNodes: number | null;
  amberNodes: number | null;
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

// ---- Scan (lightweight listing — scanL1 pattern) ----

export interface ScanEntry {
  id: string;
  summary: string;
  tags: string[];
  weight: number;
  hitCount: number;
  status: AmberStatus;
}

export interface ScanResponse {
  entries: ScanEntry[];
  total: number;
  source: "upper-layer" | "stub";
}
