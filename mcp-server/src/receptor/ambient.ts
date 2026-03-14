// ============================================================
// Receptor — AmbientEstimator (EMA-based dynamic thresholds)
// ============================================================
// Tracks per-axis behavioral baseline via Exponential Moving Average.
// effectiveThreshold = baseline + offset + fieldAdjustment
//
// Design principles (from soundLimiter v1.2):
//   - EMA tracks "normal" emotion level per axis
//   - Silence gate: no updates during idle (prevents stale baseline pollution)
//   - fieldAdjustment: writable by Meta neuron C (future), not read by this module
//   - This module does NOT know who writes fieldAdjustment — field coupling

import type { EmotionVector, EmotionAxis } from "./types.js";

// ---- Configuration ----

/** Time constant for EMA (ms). Higher = slower tracking.
 *  10 min: a few tool calls won't shift baseline, but sustained patterns will. */
const DEFAULT_TIME_CONSTANT_MS = 600_000; // 10 minutes

/** Silence gate: if no update for this long, pause EMA tracking.
 *  3 min: 30s pauses are normal (thinking), 3 min = genuinely idle. */
const SILENCE_GATE_MS = 180_000; // 3 minutes of no events = idle

/** Minimum value to include in EMA (silence gate — equivalent to soundLimiter's -50dB) */
const SILENCE_FLOOR = 0.05;

/** Default offset above baseline for spike detection.
 *  Lower offset = more sensitive (fires sooner).
 *  Tuned for real work: events are sparse, emotions need to fire
 *  within realistic accumulation range. */
const DEFAULT_OFFSETS: Record<EmotionAxis, number> = {
  frustration: 0.20,   // most critical signal — fire earlier
  hunger: 0.25,        // knowledge gap — moderate sensitivity
  uncertainty: 0.25,   // direction loss — moderate
  confidence: 0.25,    // needs clear signal before firing
  fatigue: 0.30,       // slow accumulation, still needs higher bar
  flow: 0.20,          // flow should be recognized promptly
};

/** Absolute minimum threshold (floor) — never go below this.
 *  0.25 allows offsets to work at zero baseline (0 + 0.25 = 0.25, not clamped to 0.30). */
const MIN_THRESHOLD = 0.25;

/** Absolute maximum threshold (ceiling) — never go above this */
const MAX_THRESHOLD = 0.85;

// ---- AmbientEstimator ----

export class AmbientEstimator {
  private ema: Record<EmotionAxis, number>;
  private lastUpdateTs: number = 0;
  private silenced: boolean = true; // start silenced until first event

  /** Field adjustment per axis — writable by Meta neuron C (future) */
  readonly fieldAdjustment: Record<EmotionAxis, number>;

  /** Per-axis offset above baseline */
  readonly offsets: Record<EmotionAxis, number>;

  constructor() {
    // Initialize EMA to zero (no baseline yet)
    this.ema = {
      frustration: 0, hunger: 0, uncertainty: 0,
      confidence: 0, fatigue: 0, flow: 0,
    };
    // Field adjustment starts at zero — C hasn't emitted anything yet
    this.fieldAdjustment = {
      frustration: 0, hunger: 0, uncertainty: 0,
      confidence: 0, fatigue: 0, flow: 0,
    };
    this.offsets = { ...DEFAULT_OFFSETS };
  }

  /**
   * Update EMA with new emotion vector.
   * Called once per ingestEvent cycle.
   */
  update(emotion: EmotionVector, nowMs: number = Date.now()): void {
    // Silence gate: check if we've been idle too long
    if (this.lastUpdateTs > 0 && (nowMs - this.lastUpdateTs) > SILENCE_GATE_MS) {
      // Returning from silence — reset EMA to current values to prevent
      // velocity explosion (soundLimiter: prevAmbientDb = -Infinity on resume)
      this.silenced = true;
    }

    if (this.silenced) {
      // First update or returning from silence: seed EMA with current value
      const axes: EmotionAxis[] = ["frustration", "hunger", "uncertainty", "confidence", "fatigue", "flow"];
      for (const axis of axes) {
        this.ema[axis] = emotion[axis];
      }
      this.silenced = false;
      this.lastUpdateTs = nowMs;
      return;
    }

    const dt = nowMs - this.lastUpdateTs;
    if (dt <= 0) return;

    // EMA alpha: alpha = 1 - exp(-dt / timeConstant)
    const alpha = 1 - Math.exp(-dt / DEFAULT_TIME_CONSTANT_MS);

    const axes: EmotionAxis[] = ["frustration", "hunger", "uncertainty", "confidence", "fatigue", "flow"];
    for (const axis of axes) {
      const value = emotion[axis];
      // Silence floor: skip very low values to prevent baseline pollution
      // Exception: fatigue is always tracked (safety — like soundLimiter's A neuron)
      if (axis !== "fatigue" && value < SILENCE_FLOOR) continue;
      this.ema[axis] += alpha * (value - this.ema[axis]);
    }

    this.lastUpdateTs = nowMs;
  }

  /**
   * Get effective threshold for a given axis.
   * effectiveThreshold = baseline + offset + fieldAdjustment
   * Clamped to [MIN_THRESHOLD, MAX_THRESHOLD].
   */
  effectiveThreshold(axis: EmotionAxis): number {
    const raw = this.ema[axis] + this.offsets[axis] + this.fieldAdjustment[axis];
    return Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, raw));
  }

  /** Get current baseline (EMA value) for an axis. */
  baseline(axis: EmotionAxis): number {
    return this.ema[axis];
  }

  /** Whether currently in silence gate (no recent events). */
  get isSilenced(): boolean {
    return this.silenced;
  }

  /**
   * Force reset — called on heatmap shift (context change).
   * Equivalent to soundLimiter's volumechange → AmbientEstimator.reset().
   */
  reset(): void {
    this.silenced = true;
    // EMA values will be re-seeded on next update()
  }

  /** Clear all state (for testing). */
  clear(): void {
    const axes: EmotionAxis[] = ["frustration", "hunger", "uncertainty", "confidence", "fatigue", "flow"];
    for (const axis of axes) {
      this.ema[axis] = 0;
      this.fieldAdjustment[axis] = 0;
    }
    this.lastUpdateTs = 0;
    this.silenced = true;
  }

  /** Format for display. */
  formatThresholds(): string {
    const axes: EmotionAxis[] = ["frustration", "hunger", "uncertainty", "confidence", "fatigue", "flow"];
    return axes
      .map(a => `${a}: base=${this.ema[a].toFixed(2)} thr=${this.effectiveThreshold(a).toFixed(2)}`)
      .join("  ");
  }
}