// ============================================================
// Receptor — Emotion Engine (6-axis vector computation)
// ============================================================
// Computes emotion vector from commander snapshots + heatmap signals.
// Fires multi-layered signals based on thresholds.
// Does NOT know what is connected to signals — fire and forget.

import type { EmotionVector, EmotionAxis, FireSignal, FireSignalKind, NormalizedEvent } from "./types.js";
import { ZERO_EMOTION } from "./types.js";
import type { WindowSnapshot } from "./commander.js";
import type { PathHeatmap } from "./heatmap.js";
import type { AmbientEstimator } from "./ambient.js";

// ---- Thresholds ----

/** Fallback threshold when no AmbientEstimator is provided (backward compat). */
const SPIKE_THRESHOLD = 0.6;

/** Number of consecutive sub-threshold readings required to release a hold. */
const HOLD_RELEASE_COUNT = 3;

// ---- Clamp utility ----

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ---- Emotion computation ----

export function computeEmotion(
  shortSnap: WindowSnapshot,
  mediumSnap: WindowSnapshot,
  meta: { totalEvents: number; elapsedMs: number },
  heatmap: PathHeatmap,
  lastEvent?: NormalizedEvent,
): EmotionVector {
  // -- frustration --
  const frustration = clamp(
    shortSnap.editBashAlternation * 0.15 +
    shortSnap.bashFailRate * 0.4 +
    (shortSnap.pattern === "trial_error" ? 0.3 : 0) +
    (mediumSnap.pattern === "trial_error" ? 0.1 : 0),
  );

  // -- hunger --
  const grepMissRate = mediumSnap.counts.search > 0
    ? (mediumSnap.counts.memory_read > 0 ? 0.2 : 0) // engram pull present = some gap
    : 0;
  const hunger = clamp(
    (mediumSnap.pattern === "exploration" ? 0.3 : 0) +
    (mediumSnap.pattern === "wandering" ? 0.4 : 0) +
    grepMissRate +
    (lastEvent?.action === "memory_read" && lastEvent.result === "empty" ? 0.3 : 0),
  );

  // -- uncertainty --
  const heatShift = heatmap.detectShift();
  const uncertainty = clamp(
    (shortSnap.pattern === "wandering" ? 0.4 : 0) +
    (mediumSnap.counts.file_edit === 0 && mediumSnap.total > 5 ? 0.2 : 0) +
    (heatShift.shifted ? 0.3 : 0),
  );

  // -- confidence --
  const confidence = clamp(
    (shortSnap.pattern === "implementation" && shortSnap.bashFailRate < 0.2 ? 0.4 : 0) +
    (lastEvent?.action === "shell_exec" && lastEvent.result === "success" ? 0.2 : 0) +
    (lastEvent?.action === "file_edit" && lastEvent.result === "success" ? 0.2 : 0),
  );

  // -- fatigue --
  const elapsedHours = meta.elapsedMs / 3_600_000;
  const fatigue = clamp(
    Math.min(elapsedHours * 0.15, 0.5) +
    (meta.totalEvents > 200 ? 0.2 : meta.totalEvents > 100 ? 0.1 : 0),
  );

  // -- flow --
  const flow = clamp(
    (shortSnap.pattern === "implementation" && shortSnap.bashFailRate === 0 ? 0.4 : 0) +
    (confidence > 0.3 && frustration < 0.2 ? 0.3 : 0) +
    (mediumSnap.pattern === "implementation" ? 0.2 : 0),
  );

  return { frustration, hunger, uncertainty, confidence, fatigue, flow };
}

// ---- Hold state (verification-based hold/release) ----
// Per-axis: when a signal fires, holdActive = true.
// When raw drops below threshold, count consecutive sub-threshold readings.
// Release only after HOLD_RELEASE_COUNT consecutive readings below threshold.
// This prevents flapping (fire → release → fire → release...).

interface HoldEntry {
  active: boolean;
  subThresholdCount: number; // consecutive readings below threshold
}

const _holdState: Record<string, HoldEntry> = {};

function getHold(key: string): HoldEntry {
  if (!_holdState[key]) {
    _holdState[key] = { active: false, subThresholdCount: 0 };
  }
  return _holdState[key];
}

/** Reset all hold states (called on watch stop/start). */
export function resetHoldState(): void {
  for (const key of Object.keys(_holdState)) {
    delete _holdState[key];
  }
}

// ---- Fire signal generation ----

/**
 * Generate signals from emotion vector.
 * @param emotion Current emotion vector
 * @param ambient Optional AmbientEstimator for dynamic thresholds.
 *                If omitted, falls back to fixed SPIKE_THRESHOLD (backward compat).
 */
export function generateSignals(emotion: EmotionVector, ambient?: AmbientEstimator): FireSignal[] {
  const signals: FireSignal[] = [];
  const ts = Date.now();

  /** Get threshold for an axis — dynamic if ambient provided, else fixed. */
  const thr = (axis: EmotionAxis): number =>
    ambient ? ambient.effectiveThreshold(axis) : SPIKE_THRESHOLD;

  /**
   * Check if an axis should fire, respecting hold/release.
   * Returns true if signal should be emitted.
   */
  function shouldFire(axis: EmotionAxis): boolean {
    const threshold = thr(axis);
    const hold = getHold(axis);
    const value = emotion[axis];

    if (value >= threshold) {
      // Above threshold → fire + hold
      hold.active = true;
      hold.subThresholdCount = 0;
      return true;
    }

    if (hold.active) {
      // Below threshold but hold is active → verify before release
      hold.subThresholdCount++;
      if (hold.subThresholdCount >= HOLD_RELEASE_COUNT) {
        // Stable below threshold → release
        hold.active = false;
        hold.subThresholdCount = 0;
        return false;
      }
      // Still in hold → keep signal active (prevent flapping)
      return true;
    }

    return false;
  }

  // flow suppresses all other signals
  if (shouldFire("flow")) {
    signals.push({ kind: "flow_active", intensity: emotion.flow, ts, emotion });
    return signals; // suppress everything else
  }

  // Compound: frustration + hunger
  const frustFires = shouldFire("frustration");
  const hungerFires = shouldFire("hunger");
  if (frustFires && hungerFires) {
    signals.push({
      kind: "compound_frustration_hunger",
      intensity: Math.max(emotion.frustration, emotion.hunger),
      ts,
      emotion,
    });
    return signals; // compound takes priority
  }

  // Individual spikes (including frustration/hunger if only one fired)
  const checks: Array<[EmotionAxis, FireSignalKind, boolean?]> = [
    ["frustration", "frustration_spike", frustFires],
    ["hunger", "hunger_spike", hungerFires],
    ["uncertainty", "uncertainty_sustained"],
    ["confidence", "confidence_sustained"],
    ["fatigue", "fatigue_rising"],
  ];

  for (const [axis, kind, precomputed] of checks) {
    const fires = precomputed !== undefined ? precomputed : shouldFire(axis);
    if (fires) {
      signals.push({ kind, intensity: emotion[axis], ts, emotion });
    }
  }

  return signals;
}

// ---- Format emotion for display ----

export function formatEmotion(e: EmotionVector): string {
  const axes: EmotionAxis[] = ["frustration", "hunger", "uncertainty", "confidence", "fatigue", "flow"];
  return axes.map((a) => `${a}: ${e[a].toFixed(2)}`).join("  ");
}

export function formatSignals(signals: FireSignal[]): string {
  if (signals.length === 0) return "(no signals)";
  return signals.map((s) => `${s.kind} [${s.intensity.toFixed(2)}]`).join(", ");
}

/** Get hold state summary for monitoring. */
export function getHoldSummary(): Record<string, { active: boolean; pending: number }> {
  const result: Record<string, { active: boolean; pending: number }> = {};
  for (const [key, entry] of Object.entries(_holdState)) {
    if (entry.active) {
      result[key] = { active: true, pending: entry.subThresholdCount };
    }
  }
  return result;
}