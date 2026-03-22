// ============================================================
// Receptor — Persona Prior Loader + Lens Swap
// ============================================================
// Reads the most recent PersonaPayload from sphere-ready.jsonl
// and applies it to the receptor's initial state.
//
// This is the "return path" — a persona exported by a previous
// session re-enters the receptor as a behavioral prior, seeding
// ambient baselines and field adjustments so the receptor starts
// calibrated for similar work rather than from zero.
//
// Lens swap: mid-session persona replacement. Clean swap — resets
// emotion state and re-seeds from new persona. No blending.
//
// Design: docs/PERSONA_DESIGN.md

import type { PersonaPayload } from "./sphere-shaper.js";
import type { Persona, Snapshot } from "./persona-snapshot.js";
import { getProfileHash, buildPersonaFromRawSnapshots } from "./persona-snapshot.js";
import type { AmbientEstimator } from "./ambient.js";
import type { AgentState, SessionPoint, EngramWeightEntry } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- Types ----

export interface SessionArcSummary {
  pointCount: number;
  durationMs: number;           // total work time span
  peakSignal?: string;          // highest intensity signal label
  peakIntensity?: number;
  valenceBalance: number;       // +1 = all positive, -1 = all negative, 0 = balanced
}

export interface WeightSummary {
  nodeCount: number;
  topNodes: Array<{ nodeId: string; weight: number; summary: string }>;
}

export interface PriorResult {
  applied: boolean;
  source: string;
  dominantAxis?: string;
  dominantState?: AgentState;
  snapshotCount?: number;
  sessionArc?: SessionArcSummary | null;
  weightSummary?: WeightSummary | null;
}

export interface CompatResult {
  compatible: boolean;
  reason?: string;
  modelMatch: boolean;
  profileMatch: boolean;
}

// ---- Constants ----

const SPHERE_OUTPUT_DIR = path.join(
  process.env.ENGRAM_DATA_DIR ?? path.join(import.meta.dirname!, ".."),
  "receptor-output",
);
const SPHERE_OUTPUT_PATH = path.join(SPHERE_OUTPUT_DIR, "sphere-ready.jsonl");
const PERSONA_SNAPSHOTS_PATH = path.join(SPHERE_OUTPUT_DIR, "persona-snapshots.jsonl");

// Maximum age of a persona to consider (7 days)
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ---- 3. Validation: origin compatibility check ----

/**
 * Check if a persona is compatible with the current receptor.
 * model mismatch = warning (applicable with risk).
 * profileHash mismatch = incompatible (delta semantics differ).
 */
export function validatePersonaCompat(persona: Persona): CompatResult {
  const origin = (persona as any).origin;

  // v1 personas have no origin — compatible by default (legacy)
  if (!origin) {
    return { compatible: true, modelMatch: true, profileMatch: true };
  }

  const currentModel = process.env.ENGRAM_MODEL || "unknown";
  const currentHash = getProfileHash();

  const modelMatch = origin.model === currentModel || origin.model === "unknown" || currentModel === "unknown";
  const profileMatch = origin.profileHash === currentHash || origin.profileHash === "unknown" || currentHash === "unknown";

  if (!profileMatch) {
    return {
      compatible: false,
      reason: `profileHash mismatch: persona=${origin.profileHash} current=${currentHash}. Delta semantics differ — adapter required.`,
      modelMatch,
      profileMatch,
    };
  }

  if (!modelMatch) {
    return {
      compatible: true, // applicable but with warning
      reason: `model mismatch: persona=${origin.model} current=${currentModel}. Lens may behave differently.`,
      modelMatch,
      profileMatch,
    };
  }

  return { compatible: true, modelMatch, profileMatch };
}

// ---- 4. Load + Apply (session start) ----

export interface ReadPriorResult {
  persona: Persona | null;
  source: string;
}

/**
 * Phase 1: Read persona from disk (no side effects).
 * Must be called BEFORE clear*() truncates JSONL files.
 */
export function readPriorPersona(): ReadPriorResult {
  // Primary path: finalized persona from sphere-ready.jsonl
  let persona = readLatestPersona();
  let source = "sphere-ready.jsonl";

  // Degraded path: raw snapshots from persona-snapshots.jsonl
  // (when finalizeSession didn't run — e.g. VSCode X-button kill)
  if (!persona) {
    persona = rebuildPersonaFromSnapshots();
    source = "persona-snapshots.jsonl (degraded)";
  }

  if (!persona) {
    return { persona: null, source: "none" };
  }

  return { persona, source };
}

/**
 * Phase 2: Validate + apply persona to ambient estimator.
 * Must be called AFTER clear() so ambient is fresh.
 */
export function applyPriorPersona(
  prior: ReadPriorResult,
  ambient: AmbientEstimator,
): PriorResult {
  const { persona, source } = prior;

  if (!persona) {
    return { applied: false, source };
  }

  // Check age — stale personas are worse than no prior
  const age = Date.now() - persona.ts;
  if (age > MAX_AGE_MS) {
    console.error(
      `[persona-prior] skip: persona too old (${Math.round(age / 86400000)}d)`
    );
    return { applied: false, source: "expired" };
  }

  // Validate compatibility
  const compat = validatePersonaCompat(persona);
  if (!compat.compatible) {
    console.error(`[persona-prior] skip: ${compat.reason}`);
    return { applied: false, source: "incompatible" };
  }
  if (compat.reason) {
    console.error(`[persona-prior] warn: ${compat.reason}`);
  }

  // Apply
  applyPersona(persona, ambient);

  // Derive dominant state from stateDistribution
  const dominantState = deriveDominantState(persona);

  console.error(
    `[persona-prior] loaded: dominant=${persona.emotionProfile.dominantAxis} ` +
    `state=${dominantState} snaps=${persona.sessionMeta.snapshotCount} ` +
    `age=${Math.round(age / 3600000)}h source=${source}`
  );

  return {
    applied: true,
    source,
    dominantAxis: persona.emotionProfile.dominantAxis,
    dominantState,
    snapshotCount: persona.sessionMeta.snapshotCount,
  };
}

/**
 * Legacy: combined read + apply (for lens swap and other callers).
 * Only safe when files haven't been truncated yet.
 */
export function loadPrior(ambient: AmbientEstimator): PriorResult {
  const prior = readPriorPersona();
  return applyPriorPersona(prior, ambient);
}

// ---- 5. Lens Swap (mid-session) ----

export interface SwapResult {
  applied: boolean;
  reason?: string;
  dominantAxis?: string;
  dominantState?: AgentState;
}

/**
 * Swap the current lens mid-session. Clean swap — no blending.
 *
 * Caller must:
 * 1. Reset accumulator (accumulator.clear())
 * 2. Reset ambient (ambient.clear())
 * 3. Call this function with the new persona
 *
 * This function handles: validation + ambient.applyPrior().
 * Caller handles reset because accumulator/ambient are not accessible here.
 */
export function applyLens(persona: Persona, ambient: AmbientEstimator): SwapResult {
  // Validate
  const compat = validatePersonaCompat(persona);
  if (!compat.compatible) {
    console.error(`[persona-lens] reject: ${compat.reason}`);
    return { applied: false, reason: compat.reason };
  }
  if (compat.reason) {
    console.error(`[persona-lens] warn: ${compat.reason}`);
  }

  // Apply to ambient (caller already cleared it)
  applyPersona(persona, ambient);

  const dominantState = deriveDominantState(persona);

  console.error(
    `[persona-lens] swapped: dominant=${persona.emotionProfile.dominantAxis} ` +
    `state=${dominantState} model=${(persona as any).origin?.model ?? "v1"}`
  );

  return {
    applied: true,
    reason: compat.reason,
    dominantAxis: persona.emotionProfile.dominantAxis,
    dominantState,
  };
}

// ---- Shared internals ----

/** Apply persona's core lens to ambient. v1/v2 compatible. */
function applyPersona(persona: Persona, ambient: AmbientEstimator): void {
  const fieldAdj = (persona as any).fieldAdjustment
    ?? (persona as any).adaptedThresholds?.fieldAdjustment;
  if (fieldAdj) {
    ambient.applyPrior(persona.emotionProfile.meanEmotion, fieldAdj);
  } else {
    ambient.applyPrior(persona.emotionProfile.meanEmotion, {} as any);
  }
}

/** Derive dominant state from stateDistribution. */
function deriveDominantState(persona: Persona): AgentState {
  let dominantState: AgentState = "exploring";
  let maxRatio = 0;
  for (const [state, ratio] of Object.entries(persona.stateDistribution)) {
    if (ratio > maxRatio) {
      maxRatio = ratio;
      dominantState = state as AgentState;
    }
  }
  return dominantState;
}

/**
 * Degraded path: rebuild Persona from raw persona-snapshots.jsonl.
 * Used when finalizeSession() didn't run (e.g. process killed by VSCode X-button).
 * Reads raw snapshots, applies same quality gates, builds persona.
 */
function rebuildPersonaFromSnapshots(): Persona | null {
  try {
    if (!fs.existsSync(PERSONA_SNAPSHOTS_PATH)) return null;

    const content = fs.readFileSync(PERSONA_SNAPSHOTS_PATH, "utf-8").trim();
    if (!content) return null;

    const snapshots: Snapshot[] = [];
    for (const line of content.split("\n")) {
      try {
        const parsed = JSON.parse(line) as Snapshot;
        if (typeof parsed.ts === "number" && parsed.emotion) {
          snapshots.push(parsed);
        }
      } catch {
        // Malformed line — skip
      }
    }

    if (snapshots.length === 0) return null;

    // Read learnedDelta if available
    let learnedDelta: Record<string, number> = {};
    try {
      const learnedPath = path.join(import.meta.dirname!, "receptor-learned.json");
      const learned = JSON.parse(fs.readFileSync(learnedPath, "utf-8")) as { delta: Record<string, number> };
      learnedDelta = learned.delta;
    } catch { /* no learned delta available */ }

    const model = process.env.ENGRAM_MODEL || undefined;
    const persona = buildPersonaFromRawSnapshots(snapshots, learnedDelta, undefined, model);

    if (persona) {
      console.error(
        `[persona-prior] degraded rebuild: ${snapshots.length} raw snapshots → persona ` +
        `dominant=${persona.emotionProfile.dominantAxis}`
      );
    }

    return persona;
  } catch (err) {
    console.error("[persona-prior] degraded rebuild error:", err);
    return null;
  }
}

/** Read sphere-ready.jsonl and return the most recent persona. */
function readLatestPersona(): Persona | null {
  try {
    if (!fs.existsSync(SPHERE_OUTPUT_PATH)) return null;

    const content = fs.readFileSync(SPHERE_OUTPUT_PATH, "utf-8").trim();
    if (!content) return null;

    const lines = content.split("\n");

    // Scan backwards — most recent entries are at the end
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.type === "persona" && parsed.persona) {
          return (parsed as PersonaPayload).persona;
        }
      } catch {
        // Malformed line — skip
      }
    }

    return null;
  } catch (err) {
    console.error("[persona-prior] read error:", err);
    return null;
  }
}

// ---- Session Point Loader (Phase 1: full view) ----

const SESSION_POINTS_PATH = path.join(SPHERE_OUTPUT_DIR, "session-points.jsonl");
const WEIGHT_SNAPSHOT_PATH = path.join(SPHERE_OUTPUT_DIR, "engram-weights.jsonl");

export interface SessionPointWithGap {
  point: SessionPoint;
  gapMs: number;  // work time elapsed since previous point (0 for first)
}

/**
 * Load all SessionPoints from the most recent session.
 * Returns chronologically ordered points with inter-point time gaps.
 * Returns null if no data exists.
 */
export function loadSessionPoints(): SessionPointWithGap[] | null {
  try {
    if (!fs.existsSync(SESSION_POINTS_PATH)) return null;

    const content = fs.readFileSync(SESSION_POINTS_PATH, "utf-8").trim();
    if (!content) return null;

    const points: SessionPoint[] = [];
    for (const line of content.split("\n")) {
      try {
        const parsed = JSON.parse(line) as SessionPoint;
        if (typeof parsed.t === "number" && typeof parsed.label === "string") {
          points.push(parsed);
        }
      } catch {
        // Malformed line — skip
      }
    }

    if (points.length === 0) return null;

    // Sort by work time (should already be ordered, but defensive)
    points.sort((a, b) => a.t - b.t);

    // Compute inter-point gaps
    const result: SessionPointWithGap[] = [];
    for (let i = 0; i < points.length; i++) {
      result.push({
        point: points[i],
        gapMs: i === 0 ? 0 : points[i].t - points[i - 1].t,
      });
    }

    return result;
  } catch (err) {
    console.error("[persona-prior] session points read error:", err);
    return null;
  }
}

// ---- Engram Weight Snapshot Loader ----

/**
 * Load engram weight snapshot from the most recent session.
 * Returns the weight distribution of knowledge referenced during the session.
 * For persona showcase: this is "what the craftsman knew, and how much it mattered."
 */
export function loadWeightSnapshot(): EngramWeightEntry[] | null {
  try {
    if (!fs.existsSync(WEIGHT_SNAPSHOT_PATH)) return null;

    const content = fs.readFileSync(WEIGHT_SNAPSHOT_PATH, "utf-8").trim();
    if (!content) return null;

    const entries: EngramWeightEntry[] = [];
    for (const line of content.split("\n")) {
      try {
        const parsed = JSON.parse(line) as EngramWeightEntry;
        if (typeof parsed.nodeId === "string" && typeof parsed.weight === "number") {
          entries.push(parsed);
        }
      } catch {
        // Malformed line — skip
      }
    }

    return entries.length > 0 ? entries : null;
  } catch (err) {
    console.error("[persona-prior] weight snapshot read error:", err);
    return null;
  }
}

// ---- Summarizers (for PriorResult) ----

export function summarizeSessionArc(points: SessionPointWithGap[]): SessionArcSummary {
  const count = points.length;
  const durationMs = count > 0 ? points[count - 1].point.t - points[0].point.t : 0;

  // Find peak signal
  let peakSignal: string | undefined;
  let peakIntensity = 0;
  let positiveCount = 0;
  let negativeCount = 0;

  for (const { point } of points) {
    if (point.intensity > peakIntensity) {
      peakIntensity = point.intensity;
      peakSignal = point.label;
    }
    if (point.valence === 1) positiveCount++;
    if (point.valence === -1) negativeCount++;
  }

  const total = positiveCount + negativeCount;
  const valenceBalance = total > 0 ? (positiveCount - negativeCount) / total : 0;

  return { pointCount: count, durationMs, peakSignal, peakIntensity, valenceBalance };
}

export function summarizeWeights(entries: EngramWeightEntry[]): WeightSummary {
  // Top 5 by weight descending
  const sorted = [...entries].sort((a, b) => b.weight - a.weight);
  const topNodes = sorted.slice(0, 5).map(e => ({
    nodeId: e.nodeId,
    weight: e.weight,
    summary: e.summary,
  }));

  return { nodeCount: entries.length, topNodes };
}

// ---- Prior Block Builder (AI Native Format) ----

/**
 * Build a Prior Block — compact JSON array for AI consumption.
 *
 * Three-part structure:
 *   Header (purpose)  → what the session was about
 *   Arc    (journey)  → time-series of session points with inter-point gaps
 *   Footer (outcome)  → weight distribution of referenced knowledge
 *
 * Design: docs/PERSONA_LOADING_SYSTEM.md — AI Native Prior Format
 */

// Sampling thresholds
const PRIOR_BLOCK_MAX_POINTS = 200;

type PriorHeader = ["H", number, number, ...number[]];
// ["H", durationMs, valenceBalance, frustration, seeking, confidence, fatigue, flow]

type PriorArcPoint = ["A", number, number, string, number, number, number];
// ["A", t, gapMs, label, intensity, valence, freq]
// Note: per-axis deltas will replace label/valence in future iteration

type PriorFooter = ["F", number, ...Array<[string, number]>];
// ["F", nodeCount, [summary, weight], ...]

type PriorBlock = [PriorHeader, ...PriorArcPoint[], PriorFooter] | [PriorHeader, ...PriorArcPoint[]];

export function buildPriorBlock(
  points: SessionPointWithGap[],
  weights: EngramWeightEntry[] | null,
  priorResult: PriorResult,
): PriorBlock | null {
  if (points.length === 0) return null;

  // --- Header ---
  const durationMs = points[points.length - 1].point.t - points[0].point.t;

  let positiveCount = 0;
  let negativeCount = 0;
  for (const { point } of points) {
    if (point.valence === 1) positiveCount++;
    if (point.valence === -1) negativeCount++;
  }
  const total = positiveCount + negativeCount;
  const valenceBalance = total > 0
    ? Math.round(((positiveCount - negativeCount) / total) * 100) / 100
    : 0;

  // Initial emotion state placeholder — 5 zeros until we record emotion snapshots
  // Future: read from first persona-snapshot or ambient state at session start
  const header: PriorHeader = ["H", durationMs, valenceBalance, 0, 0, 0, 0, 0];

  // --- Arc ---
  let sampled = points;
  if (points.length > PRIOR_BLOCK_MAX_POINTS) {
    sampled = samplePoints(points, PRIOR_BLOCK_MAX_POINTS);
  }

  const arc: PriorArcPoint[] = sampled.map(({ point, gapMs }) => [
    "A",
    point.t,
    gapMs,
    point.label,
    Math.round(point.intensity * 100) / 100,
    point.valence,
    Math.round(point.freq * 100) / 100,
  ]);

  // --- Footer ---
  if (weights && weights.length > 0) {
    const sorted = [...weights].sort((a, b) => b.weight - a.weight);
    const topPairs: Array<[string, number]> = sorted
      .slice(0, 5)
      .map(e => [e.summary, Math.round(e.weight * 10) / 10]);
    const footer: PriorFooter = ["F", weights.length, ...topPairs];
    return [header, ...arc, footer] as PriorBlock;
  }

  return [header, ...arc] as PriorBlock;
}

/**
 * Sample points for large sessions.
 * Strategy: keep high-delta points + sign-reversal points + even spacing.
 */
function samplePoints(
  points: SessionPointWithGap[],
  maxPoints: number,
): SessionPointWithGap[] {
  if (points.length <= maxPoints) return points;

  // Always keep first and last
  const kept = new Set<number>([0, points.length - 1]);

  // Score each point: intensity + valence reversal bonus
  const scores: Array<{ idx: number; score: number }> = [];
  for (let i = 1; i < points.length - 1; i++) {
    let score = points[i].point.intensity;
    // Valence reversal bonus
    if (i > 0 && points[i].point.valence !== points[i - 1].point.valence) {
      score += 0.3;
    }
    scores.push({ idx: i, score });
  }

  // Take top scorers
  const highDelta = Math.floor(maxPoints * 0.6);
  scores.sort((a, b) => b.score - a.score);
  for (let i = 0; i < Math.min(highDelta, scores.length); i++) {
    kept.add(scores[i].idx);
  }

  // Fill remaining with even spacing
  const remaining = maxPoints - kept.size;
  if (remaining > 0) {
    const step = points.length / remaining;
    for (let i = 0; i < remaining; i++) {
      kept.add(Math.round(i * step));
    }
  }

  // Sort by index and return
  const sortedIndices = [...kept].sort((a, b) => a - b).slice(0, maxPoints);
  return sortedIndices.map(i => points[i]);
}

/** Inline schema — travels with the data so the agent always knows the format. */
const PRIOR_BLOCK_SCHEMA =
  "[prior-block schema: " +
  "H=header(durationMs,valenceBalance,frustration,seeking,confidence,fatigue,flow) " +
  "A=arc(t,gapMs,label,intensity,valence,freq) " +
  "F=footer(nodeCount,...[summary,weight])]";

/**
 * Format Prior Block as a compact string for tool response embedding.
 * Includes inline schema header so the receiving agent can interpret the data.
 */
export function formatPriorBlock(block: PriorBlock): string {
  return `${PRIOR_BLOCK_SCHEMA}\n${JSON.stringify(block)}`;
}
