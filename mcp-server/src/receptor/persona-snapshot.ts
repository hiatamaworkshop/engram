// ============================================================
// Receptor — Persona Snapshot (positive-trigger behavioral capture)
// ============================================================
// Passive-only: captures receptor state snapshots when positive signals
// (confidence_sustained, flow_active) fire. No constant monitoring.
// At session end, aggregates snapshots into a Persona — a statistical
// fingerprint of successful behavioral patterns.
//
// Design: RECEPTOR_ARCHITECTURE.md §12

import type { EmotionVector, EmotionAxis, FireSignal, PatternKind, AgentState, ProjectMeta } from "./types.js";
import type { AmbientEstimator } from "./ambient.js";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---- Profile hash (computed once at module load) ----
// SHA-256 of emotion-profile.json — defines the semantic context of all delta values.

let _profileHash = "unknown";
try {
  const profilePath = join(import.meta.dirname!, "emotion-profile.json");
  const raw = readFileSync(profilePath, "utf-8");
  _profileHash = createHash("sha256").update(raw).digest("hex").slice(0, 16); // short hash
} catch { /* fallback to "unknown" */ }

export function getProfileHash(): string { return _profileHash; }

// ---- Constants ----

// No upper limit during test phase — all snapshots retained for analysis.
// Aggregation/thinning is the loader's job, not the recorder's.
// Each snapshot ~200 bytes; 1000 snapshots = ~200KB. No memory concern.
const POSITIVE_SIGNALS = new Set(["confidence_sustained", "flow_active"]);

// workContext sanitization limits (same rules apply at Facade)
const MAX_TECH_STACK = 5;
const MAX_DOMAIN = 3;
const MAX_TAG_LENGTH = 30;
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// Minimum snapshots required for persona generation
const MIN_SNAPSHOTS = 2;
// Minimum average confidence across snapshots
const CONFIDENCE_AVG_MIN = 0.4;

// ---- Types ----

export interface Snapshot {
  ts: number;
  emotion: EmotionVector;
  agentState: AgentState;
  pattern: PatternKind;
  thresholds: Record<EmotionAxis, number>;
  fieldAdjustment: Record<EmotionAxis, number>;
  entropy: number;
}

/** Persona — statistical fingerprint for Sphere.
 *
 * Design: docs/PERSONA_DESIGN.md
 *
 * A persona is a "lens" — a set of perceptual calibrations distilled from
 * one or more sessions. It records HOW to perceive, not WHAT was done.
 * Lightweight, reversible, swappable. Not blended — swapped.
 */
export interface Persona {
  $schema: "receptor-persona-v2";
  ts: number;

  // ---- Origin: distillation conditions ----
  // Required for Sphere showcase compatibility.
  // Same learnedDelta means different things under different models/profiles.
  origin: {
    model: string;            // e.g. "claude-opus-4-6", "claude-sonnet-4-6"
    profileHash: string;      // SHA-256 hex of emotion-profile.json (defines impulse/decay semantics)
    cumulativeSessions: number; // how many sessions contributed to this lens (1 = single session)
  };

  // ---- Core lens: what gets applied ----
  emotionProfile: {
    meanEmotion: Record<EmotionAxis, number>;   // EMA baseline seed
    dominantAxis: EmotionAxis;                   // highest absolute mean — showcase label
  };
  fieldAdjustment: Record<EmotionAxis, number>;  // MetaNeuron C field seed
  learnedDelta: Record<string, number>;          // domain-specific sensitivity adjustments

  // ---- Behavioral signature: what the lens was distilled from ----
  patternDistribution: Record<PatternKind, number>;  // normalized histogram
  stateDistribution: Record<AgentState, number>;     // normalized histogram

  // ---- Context: showcase filtering ----
  workContext: {
    techStack?: string[];
    domain?: string[];
  };

  // ---- Quality metadata ----
  sessionMeta: {
    elapsedMs: number;
    snapshotCount: number;
    confidenceAvg: number;     // gate value — quality indicator
    emotionVariance: Record<EmotionAxis, number>;  // stability indicator
    entropyAvg: number;        // work focus indicator
  };
}

// ---- Output path (kill-safe append) ----

const OUTPUT_DIR = join(
  process.env.ENGRAM_DATA_DIR ?? join(import.meta.dirname!, ".."),
  "receptor-output",
);
const PERSONA_SNAPSHOTS_PATH = join(OUTPUT_DIR, "persona-snapshots.jsonl");

// ---- Singleton state ----

const _snapshots: Snapshot[] = [];

const AXES: EmotionAxis[] = ["frustration", "seeking", "confidence", "fatigue", "flow"];

// ---- Public API ----

/**
 * Called when positive signals fire. Captures receptor state snapshot.
 */
export function captureSnapshot(
  signals: FireSignal[],
  emotion: EmotionVector,
  agentState: AgentState,
  pattern: PatternKind,
  ambient: AmbientEstimator,
  entropy: number,
): void {
  const hasPositive = signals.some(s => POSITIVE_SIGNALS.has(s.kind));
  if (!hasPositive) return;

  const thresholds = {} as Record<EmotionAxis, number>;
  const fieldAdj = {} as Record<EmotionAxis, number>;
  for (const axis of AXES) {
    thresholds[axis] = ambient.effectiveThreshold(axis);
    fieldAdj[axis] = ambient.fieldAdjustment[axis];
  }

  const snapshot: Snapshot = {
    ts: Date.now(),
    emotion: { ...emotion },
    agentState,
    pattern,
    thresholds,
    fieldAdjustment: { ...fieldAdj },
    entropy,
  };

  _snapshots.push(snapshot);

  // Append immediately — kill-safe, no finalize dependency
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    appendFileSync(PERSONA_SNAPSHOTS_PATH, JSON.stringify(snapshot) + "\n");
  } catch (err) {
    console.error("[persona] snapshot append error:", err);
  }
}

/**
 * Called at engram_watch stop. Aggregates snapshots into Persona.
 * Push gate: snapshots >= 2 && confidenceAvg >= 0.4.
 */
export function finalizeSession(
  elapsedMs: number,
  learnedDelta: Record<string, number>,
  projectMeta?: ProjectMeta,
  model?: string,
): Persona | null {
  if (_snapshots.length < MIN_SNAPSHOTS) {
    console.error(`[persona] skip: ${_snapshots.length} snapshots (need >=${MIN_SNAPSHOTS})`);
    return null;
  }

  // Push gate: confidence average across snapshots
  const confidenceAvg = _snapshots.reduce((a, s) => a + s.emotion.confidence, 0) / _snapshots.length;
  if (confidenceAvg < CONFIDENCE_AVG_MIN) {
    console.error(
      `[persona] skip: confidenceAvg=${confidenceAvg.toFixed(2)} (min ${CONFIDENCE_AVG_MIN})`
    );
    return null;
  }

  return _buildPersona(elapsedMs, learnedDelta, confidenceAvg, projectMeta, model);
}

/** Clear all state (called on watch start). Truncates JSONL for new session. */
export function clearPersonaState(): void {
  _snapshots.length = 0;
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(PERSONA_SNAPSHOTS_PATH, "");
  } catch { /* ignore */ }
}

/** Get snapshot count (for status display). */
export function snapshotCount(): number {
  return _snapshots.length;
}

/** Get snapshots for debug inspection. */
export function getSnapshots(): ReadonlyArray<Snapshot> {
  return _snapshots;
}

/**
 * Build Persona from raw snapshots (degraded path).
 * Used by persona-prior when finalizeSession didn't run (e.g. VSCode X-button kill).
 * Same logic as finalizeSession + _buildPersona but accepts external snapshot array.
 */
export function buildPersonaFromRawSnapshots(
  snapshots: Snapshot[],
  learnedDelta?: Record<string, number>,
  projectMeta?: ProjectMeta,
  model?: string,
): Persona | null {
  if (snapshots.length < MIN_SNAPSHOTS) return null;

  const confidenceAvg = snapshots.reduce((a, s) => a + s.emotion.confidence, 0) / snapshots.length;
  if (confidenceAvg < CONFIDENCE_AVG_MIN) return null;

  // Estimate elapsed from first/last snapshot timestamps
  const elapsedMs = snapshots.length > 1
    ? snapshots[snapshots.length - 1].ts - snapshots[0].ts
    : 0;

  // Temporarily swap _snapshots for _buildPersona (uses module-level array)
  const saved = _snapshots.slice();
  _snapshots.length = 0;
  _snapshots.push(...snapshots);
  const persona = _buildPersona(elapsedMs, learnedDelta ?? {}, confidenceAvg, projectMeta, model);
  _snapshots.length = 0;
  _snapshots.push(...saved);

  return persona;
}

// ---- Internal ----

function _round3(v: number): number { return Math.round(v * 1000) / 1000; }
function _round4(v: number): number { return Math.round(v * 10000) / 10000; }

/** Sanitize workContext tags: lowercase, alphanumeric+hyphen, length limit, count limit. */
function _sanitizeTags(tags: string[] | undefined, maxCount: number): string[] | undefined {
  if (!tags || tags.length === 0) return undefined;
  return tags
    .map(t => t.toLowerCase().trim().slice(0, MAX_TAG_LENGTH))
    .filter(t => TAG_PATTERN.test(t))
    .slice(0, maxCount);
}

function _buildPersona(
  elapsedMs: number,
  learnedDelta: Record<string, number>,
  confidenceAvg: number,
  projectMeta?: ProjectMeta,
  model?: string,
): Persona {
  const n = _snapshots.length;

  // ---- Core lens: emotion mean (EMA seed) ----
  const meanEmotion = {} as Record<EmotionAxis, number>;
  const emotionVariance = {} as Record<EmotionAxis, number>;

  for (const axis of AXES) {
    const values = _snapshots.map(s => s.emotion[axis]);
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
    meanEmotion[axis] = _round3(mean);
    emotionVariance[axis] = _round4(variance);
  }

  // Dominant axis: highest absolute mean
  let dominantAxis: EmotionAxis = "flow";
  let maxAbsMean = 0;
  for (const axis of AXES) {
    const abs = Math.abs(meanEmotion[axis]);
    if (abs > maxAbsMean) { maxAbsMean = abs; dominantAxis = axis; }
  }

  // ---- Core lens: field adjustment (MetaNeuron C seed) ----
  const meanFieldAdj = {} as Record<EmotionAxis, number>;
  for (const axis of AXES) {
    meanFieldAdj[axis] = _round3(_snapshots.reduce((a, s) => a + s.fieldAdjustment[axis], 0) / n);
  }

  // ---- Behavioral signature: pattern + state distributions ----
  const patternCounts: Record<string, number> = {};
  for (const s of _snapshots) {
    patternCounts[s.pattern] = (patternCounts[s.pattern] ?? 0) + 1;
  }
  const patternDistribution = {} as Record<PatternKind, number>;
  for (const [pat, count] of Object.entries(patternCounts)) {
    patternDistribution[pat as PatternKind] = _round3(count / n);
  }

  const stateCounts: Record<string, number> = {};
  for (const s of _snapshots) {
    stateCounts[s.agentState] = (stateCounts[s.agentState] ?? 0) + 1;
  }
  const stateDistribution = {} as Record<AgentState, number>;
  for (const [state, count] of Object.entries(stateCounts)) {
    stateDistribution[state as AgentState] = _round3(count / n);
  }

  // ---- Quality metadata ----
  const entropyAvg = _round3(_snapshots.reduce((a, s) => a + s.entropy, 0) / n);

  // ---- Assemble persona v2 ----
  return {
    $schema: "receptor-persona-v2",
    ts: Date.now(),
    origin: {
      model: model || process.env.ENGRAM_MODEL || "unknown",
      profileHash: _profileHash,
      cumulativeSessions: 1,
    },
    emotionProfile: {
      meanEmotion,
      dominantAxis,
    },
    fieldAdjustment: meanFieldAdj,
    learnedDelta: { ...learnedDelta },
    patternDistribution,
    stateDistribution,
    workContext: {
      techStack: _sanitizeTags(projectMeta?.techStack, MAX_TECH_STACK),
      domain: _sanitizeTags(projectMeta?.domain, MAX_DOMAIN),
    },
    sessionMeta: {
      elapsedMs,
      snapshotCount: n,
      confidenceAvg: _round3(confidenceAvg),
      emotionVariance,
      entropyAvg,
    },
  };
}
