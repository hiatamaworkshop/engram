// ============================================================
// Engram — Digestor (project-scoped batch metabolism)
// ============================================================
//
// Two-pass metabolism per project batch:
//
// Pass 1 — Recent nodes:
//   - weight >= promotionThreshold → promote to "fixed"
//   - ttl <= 0 && weight < threshold → delete (expired)
//   - otherwise → decrement ttl (dynamic decay from density) and leave for next batch
//
// Pass 2 — Fixed nodes (soft demotion):
//   - Apply half-life exponential decay (default 60 days)
//   - recall hit resets decay timer (weight untouched)
//   - weight < fixedDemotionThreshold → demote to "recent" (re-enters TTL cycle)
//
// Density-based dynamic metabolism:
//   - density = nodeCount / span(ingestedAt) per project
//   - high density → faster decay (information flood)
//   - low density → slower decay (preserve scarce knowledge)
//
// Inactive projects are never touched → natural hibernation.
// Idle projects (no API activity for idleThresholdMs) are skipped → soft hibernation.
// Any subsequent API call via touchProject() wakes them up.

import {
  scrollPoints,
  setPayload,
  deletePoints,
  getPointById,
  countPoints,
} from "./upper-layer/qdrant-client.js";
import type { UpperLayerPointPayload } from "./upper-layer/types.js";
import type { NodeStatus } from "./types.js";

// ---- Config ----

export interface DigestorConfig {
  intervalMs: number;          // batch interval (default: 10min)
  promotionThreshold: number;  // weight needed to promote to fixed (default: 3)
  promotionHitCount: number;   // hitCount needed to promote to fixed (default: 5)
  decayPerBatch: number;       // BASE weight decay per batch tick for recent nodes (default: 0.1)
  ttlSeconds: number;          // initial TTL countdown for new nodes (default: 6h = 21600s)
  idleThresholdMs: number;     // skip batch if no activity for this long (default: 30min)
  fixedHalfLifeDays: number;   // half-life for fixed node decay in days (default: 60)
  fixedDemotionThreshold: number; // weight below this → fixed demoted to recent (default: 1.0)
  qdrantUrl: string;
  collection: string;
}

export const DEFAULT_DIGESTOR_CONFIG: DigestorConfig = {
  intervalMs: 600_000,         // 10 minutes
  promotionThreshold: 3,
  promotionHitCount: 5,
  decayPerBatch: 0.1,
  ttlSeconds: 21_600,          // 6 hours
  idleThresholdMs: 1_800_000,  // 30 minutes
  fixedHalfLifeDays: 60,       // ~100 days to demotion from weight=3
  fixedDemotionThreshold: 1.0,
  qdrantUrl: "http://localhost:6333",
  collection: "engram",
};

// ---- Expired node notification (sink integration) ----

export interface ExpiredNodeInfo {
  pointId: string;
  summary: string;
  tags: string[];
  projectId: string;
  weight: number;
  reason: "ttl_expired" | "soft_demotion";
}

type ExpireHandler = (nodes: ExpiredNodeInfo[]) => void;
let _onExpire: ExpireHandler | null = null;

/** Register a handler to receive notifications when nodes are deleted. */
export function setExpireHandler(handler: ExpireHandler): void {
  _onExpire = handler;
}

// ---- State ----

const activeProjects = new Map<string, number>(); // projectId → lastActivityMs
let timer: ReturnType<typeof setInterval> | null = null;
let config: DigestorConfig = { ...DEFAULT_DIGESTOR_CONFIG };

/** Pending hit/weight bumps — accumulated between batch ticks, flushed at batch start. */
const pendingBumps = new Map<string, { hitDelta: number; weightDelta: number }>();

/** Cached node counts per project (+ "__global__" key for all). */
const countsCache = new Map<string, { total: number; recent: number; fixed: number; updatedAt: number }>();

/** Cached project listing. */
let projectListCache: { projects: Array<{ projectId: string; count: number }>; updatedAt: number } | null = null;

// ---- Public API ----

export function addActiveProject(projectId: string): void {
  activeProjects.set(projectId, Date.now());
  console.log(`[digestor] project activated: ${projectId} (active: ${activeProjects.size})`);
}

export async function removeActiveProject(projectId: string): Promise<void> {
  // Run final batch before deactivation
  await runProjectBatch(projectId).catch((err) => {
    console.warn(`[digestor] final batch failed for ${projectId}: ${(err as Error).message}`);
  });
  activeProjects.delete(projectId);
  console.log(`[digestor] project deactivated: ${projectId} (active: ${activeProjects.size})`);
}

export function getActiveProjects(): string[] {
  return [...activeProjects.keys()];
}

/** Update last-activity timestamp. Auto-activates if project was not in the set. */
export function touchProject(projectId: string): void {
  const wasIdle = activeProjects.has(projectId) &&
    (Date.now() - (activeProjects.get(projectId) ?? 0) > config.idleThresholdMs);
  activeProjects.set(projectId, Date.now());
  if (wasIdle) {
    console.log(`[digestor] project woke up: ${projectId}`);
  }
}

export function startDigestor(partial: Partial<DigestorConfig> & { qdrantUrl: string; collection: string }): void {
  config = { ...DEFAULT_DIGESTOR_CONFIG, ...partial };

  if (timer) clearInterval(timer);

  timer = setInterval(() => {
    runBatch().catch((err) => {
      console.warn(`[digestor] batch error: ${(err as Error).message}`);
    });
  }, config.intervalMs);

  console.log(
    `[digestor] started (interval=${config.intervalMs}ms, weight>=${config.promotionThreshold}&hits>=${config.promotionHitCount}, decay=${config.decayPerBatch}/batch, ttl=${config.ttlSeconds}s, idle=${config.idleThresholdMs}ms)`,
  );
}

export function updateTtl(ttlSeconds: number): void {
  config.ttlSeconds = ttlSeconds;
  console.log(`[digestor] ttl updated: ${ttlSeconds}s`);
}

export function getTtlSeconds(): number {
  return config.ttlSeconds;
}

export function stopDigestor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log("[digestor] stopped");
  }
}

// ---- Bump queue (replaces fire-and-forget setPayload per recall) ----

/** Queue a hit/weight bump — throttled: weight only bumped once per batch window per node. */
export function queueBump(pointId: string, hitDelta: number, weightDelta: number): void {
  const existing = pendingBumps.get(pointId);
  if (existing) {
    // hitCount always accumulates, but weight is throttled (first bump wins)
    existing.hitDelta += hitDelta;
  } else {
    pendingBumps.set(pointId, { hitDelta, weightDelta });
  }
}

// ---- Counts cache (replaces per-request countPoints) ----

/** Get cached counts. Returns null if cache is stale or missing. */
export function getCachedCounts(projectId?: string): { total: number; recent: number; fixed: number } | null {
  const key = projectId ?? "__global__";
  const cached = countsCache.get(key);
  if (!cached) return null;
  // Stale after 2× batch interval
  if (Date.now() - cached.updatedAt > config.intervalMs * 2) return null;
  return { total: cached.total, recent: cached.recent, fixed: cached.fixed };
}

/** Get cached project listing. Returns null if stale or missing. */
export function getCachedProjectList(): Array<{ projectId: string; count: number }> | null {
  if (!projectListCache) return null;
  if (Date.now() - projectListCache.updatedAt > config.intervalMs * 2) return null;
  return projectListCache.projects;
}

// ---- Batch processing ----

async function runBatch(): Promise<void> {
  // Flush accumulated bumps first (even if no active projects)
  await flushPendingBumps();

  if (activeProjects.size === 0) return;

  const now = Date.now();

  for (const [projectId, lastActivity] of activeProjects) {
    if (now - lastActivity > config.idleThresholdMs) {
      console.log(`[digestor] skipping idle project: ${projectId} (idle ${Math.floor((now - lastActivity) / 60_000)}min)`);
      continue;
    }
    await runProjectBatch(projectId);
  }

  // Refresh global counts + project list after all batches
  await refreshGlobalCache();
}

/** Round to 2 decimal places to avoid floating-point drift. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---- Density computation (from existing batch scan) ----

interface ProjectDensity {
  nodeCount: number;
  spanMs: number;       // newest - oldest ingestedAt
  density: number;      // nodes per hour
  decayMultiplier: number; // applied to config.decayPerBatch
}

/**
 * Compute density from ingestedAt timestamps of scanned nodes.
 * No additional queries — piggybacks on the existing scroll.
 */
function computeDensity(points: Array<{ payload: UpperLayerPointPayload }>): ProjectDensity {
  let oldest = Infinity;
  let newest = 0;
  for (const p of points) {
    const t = (p.payload as UpperLayerPointPayload).ingestedAt ?? 0;
    if (t < oldest) oldest = t;
    if (t > newest) newest = t;
  }

  const spanMs = Math.max(newest - oldest, 3_600_000); // min 1h to avoid division spikes
  const nodeCount = points.length;
  const density = nodeCount / (spanMs / 3_600_000); // nodes per hour

  // Decay multiplier: density-driven
  //   < 1 node/h  → 0.5× (gentle — scarce knowledge)
  //   ~3 nodes/h  → 1.0× (baseline)
  //   > 10 nodes/h → 2.0× (aggressive — information flood)
  let decayMultiplier: number;
  if (density < 1) {
    decayMultiplier = 0.5 + density * 0.5; // 0.5-1.0
  } else if (density <= 10) {
    decayMultiplier = 1.0 + (density - 1) / 9; // 1.0-2.0
  } else {
    decayMultiplier = Math.min(3.0, 2.0 + (density - 10) / 20); // 2.0-3.0 cap
  }

  return { nodeCount, spanMs, density: round2(density), decayMultiplier: round2(decayMultiplier) };
}

// ---- Fixed node half-life decay ----

/**
 * Compute weight decay for a fixed node using half-life formula.
 * weight(t) = weight × 2^(-batchInterval / halfLife)
 * Returns the decayed weight after one batch interval.
 */
function fixedDecayFactor(): number {
  const halfLifeMs = config.fixedHalfLifeDays * 86_400_000;
  return Math.pow(2, -config.intervalMs / halfLifeMs);
}

// ---- Project batch: two-pass (recent + fixed) ----

async function runProjectBatch(projectId: string): Promise<void> {
  // Scroll ALL project nodes (recent + fixed) in one query
  const allPoints = await scrollPoints(
    config.qdrantUrl,
    config.collection,
    {
      must: [
        { key: "projectId", match: { value: projectId } },
      ],
    },
    500,
  );

  if (allPoints.length === 0) return;

  // Split by status
  const recentPoints = allPoints.filter(p => (p.payload as UpperLayerPointPayload).status === "recent");
  const fixedPoints = allPoints.filter(p => (p.payload as UpperLayerPointPayload).status === "fixed");

  // Compute project density from all nodes
  const density = computeDensity(allPoints);
  const effectiveDecay = round2(config.decayPerBatch * density.decayMultiplier);

  // Collect expired node info for sink notification
  const expiredNodes: ExpiredNodeInfo[] = [];

  // ---- Pass 1: Recent nodes ----

  const decrement = Math.floor(config.intervalMs / 1000);
  const toPromote: string[] = [];
  const toExpire: string[] = [];
  const toUpdate: Map<string, string[]> = new Map();

  for (const point of recentPoints) {
    const p = point.payload as UpperLayerPointPayload;
    const weight = p.weight ?? 0;
    const hitCount = p.hitCount ?? 0;
    const currentTtl = p.ttl ?? config.ttlSeconds;

    if (weight >= config.promotionThreshold && hitCount >= config.promotionHitCount) {
      toPromote.push(point.id);
    } else {
      const newTtl = currentTtl - decrement;
      const newWeight = round2(weight - effectiveDecay);
      const ttlExpiredThreshold = config.promotionThreshold * 0.5;
      if (newTtl <= 0 && newWeight < ttlExpiredThreshold) {
        toExpire.push(point.id);
        expiredNodes.push({
          pointId: point.id,
          summary: p.summary ?? "",
          tags: p.tags ?? [],
          projectId,
          weight: p.weight ?? 0,
          reason: "ttl_expired",
        });
      } else {
        const key = `${newTtl}:${newWeight}`;
        const group = toUpdate.get(key) ?? [];
        group.push(point.id);
        toUpdate.set(key, group);
      }
    }
  }

  // Promote
  if (toPromote.length > 0) {
    await setPayload(
      config.qdrantUrl,
      config.collection,
      toPromote,
      { status: "fixed" as NodeStatus } as Partial<UpperLayerPointPayload>,
    );
  }

  // Expire recent
  if (toExpire.length > 0) {
    await deletePoints(config.qdrantUrl, config.collection, toExpire);
  }

  // Update surviving recent
  for (const [key, ids] of toUpdate) {
    const [ttlStr, weightStr] = key.split(":");
    await setPayload(
      config.qdrantUrl,
      config.collection,
      ids,
      { ttl: Number(ttlStr), weight: Number(weightStr) } as Partial<UpperLayerPointPayload>,
    );
  }

  // ---- Pass 2: Fixed nodes (soft demotion) ----

  const factor = fixedDecayFactor();
  const toDemote: string[] = [];
  const fixedUpdate: Map<string, string[]> = new Map(); // "weight" → pointIds

  for (const point of fixedPoints) {
    const p = point.payload as UpperLayerPointPayload;
    const weight = p.weight ?? config.promotionThreshold;
    const newWeight = round2(weight * factor);

    if (newWeight < config.fixedDemotionThreshold) {
      toDemote.push(point.id);
      expiredNodes.push({
        pointId: point.id,
        summary: p.summary ?? "",
        tags: p.tags ?? [],
        projectId,
        weight,
        reason: "soft_demotion",
      });
    } else {
      const key = `${newWeight}`;
      const group = fixedUpdate.get(key) ?? [];
      group.push(point.id);
      fixedUpdate.set(key, group);
    }
  }

  // Demote fixed → recent (re-enters TTL cycle)
  if (toDemote.length > 0) {
    await setPayload(
      config.qdrantUrl,
      config.collection,
      toDemote,
      { status: "recent" as NodeStatus, ttl: config.ttlSeconds } as Partial<UpperLayerPointPayload>,
    );
  }

  // Update fixed weights
  for (const [weightStr, ids] of fixedUpdate) {
    await setPayload(
      config.qdrantUrl,
      config.collection,
      ids,
      { weight: Number(weightStr) } as Partial<UpperLayerPointPayload>,
    );
  }

  // ---- Sink notification ----

  if (expiredNodes.length > 0 && _onExpire) {
    try { _onExpire(expiredNodes); } catch { /* non-fatal */ }
  }

  // ---- Logging ----

  const recentUpdated = [...toUpdate.values()].reduce((n, ids) => n + ids.length, 0);
  const fixedUpdated = [...fixedUpdate.values()].reduce((n, ids) => n + ids.length, 0);
  console.log(
    `[digestor] batch: project=${projectId} total=${allPoints.length} ` +
    `density=${density.density}n/h×${density.decayMultiplier} ` +
    `promoted=${toPromote.length} expired=${toExpire.length} demoted=${toDemote.length} ` +
    `updated=${recentUpdated}+${fixedUpdated}`,
  );

  // Refresh per-project counts cache after batch
  try {
    countsCache.set(projectId, {
      total: allPoints.length - toExpire.length,
      recent: recentPoints.length - toExpire.length - toPromote.length + toDemote.length,
      fixed: fixedPoints.length + toPromote.length - toDemote.length,
      updatedAt: Date.now(),
    });
  } catch { /* non-fatal */ }
}

// ---- Flush pending bumps ----

async function flushPendingBumps(): Promise<void> {
  if (pendingBumps.size === 0) return;

  const bumps = new Map(pendingBumps);
  pendingBumps.clear();

  let flushed = 0;
  for (const [pointId, { hitDelta, weightDelta }] of bumps) {
    try {
      const point = await getPointById(config.qdrantUrl, config.collection, pointId);
      if (!point) continue;

      await setPayload(
        config.qdrantUrl,
        config.collection,
        [pointId],
        {
          hitCount: (point.payload.hitCount ?? 0) + hitDelta,
          weight: round2((point.payload.weight ?? 0) + weightDelta),
        } as Partial<UpperLayerPointPayload>,
      );
      flushed++;
    } catch (err) {
      console.warn(`[digestor] bump flush failed for ${pointId}: ${(err as Error).message}`);
    }
  }

  if (flushed > 0) {
    console.log(`[digestor] flushed ${flushed} pending bumps`);
  }
}

// ---- Refresh global counts + project list cache ----

async function refreshGlobalCache(): Promise<void> {
  try {
    const [total, fixed] = await Promise.all([
      countPoints(config.qdrantUrl, config.collection, undefined),
      countPoints(config.qdrantUrl, config.collection, {
        must: [{ key: "status", match: { value: "fixed" } }],
      }),
    ]);
    countsCache.set("__global__", { total, recent: total - fixed, fixed, updatedAt: Date.now() });
  } catch { /* non-fatal */ }

  try {
    const points = await scrollPoints(config.qdrantUrl, config.collection, {}, 1000);
    const counts = new Map<string, number>();
    for (const p of points) {
      const pid = (p.payload as UpperLayerPointPayload).projectId;
      if (pid) counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
    projectListCache = {
      projects: Array.from(counts.entries())
        .map(([projectId, count]) => ({ projectId, count }))
        .sort((a, b) => b.count - a.count),
      updatedAt: Date.now(),
    };
  } catch { /* non-fatal */ }
}
