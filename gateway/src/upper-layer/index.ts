// ============================================================
// UpperLayer — public API (Engram)
// ============================================================
//
// Gateway 内蔵モジュール。Qdrant + @xenova/transformers で
// NodeSeed を即座に検索可能にする。
//
// [設計]
//   initUpperLayer()  — 起動時1回 (collection 確保 + embedding warm-up)
//   ingestNodes()     — ingest handler から直接呼出
//   searchRecent()    — recall handler から呼出 (hitCount++ 含む)
//   listRecent()      — scan handler から呼出

import { randomUUID } from "node:crypto";
import type { NodeSeed, RecallResult, ScanEntry } from "../types.js";
import type { UpperLayerConfig, SearchOptions, UpperLayerPointPayload } from "./types.js";
import { DEFAULT_UPPER_LAYER_CONFIG } from "./types.js";
import { onRecallHit } from "../amber.js";
import { configureEmbedding, embedText, embedTexts, isReady } from "./embedding.js";
import {
  ensureCollection,
  upsertPoints,
  searchPoints,
  scrollPoints,
  deletePoints,
  countPoints,
  getPointById,
  setPayload,
  checkQdrantHealth,
} from "./qdrant-client.js";

let config: UpperLayerConfig = { ...DEFAULT_UPPER_LAYER_CONFIG };
let initialized = false;

// ---- Init ----

export async function initUpperLayer(partial?: Partial<UpperLayerConfig>): Promise<void> {
  config = { ...DEFAULT_UPPER_LAYER_CONFIG, ...partial };

  configureEmbedding(config.embeddingModel, config.embeddingDimension);

  const healthy = await checkQdrantHealth(config.qdrantUrl);
  if (!healthy) {
    console.warn(
      `[upper-layer] Qdrant unreachable at ${config.qdrantUrl} — UpperLayer disabled until available`,
    );
    return;
  }

  await ensureCollection(config.qdrantUrl, config.recentCollection, config.embeddingDimension);

  // Embedding warm-up — preload model so first query is instant
  await embedText("warm-up");

  initialized = true;
  console.log(
    `[upper-layer] initialized: collection=${config.recentCollection} ` +
    `dim=${config.embeddingDimension} maxPerProject=${config.maxNodesPerProject}`,
  );
}

// ---- Ingest ----

export async function ingestNodes(
  nodes: NodeSeed[],
  projectId: string,
  trigger = "session-end",
): Promise<{ ingested: number; evicted: number }> {
  if (!initialized || nodes.length === 0) return { ingested: 0, evicted: 0 };

  const now = Date.now();
  const texts = nodes.map((n) => n.summary || "");

  // Batch embed
  const vectors = await embedTexts(texts);

  // Build points
  const points = nodes.map((node, i) => ({
    id: randomUUID(),
    vector: vectors[i],
    payload: {
      summary: node.summary,
      tags: node.tags,
      content: node.content ?? "",
      projectId,
      source: "mcp-ingest",
      trigger,
      weight: node.weight ?? 0.5,
      hitCount: 0,
      status: "fresh" as const,
      ingestedAt: now,
      lastAccessedAt: now,
    } satisfies UpperLayerPointPayload,
  }));

  // Upsert
  await upsertPoints(config.qdrantUrl, config.recentCollection, points);

  // LRU eviction
  const evicted = await evictExcess(projectId);

  console.log(
    `[upper-layer] ingested: project=${projectId} nodes=${nodes.length} evicted=${evicted}`,
  );

  return { ingested: nodes.length, evicted };
}

async function evictExcess(projectId: string): Promise<number> {
  const filter = { must: [{ key: "projectId", match: { value: projectId } }] };
  const count = await countPoints(config.qdrantUrl, config.recentCollection, filter);

  if (count <= config.maxNodesPerProject) return 0;

  const excess = count - config.maxNodesPerProject;

  // LRU eviction: fossil first, then least recently accessed
  const oldest = await scrollPoints(
    config.qdrantUrl,
    config.recentCollection,
    filter,
    excess,
    { key: "lastAccessedAt", direction: "asc" },
  );

  const ids = oldest.map((p) => p.id);
  await deletePoints(config.qdrantUrl, config.recentCollection, ids);

  return ids.length;
}

// ---- Search ----

export async function searchRecent(options: SearchOptions): Promise<RecallResult[]> {
  if (!initialized) return [];

  const { query, projectId, limit = 10 } = options;

  const queryVector = await embedText(query);

  const filter = projectId
    ? { must: [{ key: "projectId", match: { value: projectId } }] }
    : undefined;

  const hits = await searchPoints(
    config.qdrantUrl,
    config.recentCollection,
    queryVector,
    filter,
    limit,
  );

  // hitCount++ and amber promotion for all hits (fire-and-forget)
  if (hits.length > 0) {
    bumpHitCounts(hits);
  }

  return hits.map((hit) => ({
    id: hit.id,
    distance: 1 - hit.score,
    summary: hit.payload.summary,
    tags: hit.payload.tags,
    weight: hit.payload.weight ?? 0.5,
    hitCount: (hit.payload.hitCount ?? 0) + 1,  // reflect the bump
    status: resolveStatus(hit.payload),
    timestamp: hit.payload.ingestedAt,
    content: hit.payload.content || undefined,
  }));
}

/** Resolve what status will be after this hit */
function resolveStatus(payload: UpperLayerPointPayload): "fresh" | "amber" | "fossil" {
  const result = onRecallHit({
    hitCount: payload.hitCount ?? 0,
    status: (payload.status as "fresh" | "amber" | "fossil") ?? "fresh",
    lastRecalledAt: payload.lastAccessedAt,
    createdAt: payload.ingestedAt,
  });
  return result.status ?? payload.status ?? "fresh";
}

// ---- List (scan pattern) ----

export async function listRecent(projectId: string, limit: number): Promise<ScanEntry[]> {
  if (!initialized) return [];

  const filter = { must: [{ key: "projectId", match: { value: projectId } }] };

  const points = await scrollPoints(
    config.qdrantUrl,
    config.recentCollection,
    filter,
    limit,
    { key: "ingestedAt", direction: "desc" },
  );

  return points.map((p) => ({
    id: p.id,
    summary: p.payload.summary,
    tags: p.payload.tags,
    weight: p.payload.weight ?? 0.5,
    hitCount: p.payload.hitCount ?? 0,
    status: (p.payload.status as "fresh" | "amber" | "fossil") ?? "fresh",
  }));
}

// ---- Single node fetch (sense pattern) ----

export async function getRecentById(entryId: string): Promise<RecallResult | null> {
  if (!initialized) return null;

  const point = await getPointById(config.qdrantUrl, config.recentCollection, entryId);
  if (!point) return null;

  // hitCount++ (fire-and-forget)
  bumpHitCounts([point]);

  return {
    id: point.id,
    distance: 0,
    summary: point.payload.summary,
    tags: point.payload.tags,
    weight: point.payload.weight ?? 0.5,
    hitCount: (point.payload.hitCount ?? 0) + 1,
    status: resolveStatus(point.payload),
    timestamp: point.payload.ingestedAt,
    content: point.payload.content || undefined,
  };
}

// ---- Hit count bump + amber promotion (fire-and-forget) ----

function bumpHitCounts(points: Array<{ id: string; payload: UpperLayerPointPayload }>): void {
  for (const point of points) {
    const update = onRecallHit({
      hitCount: point.payload.hitCount ?? 0,
      status: (point.payload.status as "fresh" | "amber" | "fossil") ?? "fresh",
      lastRecalledAt: point.payload.lastAccessedAt,
      createdAt: point.payload.ingestedAt,
    });

    setPayload(
      config.qdrantUrl,
      config.recentCollection,
      [point.id],
      {
        hitCount: update.hitCount,
        status: update.status,
        lastAccessedAt: update.lastRecalledAt ?? Date.now(),
      } as Partial<UpperLayerPointPayload>,
    ).catch((err) => {
      console.warn(`[upper-layer] bumpHitCount failed (non-fatal): ${(err as Error).message}`);
    });
  }
}

// ---- Stats / Health ----

export async function checkUpperLayerHealth(): Promise<boolean> {
  if (!initialized) return false;
  return checkQdrantHealth(config.qdrantUrl);
}

export function getUpperLayerStats(): {
  initialized: boolean;
  embeddingReady: boolean;
  qdrantUrl: string;
  collection: string;
} {
  return {
    initialized,
    embeddingReady: isReady(),
    qdrantUrl: config.qdrantUrl,
    collection: config.recentCollection,
  };
}

export async function getTotalNodeCount(): Promise<number> {
  if (!initialized) return 0;
  return countPoints(config.qdrantUrl, config.recentCollection);
}

export async function getAmberNodeCount(): Promise<number> {
  if (!initialized) return 0;
  const filter = { must: [{ key: "status", match: { value: "amber" } }] };
  return countPoints(config.qdrantUrl, config.recentCollection, filter);
}
