// ============================================================
// Engram MCP Server → Gateway HTTP client
// ============================================================

import type { EngramContext, ProjectMeta, NodeSeed } from "./types.js";

// ---- Gateway response types ----

export interface RecallResult {
  id: string;
  distance: number;
  summary: string;
  tags: string[];
  weight: number;
  hitCount: number;
  status: "fresh" | "amber" | "fossil";
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

export interface StatusResponse {
  upperLayer: {
    initialized: boolean;
    embeddingReady: boolean;
    qdrantUrl: string;
    collection: string;
  } | null;
  totalNodes: number | null;
  amberNodes: number | null;
}

export interface ScanEntry {
  id: string;
  summary: string;
  tags: string[];
  weight: number;
  hitCount: number;
  status: "fresh" | "amber" | "fossil";
}

export interface ScanResponse {
  entries: ScanEntry[];
  total: number;
  source: "upper-layer" | "stub";
}

// ---- Health (cached) ----

let _healthCache: { ok: boolean; at: number } | null = null;
const HEALTH_CACHE_TTL = 30_000;

export async function checkHealth(ctx: EngramContext): Promise<boolean> {
  if (_healthCache && Date.now() - _healthCache.at < HEALTH_CACHE_TTL) {
    return _healthCache.ok;
  }
  try {
    const res = await fetch(`${ctx.gatewayUrl}/health`);
    _healthCache = { ok: res.ok, at: Date.now() };
    return res.ok;
  } catch {
    _healthCache = { ok: false, at: Date.now() };
    return false;
  }
}

// ---- Recall (search mode) ----

export async function recallNodes(
  ctx: EngramContext,
  query: string,
  projectId?: string,
  limit = 10,
): Promise<RecallResponse> {
  const res = await fetch(`${ctx.gatewayUrl}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, projectId, limit }),
  });
  if (!res.ok) {
    throw new Error(`Gateway /recall ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as RecallResponse;
}

// ---- Recall (sense mode — single node by ID) ----

export async function recallById(
  ctx: EngramContext,
  entryId: string,
): Promise<RecallResponse> {
  const res = await fetch(`${ctx.gatewayUrl}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryId }),
  });
  if (!res.ok) {
    throw new Error(`Gateway /recall ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as RecallResponse;
}

// ---- Scan ----

export async function scan(
  ctx: EngramContext,
  projectId: string,
  limit = 10,
): Promise<ScanResponse> {
  const res = await fetch(
    `${ctx.gatewayUrl}/scan/${encodeURIComponent(projectId)}?limit=${limit}`,
  );
  if (!res.ok) {
    throw new Error(`Gateway /scan ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as ScanResponse;
}

// ---- Ingest (capsuleSeeds required) ----

export async function ingest(
  ctx: EngramContext,
  compactText: string,
  meta: ProjectMeta,
  capsuleSeeds: NodeSeed[],
  trigger?: string,
): Promise<IngestResponse> {
  const body: Record<string, unknown> = { compactText, meta, capsuleSeeds };
  if (trigger) body.trigger = trigger;
  const res = await fetch(`${ctx.gatewayUrl}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Gateway /ingest ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as IngestResponse;
}

// ---- Status ----

export async function getStatus(
  ctx: EngramContext,
  projectId?: string,
): Promise<StatusResponse> {
  const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const res = await fetch(`${ctx.gatewayUrl}/status${params}`);
  if (!res.ok) {
    throw new Error(`Gateway /status ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as StatusResponse;
}
