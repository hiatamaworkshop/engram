// ============================================================
// Receptor — Future Probe (predictive knowledge supply)
// ============================================================
// Computes movement vector (Δv) from action_log centroid windows,
// projects future position, and searches for relevant knowledge.
//
// Position is defined as the weighted centroid of recent action_log
// entries, not a single snapshot. Weights: exponential recency decay
// × entropy magnitude (high-entropy keypoints = turning points).
//
// Query generation is the core value — search target is swappable
// (local Qdrant now, Sphere later).
//
// Two phases:
//   1. buildQuery(): centroid Δv + entropy + emotion → query vector
//   2. execute():    query → search → format → output-router

import type { EmotionVector, AgentState } from "./types.js";

// ---- Config ----

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3100";
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const ACTION_LOG_COLLECTION = "action_log";
const ENGRAM_COLLECTION = "engram";

/** Base half-window size. Actual size adapts by emotion intensity. */
const WINDOW_N_BASE = 3;

/** Max half-window expansion (base + MAX_EXPAND at intensity=1). */
const WINDOW_N_MAX_EXPAND = 3;

/** Recency decay half-life in entries (not time). */
const DECAY_HALF_LIFE = 3;

// ---- Types ----

export interface ProbeContext {
  topPaths: string[];
  emotion: EmotionVector;
  agentState: AgentState;
  entropy: number;
  projectId?: string;
}

export interface ProbeQuery {
  vector: number[];       // predicted future position
  centroidNow: number[];  // current position centroid (for diagnostics)
  emotion: EmotionVector; // for post-filter ranking
  agentState: AgentState;
  alpha: number;          // prediction confidence
  windowSize: number;     // actual entries used per window
}

interface ProbeResult {
  id: string;
  score: number;
  summary: string;
  tags?: string[];
  source: "action_log" | "engram";
}

interface ActionLogPoint {
  vector: number[];
  entropy: number;
  ts: number;
  emotion?: EmotionVector;
  state?: string;
}

// ---- Enriched centroid (Sphere-ready payload before anonymization) ----

export interface LinkedKnowledge {
  summary: string;
  tags: string[];
  similarity: number;
}

export interface EnrichedCentroid {
  pattern: string;                // e.g. "stuck→exploring"
  centroid_embedding: number[];   // 384d
  emotion_avg: Partial<EmotionVector>;
  entropy_range: [number, number]; // [min, max]
  outcome: string;                // final state in window
  linked_knowledge: LinkedKnowledge[];
  window_size: number;
  alpha: number;
  ts: number;
}

// ---- Embedding via gateway (fallback for cold start) ----

async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${GATEWAY_URL}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { vector: number[] };
    return data.vector;
  } catch {
    return null;
  }
}

// ---- Fetch recent vectors from action_log ----

/**
 * Scroll the most recent 2N entries from action_log, ordered by ts desc.
 * Returns vectors + entropy + ts for centroid computation.
 */
async function scrollRecentVectors(
  n: number,
  projectId?: string,
): Promise<ActionLogPoint[]> {
  try {
    const filter = projectId
      ? { must: [{ key: "projectId", match: { value: projectId } }] }
      : undefined;

    const res = await fetch(`${QDRANT_URL}/collections/${ACTION_LOG_COLLECTION}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: n,
        with_payload: true,
        with_vector: true,
        filter,
        order_by: { key: "ts", direction: "desc" },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      result: { points: Array<{ vector: number[]; payload: Record<string, any> }> };
    };

    return (data.result?.points ?? []).map(p => ({
      vector: p.vector,
      entropy: p.payload.entropy ?? 0,
      ts: p.payload.ts ?? 0,
      emotion: p.payload.emotion as EmotionVector | undefined,
      state: p.payload.state as string | undefined,
    }));
  } catch {
    return [];
  }
}

// ---- Vector arithmetic ----

/** v_a + scale * v_b */
function vecAdd(a: number[], b: number[], scale = 1): number[] {
  return a.map((v, i) => v + scale * b[i]);
}

/** v_a - v_b */
function vecSub(a: number[], b: number[]): number[] {
  return a.map((v, i) => v - b[i]);
}

/** L2 normalize */
function vecNorm(v: number[]): number[] {
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return len > 0 ? v.map(x => x / len) : v;
}

/** Zero vector of given dimension. */
function vecZero(dim: number): number[] {
  return new Array(dim).fill(0);
}

// ---- Weighted centroid ----

/**
 * Compute weighted centroid of vectors.
 *
 * Weight per entry = recencyDecay(index) × entropyWeight(entropy)
 *
 * - recencyDecay: exponential, newest = 1.0, halves every DECAY_HALF_LIFE entries
 * - entropyWeight: 1 + entropy (high-entropy keypoints are turning points,
 *   they should anchor the position more strongly)
 *
 * Input must be ordered newest-first (index 0 = most recent).
 */
function weightedCentroid(points: ActionLogPoint[]): number[] | null {
  if (points.length === 0) return null;

  const dim = points[0].vector.length;
  const result = vecZero(dim);
  let totalWeight = 0;

  for (let i = 0; i < points.length; i++) {
    const recency = Math.pow(0.5, i / DECAY_HALF_LIFE);
    const entropyW = 1 + points[i].entropy;
    const w = recency * entropyW;

    for (let d = 0; d < dim; d++) {
      result[d] += points[i].vector[d] * w;
    }
    totalWeight += w;
  }

  if (totalWeight === 0) return null;
  for (let d = 0; d < dim; d++) {
    result[d] /= totalWeight;
  }
  return result;
}

// ---- Query generation (core value) ----

/**
 * Build a predictive query from action_log centroids.
 *
 * - Fetches recent 2N entries from action_log (Qdrant scroll)
 * - Splits into new window (0..N-1) and old window (N..2N-1)
 * - Computes weighted centroids for each window
 * - Δv = centroid_new - centroid_old (macro movement direction)
 * - v_future = centroid_new + α × Δv
 * - α adjusted by current entropy
 *
 * Falls back to single-embed if action_log has < 2 entries.
 * Returns null if no position can be determined.
 */
export async function buildQuery(ctx: ProbeContext): Promise<ProbeQuery | null> {
  // Adaptive window: high intensity → wider window → stronger centroid
  //   intensity = max(frustration, entropy/3), clamped to [0, 1]
  //   windowN:  3 (calm) → 6 (max distress)
  const intensity = Math.min(1, Math.max(ctx.emotion.frustration, ctx.entropy / 3));
  const windowN = WINDOW_N_BASE + Math.round(intensity * WINDOW_N_MAX_EXPAND);

  // Fetch recent entries from action_log
  const points = await scrollRecentVectors(windowN * 2, ctx.projectId);

  if (points.length < 2) {
    // Cold start: not enough history for centroid
    console.error(`[future-probe] insufficient action_log entries (${points.length}), skipping`);
    return null;
  }

  // Split into windows (points are newest-first)
  const splitAt = Math.min(windowN, Math.floor(points.length / 2));
  const windowNew = points.slice(0, splitAt);
  const windowOld = points.slice(splitAt);

  const centroidNew = weightedCentroid(windowNew);
  const centroidOld = weightedCentroid(windowOld);

  if (!centroidNew || !centroidOld) return null;

  // Δv: macro movement direction between windows
  const delta = vecSub(centroidNew, centroidOld);

  // α: prediction confidence adjusted by current entropy
  //   entropy low  → α large (confident direction, look further)
  //   entropy high → α small (unclear, stay close)
  const entropyFactor = Math.max(0.1, 1 - ctx.entropy / 4);
  const alpha = entropyFactor * 0.5;

  // Project future position
  const vFuture = vecNorm(vecAdd(centroidNew, delta, alpha));

  return {
    vector: vFuture,
    centroidNow: centroidNew,
    emotion: ctx.emotion,
    agentState: ctx.agentState,
    alpha,
    windowSize: splitAt,
  };
}

// ---- Enriched centroid builder (Sphere-ready data shaping) ----

/**
 * Build an enriched centroid from the current action_log window.
 *
 * Computes:
 *   - emotion_avg: average emotion across the new window
 *   - entropy_range: [min, max] entropy in the window
 *   - pattern: state transition summary (e.g. "stuck→exploring")
 *   - outcome: final state in window (newest entry)
 *   - linked_knowledge: top-3 fixed engram nodes near the centroid
 *
 * Returns null if insufficient data (same cold-start guard as buildQuery).
 */
export async function buildEnrichedCentroid(ctx: ProbeContext): Promise<EnrichedCentroid | null> {
  const intensity = Math.min(1, Math.max(ctx.emotion.frustration, ctx.entropy / 3));
  const windowN = WINDOW_N_BASE + Math.round(intensity * WINDOW_N_MAX_EXPAND);

  const points = await scrollRecentVectors(windowN * 2, ctx.projectId);
  if (points.length < 2) return null;

  const splitAt = Math.min(windowN, Math.floor(points.length / 2));
  const windowNew = points.slice(0, splitAt);
  const windowOld = points.slice(splitAt);

  const centroidNew = weightedCentroid(windowNew);
  if (!centroidNew) return null;

  const centroidOld = weightedCentroid(windowOld);
  const delta = centroidOld ? vecSub(centroidNew, centroidOld) : vecZero(centroidNew.length);
  const entropyFactor = Math.max(0.1, 1 - ctx.entropy / 4);
  const alpha = entropyFactor * 0.5;

  // ---- Emotion average across new window ----
  const emotionAxes: (keyof EmotionVector)[] = [
    "frustration", "seeking", "confidence", "fatigue", "flow",
  ];
  const emotionAvg: Partial<EmotionVector> = {};
  let emotionCount = 0;
  for (const pt of windowNew) {
    if (!pt.emotion) continue;
    emotionCount++;
    for (const axis of emotionAxes) {
      emotionAvg[axis] = (emotionAvg[axis] ?? 0) + (pt.emotion[axis] ?? 0);
    }
  }
  if (emotionCount > 0) {
    for (const axis of emotionAxes) {
      emotionAvg[axis] = Math.round(((emotionAvg[axis] ?? 0) / emotionCount) * 1000) / 1000;
    }
  }

  // ---- Entropy range ----
  const entropies = points.map(p => p.entropy);
  const entropyRange: [number, number] = [
    Math.round(Math.min(...entropies) * 100) / 100,
    Math.round(Math.max(...entropies) * 100) / 100,
  ];

  // ---- State pattern + outcome ----
  const states = points
    .map(p => p.state)
    .filter((s): s is string => !!s);
  const uniqueStates: string[] = [];
  for (const s of states.reverse()) { // oldest→newest
    if (uniqueStates.length === 0 || uniqueStates[uniqueStates.length - 1] !== s) {
      uniqueStates.push(s);
    }
  }
  const pattern = uniqueStates.length > 0 ? uniqueStates.join("→") : "unknown";
  const outcome = uniqueStates.length > 0 ? uniqueStates[uniqueStates.length - 1] : "unknown";

  // ---- Linked knowledge: search engram fixed nodes near centroid ----
  const linked = await searchFixedNearCentroid(centroidNew, ctx.projectId);

  return {
    pattern,
    centroid_embedding: centroidNew,
    emotion_avg: emotionAvg,
    entropy_range: entropyRange,
    outcome,
    linked_knowledge: linked,
    window_size: splitAt,
    alpha,
    ts: Date.now(),
  };
}

/**
 * Search engram collection for fixed nodes near the centroid.
 * Cross-project (no projectId filter) — fixed nodes are universal knowledge.
 * score_threshold=0.35 accounts for centroid averaging diluting cosine scores
 * (~0.5 centroid ≈ ~0.7 individual embedding similarity).
 */
async function searchFixedNearCentroid(
  centroid: number[],
  _projectId?: string,
): Promise<LinkedKnowledge[]> {
  try {
    const filter: Record<string, any> = {
      must: [{ key: "status", match: { value: "fixed" } }],
    };

    const res = await fetch(`${QDRANT_URL}/collections/${ENGRAM_COLLECTION}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector: centroid,
        limit: 3,
        score_threshold: 0.35,
        with_payload: true,
        filter,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      result: Array<{ score: number; payload: Record<string, any> }>;
    };

    return (data.result ?? []).map(r => ({
      summary: r.payload.summary || "(no summary)",
      tags: r.payload.tags || [],
      similarity: Math.round(r.score * 1000) / 1000,
    }));
  } catch {
    return [];
  }
}

// ---- Search execution (swappable target) ----

/**
 * Execute search against local Qdrant collections.
 * Searches both action_log (past behavioral patterns) and engram (knowledge).
 * Results are ranked by cosine similarity × emotion weight.
 */
export async function executeSearch(query: ProbeQuery, projectId?: string): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  // Search action_log for past behavioral patterns
  const actionResults = await searchQdrant(ACTION_LOG_COLLECTION, query.vector, 5, projectId);
  for (const r of actionResults) {
    results.push({
      id: r.id,
      score: applyEmotionWeight(r.score, r.payload, query),
      summary: r.payload.text || `[${r.payload.state}] entropy=${r.payload.entropy}`,
      source: "action_log",
    });
  }

  // Search engram for relevant knowledge
  const engramResults = await searchQdrant(ENGRAM_COLLECTION, query.vector, 5, projectId);
  for (const r of engramResults) {
    results.push({
      id: r.id,
      score: applyEmotionWeight(r.score, r.payload, query),
      summary: r.payload.summary || "(no summary)",
      tags: r.payload.tags,
      source: "engram",
    });
  }

  // Sort by weighted score, descending
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 5);
}

// ---- Qdrant search ----

async function searchQdrant(
  collection: string,
  vector: number[],
  limit: number,
  projectId?: string,
): Promise<Array<{ id: string; score: number; payload: Record<string, any> }>> {
  try {
    const filter = projectId
      ? { must: [{ key: "projectId", match: { value: projectId } }] }
      : undefined;

    const res = await fetch(`${QDRANT_URL}/collections/${collection}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vector, limit, with_payload: true, filter }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { result: Array<{ id: string; score: number; payload: Record<string, any> }> };
    return data.result;
  } catch {
    return [];
  }
}

// ---- Emotion-based post-filter ranking ----

/**
 * Adjust cosine similarity score by emotional relevance.
 * Same knowledge gets different priority based on agent state.
 */
function applyEmotionWeight(
  cosineScore: number,
  payload: Record<string, any>,
  query: ProbeQuery,
): number {
  let weight = 1.0;
  const tags: string[] = payload.tags || [];
  const pastState: string = payload.state || "";

  if (query.emotion.frustration > 0.5) {
    // Frustration high → prioritize gotcha/error-resolved from past stuck states
    if (tags.includes("gotcha") || tags.includes("error-resolved")) weight *= 1.5;
    if (pastState === "stuck") weight *= 1.3;
  }

  if (Math.abs(query.emotion.seeking) > 0.5) {
    // High seeking intensity → prioritize howto/where
    if (tags.includes("howto") || tags.includes("where")) weight *= 1.4;
  }

  if (query.emotion.confidence > 0.5) {
    // Confidence high → suppress (don't interrupt flow)
    weight *= 0.5;
  }

  // Outcome bonus: past resolved states are more valuable
  if (payload.outcome === "resolved") weight *= 1.3;

  return cosineScore * weight;
}

// ---- Format for output ----

/**
 * Format probe results for subsystem FIFO / hotmemo consumption.
 */
export function formatResults(results: ProbeResult[]): string {
  if (results.length === 0) return "";
  const lines = results.map(r => {
    const src = r.source === "action_log" ? "past" : "knowledge";
    const tags = r.tags ? ` [${r.tags.join(",")}]` : "";
    return `${src}: ${r.summary}${tags} (${r.score.toFixed(2)})`;
  });
  return lines.join("\n");
}

/** Reset state (for testing). Centroid mode is stateless — nothing to clear. */
export function clearFutureProbe(): void {
  // No-op: centroid is computed from action_log on each call.
  // Kept for API compatibility with index.ts setWatch(false).
}