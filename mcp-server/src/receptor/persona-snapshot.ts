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

// ---- Constants ----

const MAX_SNAPSHOTS = 10;
const POSITIVE_SIGNALS = new Set(["confidence_sustained", "flow_active"]);

// Minimum snapshots required for persona generation
const MIN_SNAPSHOTS = 2;
// Minimum average confidence across snapshots
const CONFIDENCE_AVG_MIN = 0.4;

// ---- Types ----

interface Snapshot {
  ts: number;
  emotion: EmotionVector;
  agentState: AgentState;
  pattern: PatternKind;
  thresholds: Record<EmotionAxis, number>;
  fieldAdjustment: Record<EmotionAxis, number>;
  entropy: number;
}

/** Persona — statistical fingerprint for Sphere. */
export interface Persona {
  $schema: string;
  ts: number;
  actionSignature?: number[]; // from action_log centroid, injected externally
  emotionProfile: {
    meanEmotion: Record<EmotionAxis, number>;
    emotionVariance: Record<EmotionAxis, number>;
    dominantAxis: EmotionAxis;
  };
  adaptedThresholds: {
    mean: Record<EmotionAxis, number>;
    fieldAdjustment: Record<EmotionAxis, number>;
  };
  patternDistribution: Record<PatternKind, number>;
  stateDistribution: Record<AgentState, number>;
  learnedDelta: Record<string, number>;
  workContext: {
    techStack?: string[];
    domain?: string[];
    entropyAvg: number;
  };
  sessionMeta: {
    elapsedMs: number;
    snapshotCount: number;
  };
}

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

  _snapshots.push({
    ts: Date.now(),
    emotion: { ...emotion },
    agentState,
    pattern,
    thresholds,
    fieldAdjustment: { ...fieldAdj },
    entropy,
  });

  // Evict oldest if over capacity
  while (_snapshots.length > MAX_SNAPSHOTS) {
    _snapshots.shift();
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
  actionSignature?: number[],
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

  return _buildPersona(elapsedMs, learnedDelta, projectMeta, actionSignature);
}

/** Clear all state (called on watch start). */
export function clearPersonaState(): void {
  _snapshots.length = 0;
}

/** Get snapshot count (for status display). */
export function snapshotCount(): number {
  return _snapshots.length;
}

// ---- Internal ----

function _round3(v: number): number { return Math.round(v * 1000) / 1000; }
function _round4(v: number): number { return Math.round(v * 10000) / 10000; }

function _buildPersona(
  elapsedMs: number,
  learnedDelta: Record<string, number>,
  projectMeta?: ProjectMeta,
  actionSignature?: number[],
): Persona {
  const n = _snapshots.length;

  // ---- Emotion: mean + variance across positive-trigger snapshots ----
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

  // ---- Adapted thresholds: mean across snapshots ----
  const meanThresholds = {} as Record<EmotionAxis, number>;
  const meanFieldAdj = {} as Record<EmotionAxis, number>;
  for (const axis of AXES) {
    meanThresholds[axis] = _round3(_snapshots.reduce((a, s) => a + s.thresholds[axis], 0) / n);
    meanFieldAdj[axis] = _round3(_snapshots.reduce((a, s) => a + s.fieldAdjustment[axis], 0) / n);
  }

  // ---- Pattern distribution (from snapshots, normalized) ----
  const patternCounts: Record<string, number> = {};
  for (const s of _snapshots) {
    patternCounts[s.pattern] = (patternCounts[s.pattern] ?? 0) + 1;
  }
  const patternDistribution = {} as Record<PatternKind, number>;
  for (const [pat, count] of Object.entries(patternCounts)) {
    patternDistribution[pat as PatternKind] = _round3(count / n);
  }

  // ---- State distribution (from snapshots, normalized) ----
  const stateCounts: Record<string, number> = {};
  for (const s of _snapshots) {
    stateCounts[s.agentState] = (stateCounts[s.agentState] ?? 0) + 1;
  }
  const stateDistribution = {} as Record<AgentState, number>;
  for (const [state, count] of Object.entries(stateCounts)) {
    stateDistribution[state as AgentState] = _round3(count / n);
  }

  // ---- Entropy average (work focus indicator) ----
  const entropyAvg = _round3(_snapshots.reduce((a, s) => a + s.entropy, 0) / n);

  // ---- Assemble persona ----
  const persona: Persona = {
    $schema: "receptor-persona-v1",
    ts: Date.now(),
    emotionProfile: {
      meanEmotion,
      emotionVariance,
      dominantAxis,
    },
    adaptedThresholds: {
      mean: meanThresholds,
      fieldAdjustment: meanFieldAdj,
    },
    patternDistribution,
    stateDistribution,
    learnedDelta: { ...learnedDelta },
    workContext: {
      techStack: projectMeta?.techStack,
      domain: projectMeta?.domain,
      entropyAvg,
    },
    sessionMeta: {
      elapsedMs,
      snapshotCount: n,
    },
  };

  if (actionSignature) {
    persona.actionSignature = actionSignature;
  }

  return persona;
}
