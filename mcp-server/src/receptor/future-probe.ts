// ============================================================
// Receptor — Future Probe (predictive knowledge supply)
// ============================================================
// Computes movement vector (Δv) from recent action_log entries,
// projects future position, and searches for relevant knowledge.
//
// Query generation is the core value — search target is swappable
// (local Qdrant now, Sphere later).
//
// Two phases:
//   1. buildQuery(): entropy + Δv + emotion → query vector + filters
//   2. execute():    query → search → format → output-router

import type { EmotionVector, AgentState } from "./types.js";

// ---- Config ----

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3100";
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const ACTION_LOG_COLLECTION = "action_log";
const ENGRAM_COLLECTION = "engram";

// ---- Types ----

export interface ProbeContext {
  topPaths: string[];
  emotion: EmotionVector;
  agentState: AgentState;
  entropy: number;
  projectId?: string;
}

interface ProbeQuery {
  vector: number[];       // predicted future position
  emotion: EmotionVector; // for post-filter ranking
  agentState: AgentState;
  alpha: number;          // prediction confidence
}

interface ProbeResult {
  id: string;
  score: number;
  summary: string;
  tags?: string[];
  source: "action_log" | "engram";
}

// ---- Embedding cache (v_prev, v_now) ----

let _vPrev: number[] | null = null;
let _vNow: number[] | null = null;

// ---- Embedding via gateway ----

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

// ---- Query generation (core value) ----

/**
 * Build a predictive query from current context.
 *
 * - Embeds current action state as v_now
 * - Computes Δv = v_now - v_prev (movement direction)
 * - Projects v_future = v_now + α × Δv
 * - α is adjusted by entropy and emotion
 *
 * Returns null if insufficient history (need at least 2 snapshots).
 */
export async function buildQuery(ctx: ProbeContext): Promise<ProbeQuery | null> {
  // Build current action text
  const pathParts = ctx.topPaths.slice(0, 5).map(p => {
    const segs = p.split("/");
    return segs.slice(-2).join("/");
  });
  const text = `${ctx.agentState} ${pathParts.join(", ")}`;

  // Embed current state
  const v = await embed(text);
  if (!v) return null;

  // Shift history
  _vPrev = _vNow;
  _vNow = v;

  // Need at least 2 snapshots for Δv
  if (!_vPrev) return null;

  // Compute Δv (movement direction)
  const delta = vecSub(_vNow, _vPrev);

  // Compute α (prediction confidence)
  //   entropy low  → α large (direction is confident, look further)
  //   entropy high → α small (direction unclear, stay close)
  //   frustration rising → also explore lateral/reverse (handled by caller)
  const entropyFactor = Math.max(0.1, 1 - ctx.entropy / 4); // entropy 0→1.0, entropy 4→0.1
  const alpha = entropyFactor * 0.5; // base scale 0.5, dampened by entropy

  // Project future position
  const vFuture = vecNorm(vecAdd(_vNow, delta, alpha));

  return {
    vector: vFuture,
    emotion: ctx.emotion,
    agentState: ctx.agentState,
    alpha,
  };
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

  if (query.emotion.hunger > 0.5) {
    // Hunger high → prioritize howto/where
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

/** Reset state (for testing). */
export function clearFutureProbe(): void {
  _vPrev = null;
  _vNow = null;
}