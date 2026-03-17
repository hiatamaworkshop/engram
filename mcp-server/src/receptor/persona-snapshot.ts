// ============================================================
// Receptor — Persona Snapshot (positive-trigger behavioral capture)
// ============================================================
// Captures receptor state snapshots during positive triggers
// (confidence_sustained, flow_active). At session end, aggregates
// snapshots into a Persona — a statistical fingerprint of successful
// behavioral patterns — and conditionally exports to sphere-ready.jsonl.
//
// Design: RECEPTOR_ARCHITECTURE.md §12

import type { EmotionVector, EmotionAxis, FireSignal, PatternKind, AgentState, ProjectMeta } from "./types.js";
import type { AmbientEstimator } from "./ambient.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- Constants ----

const MAX_SNAPSHOTS = 10;
const POSITIVE_SIGNALS = new Set(["confidence_sustained", "flow_active"]);

// Session-end push thresholds
const FLOW_ACTIVE_RATIO_MIN = 0.3;
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
    suppressionRate: number; // ratio of flow_active events / total
  };
  adaptedThresholds: {
    mean: Record<EmotionAxis, number>;  // mean effective threshold across snapshots
    fieldAdjustment: Record<EmotionAxis, number>; // mean C-field adjustment
  };
  firingStats: Record<string, { count: number; avgIntensity: number }>;
  patternDistribution: Record<PatternKind, number>;
  stateDistribution: Record<AgentState, number>;
  methodTypeWeights: Record<string, number>;
  learnedDelta: Record<string, number>;
  workContext: {
    techStack?: string[];   // from ProjectMeta (categorical, survives anonymization)
    domain?: string[];      // from ProjectMeta
    entropyAvg: number;     // mean heatmap entropy across snapshots (work focus)
  };
  sessionMeta: {
    eventCount: number;
    elapsedMs: number;
    snapshotCount: number;
  };
}

// ---- Singleton state ----

const _snapshots: Snapshot[] = [];

// Session-wide accumulators for push-gate check
let _totalEvents = 0;
let _flowActiveEvents = 0;
let _confidenceSum = 0;

// Firing stats across session
const _firingCounts: Record<string, number> = {};
const _firingIntensitySum: Record<string, number> = {};

// Pattern + state counts across session
const _patternCounts: Record<string, number> = {};
const _stateCounts: Record<string, number> = {};

const AXES: EmotionAxis[] = ["frustration", "seeking", "confidence", "fatigue", "flow"];

// ---- Public API ----

/**
 * Called on every ingestEvent. Tracks session-wide stats for push-gate.
 */
export function trackEvent(
  emotion: EmotionVector,
  signals: FireSignal[],
  pattern: PatternKind,
  agentState: AgentState,
): void {
  _totalEvents++;
  _confidenceSum += emotion.confidence;
  _patternCounts[pattern] = (_patternCounts[pattern] ?? 0) + 1;
  _stateCounts[agentState] = (_stateCounts[agentState] ?? 0) + 1;

  const hasFlow = signals.some(s => s.kind === "flow_active");
  if (hasFlow) _flowActiveEvents++;

  for (const sig of signals) {
    _firingCounts[sig.kind] = (_firingCounts[sig.kind] ?? 0) + 1;
    _firingIntensitySum[sig.kind] = (_firingIntensitySum[sig.kind] ?? 0) + sig.intensity;
  }
}

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
 * Called at engram_watch stop. Evaluates push gate, computes persona if qualified.
 * Returns persona or null (session didn't meet quality thresholds).
 */
export function finalizeSession(
  elapsedMs: number,
  learnedDelta: Record<string, number>,
  projectMeta?: ProjectMeta,
  actionSignature?: number[],
): Persona | null {
  if (_totalEvents === 0) return null;

  // Push gate: session quality check
  const flowRatio = _flowActiveEvents / _totalEvents;
  const confidenceAvg = _confidenceSum / _totalEvents;

  if (flowRatio < FLOW_ACTIVE_RATIO_MIN || confidenceAvg < CONFIDENCE_AVG_MIN) {
    console.error(
      `[persona] skip: flowRatio=${flowRatio.toFixed(2)} (min ${FLOW_ACTIVE_RATIO_MIN}), ` +
      `confidenceAvg=${confidenceAvg.toFixed(2)} (min ${CONFIDENCE_AVG_MIN})`
    );
    return null;
  }

  if (_snapshots.length < 2) {
    console.error(`[persona] skip: only ${_snapshots.length} snapshots (need ≥2)`);
    return null;
  }

  return _buildPersona(elapsedMs, learnedDelta, projectMeta, actionSignature);
}

/**
 * Write persona to sphere-ready.jsonl.
 */
export function exportPersona(persona: Persona): void {
  const outputDir = path.join(
    process.env.ENGRAM_DATA_DIR ?? (import.meta.dirname ? path.join(import.meta.dirname, "..") : "."),
    "receptor-output",
  );
  const outputPath = path.join(outputDir, "sphere-ready.jsonl");

  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.appendFileSync(outputPath, JSON.stringify(persona) + "\n");
    console.error(`[persona] exported to sphere-ready.jsonl (${_snapshots.length} snapshots aggregated)`);
  } catch (err) {
    console.error("[persona] export error:", err);
  }
}

/** Clear all state (called on watch start). */
export function clearPersonaState(): void {
  _snapshots.length = 0;
  _totalEvents = 0;
  _flowActiveEvents = 0;
  _confidenceSum = 0;

  for (const key of Object.keys(_firingCounts)) delete _firingCounts[key];
  for (const key of Object.keys(_firingIntensitySum)) delete _firingIntensitySum[key];
  for (const key of Object.keys(_patternCounts)) delete _patternCounts[key];
  for (const key of Object.keys(_stateCounts)) delete _stateCounts[key];
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

  // ---- Firing stats ----
  const firingStats: Record<string, { count: number; avgIntensity: number }> = {};
  for (const [kind, count] of Object.entries(_firingCounts)) {
    firingStats[kind] = {
      count,
      avgIntensity: _round3(_firingIntensitySum[kind] / count),
    };
  }

  // ---- Pattern distribution (normalized) ----
  const patternDistribution = {} as Record<PatternKind, number>;
  for (const [pat, count] of Object.entries(_patternCounts)) {
    patternDistribution[pat as PatternKind] = _round3(count / _totalEvents);
  }

  // ---- State distribution (normalized) ----
  const stateDistribution = {} as Record<AgentState, number>;
  for (const [state, count] of Object.entries(_stateCounts)) {
    stateDistribution[state as AgentState] = _round3(count / _totalEvents);
  }

  // ---- Method type weights ----
  const methodTypeMap: Record<string, string> = {
    frustration_spike: "knowledge_search",
    seeking_spike: "knowledge_search",
    compound_frustration_seeking: "knowledge_search",
    confidence_sustained: "context_persist",
    fatigue_rising: "status_notify",
    flow_active: "flow_suppress",
  };
  const methodTypeCounts: Record<string, number> = {};
  let totalFirings = 0;
  for (const [kind, count] of Object.entries(_firingCounts)) {
    const mtype = methodTypeMap[kind] ?? "other";
    methodTypeCounts[mtype] = (methodTypeCounts[mtype] ?? 0) + count;
    totalFirings += count;
  }
  const methodTypeWeights: Record<string, number> = {};
  if (totalFirings > 0) {
    for (const [mtype, count] of Object.entries(methodTypeCounts)) {
      methodTypeWeights[mtype] = _round3(count / totalFirings);
    }
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
      suppressionRate: _round3(_flowActiveEvents / _totalEvents),
    },
    adaptedThresholds: {
      mean: meanThresholds,
      fieldAdjustment: meanFieldAdj,
    },
    firingStats,
    patternDistribution,
    stateDistribution,
    methodTypeWeights,
    learnedDelta: { ...learnedDelta },
    workContext: {
      techStack: projectMeta?.techStack,
      domain: projectMeta?.domain,
      entropyAvg,
    },
    sessionMeta: {
      eventCount: _totalEvents,
      elapsedMs,
      snapshotCount: n,
    },
  };

  if (actionSignature) {
    persona.actionSignature = actionSignature;
  }

  return persona;
}
