// ============================================================
// Receptor — Persona Prior Loader
// ============================================================
// Reads the most recent PersonaPayload from sphere-ready.jsonl
// and applies it to the receptor's initial state.
//
// This is the "return path" — a persona exported by a previous
// session re-enters the receptor as a behavioral prior, seeding
// ambient baselines and field adjustments so the receptor starts
// calibrated for similar work rather than from zero.
//
// Design: the prior is a suggestion, not a command. The receptor
// overwrites it naturally as new events accumulate. The prior
// only affects the initial calibration window (~first 20 events).

import type { PersonaPayload } from "./sphere-shaper.js";
import type { Persona } from "./persona-snapshot.js";
import type { AmbientEstimator } from "./ambient.js";
import type { AgentState } from "./types.js";
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

// ---- Constants ----

const SPHERE_OUTPUT_DIR = path.join(
  process.env.ENGRAM_DATA_DIR ?? path.join(import.meta.dirname!, ".."),
  "receptor-output",
);
const SPHERE_OUTPUT_PATH = path.join(SPHERE_OUTPUT_DIR, "sphere-ready.jsonl");

// Maximum age of a persona to consider (7 days)
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ---- Public API ----

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

  // Apply to ambient: seed EMA baselines from persona's emotion profile
  // and field adjustments. v2: top-level fieldAdjustment. v1 compat: adaptedThresholds.
  const fieldAdj = (persona as any).fieldAdjustment
    ?? (persona as any).adaptedThresholds?.fieldAdjustment;
  if (fieldAdj) {
    ambient.applyPrior(persona.emotionProfile.meanEmotion, fieldAdj);
  } else {
    ambient.applyPrior(persona.emotionProfile.meanEmotion, {} as any);
  }

  // Derive dominant state from stateDistribution
  let dominantState: AgentState = "exploring";
  let maxRatio = 0;
  for (const [state, ratio] of Object.entries(persona.stateDistribution)) {
    if (ratio > maxRatio) {
      maxRatio = ratio;
      dominantState = state as AgentState;
    }
  }

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

// ---- Internal ----

/**
 * Read sphere-ready.jsonl and return the most recent PersonaPayload's persona.
 * Scans from the end of the file for efficiency.
 */
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
