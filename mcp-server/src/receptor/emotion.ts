// ============================================================
// Receptor — Emotion Engine (accumulation + time decay)
// ============================================================
// Impulse-based: each event contributes small deltas.
// EmotionAccumulator holds stateful values with exponential decay.
// All axes decay toward 0 (away from threshold) over time.
// Idle freezes decay. Does NOT know what is connected to signals.

import type { EmotionVector, EmotionAxis, FireSignal, FireSignalKind, NormalizedEvent, PatternKind, AgentState } from "./types.js";
import { ZERO_EMOTION } from "./types.js";
import type { WindowSnapshot } from "./commander.js";
import type { PathHeatmap } from "./heatmap.js";
import type { AmbientEstimator } from "./ambient.js";

// ---- Constants ----

const AXES: EmotionAxis[] = ["frustration", "hunger", "uncertainty", "confidence", "fatigue", "flow"];

/** Fallback threshold when no AmbientEstimator is provided (backward compat). */
const SPIKE_THRESHOLD = 0.6;

/** Number of consecutive sub-threshold readings required to release a hold. */
const HOLD_RELEASE_COUNT = 3;

// ---- Clamp utility ----

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ============================================================
// Emotion Accumulator — stateful decay engine
// ============================================================
// All accumulated values decay exponentially: value *= exp(-λ·dt)
// λ = ln(2) / halfLife — so after halfLife ms, value halves.
// Idle (dt > IDLE_FREEZE_MS) freezes decay — no phantom drain.

/** Decay half-life per axis (ms). */
const HALF_LIFE: Record<EmotionAxis, number> = {
  frustration: 60_000,   // 1 min — fades as time passes
  hunger: 90_000,        // 1.5 min — knowledge gaps persist longer
  uncertainty: 75_000,   // 1.25 min
  confidence: 60_000,    // 1 min — needs reinforcement
  fatigue: 300_000,      // 5 min — slow recovery
  flow: 90_000,          // 1.5 min — sustained state, longer memory
};

/** If no event for this long, freeze decay (idle). */
const IDLE_FREEZE_MS = 180_000; // 3 min (matches silence gate)

export class EmotionAccumulator {
  private _values: EmotionVector = { ...ZERO_EMOTION };
  private _lastTs = 0;

  /** Current accumulated values (readonly copy). */
  get values(): EmotionVector { return { ...this._values }; }

  /**
   * Apply time decay since last update, then add impulse.
   * Returns the new accumulated emotion vector.
   */
  update(impulse: EmotionVector, ts: number): EmotionVector {
    // Time decay
    if (this._lastTs > 0) {
      const dt = ts - this._lastTs;
      if (dt > 0 && dt < IDLE_FREEZE_MS) {
        // Normal decay — all axes move toward 0
        for (const axis of AXES) {
          const lambda = Math.LN2 / HALF_LIFE[axis];
          this._values[axis] *= Math.exp(-lambda * dt);
        }
      }
      // dt >= IDLE_FREEZE_MS → idle freeze (no decay)
      // dt <= 0 → clock skew, skip
    }
    this._lastTs = ts;

    // Add impulse (can be negative — e.g. success relieves frustration)
    for (const axis of AXES) {
      this._values[axis] = clamp(this._values[axis] + impulse[axis]);
    }

    return this.values;
  }

  /** Direct disruption from meta neuron (e.g., flow pushdown during spike). */
  disrupt(axis: EmotionAxis, delta: number): void {
    this._values[axis] = clamp(this._values[axis] + delta);
  }

  /** Clear (watch restart). */
  clear(): void {
    this._values = { ...ZERO_EMOTION };
    this._lastTs = 0;
  }
}

// ============================================================
// Impulse computation — per-event deltas
// ============================================================
// Each event contributes small impulses. The accumulator + decay
// handles memory. No need for medium snapshot — accumulation IS memory.

export function computeImpulse(
  shortSnap: WindowSnapshot,
  sessionMeta: { totalEvents: number; elapsedMs: number },
  lastEvent?: NormalizedEvent,
  heatmap?: PathHeatmap,
): EmotionVector {
  let frustration = 0;
  let hunger = 0;
  let uncertainty = 0;
  let confidence = 0;
  let fatigue = 0;
  let flow = 0;

  // ---- Event-driven impulses (from this specific event) ----

  if (lastEvent) {
    switch (lastEvent.action) {
      case "shell_exec":
        if (lastEvent.result === "failure") {
          frustration += 0.10;          // bash fail → strong frustration
        } else {
          confidence += 0.08;           // bash success → confidence
          flow += 0.04;                 // success feeds flow
          frustration -= 0.03;          // success relieves frustration
          uncertainty -= 0.02;          // progress reduces uncertainty
        }
        break;
      case "file_edit":
        confidence += 0.04;            // editing = making progress
        uncertainty -= 0.01;
        break;
      case "search":
        if (lastEvent.result === "empty") {
          hunger += 0.08;              // empty search → knowledge gap
          uncertainty += 0.05;
        } else {
          hunger -= 0.03;             // found something → gap narrows
        }
        break;
      case "file_read":
        hunger += 0.03;              // reading = seeking information
        break;
      case "memory_read":
        hunger += 0.05;              // consulting memory = knowledge need
        break;
      case "memory_write":
        confidence += 0.03;          // saving knowledge = consolidation
        break;
    }
  }

  // ---- Pattern-driven impulses (sustained push from current pattern) ----

  if (shortSnap.pattern === "trial_error") {
    frustration += 0.05;             // stuck in loop → background frustration
  }
  if (shortSnap.pattern === "implementation") {
    flow += 0.03;                    // implementation → flow (accumulates with bash success)
    confidence += 0.03;              // productive implementation → confidence
  }
  if (shortSnap.pattern === "wandering") {
    uncertainty += 0.07;             // directionless → uncertainty
    hunger += 0.06;                  // seeking → hunger
  }
  if (shortSnap.pattern === "exploration") {
    hunger += 0.04;                  // exploring → mild hunger
  }

  // ---- Heatmap-driven ----

  if (heatmap?.detectShift().shifted) {
    uncertainty += 0.10;             // context switch → uncertainty spike
  }

  // ---- Fatigue (tiny per-event, increases with session duration) ----

  const sessionHours = sessionMeta.elapsedMs / 3_600_000;
  fatigue += 0.005 + sessionHours * 0.003;

  // Return raw impulse — accumulator handles clamping
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

/** Context snapshot from A/C neurons, attached to every fire signal. */
export interface SignalContext {
  agentState: AgentState;
  pattern: PatternKind;
}

/**
 * Generate signals from emotion vector.
 * @param emotion Current emotion vector
 * @param ambient Optional AmbientEstimator for dynamic thresholds.
 * @param ctx Context snapshot (agentState + pattern) to attach to signals.
 */
export function generateSignals(
  emotion: EmotionVector,
  ambient?: AmbientEstimator,
  ctx?: SignalContext,
): FireSignal[] {
  const signals: FireSignal[] = [];
  const ts = Date.now();
  const agentState: AgentState = ctx?.agentState ?? "exploring";
  const pattern: PatternKind = ctx?.pattern ?? "stagnation";

  /** Get threshold for an axis — dynamic if ambient provided, else fixed. */
  const thr = (axis: EmotionAxis): number =>
    ambient ? ambient.effectiveThreshold(axis) : SPIKE_THRESHOLD;

  /** Build a FireSignal with full context. */
  const sig = (kind: FireSignalKind, intensity: number): FireSignal =>
    ({ kind, intensity, ts, emotion, agentState, pattern });

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
    signals.push(sig("flow_active", emotion.flow));
    return signals; // suppress everything else
  }

  // Compound: frustration + hunger
  const frustFires = shouldFire("frustration");
  const hungerFires = shouldFire("hunger");
  if (frustFires && hungerFires) {
    signals.push(sig("compound_frustration_hunger", Math.max(emotion.frustration, emotion.hunger)));
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
      signals.push(sig(kind, emotion[axis]));
    }
  }

  return signals;
}

// ---- Format emotion for display ----

export function formatEmotion(e: EmotionVector): string {
  return AXES.map((a) => `${a}: ${e[a].toFixed(2)}`).join("  ");
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