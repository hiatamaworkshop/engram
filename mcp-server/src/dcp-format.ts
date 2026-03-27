/**
 * DCP formatter for engram MCP responses.
 *
 * Converts RecallResult[] and ScanEntry[] to DCP positional arrays.
 * Schemas are hardcoded — these are known structures, not arbitrary JSON.
 */

import type { RecallResult, ScanEntry } from "./gateway-client.js";

// ── Schemas ────────────────────────────────────────────────

const RECALL_HEADER = '["$S","engram-recall:v1","id","relevance","summary","tags","hitCount","weight","status"]';
const SCAN_HEADER = '["$S","engram-scan:v1","id","summary","tags","hitCount","weight","status"]';

// ── Formatters ─────────────────────────────────────────────

export function formatRecallDcp(results: RecallResult[]): string {
  const rows = results.map((r) =>
    JSON.stringify([
      r.id,
      +r.relevance.toFixed(3),
      r.summary,
      r.tags.join(",") || "-",
      r.hitCount,
      r.weight,
      r.status,
    ])
  );
  return [RECALL_HEADER, ...rows].join("\n");
}

export function formatScanDcp(entries: ScanEntry[]): string {
  const rows = entries.map((e) =>
    JSON.stringify([
      e.id,
      e.summary,
      e.tags.join(",") || "-",
      e.hitCount,
      e.weight,
      e.status,
    ])
  );
  return [SCAN_HEADER, ...rows].join("\n");
}
