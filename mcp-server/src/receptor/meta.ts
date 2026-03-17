// ============================================================
// Receptor — Meta Neuron C (FIFO firing buffer + field emission)
// ============================================================
// Observes B's firing history via a fixed-size FIFO buffer.
// Derives agent state and emits field adjustments to AmbientEstimator.
// Detects flow disruptions (spike during flow → pushdown).
// Does NOT fire signals or control anything directly.
//
// All numeric constants loaded from emotion-profile.json via profile.ts.

import type { EmotionVector, EmotionAxis, FireSignal, PatternKind, AgentState } from "./types.js";
import type { AmbientEstimator } from "./ambient.js";
import { profile } from "./profile.js";

export type { AgentState } from "./types.js";

// ---- Constants (from profile) ----

const CONF = profile.meta;

// ---- Disruption instruction ----

export interface Disruption {
  axis: EmotionAxis;
  delta: number;
}

// ---- Buffer Entry ----

interface FiringEntry {
  dominant: EmotionAxis;
  intensity: number;
  ts: number;
}

// ---- MetaNeuron ----

export class MetaNeuron {
  private buffer: FiringEntry[] = [];
  private _lastState: AgentState = "idle";

  observe(signals: FireSignal[]): void {
    if (signals.length === 0) return;

    let strongest = signals[0];
    for (let i = 1; i < signals.length; i++) {
      if (signals[i].intensity > strongest.intensity) {
        strongest = signals[i];
      }
    }

    const emotion = strongest.emotion;
    const axes: EmotionAxis[] = ["frustration", "seeking", "confidence", "fatigue", "flow"];
    let dominant: EmotionAxis = "frustration";
    let maxVal = -1;
    for (const axis of axes) {
      const v = axis === "seeking" ? Math.abs(emotion[axis]) : emotion[axis];
      if (v > maxVal) {
        maxVal = v;
        dominant = axis;
      }
    }

    this.buffer.push({ dominant, intensity: maxVal, ts: strongest.ts });

    while (this.buffer.length > CONF.bufferSize) {
      this.buffer.shift();
    }
  }

  checkFlowDisruption(
    currentEmotion: EmotionVector,
    signals: FireSignal[],
  ): Disruption[] {
    if (currentEmotion.flow < CONF.flowDisruption.threshold) return [];

    const nonFlowSignals = signals.filter(s => s.kind !== "flow_active");
    if (nonFlowSignals.length === 0) return [];

    const maxIntensity = Math.max(...nonFlowSignals.map(s => s.intensity));
    return [{ axis: "flow", delta: -maxIntensity * CONF.flowDisruption.ratio }];
  }

  process(
    currentEmotion: EmotionVector,
    pattern: PatternKind,
    ambient: AmbientEstimator,
    isSilenced: boolean,
  ): void {
    this._lastState = this._deriveState(currentEmotion, pattern, isSilenced);

    const rates = this._hitRates();
    this._emitFieldAdjustments(rates, ambient);
  }

  get state(): AgentState {
    return this._lastState;
  }

  hitRates(): Record<EmotionAxis, number> {
    return this._hitRates();
  }

  get bufferFill(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
    this._lastState = "idle";
  }

  format(): string {
    const rates = this._hitRates();
    const topAxes = (Object.entries(rates) as [EmotionAxis, number][])
      .filter(([, r]) => r > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([axis, rate]) => `${axis}:${(rate * 100).toFixed(0)}%`)
      .join(" ");
    return `Meta[${this._lastState}] buf=${this.buffer.length}/${CONF.bufferSize} ${topAxes}`;
  }

  // ---- Internals ----

  private _hitRates(): Record<EmotionAxis, number> {
    const counts: Record<EmotionAxis, number> = {
      frustration: 0, seeking: 0,
      confidence: 0, fatigue: 0, flow: 0,
    };
    for (const entry of this.buffer) {
      counts[entry.dominant]++;
    }
    const total = this.buffer.length || 1;
    return {
      frustration: counts.frustration / total,
      seeking: counts.seeking / total,
      confidence: counts.confidence / total,
      fatigue: counts.fatigue / total,
      flow: counts.flow / total,
    };
  }

  private _deriveState(
    emotion: EmotionVector,
    pattern: PatternKind,
    isSilenced: boolean,
  ): AgentState {
    if (isSilenced) return "idle";
    if (pattern === "delegation") return "delegating";

    // Profile-driven state thresholds
    for (const [state, cond] of Object.entries(CONF.stateThresholds)) {
      if (emotion[cond.axis] > cond.min && pattern === cond.pattern) {
        return state as AgentState;
      }
    }

    if (pattern === "exploration" || pattern === "wandering") return "exploring";

    return "exploring";
  }

  private _emitFieldAdjustments(
    rates: Record<EmotionAxis, number>,
    ambient: AmbientEstimator,
  ): void {
    const fa = ambient.fieldAdjustment;

    if (rates.frustration > CONF.dangerHitRate) {
      fa.seeking = Math.max(-CONF.maxFieldAdjustment, fa.seeking - CONF.adjustmentStep);
    } else if (rates.frustration < CONF.safeHitRate) {
      fa.seeking = this._decayToward(fa.seeking, 0, CONF.adjustmentStep);
    }

    if (this._lastState === "deep_work") {
      fa.frustration = Math.min(CONF.maxFieldAdjustment, fa.frustration + CONF.adjustmentStep);
    } else if (this._lastState === "stuck") {
      fa.frustration = Math.max(-CONF.maxFieldAdjustment, fa.frustration - CONF.adjustmentStep);
    } else {
      fa.frustration = this._decayToward(fa.frustration, 0, CONF.adjustmentStep);
    }

    fa.flow = this._decayToward(fa.flow, 0, CONF.adjustmentStep);
    fa.confidence = this._decayToward(fa.confidence, 0, CONF.adjustmentStep);
  }

  private _decayToward(value: number, target: number, step: number): number {
    if (Math.abs(value - target) <= step) return target;
    return value > target ? value - step : value + step;
  }
}
