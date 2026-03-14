/**
 * Mycelium report cache — read-only, in-memory lookup.
 *
 * Loads the report JSON once at init, then watches the file for changes.
 * Gateway code can call `getMyceliumHint(engramId)` at zero cost.
 */
import { readFile, watch } from "node:fs/promises";

export interface MyceliumHint {
  signal: "redundant" | "loner" | "pure" | "merger";
  strength: number; // 0 = threshold-minimum, 1 = unanimous
}

interface ReportEntry {
  engramId: string;
  votes: number;
  total: number;
}

interface ReportFile {
  timestamp: string;
  config?: { votePct?: number };
  confirmed: {
    redundant: ReportEntry[];
    loner: ReportEntry[];
    pure: ReportEntry[];
    merger: ReportEntry[];
  };
}

// ---- State ----

let hintMap: Map<string, MyceliumHint> = new Map();
let reportPath: string | null = null;
let watchAbort: AbortController | null = null;

// ---- Public API ----

export function getMyceliumHint(engramId: string): MyceliumHint | undefined {
  return hintMap.get(engramId);
}

export function getMyceliumHints(engramIds: string[]): Map<string, MyceliumHint> {
  const result = new Map<string, MyceliumHint>();
  for (const id of engramIds) {
    const hint = hintMap.get(id);
    if (hint) result.set(id, hint);
  }
  return result;
}

export async function initMyceliumCache(path: string): Promise<void> {
  reportPath = path;
  await reload();
  startWatcher();
}

// ---- Internals ----

async function reload(): Promise<void> {
  if (!reportPath) return;
  try {
    const raw = await readFile(reportPath, "utf-8");
    const report: ReportFile = JSON.parse(raw);
    const next = new Map<string, MyceliumHint>();

    const votePct = report.config?.votePct ?? 0.4;

    for (const signal of ["redundant", "loner", "pure", "merger"] as const) {
      const entries = report.confirmed?.[signal] ?? [];
      for (const entry of entries) {
        const threshold = Math.ceil(votePct * entry.total);
        const headroom = entry.total - threshold;
        const strength = headroom > 0
          ? Math.round(Math.min((entry.votes - threshold) / headroom, 1) * 100) / 100
          : 1;
        const existing = next.get(entry.engramId);
        if (!existing || strength > existing.strength) {
          next.set(entry.engramId, { signal, strength });
        }
      }
    }

    hintMap = next;
    console.log(`[mycelium-cache] Loaded ${next.size} hints from report (${report.timestamp})`);
  } catch {
    // File missing or invalid — not an error, just no hints available
  }
}

function startWatcher(): void {
  if (!reportPath) return;
  watchAbort?.abort();
  watchAbort = new AbortController();

  (async () => {
    try {
      const watcher = watch(reportPath!, { signal: watchAbort!.signal });
      for await (const _event of watcher) {
        // Debounce: wait a bit for file write to complete
        await new Promise((r) => setTimeout(r, 500));
        await reload();
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).name !== "AbortError") {
        console.warn(`[mycelium-cache] Watcher stopped: ${(err as Error).message}`);
      }
    }
  })();
}
