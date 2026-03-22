// ============================================================
// Receptor — Session Point Recorder (persona loading — experience trace)
// ============================================================
// Records ALL fire signals as SessionPoints — good, bad, neutral.
// Unlike persona-snapshot.ts (positive-only), this captures the full
// emotional timeline for experience replay.
//
// Design: docs/DATA_COST_PROTOCOL.md §ペルソナローディングシステム

import type { FireSignal, FireSignalKind, SessionPoint, EngramWeightEntry } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- Profile: idle freeze threshold (same as emotion accumulator) ----

let IDLE_FREEZE_MS = 180_000;
try {
  const profilePath = path.join(import.meta.dirname!, "emotion-profile.json");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf-8"));
  IDLE_FREEZE_MS = profile.accumulator.idleFreezeMs ?? 180_000;
} catch { /* fallback */ }

// ---- Output path ----

const OUTPUT_DIR = path.join(
  process.env.ENGRAM_DATA_DIR ?? path.join(import.meta.dirname!, ".."),
  "receptor-output",
);
const SESSION_POINTS_PATH = path.join(OUTPUT_DIR, "session-points.jsonl");
const WEIGHT_SNAPSHOT_PATH = path.join(OUTPUT_DIR, "engram-weights.jsonl");

// ---- Valence mapping ----

const VALENCE_MAP: Record<FireSignalKind, 1 | 0 | -1> = {
  confidence_sustained: 1,
  flow_active: 1,
  frustration_spike: -1,
  fatigue_rising: -1,
  compound_frustration_seeking: -1,
  seeking_spike: 0,
};

// ---- State ----

let _workTimeMs = 0;
let _lastEventTs = 0;
let _sessionActive = false;

// Frequency tracking: sliding window of recent signal fires
const FREQ_WINDOW_MS = 60_000;
const FREQ_MAX = 20; // normalization ceiling
const _recentFires: Array<{ kind: FireSignalKind; ts: number }> = [];

// Link tracking: most recent engram push node ID
let _lastPushNodeId: string | null = null;
let _lastPushTs = 0;
const LINK_WINDOW_MS = 30_000; // link is valid for 30s after push

// Engram weight tracking: referenced nodes + weights during session
const _weightEntries: Map<string, EngramWeightEntry> = new Map(); // keyed by nodeId, latest wins

// ---- Public API ----

/**
 * Update cumulative work time. Called on every event (not just signals).
 * Idle gaps (> IDLE_FREEZE_MS) are excluded from work time.
 */
export function updateWorkTime(eventTs: number): void {
  if (!_sessionActive) return;

  if (_lastEventTs > 0) {
    const dt = eventTs - _lastEventTs;
    if (dt > 0 && dt < IDLE_FREEZE_MS) {
      _workTimeMs += dt;
    }
  }
  _lastEventTs = eventTs;
}

/**
 * Record SessionPoints for ALL fire signals in this cycle.
 * Each signal becomes one SessionPoint — simultaneous signals share the same t.
 */
export function recordSessionPoints(signals: FireSignal[]): void {
  if (!_sessionActive || signals.length === 0) return;

  const now = Date.now();

  // Evict old frequency entries
  while (_recentFires.length > 0 && now - _recentFires[0].ts > FREQ_WINDOW_MS) {
    _recentFires.shift();
  }

  // Determine link (one-shot: consumed after use)
  let link: string | null = null;
  if (_lastPushNodeId && (now - _lastPushTs) < LINK_WINDOW_MS) {
    link = _lastPushNodeId;
    _lastPushNodeId = null; // one-shot
  }

  const points: SessionPoint[] = [];

  for (const signal of signals) {
    // Frequency: count same-kind fires in recent window
    const kindCount = _recentFires.filter(f => f.kind === signal.kind).length;
    const freq = Math.min(1.0, kindCount / FREQ_MAX);

    // Record this fire for future frequency calculations
    _recentFires.push({ kind: signal.kind, ts: now });

    points.push({
      t: _workTimeMs,
      label: signal.kind,
      intensity: Math.min(1.0, Math.abs(signal.intensity)),
      valence: VALENCE_MAP[signal.kind] ?? 0,
      freq,
      link,
      emotion: { ...signal.emotion },
      agentState: signal.agentState,
    });

    // link is shared across simultaneous signals but consumed for next cycle
  }

  // Append to JSONL
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const lines = points.map(p => JSON.stringify(p)).join("\n") + "\n";
    fs.appendFileSync(SESSION_POINTS_PATH, lines);
  } catch (err) {
    console.error("[session-point] write error:", err);
  }
}

/**
 * Register the most recent engram push node ID for link attachment.
 */
export function setLastPushNodeId(id: string): void {
  _lastPushNodeId = id;
  _lastPushTs = Date.now();
}

/**
 * Record engram node weights from pull/auto_pull results.
 * Called when engram_pull returns results — captures the weight distribution
 * of knowledge referenced during this session.
 * Later entries for the same nodeId overwrite in memory (weight may change mid-session).
 * Every call appends to JSONL immediately — kill-safe, no flush dependency.
 */
export function recordEngramWeights(
  results: Array<{ id: string; weight: number; summary: string }>,
  source: "pull" | "auto_pull",
): void {
  console.error(`[session-point] recordEngramWeights called: source=${source} results=${results.length} sessionActive=${_sessionActive}`);
  if (!_sessionActive || results.length === 0) return;

  const now = Date.now();
  const newEntries: EngramWeightEntry[] = [];
  for (const r of results) {
    console.error(`[session-point]   weight entry: id=${r.id?.slice(0, 12)} weight=${r.weight} summary=${r.summary?.slice(0, 40)}`);
    const entry: EngramWeightEntry = {
      nodeId: r.id,
      weight: r.weight,
      summary: r.summary,
      ts: now,
      source,
    };
    _weightEntries.set(r.id, entry);
    newEntries.push(entry);
  }

  // Append immediately — kill-safe
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const lines = newEntries.map(e => JSON.stringify(e)).join("\n") + "\n";
    fs.appendFileSync(WEIGHT_SNAPSHOT_PATH, lines);
  } catch (err) {
    console.error("[session-point] weight append error:", err);
  }
}

/**
 * Flush deduplicated engram weight snapshot to JSONL. Called on session stop.
 * Overwrites the append-only file with deduplicated entries (latest per nodeId).
 * This is a bonus cleanup — if kill happens before this, the append-only file
 * still has all data (with possible duplicates the loader can deduplicate).
 */
export function flushWeightSnapshot(): void {
  if (_weightEntries.size === 0) return;

  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const lines = [..._weightEntries.values()]
      .map(e => JSON.stringify(e))
      .join("\n") + "\n";
    fs.writeFileSync(WEIGHT_SNAPSHOT_PATH, lines);
  } catch (err) {
    console.error("[session-point] weight snapshot write error:", err);
  }
}

/**
 * Get engram weight entry count (for status display).
 */
export function weightEntryCount(): number {
  return _weightEntries.size;
}

/**
 * Clear all state + truncate JSONL. Called on watch start.
 */
export function clearSessionPoints(): void {
  _workTimeMs = 0;
  _lastEventTs = 0;
  _recentFires.length = 0;
  _lastPushNodeId = null;
  _lastPushTs = 0;
  _weightEntries.clear();
  _sessionActive = true;

  // Truncate (not delete) — keeps the file for the loader
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(SESSION_POINTS_PATH, "");
    fs.writeFileSync(WEIGHT_SNAPSHOT_PATH, "");
  } catch (err) {
    console.error("[session-point] clear error:", err);
  }
}

/**
 * Mark session as inactive. Called on watch stop.
 */
export function stopSessionPoints(): void {
  flushWeightSnapshot();
  _sessionActive = false;
}

/**
 * Get current session point count (for status display).
 */
export function sessionPointCount(): number {
  try {
    if (!fs.existsSync(SESSION_POINTS_PATH)) return 0;
    const content = fs.readFileSync(SESSION_POINTS_PATH, "utf-8").trim();
    if (!content) return 0;
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * Get current cumulative work time (ms).
 */
export function getWorkTimeMs(): number {
  return _workTimeMs;
}

/**
 * Get live debug snapshot of all session-point state.
 * For testing/inspection via HTTP debug endpoint.
 */
export function getDebugSnapshot(): {
  sessionActive: boolean;
  workTimeMs: number;
  recentFires: number;
  weightEntries: EngramWeightEntry[];
  sessionPoints: SessionPoint[];
} {
  // Read session points from file (source of truth)
  let sessionPoints: SessionPoint[] = [];
  try {
    if (fs.existsSync(SESSION_POINTS_PATH)) {
      const content = fs.readFileSync(SESSION_POINTS_PATH, "utf-8").trim();
      if (content) {
        sessionPoints = content.split("\n").map(l => JSON.parse(l) as SessionPoint);
      }
    }
  } catch { /* empty */ }

  return {
    sessionActive: _sessionActive,
    workTimeMs: _workTimeMs,
    recentFires: _recentFires.length,
    weightEntries: [..._weightEntries.values()],
    sessionPoints,
  };
}