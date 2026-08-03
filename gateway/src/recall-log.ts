// ============================================================
// Recall Log — miss observation (the "void" side of the ratchet)
// ============================================================
// weight measures whether a node was pulled. It cannot distinguish
// "nobody wanted this" from "nobody could find it". A node sitting at
// zero hits looks identical in both cases.
//
// This log records the other half: every search's best score, whether
// or not anything cleared the relevance floor. A weak recall near a
// node that never gets pulled means the knowledge exists but the
// summary vocabulary misses — a writing problem, not a value problem.
//
// Deliberately NOT a graph and NOT a stored node:
//   - no edges, no derived structure to maintain
//   - in-process ring buffer; the gateway container is long-lived, so
//     this already spans many agent sessions
//   - materializing misses as nodes in a _void project stays open, but
//     needs the score distribution below to pick a threshold first
//
// Nothing here filters or discards search results. Observation only.

const MAX_PROBES = 200;

/**
 * Provisional label boundary. NOT a filter — searchNodes still uses
 * config.maxDistance. Chosen blind; the bucket histogram exists
 * precisely to replace this with a measured value.
 */
export const WEAK_THRESHOLD = 0.5;

/** Bucket edges for the score histogram (lower bound of each bucket). */
const BUCKETS = [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

export interface RecallProbe {
  query: string;
  projectId?: string;
  /** Best raw score before the relevance floor. -1 when the store returned nothing at all. */
  topScore: number;
  /** How many results survived the relevance floor. */
  returned: number;
  ts: number;
}

const probes: RecallProbe[] = [];

/** Record one search. Called from searchNodes — must never throw. */
export function recordRecall(probe: RecallProbe): void {
  probes.push({ ...probe, query: probe.query.slice(0, 200) });
  if (probes.length > MAX_PROBES) probes.shift();
}

export interface RecallStats {
  /** Probes retained in the ring buffer. */
  total: number;
  /** Probes whose best score fell below WEAK_THRESHOLD. */
  weak: number;
  /** weak / total, 0 when empty. */
  weakRate: number;
  /** Probes where nothing cleared the relevance floor at all. */
  empty: number;
  weakThreshold: number;
  /** Score histogram: bucket lower bound → count. Reveals where the real cliff sits. */
  buckets: Record<string, number>;
  /** Weakest recent probes, worst first — the queries knowledge is missing for. */
  worst: RecallProbe[];
}

export function getRecallStats(worstLimit = 10): RecallStats {
  const total = probes.length;
  const buckets: Record<string, number> = {};
  for (const edge of BUCKETS) buckets[edge.toFixed(1)] = 0;

  let weak = 0;
  let empty = 0;
  for (const p of probes) {
    if (p.returned === 0) empty++;
    if (p.topScore < WEAK_THRESHOLD) weak++;
    const score = Math.max(p.topScore, 0);
    let edge = BUCKETS[0];
    for (const b of BUCKETS) if (score >= b) edge = b;
    buckets[edge.toFixed(1)]++;
  }

  const worst = [...probes]
    .filter((p) => p.topScore < WEAK_THRESHOLD)
    .sort((a, b) => a.topScore - b.topScore)
    .slice(0, worstLimit);

  return {
    total,
    weak,
    weakRate: total > 0 ? Math.round((weak / total) * 100) / 100 : 0,
    empty,
    weakThreshold: WEAK_THRESHOLD,
    buckets,
    worst,
  };
}

/** Test/maintenance hook. */
export function clearRecallLog(): void {
  probes.length = 0;
}
