// ============================================================
// Engram MCP Server → Gateway HTTP client
// ============================================================

import type { EngramContext, NodeSeed, NodeStatus, IngestTrigger, FeedbackSignal } from "./types.js";

// ---- Gateway response types ----

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

export interface ScanEntry {
  id: string;
  summary: string;
  tags: string[];
  hitCount: number;
  weight: number;
  status: NodeStatus;
}

export interface FeedbackResponse {
  status: "applied" | "not-found" | "error";
  entryId: string;
  signal: string;
  newWeight?: number;
  summary?: string;
}

export interface ScanResponse {
  entries: ScanEntry[];
  total: number;
}

// ---- Health (cached) ----

export interface HealthResult {
  ok: boolean;
  diagnosis: string;
}

let _healthCache: { ok: boolean; diagnosis: string; at: number } | null = null;
const HEALTH_CACHE_TTL = 30_000;

export async function checkHealth(ctx: EngramContext): Promise<HealthResult> {
  if (_healthCache && Date.now() - _healthCache.at < HEALTH_CACHE_TTL) {
    return { ok: _healthCache.ok, diagnosis: _healthCache.diagnosis };
  }
  try {
    const res = await fetch(`${ctx.gatewayUrl}/health`);
    if (res.ok) {
      _healthCache = { ok: true, diagnosis: "", at: Date.now() };
      return { ok: true, diagnosis: "" };
    }
    const body = await res.text().catch(() => "");
    const diagnosis = `Gateway returned HTTP ${res.status}. ${body}`.trim();
    _healthCache = { ok: false, diagnosis, at: Date.now() };
    return { ok: false, diagnosis };
  } catch (err) {
    const diagnosis = diagnoseConnectionError(err, ctx.gatewayUrl);
    _healthCache = { ok: false, diagnosis, at: Date.now() };
    return { ok: false, diagnosis };
  }
}

function diagnoseConnectionError(err: unknown, gatewayUrl: string): string {
  const msg = (err as Error).message ?? String(err);
  const code = (err as NodeJS.ErrnoException).code ?? "";

  if (code === "ECONNREFUSED" || msg.includes("ECONNREFUSED")) {
    return `Connection refused at ${gatewayUrl}. Docker is likely not running.\nFix: docker compose up -d (in your engram directory)`;
  }
  if (code === "ENOTFOUND" || msg.includes("ENOTFOUND")) {
    return `DNS lookup failed for ${gatewayUrl}. Check GATEWAY_URL in your MCP config.`;
  }
  if (code === "ETIMEDOUT" || msg.includes("ETIMEDOUT") || msg.includes("timeout")) {
    return `Connection timed out to ${gatewayUrl}. Gateway may be starting up — retry in a few seconds.`;
  }
  if (msg.includes("fetch failed")) {
    return `Cannot reach ${gatewayUrl}. Is Docker running?\nFix: docker compose up -d`;
  }
  return `Gateway unreachable: ${msg}`;
}

// ---- Recall (search mode) ----

export async function recallNodes(
  ctx: EngramContext,
  query: string,
  projectId?: string,
  limit = 10,
  minWeight?: number,
  status?: string,
): Promise<RecallResponse> {
  const body: Record<string, unknown> = { query, projectId, limit };
  if (minWeight !== undefined) body.minWeight = minWeight;
  if (status) body.status = status;
  const res = await fetch(`${ctx.gatewayUrl}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  tag?: string,
  status?: string,
  sort?: string,
): Promise<ScanResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (tag) params.set("tag", tag);
  if (status) params.set("status", status);
  if (sort) params.set("sort", sort);
  const res = await fetch(
    `${ctx.gatewayUrl}/scan/${encodeURIComponent(projectId)}?${params}`,
  );
  if (!res.ok) {
    throw new Error(`Gateway /scan ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as ScanResponse;
}

// ---- Ingest (v2: minimal params) ----

export async function ingest(
  ctx: EngramContext,
  capsuleSeeds: NodeSeed[],
  projectId: string,
  trigger: IngestTrigger,
  sessionId?: string,
): Promise<IngestResponse> {
  const body: Record<string, unknown> = {
    capsuleSeeds,
    projectId,
    trigger,
  };
  if (sessionId) body.sessionId = sessionId;
  if (ctx.userId && ctx.userId !== "default") body.userId = ctx.userId;

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

// ---- Feedback (weight adjustment) ----

export async function feedback(
  ctx: EngramContext,
  entryId: string,
  signal: FeedbackSignal,
  reason?: string,
): Promise<FeedbackResponse> {
  const body: Record<string, unknown> = { entryId, signal };
  if (reason) body.reason = reason;

  const res = await fetch(`${ctx.gatewayUrl}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Gateway /feedback ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as FeedbackResponse;
}

// ---- Activate / Deactivate (Digestor project scope) ----

export async function activateProject(
  ctx: EngramContext,
  projectId: string,
  ttlSeconds?: number,
): Promise<void> {
  const body: Record<string, unknown> = { projectId };
  if (ttlSeconds) body.ttlSeconds = ttlSeconds;
  const res = await fetch(`${ctx.gatewayUrl}/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Gateway /activate ${res.status}: ${await res.text()}`);
  }
}

export async function deactivateProject(
  ctx: EngramContext,
  projectId: string,
): Promise<void> {
  const res = await fetch(`${ctx.gatewayUrl}/deactivate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId }),
  });
  if (!res.ok) {
    throw new Error(`Gateway /deactivate ${res.status}: ${await res.text()}`);
  }
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
