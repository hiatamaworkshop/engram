// ============================================================
// Receptor — Future Probe (predictive knowledge supply)
// ============================================================
// Searches for relevant knowledge near the current behavioral position.
//
// Position = weighted centroid of recent action_log entries.
// Weights: exponential recency decay × entropy magnitude.
//
// Design: NO linear extrapolation — embedding space non-linearity makes
// Δv projection unreliable. Instead:
//   1. Search at centroidNow with trigger-scaled radius
//   2. Post-filter by delta alignment + emotion proximity
//
// Trigger strength = emotionNorm × 0.6 + entropy × 0.4
//   → scales search radius (calm=tight, intense=wide)
//
// Three phases:
//   1. buildQuery(): centroid + Δv + triggerStrength
//   2. execute():    threshold search → delta+emotion post-filter
//   3. format():     output-router

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
  vector: number[];       // search position (centroidNow — no extrapolation)
  delta: number[];        // movement direction (centroidNew - centroidOld) for post-filter
  emotion: EmotionVector; // for post-filter ranking
  agentState: AgentState;
  triggerStrength: number; // emotion intensity × entropy blend → scales search radius
  alpha: number;          // prediction confidence (retained for enriched centroid)
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

/** L2 magnitude */
function vecMag(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

/** Cosine similarity between two vectors */
function cosineSim(a: number[], b: number[]): number {
  const magA = vecMag(a);
  const magB = vecMag(b);
  if (magA === 0 || magB === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (magA * magB);
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
 * Build a search query from action_log centroids.
 *
 * - Fetches recent 2N entries from action_log (Qdrant scroll)
 * - Splits into new window (0..N-1) and old window (N..2N-1)
 * - Computes weighted centroids for each window
 * - Δv = centroid_new - centroid_old (kept for post-filter, NOT extrapolated)
 * - Search vector = centroidNow (no linear extrapolation — avoids
 *   embedding-space non-linearity artifacts)
 * - triggerStrength = emotionNorm × 0.6 + entropy × 0.4 → scales search radius
 *
 * Falls back to null if action_log has < 2 entries.
 */
export async function buildQuery(ctx: ProbeContext): Promise<ProbeQuery | null> {
  // Adaptive window: high intensity → wider window → stronger centroid
  const intensity = Math.min(1, Math.max(ctx.emotion.frustration, ctx.entropy / 3));
  const windowN = WINDOW_N_BASE + Math.round(intensity * WINDOW_N_MAX_EXPAND);

  const points = await scrollRecentVectors(windowN * 2, ctx.projectId);

  if (points.length < 2) {
    console.error(`[future-probe] insufficient action_log entries (${points.length}), skipping`);
    return null;
  }

  const splitAt = Math.min(windowN, Math.floor(points.length / 2));
  const windowNew = points.slice(0, splitAt);
  const windowOld = points.slice(splitAt);

  const centroidNew = weightedCentroid(windowNew);
  const centroidOld = weightedCentroid(windowOld);

  if (!centroidNew || !centroidOld) return null;

  // Δv: movement direction — used for post-filter ranking, not extrapolation
  const delta = vecSub(centroidNew, centroidOld);

  // α: retained for enriched centroid compatibility
  const entropyFactor = Math.max(0.1, 1 - ctx.entropy / 4);
  const alpha = entropyFactor * 0.5;

  // Trigger strength: emotion intensity (L2 norm) × 0.6 + entropy × 0.4
  // Clamped to [0, 1] to prevent extreme radius scaling
  const emotionVec = [
    ctx.emotion.frustration, ctx.emotion.seeking, ctx.emotion.confidence,
    ctx.emotion.fatigue, ctx.emotion.flow,
  ];
  const emotionNorm = Math.min(1, vecMag(emotionVec));
  const normalizedEntropy = Math.min(1, ctx.entropy / 3);
  const triggerStrength = Math.min(1, emotionNorm * 0.6 + normalizedEntropy * 0.4);

  return {
    vector: centroidNew,       // search at current position, no extrapolation
    delta,                     // for post-filter delta alignment
    emotion: ctx.emotion,
    agentState: ctx.agentState,
    triggerStrength,
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
 *
 * 1. Trigger strength → dynamic score_threshold (calm=0.5, max=0.3)
 * 2. Fetch candidates from action_log + engram at centroidNow
 * 3. Post-filter: delta alignment + emotion proximity + tag heuristics
 */
export async function executeSearch(query: ProbeQuery, projectId?: string): Promise<ProbeResult[]> {
  // Dynamic threshold: stronger trigger → lower threshold → wider search
  // Floor at 0.3 to avoid noise; ceiling at 0.5 for calm state
  const threshold = 0.5 - query.triggerStrength * 0.2;

  const results: ProbeResult[] = [];

  // Search action_log for past behavioral patterns
  const actionResults = await searchQdrantWithThreshold(
    ACTION_LOG_COLLECTION, query.vector, 10, threshold, projectId,
  );
  for (const r of actionResults) {
    results.push({
      id: r.id,
      score: applyPostFilter(r.score, r.payload, query),
      summary: r.payload.text || `[${r.payload.state}] entropy=${r.payload.entropy}`,
      source: "action_log",
    });
  }

  // Search engram for relevant knowledge
  const engramResults = await searchQdrantWithThreshold(
    ENGRAM_COLLECTION, query.vector, 10, threshold, projectId,
  );
  for (const r of engramResults) {
    results.push({
      id: r.id,
      score: applyPostFilter(r.score, r.payload, query),
      summary: r.payload.summary || "(no summary)",
      tags: r.payload.tags,
      source: "engram",
    });
  }

  // Sort by weighted score, descending
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 5);
}

// ---- Qdrant search (threshold-aware) ----

async function searchQdrantWithThreshold(
  collection: string,
  vector: number[],
  limit: number,
  scoreThreshold: number,
  projectId?: string,
): Promise<Array<{ id: string; score: number; payload: Record<string, any> }>> {
  try {
    const filter = projectId
      ? { must: [{ key: "projectId", match: { value: projectId } }] }
      : undefined;

    const res = await fetch(`${QDRANT_URL}/collections/${collection}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector, limit, with_payload: true, with_vector: true,
        score_threshold: scoreThreshold, filter,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      result: Array<{ id: string; score: number; vector: number[]; payload: Record<string, any> }>;
    };
    return data.result;
  } catch {
    return [];
  }
}

// ---- Post-filter: delta alignment + emotion proximity + tag heuristics ----

/**
 * Three-layer post-filter ranking:
 *
 * 1. Delta alignment: does the candidate's movement direction match ours?
 *    - Same direction → 1.2x bonus
 *    - Opposite direction → 0.5x (still useful as "what not to do")
 *
 * 2. Emotion proximity: cosine similarity between candidate's emotion
 *    vector and current emotion. Similar emotional context → more relevant.
 *
 * 3. Tag heuristics: retained from v1 (gotcha boost under frustration, etc.)
 */
function applyPostFilter(
  cosineScore: number,
  payload: Record<string, any>,
  query: ProbeQuery,
): number {
  let weight = 1.0;

  // --- Layer 1: Delta alignment ---
  // If candidate has a vector, compute its implied delta relative to query centroid
  if (payload.vector && query.delta) {
    const candidateOffset = vecSub(payload.vector, query.vector);
    const deltaCos = cosineSim(candidateOffset, query.delta);
    if (deltaCos > 0.3) {
      weight *= 1.2;   // same direction bonus
    } else if (deltaCos < -0.3) {
      weight *= 0.5;   // opposite direction — dampen, don't exclude
    }
    // -0.3..0.3 → neutral, no adjustment
  }

  // --- Layer 2: Emotion proximity ---
  const candidateEmotion = payload.emotion as EmotionVector | undefined;
  if (candidateEmotion) {
    const currentVec = [
      query.emotion.frustration, query.emotion.seeking, query.emotion.confidence,
      query.emotion.fatigue, query.emotion.flow,
    ];
    const candidateVec = [
      candidateEmotion.frustration ?? 0, candidateEmotion.seeking ?? 0,
      candidateEmotion.confidence ?? 0, candidateEmotion.fatigue ?? 0,
      candidateEmotion.flow ?? 0,
    ];
    const emotionSim = cosineSim(currentVec, candidateVec);
    // Scale: sim=1 → 1.3x, sim=0 → 1.0x, sim=-1 → 0.7x
    weight *= 1.0 + emotionSim * 0.3;
  }

  // --- Layer 3: Tag heuristics (retained from v1) ---
  const tags: string[] = payload.tags || [];
  const pastState: string = payload.state || "";

  if (query.emotion.frustration > 0.5) {
    if (tags.includes("gotcha") || tags.includes("error-resolved")) weight *= 1.5;
    if (pastState === "stuck") weight *= 1.3;
  }

  if (Math.abs(query.emotion.seeking) > 0.5) {
    if (tags.includes("howto") || tags.includes("where")) weight *= 1.4;
  }

  if (query.emotion.confidence > 0.5) {
    weight *= 0.5;
  }

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