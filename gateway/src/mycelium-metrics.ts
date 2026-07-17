// ============================================================
// Engram — Mycelium Metrics (fuel loop F2, usage-side write-back)
// ============================================================
//
// Maintains payload.myceliumMetrics on engram Qdrant points:
//
//   survived   — count of mycelium runs the point survived (pure/merged)
//   lastClass  — classification from the most recent run
//   hits/reads — usage counters (focused fetch / recall appearance)
//   updatedAt  — epoch ms, EMA decay reference
//
// Two write paths converge here:
//   1. Report write-back — receptor sink POSTs the parsed mycelium
//      report to the gateway (/mycelium/report), which calls
//      applyMyceliumReport(). Survivors get survived+1; everyone
//      mentioned gets lastClass refreshed.
//   2. Usage counters — Digestor's bump flush calls
//      decayedUsage() to fold queued hits/reads into the stored
//      metrics (same setPayload as hitCount/weight — no extra I/O).
//
// EMA decay: hits/reads lose half their value every
// MYCELIUM_USAGE_HALFLIFE_DAYS (default 14), computed lazily from
// updatedAt whenever metrics are rewritten. survived never decays —
// mycelium's nutrition-resolver saturates it via tanh instead.

import { setPayload, getPointById } from "./upper-layer/qdrant-client.js";
import type { MyceliumMetrics, UpperLayerPointPayload } from "./upper-layer/types.js";

// ---- Config ----

const HALFLIFE_DAYS = (() => {
  const v = parseFloat(process.env.MYCELIUM_USAGE_HALFLIFE_DAYS ?? "14");
  return Number.isFinite(v) && v > 0 ? v : 14;
})();
const HALFLIFE_MS = HALFLIFE_DAYS * 86_400_000;

const SURVIVOR_CLASSES = new Set(["pure", "merged"]);
const VALID_CLASSES = new Set(["pure", "merged", "loner", "redundant", "dead"]);

// Echo-chamber guard (F3): entries whose classification is unstable
// (consensusRate below this) get no fuel credit — survived / lastClass
// stay untouched. Entries without a rate (single-run mode) pass through.
const MIN_CONSENSUS = (() => {
  const v = parseFloat(process.env.MYCELIUM_MIN_CONSENSUS ?? "0.6");
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.6;
})();

// ---- Report entry (posted by receptor sink) ----

export interface MyceliumReportEntry {
  pointId: string;
  classification: MyceliumMetrics["lastClass"];
  consensusRate?: number;
}

// ---- EMA decay ----

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Decay factor for usage counters based on elapsed time since updatedAt. */
function decayFactor(updatedAt: number | undefined, now: number): number {
  if (!updatedAt || updatedAt >= now) return 1;
  return Math.pow(2, -(now - updatedAt) / HALFLIFE_MS);
}

/**
 * Fold queued usage deltas into stored metrics, applying EMA decay to
 * the previously accumulated hits/reads. Pure function — caller persists.
 */
export function decayedUsage(
  existing: MyceliumMetrics | undefined,
  hitDelta: number,
  readDelta: number,
  now: number = Date.now(),
): MyceliumMetrics {
  const factor = decayFactor(existing?.updatedAt, now);
  return {
    survived: existing?.survived ?? 0,
    lastClass: existing?.lastClass ?? "pure",
    hits: round2((existing?.hits ?? 0) * factor + hitDelta),
    reads: round2((existing?.reads ?? 0) * factor + readDelta),
    updatedAt: now,
  };
}

// ---- Report write-back ----

/**
 * Apply a mycelium run report: survivors (pure/merged) get survived+1,
 * every mentioned point gets lastClass + decayed usage counters.
 * Returns the number of points updated.
 */
export async function applyMyceliumReport(
  qdrantUrl: string,
  collection: string,
  entries: MyceliumReportEntry[],
): Promise<number> {
  const now = Date.now();
  let updated = 0;

  let lowConsensus = 0;

  for (const entry of entries) {
    if (!entry.pointId || !VALID_CLASSES.has(entry.classification)) continue;
    if (entry.consensusRate != null && entry.consensusRate < MIN_CONSENSUS) {
      lowConsensus++;
      continue;
    }
    try {
      const point = await getPointById(qdrantUrl, collection, entry.pointId);
      if (!point) continue;

      const existing = (point.payload as UpperLayerPointPayload).myceliumMetrics;
      const factor = decayFactor(existing?.updatedAt, now);
      const metrics: MyceliumMetrics = {
        survived: (existing?.survived ?? 0) + (SURVIVOR_CLASSES.has(entry.classification) ? 1 : 0),
        lastClass: entry.classification,
        hits: round2((existing?.hits ?? 0) * factor),
        reads: round2((existing?.reads ?? 0) * factor),
        updatedAt: now,
      };

      await setPayload(
        qdrantUrl,
        collection,
        [entry.pointId],
        { myceliumMetrics: metrics } as Partial<UpperLayerPointPayload>,
      );
      updated++;
    } catch (err) {
      console.warn(`[mycelium-metrics] write-back failed for ${entry.pointId}: ${(err as Error).message}`);
    }
  }

  if (updated > 0 || lowConsensus > 0) {
    console.log(
      `[mycelium-metrics] report applied: ${updated}/${entries.length} points updated` +
      (lowConsensus > 0 ? `, ${lowConsensus} skipped (consensus < ${MIN_CONSENSUS})` : ""),
    );
  }
  return updated;
}
