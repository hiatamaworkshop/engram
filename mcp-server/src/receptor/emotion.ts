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

// ---- Thresholds ----

const SPIKE_THRESHOLD = 0.6;

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

// ---- Fire signal generation ----

export function generateSignals(emotion: EmotionVector): FireSignal[] {
  const signals: FireSignal[] = [];
  const ts = Date.now();

  // flow suppresses all other signals
  if (emotion.flow >= SPIKE_THRESHOLD) {
    signals.push({ kind: "flow_active", intensity: emotion.flow, ts, emotion });
    return signals; // suppress everything else
  }

  // Compound: frustration + hunger
  if (emotion.frustration >= SPIKE_THRESHOLD && emotion.hunger >= SPIKE_THRESHOLD) {
    signals.push({
      kind: "compound_frustration_hunger",
      intensity: Math.max(emotion.frustration, emotion.hunger),
      ts,
      emotion,
    });
    return signals; // compound takes priority
  }

  // Individual spikes
  const checks: Array<[EmotionAxis, FireSignalKind]> = [
    ["hunger", "hunger_spike"],
    ["frustration", "frustration_spike"],
    ["uncertainty", "uncertainty_sustained"],
    ["confidence", "confidence_sustained"],
    ["fatigue", "fatigue_rising"],
  ];

  for (const [axis, kind] of checks) {
    if (emotion[axis] >= SPIKE_THRESHOLD) {
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