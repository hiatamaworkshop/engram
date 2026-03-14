// ============================================================
// Receptor — Meta Neuron C (FIFO firing buffer + field emission)
// ============================================================
// Observes B's firing history via a fixed-size FIFO buffer.
// Derives agent state and emits field adjustments to AmbientEstimator.
// Detects flow disruptions (spike during flow → pushdown).
// Does NOT fire signals or control anything directly.
//
// Design:
//   - FIFO buffer of N recent firings (dominant axis only per event)
//   - Hit rate per axis: time-weighted (recent entries weigh more)
//   - High frustration hit rate → "dangerous environment" → lower other thresholds
//   - Agent state derived from hit rates + current emotion + pattern
//   - Flow disruption: non-flow spike during flow → pushdown instruction

import type { EmotionVector, EmotionAxis, FireSignal, PatternKind, AgentState } from "./types.js";
import type { AmbientEstimator } from "./ambient.js";

export type { AgentState } from "./types.js";

// ---- Configuration ----

/** FIFO buffer capacity. 20 entries ≈ 5-15 minutes of firing history. */
const BUFFER_SIZE = 20;

/** Frustration dominance threshold — above this = dangerous environment */
const DANGER_HIT_RATE = 0.5;

/** Safe environment threshold — below this = relax thresholds */
const SAFE_HIT_RATE = 0.2;

/** Maximum field adjustment magnitude (per axis) */
const MAX_ADJUSTMENT = 0.10;

/** Field adjustment step per process() call */
const ADJUSTMENT_STEP = 0.02;

/** Flow disruption: proportion of spike intensity to subtract from flow */
const FLOW_DISRUPTION_RATIO = 0.3;

/** Minimum flow level to consider "in flow" for disruption detection */
const FLOW_DISRUPTION_THRESHOLD = 0.3;

// ---- Disruption instruction ----

export interface Disruption {
  axis: EmotionAxis;
  delta: number; // negative = push down
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

  /**
   * Observe a set of fired signals. Called after generateSignals().
   * Only records the dominant axis from the strongest signal.
   * If no signals fired, nothing is recorded (buffer doesn't grow during quiet).
   */
  observe(signals: FireSignal[]): void {
    if (signals.length === 0) return;

    // Find strongest signal
    let strongest = signals[0];
    for (let i = 1; i < signals.length; i++) {
      if (signals[i].intensity > strongest.intensity) {
        strongest = signals[i];
      }
    }

    // Determine dominant axis from emotion snapshot
    const emotion = strongest.emotion;
    const axes: EmotionAxis[] = ["frustration", "hunger", "uncertainty", "confidence", "fatigue", "flow"];
    let dominant: EmotionAxis = "frustration";
    let maxVal = -1;
    for (const axis of axes) {
      if (emotion[axis] > maxVal) {
        maxVal = emotion[axis];
        dominant = axis;
      }
    }

    // Push to FIFO
    this.buffer.push({ dominant, intensity: maxVal, ts: strongest.ts });

    // Evict oldest if over capacity
    while (this.buffer.length > BUFFER_SIZE) {
      this.buffer.shift();
    }
  }

  /**
   * Check for flow disruption: non-flow spike fires while flow is high.
   * Returns disruption instructions for the accumulator.
   *
   * @param currentEmotion Current accumulated emotion (after impulse)
   * @param signals Signals that just fired
   */
  checkFlowDisruption(
    currentEmotion: EmotionVector,
    signals: FireSignal[],
  ): Disruption[] {
    if (currentEmotion.flow < FLOW_DISRUPTION_THRESHOLD) return [];

    // Find non-flow signals
    const nonFlowSignals = signals.filter(s => s.kind !== "flow_active");
    if (nonFlowSignals.length === 0) return [];

    // Flow disruption: push flow down proportional to spike intensity
    const maxIntensity = Math.max(...nonFlowSignals.map(s => s.intensity));
    return [{ axis: "flow", delta: -maxIntensity * FLOW_DISRUPTION_RATIO }];
  }

  /**
   * Process: derive agent state and emit field adjustments.
   * Called once per ingestEvent cycle, after observe().
   *
   * @param currentEmotion Current emotion vector (for state derivation)
   * @param pattern Current short-window pattern from Commander
   * @param ambient The AmbientEstimator to write fieldAdjustment into
   * @param isSilenced Whether the silence gate is active
   */
  process(
    currentEmotion: EmotionVector,
    pattern: PatternKind,
    ambient: AmbientEstimator,
    isSilenced: boolean,
  ): void {
    // Derive agent state
    this._lastState = this._deriveState(currentEmotion, pattern, isSilenced);

    // Calculate time-weighted hit rates
    const rates = this._hitRates();

    // Emit field adjustments based on firing history + state
    this._emitFieldAdjustments(rates, ambient);
  }

  /** Get current agent state. */
  get state(): AgentState {
    return this._lastState;
  }

  /** Get hit rates for display/debugging. */
  hitRates(): Record<EmotionAxis, number> {
    return this._hitRates();
  }

  /** Buffer size (for display). */
  get bufferFill(): number {
    return this.buffer.length;
  }

  /** Clear (for testing / watch restart). */
  clear(): void {
    this.buffer = [];
    this._lastState = "idle";
  }

  /** Format for display. */
  format(): string {
    const rates = this._hitRates();
    const topAxes = (Object.entries(rates) as [EmotionAxis, number][])
      .filter(([, r]) => r > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([axis, rate]) => `${axis}:${(rate * 100).toFixed(0)}%`)
      .join(" ");
    return `Meta[${this._lastState}] buf=${this.buffer.length}/${BUFFER_SIZE} ${topAxes}`;
  }

  // ---- Internals ----

  /** Hit rates: count / buffer size. Position in FIFO encodes recency. */
  private _hitRates(): Record<EmotionAxis, number> {
    const counts: Record<EmotionAxis, number> = {
      frustration: 0, hunger: 0, uncertainty: 0,
      confidence: 0, fatigue: 0, flow: 0,
    };
    for (const entry of this.buffer) {
      counts[entry.dominant]++;
    }
    const total = this.buffer.length || 1;
    return {
      frustration: counts.frustration / total,
      hunger: counts.hunger / total,
      uncertainty: counts.uncertainty / total,
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

    // stuck: frustration accumulating + trial_error pattern
    if (emotion.frustration > 0.3 && pattern === "trial_error") return "stuck";

    // deep_work: flow accumulating + implementation pattern
    if (emotion.flow > 0.2 && pattern === "implementation") return "deep_work";

    // exploring: reading/searching patterns
    if (pattern === "exploration" || pattern === "wandering") return "exploring";

    // default to exploring (safer than stuck)
    return "exploring";
  }

  private _emitFieldAdjustments(
    rates: Record<EmotionAxis, number>,
    ambient: AmbientEstimator,
  ): void {
    const fa = ambient.fieldAdjustment;

    // Frustration-driven: high frustration firing → lower hunger/uncertainty thresholds
    // (先回り介入: エージェントが苦戦中なら、知識ギャップ検知をより敏感に)
    if (rates.frustration > DANGER_HIT_RATE) {
      // Dangerous environment — decrease thresholds (make more sensitive)
      fa.hunger = Math.max(-MAX_ADJUSTMENT, fa.hunger - ADJUSTMENT_STEP);
      fa.uncertainty = Math.max(-MAX_ADJUSTMENT, fa.uncertainty - ADJUSTMENT_STEP);
    } else if (rates.frustration < SAFE_HIT_RATE) {
      // Safe environment — relax adjustments back toward zero
      fa.hunger = this._decayToward(fa.hunger, 0, ADJUSTMENT_STEP);
      fa.uncertainty = this._decayToward(fa.uncertainty, 0, ADJUSTMENT_STEP);
    }

    // State-driven: deep_work → raise frustration threshold (less sensitive)
    // (集中を邪魔しない)
    if (this._lastState === "deep_work") {
      fa.frustration = Math.min(MAX_ADJUSTMENT, fa.frustration + ADJUSTMENT_STEP);
    } else if (this._lastState === "stuck") {
      // Stuck → lower frustration threshold (more sensitive, fire-through will handle delivery)
      fa.frustration = Math.max(-MAX_ADJUSTMENT, fa.frustration - ADJUSTMENT_STEP);
    } else {
      fa.frustration = this._decayToward(fa.frustration, 0, ADJUSTMENT_STEP);
    }

    // Flow and confidence adjustments decay to zero
    fa.flow = this._decayToward(fa.flow, 0, ADJUSTMENT_STEP);
    fa.confidence = this._decayToward(fa.confidence, 0, ADJUSTMENT_STEP);

    // Fatigue: never adjusted by C (safety — like soundLimiter's A neuron)
    // fa.fatigue stays at 0
  }

  /** Move value toward target by at most step. */
  private _decayToward(value: number, target: number, step: number): number {
    if (Math.abs(value - target) <= step) return target;
    return value > target ? value - step : value + step;
  }
}