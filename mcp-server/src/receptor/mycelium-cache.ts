// ============================================================
// Receptor — Mycelium Cache (fuel loop Phase 3)
// ============================================================
// mycelium is expensive to run (multi-consensus tick simulation).
// This module lets the receptor skip re-running it when the source
// collection hasn't changed since the last run: survivors from a
// prior run are cached as engram nodes, and a small meta node
// records the source point count at push time. A cache hit is
// "meta exists AND its pointCount matches the source collection's
// current count right now" — no separate staleness clock needed,
// because engram's own TTL economy naturally expires unused cache
// nodes (weight starts at 0, nothing bumps it, they decay away).
//
// Two entry points, wired into service-loader.ts around callMcpTool:
//   - checkMyceliumCacheGate(args) — pre-check, BEFORE the mycelium
//     MCP call. Hit means skip the call entirely.
//   - pushMyceliumCache(raw, args) — post-process, AFTER a real run.
//     Parses the raw SurvivorReport[] and caches pure/merged
//     survivors + refreshes the meta node.

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3100";
const PROJECT_ID = process.env.ENGRAM_PROJECT_ID || "engram";

/** Tag applied to every cached survivor node — pass this as EXCLUDE_TAGS
 *  to mycelium_filter on self-referential sources so cache nodes never
 *  get re-ingested as fresh unfiltered input (recursion guard). */
export const EXCLUDE_TAG = "mycelium-filtered";

const INGEST_BATCH = 8; // gate.ts hard limit on capsuleSeeds per /ingest call

export function metaTag(collection: string, hardness: string): string {
  return `mycelium-cache-meta:${collection}:${hardness}`;
}
export function entryTag(collection: string, hardness: string): string {
  return `mycelium-src:${collection}:${hardness}`;
}

// ---- Minimal report shape (mirrors mycelium_universal feed-instance.ts) ----

interface ChunkRef {
  pointId?: string;
  classification: string;
  text?: string;
}

interface RawReport {
  collection?: string;
  totalChunks?: number;
  survivingChunks?: number;
  chunkDetails?: ChunkRef[]; // survivors (pure + merged)
}

const SURVIVOR_CLASSES = new Set(["pure", "merged"]);

// ---- Raw Qdrant helpers ----

async function countSourcePoints(qdrantUrl: string, collection: string): Promise<number | null> {
  try {
    const res = await fetch(`${qdrantUrl}/collections/${collection}/points/count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exact: true }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: { count?: number } };
    return typeof data.result?.count === "number" ? data.result.count : null;
  } catch {
    return null;
  }
}

// ---- Meta node read ----

interface CacheMeta {
  collection: string;
  pointCount: number;
  ts: number;
  filterHardness: string;
  consensusRuns?: number;
}

async function readCacheMeta(collection: string, hardness: string): Promise<CacheMeta | null> {
  try {
    const scanRes = await fetch(
      `${GATEWAY_URL}/scan/${encodeURIComponent(PROJECT_ID)}?limit=1&tag=${encodeURIComponent(metaTag(collection, hardness))}`,
    );
    if (!scanRes.ok) return null;
    const scan = (await scanRes.json()) as { entries?: Array<{ id: string }> };
    const entryId = scan.entries?.[0]?.id;
    if (!entryId) return null;

    const recallRes = await fetch(`${GATEWAY_URL}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryId }),
    });
    if (!recallRes.ok) return null;
    const recall = (await recallRes.json()) as { results?: Array<{ content?: string }> };
    const content = recall.results?.[0]?.content;
    if (!content) return null;

    const meta = JSON.parse(content) as CacheMeta;
    return typeof meta.pointCount === "number" ? meta : null;
  } catch {
    return null;
  }
}

// ---- Public API: pre-check gate ----

/**
 * Called before callMcpTool. skip:true means the cache is valid and
 * the mycelium run should be skipped entirely — result is a compact
 * summary to route directly instead.
 */
export async function checkMyceliumCacheGate(
  args: Record<string, unknown>,
): Promise<{ skip: boolean; result?: string }> {
  const collection = String(args.collections ?? "");
  if (!collection || collection.includes(",")) {
    return { skip: false }; // MVP: single-collection scoping only
  }
  const hardness = String(args.filterHardness ?? "mid");
  const sourceQdrantUrl = String(args.sourceQdrantUrl ?? "http://localhost:6333");

  const meta = await readCacheMeta(collection, hardness);
  if (!meta) return { skip: false };

  const current = await countSourcePoints(sourceQdrantUrl, collection);
  if (current == null || current !== meta.pointCount) return { skip: false };

  try {
    const scanRes = await fetch(
      `${GATEWAY_URL}/scan/${encodeURIComponent(PROJECT_ID)}?limit=30&tag=${encodeURIComponent(entryTag(collection, hardness))}`,
    );
    const scan = scanRes.ok ? ((await scanRes.json()) as { total?: number }) : { total: 0 };
    return {
      skip: true,
      result: `mycelium-cache: ${collection}:${hardness}: ${scan.total ?? 0} cached survivor(s) (pointCount=${current}, hit)`,
    };
  } catch {
    return { skip: false };
  }
}

// ---- Public API: post-process cache push ----

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Called after a real mycelium run. Parses raw SurvivorReport[] JSON,
 * caches pure/merged survivors as engram nodes, and refreshes the
 * per-scope meta node. Returns a compact summary, or null if raw
 * wasn't a raw report (nothing to cache).
 */
export async function pushMyceliumCache(
  raw: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  let reports: RawReport[];
  try {
    const parsed = JSON.parse(raw);
    reports = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
  if (!reports.some(r => r && r.chunkDetails)) return null;

  const hardness = String(args.filterHardness ?? "mid");
  const consensusRuns = args.consensusRuns as number | undefined;
  const sourceQdrantUrl = String(args.sourceQdrantUrl ?? "http://localhost:6333");

  const byCollection = new Map<string, ChunkRef[]>();
  for (const r of reports) {
    if (!r.collection) continue;
    const group = byCollection.get(r.collection) ?? [];
    for (const c of r.chunkDetails ?? []) {
      if (!c.pointId || !c.text || !SURVIVOR_CLASSES.has(c.classification)) continue;
      group.push(c);
    }
    byCollection.set(r.collection, group);
  }

  const summaries: string[] = [];

  for (const [collection, survivors] of byCollection) {
    if (survivors.length === 0) continue;

    const seeds = survivors.map(c => ({
      summary: truncate(c.text!, 200),
      content: truncate(c.text!, 2000),
      tags: [EXCLUDE_TAG, entryTag(collection, hardness)],
    }));

    let pushed = 0;
    for (let i = 0; i < seeds.length; i += INGEST_BATCH) {
      const batch = seeds.slice(i, i + INGEST_BATCH);
      try {
        const res = await fetch(`${GATEWAY_URL}/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capsuleSeeds: batch, projectId: PROJECT_ID, trigger: "mycelium-cache" }),
        });
        if (res.ok) {
          const body = (await res.json()) as { nodesIngested?: number };
          pushed += body.nodesIngested ?? batch.length;
        }
      } catch (err) {
        console.warn(`[mycelium-cache] ingest batch failed for ${collection}: ${(err as Error).message}`);
      }
    }

    const pointCount = await countSourcePoints(sourceQdrantUrl, collection);
    if (pointCount != null) {
      const metaSeed = {
        summary: `mycelium-cache-meta ${collection} ${hardness}`,
        content: JSON.stringify({ collection, pointCount, ts: Date.now(), filterHardness: hardness, consensusRuns }),
        tags: [metaTag(collection, hardness)],
      };
      try {
        await fetch(`${GATEWAY_URL}/ingest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capsuleSeeds: [metaSeed], projectId: PROJECT_ID, trigger: "mycelium-cache" }),
        });
      } catch (err) {
        console.warn(`[mycelium-cache] meta push failed for ${collection}: ${(err as Error).message}`);
      }
    }

    summaries.push(`mycelium-cache: ${collection}:${hardness}: ${pushed} pushed${pointCount != null ? ` (pointCount=${pointCount})` : ""}`);
  }

  return summaries.length > 0 ? summaries.join(" | ") : null;
}
