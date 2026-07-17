// ============================================================
// Receptor — Mycelium Sink (fuel loop F2)
// ============================================================
// mycelium is a pure stdout filter — it never writes back to the
// source Qdrant. This sink closes the fuel loop: it parses the raw
// SurvivorReport[] JSON from a mycelium_filter run, extracts
// per-point classifications, and POSTs them to the gateway
// (POST /mycelium/report), which updates payload.myceliumMetrics.
//
// Returns a compact one-line summary for the output router, so the
// raw report JSON never floods the subsystem FIFO.

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3100";

// ---- Minimal report shape (mirrors mycelium_universal feed-instance.ts) ----

interface ChunkRef {
  pointId?: string;
  classification: string;
  consensusRate?: number;
}

interface RawReport {
  sourceId?: string;
  totalChunks?: number;
  survivingChunks?: number;
  chunkDetails?: ChunkRef[];   // survivors (pure + merged)
  deadBriefs?: ChunkRef[];     // redundant + loner + dead
}

const VALID_CLASSES = new Set(["pure", "merged", "loner", "redundant", "dead"]);

// ---- Public API ----

/**
 * Process a mycelium_filter result. If it parses as a raw report,
 * push metrics to the gateway and return a compact summary line.
 * Returns null when the payload is not a raw report (caller falls
 * back to routing the original text).
 */
export async function processMyceliumResult(raw: string): Promise<string | null> {
  let reports: RawReport[];
  try {
    const parsed = JSON.parse(raw);
    reports = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null; // not JSON (compact/summary format) — nothing to write back
  }
  if (!reports.some(r => r && (r.chunkDetails || r.deadBriefs))) {
    return null; // JSON but not a raw SurvivorReport (e.g. digest/manifest)
  }

  const entries: Array<{ pointId: string; classification: string; consensusRate?: number }> = [];
  let total = 0;
  let surviving = 0;

  for (const r of reports) {
    total += r.totalChunks ?? 0;
    surviving += r.survivingChunks ?? 0;
    for (const c of [...(r.chunkDetails ?? []), ...(r.deadBriefs ?? [])]) {
      if (!c.pointId || !VALID_CLASSES.has(c.classification)) continue;
      entries.push({
        pointId: c.pointId,
        classification: c.classification,
        ...(c.consensusRate != null ? { consensusRate: c.consensusRate } : {}),
      });
    }
  }

  let pushed = "skipped (no pointIds)";
  if (entries.length > 0) {
    try {
      const res = await fetch(`${GATEWAY_URL}/mycelium/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      if (res.ok) {
        const body = (await res.json()) as { updated?: number };
        pushed = `metrics→${body.updated ?? 0}pts`;
      } else {
        pushed = `push failed (${res.status})`;
      }
    } catch (err) {
      pushed = `push failed (${(err as Error).message})`;
    }
  }

  const rate = total > 0 ? `${Math.round((surviving / total) * 100)}%` : "N/A";
  return `mycelium: ${surviving}/${total} survived (${rate}), ${pushed}`;
}
