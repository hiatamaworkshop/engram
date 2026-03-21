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
import type { Persona } from "./persona-snapshot.js";
import { getProfileHash } from "./persona-snapshot.js";
import type { AmbientEstimator } from "./ambient.js";
import type { AgentState, SessionPoint, EngramWeightEntry } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- Types ----

export interface PriorResult {
  applied: boolean;
  source: string;
  dominantAxis?: string;
  dominantState?: AgentState;
  snapshotCount?: number;
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

/**
 * Load the most recent persona from sphere-ready.jsonl and apply
 * it to the ambient estimator as a behavioral prior.
 *
 * Returns metadata about what was loaded (for logging/status).
 */
export function loadPrior(ambient: AmbientEstimator): PriorResult {
  const persona = readLatestPersona();
  if (!persona) {
    return { applied: false, source: "none" };
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
    `age=${Math.round(age / 3600000)}h`
  );

  return {
    applied: true,
    source: "sphere-ready.jsonl",
    dominantAxis: persona.emotionProfile.dominantAxis,
    dominantState,
    snapshotCount: persona.sessionMeta.snapshotCount,
  };
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
