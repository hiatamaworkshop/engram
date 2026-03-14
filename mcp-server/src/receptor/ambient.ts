// ============================================================
// Receptor — AmbientEstimator (EMA-based dynamic thresholds)
// ============================================================
// Tracks per-axis behavioral baseline via Exponential Moving Average.
// effectiveThreshold = baseline + offset + fieldAdjustment
//
// All numeric constants loaded from emotion-profile.json via profile.ts.

import type { EmotionVector, EmotionAxis } from "./types.js";
import { profile } from "./profile.js";

// ---- Constants (from profile) ----

const CONF = profile.ambient;
const AXES: EmotionAxis[] = ["frustration", "hunger", "uncertainty", "confidence", "fatigue", "flow"];

// ---- AmbientEstimator ----

export class AmbientEstimator {
  private ema: Record<EmotionAxis, number>;
  private lastUpdateTs: number = 0;
  private silenced: boolean = true;

  /** Field adjustment per axis — writable by Meta neuron C */
  readonly fieldAdjustment: Record<EmotionAxis, number>;

  /** Per-axis offset above baseline */
  readonly offsets: Record<EmotionAxis, number>;

  constructor() {
    this.ema = {
      frustration: 0, hunger: 0, uncertainty: 0,
      confidence: 0, fatigue: 0, flow: 0,
    };
    this.fieldAdjustment = {
      frustration: 0, hunger: 0, uncertainty: 0,
      confidence: 0, fatigue: 0, flow: 0,
    };
    this.offsets = { ...CONF.offsets };
  }

  update(emotion: EmotionVector, nowMs: number = Date.now()): void {
    if (this.lastUpdateTs > 0 && (nowMs - this.lastUpdateTs) > CONF.silenceGateMs) {
      this.silenced = true;
    }

    if (this.silenced) {
      for (const axis of AXES) {
        this.ema[axis] = emotion[axis];
      }
      this.silenced = false;
      this.lastUpdateTs = nowMs;
      return;
    }

    const dt = nowMs - this.lastUpdateTs;
    if (dt <= 0) return;

    const alpha = 1 - Math.exp(-dt / CONF.timeConstantMs);

    for (const axis of AXES) {
      const value = emotion[axis];
      if (axis !== "fatigue" && value < CONF.silenceFloor) continue;
      this.ema[axis] += alpha * (value - this.ema[axis]);
    }

    this.lastUpdateTs = nowMs;
  }

  effectiveThreshold(axis: EmotionAxis): number {
    const raw = this.ema[axis] + this.offsets[axis] + this.fieldAdjustment[axis];
    return Math.max(CONF.minThreshold, Math.min(CONF.maxThreshold, raw));
  }

  baseline(axis: EmotionAxis): number {
    return this.ema[axis];
  }

  get isSilenced(): boolean {
    return this.silenced;
  }

  reset(): void {
    this.silenced = true;
  }

  clear(): void {
    for (const axis of AXES) {
      this.ema[axis] = 0;
      this.fieldAdjustment[axis] = 0;
    }
    this.lastUpdateTs = 0;
    this.silenced = true;
  }

  formatThresholds(): string {
    return AXES
      .map(a => `${a}: base=${this.ema[a].toFixed(2)} thr=${this.effectiveThreshold(a).toFixed(2)}`)
      .join("  ");
  }
}
