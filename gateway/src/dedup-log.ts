// ============================================================
// Dedup Log — near-threshold observation on the write path
// ============================================================
// ingestNodes decides merge-vs-new with a single cut at 0.92. That
// number was chosen blind, and every judgement it makes is discarded:
// a seed absorbed at 0.921 and one kept at 0.919 leave the same trace,
// which is none. Same failure form as the recall floor before
// recall-log.ts — the signal exists, nothing looks at it.
//
// This records the top score of every ingest, merged or not, so the
// threshold can be replaced with a measured value rather than argued
// about. Buckets are dense above 0.85 because that is the only region
// where the decision is actually in doubt.
//
// Open question this is meant to answer: does a summary that NEGATES an
// existing one ("port 3100 conflicts, do not use") reach 0.92 against
// the summary it contradicts? If it does, corrections are being merged
// into the claims they correct. If it does not, that hole is closed by
// the embedding itself and needs no mechanism.
//
// Observation only. Nothing here changes what gets merged.

const MAX_PROBES = 200;

/** Mirrors DEDUP_THRESHOLD in upper-layer/index.ts. Recorded, not enforced. */
export const DEDUP_THRESHOLD_OBSERVED = 0.92;

/** Dense near the cut — the wide low buckets are just "obviously new". */
const BUCKETS = [0, 0.5, 0.7, 0.8, 0.85, 0.88, 0.9, 0.92, 0.94, 0.96, 0.98];

export interface DedupProbe {
  /** The incoming seed's summary (truncated). */
  summary: string;
  projectId: string;
  /** Nearest existing node's score. -1 when the project was empty. */
  topScore: number;
  /** Whether this seed was absorbed into the nearest node. */
  merged: boolean;
  /** Summary of the node it merged into (or would have). Empty when none. */
  targetSummary: string;
  /** Status of that node — merging into a `fixed` node inherits its authority. */
  targetStatus: string;
  ts: number;
}

const probes: DedupProbe[] = [];

/** Record one dedup decision. Called from ingestNodes — must never throw. */
export function recordDedup(probe: DedupProbe): void {
  probes.push({
    ...probe,
    summary: probe.summary.slice(0, 120),
    targetSummary: probe.targetSummary.slice(0, 120),
  });
  if (probes.length > MAX_PROBES) probes.shift();
}

export interface DedupStats {
  total: number;
  merged: number;
  /** Merges that landed on a node already promoted to `fixed`. */
  mergedIntoFixed: number;
  /** Decisions within ±0.03 of the cut — where a different threshold would flip the outcome. */
  nearThreshold: number;
  threshold: number;
  /** Score histogram: bucket lower bound → count. */
  buckets: Record<string, number>;
  /** The closest calls, nearest-to-the-cut first. */
  borderline: DedupProbe[];
}

const NEAR_BAND = 0.03;

export function getDedupStats(limit = 10): DedupStats {
  const buckets: Record<string, number> = {};
  for (const edge of BUCKETS) buckets[edge.toFixed(2)] = 0;

  let merged = 0;
  let mergedIntoFixed = 0;
  let nearThreshold = 0;

  for (const p of probes) {
    if (p.merged) {
      merged++;
      if (p.targetStatus === "fixed") mergedIntoFixed++;
    }
    if (p.topScore >= 0 && Math.abs(p.topScore - DEDUP_THRESHOLD_OBSERVED) <= NEAR_BAND) {
      nearThreshold++;
    }
    const score = Math.max(p.topScore, 0);
    let edge = BUCKETS[0];
    for (const b of BUCKETS) if (score >= b) edge = b;
    buckets[edge.toFixed(2)]++;
  }

  const borderline = [...probes]
    .filter((p) => p.topScore >= 0)
    .sort(
      (a, b) =>
        Math.abs(a.topScore - DEDUP_THRESHOLD_OBSERVED) -
        Math.abs(b.topScore - DEDUP_THRESHOLD_OBSERVED),
    )
    .slice(0, limit);

  return {
    total: probes.length,
    merged,
    mergedIntoFixed,
    nearThreshold,
    threshold: DEDUP_THRESHOLD_OBSERVED,
    buckets,
    borderline,
  };
}

/** Test/maintenance hook. */
export function clearDedupLog(): void {
  probes.length = 0;
}
