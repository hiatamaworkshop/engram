// ============================================================
// Receptor — Emotion Engine (accumulation + time decay)
// ============================================================
// Impulse-based: each event contributes small deltas.
// EmotionAccumulator holds stateful values with exponential decay.
// All axes decay toward 0 (away from threshold) over time.
// Idle freezes decay. Does NOT know what is connected to signals.
//
// All numeric constants loaded from emotion-profile.json via profile.ts.

import type { EmotionVector, EmotionAxis, FireSignal, FireSignalKind, NormalizedEvent, PatternKind, AgentState } from "./types.js";
import { ZERO_EMOTION } from "./types.js";
import type { WindowSnapshot } from "./commander.js";
import type { PathHeatmap } from "./heatmap.js";
import type { AmbientEstimator } from "./ambient.js";
import { profile } from "./profile.js";

// ---- Constants (from profile) ----

const AXES: EmotionAxis[] = ["frustration", "seeking", "confidence", "fatigue", "flow"];
const HALF_LIFE = profile.accumulator.halfLife;
const IDLE_FREEZE_MS = profile.accumulator.idleFreezeMs;
const INTER_TURN_CAP_MS = profile.accumulator.interTurnCapMs;
const SPIKE_THRESHOLD = profile.signal.defaultThreshold;
const HOLD_RELEASE_COUNT = profile.signal.holdReleaseCount;
const EVENT_IMPULSE = profile.impulse.event;
const PATTERN_IMPULSE = profile.impulse.pattern;
const HEATMAP_SHIFT_IMPULSE = profile.impulse.heatmapShift;
const FATIGUE_CONF = profile.impulse.fatigue;
const COMPOUNDS = profile.signal.compounds;

// ---- Clamp utility ----

function clamp(v: number, allowNegative = false): number {
  return allowNegative ? Math.max(-1, Math.min(1, v)) : Math.max(0, Math.min(1, v));
}

// ============================================================
// Emotion Accumulator — stateful decay engine
// ============================================================

export class EmotionAccumulator {
  private _values: EmotionVector = { ...ZERO_EMOTION };
  private _lastTs = 0;

  get values(): EmotionVector { return { ...this._values }; }

  update(impulse: EmotionVector, ts: number): EmotionVector {
    if (this._lastTs > 0) {
      const dt = ts - this._lastTs;
      if (dt > 0 && dt < IDLE_FREEZE_MS) {
        const effectiveDt = Math.min(dt, INTER_TURN_CAP_MS);
        for (const axis of AXES) {
          const lambda = Math.LN2 / HALF_LIFE[axis];
          this._values[axis] *= Math.exp(-lambda * effectiveDt);
        }
      }
    }
    this._lastTs = ts;

    for (const axis of AXES) {
      this._values[axis] = clamp(this._values[axis] + impulse[axis], axis === "seeking");
    }

    return this.values;
  }

  disrupt(axis: EmotionAxis, delta: number): void {
    this._values[axis] = clamp(this._values[axis] + delta);
  }

  clear(): void {
    this._values = { ...ZERO_EMOTION };
    this._lastTs = 0;
  }
}

// ============================================================
// Impulse computation — per-event deltas
// ============================================================

/** Apply an AxisRecord impulse map to a mutable vector. */
function applyImpulse(
  vec: EmotionVector,
  deltas: Partial<Record<EmotionAxis, number>> | undefined,
): void {
  if (!deltas) return;
  for (const [axis, val] of Object.entries(deltas)) {
    if (val !== undefined && axis in vec) {
      (vec as unknown as Record<string, number>)[axis] += val;
    }
  }
}

export function computeImpulse(
  shortSnap: WindowSnapshot,
  sessionMeta: { totalEvents: number; elapsedMs: number },
  lastEvent?: NormalizedEvent,
  heatmap?: PathHeatmap,
): EmotionVector {
  const vec: EmotionVector = { ...ZERO_EMOTION };

  // ---- Event-driven impulses ----
  if (lastEvent) {
    const action = lastEvent.action;
    const result = lastEvent.result;

    // Compound key: "action.result" or just "action"
    if (result === "failure" || result === "empty") {
      applyImpulse(vec, EVENT_IMPULSE[`${action}.failure`] ?? EVENT_IMPULSE[`${action}.empty`]);
    } else if (result === "success") {
      applyImpulse(vec, EVENT_IMPULSE[`${action}.success`]);
    }
    // Always apply the base action impulse (non-result-specific)
    applyImpulse(vec, EVENT_IMPULSE[action]);

    // For search with "found" result (non-empty, non-failure)
    if (action === "search" && result !== "empty" && result !== "failure") {
      applyImpulse(vec, EVENT_IMPULSE["search.found"]);
    }

    // Dialogue: long prompts (>100 chars) get additional impulse
    if (action === "user_prompt" && lastEvent.promptLength && lastEvent.promptLength > 100) {
      applyImpulse(vec, EVENT_IMPULSE["user_prompt.long"]);
    }
  }

  // ---- Pattern-driven impulses ----
  applyImpulse(vec, PATTERN_IMPULSE[shortSnap.pattern]);

  // ---- Heatmap-driven ----
  if (heatmap?.detectShift().shifted) {
    applyImpulse(vec, HEATMAP_SHIFT_IMPULSE);
  }

  // ---- Fatigue ----
  const sessionHours = sessionMeta.elapsedMs / 3_600_000;
  vec.fatigue += FATIGUE_CONF.base + sessionHours * FATIGUE_CONF.hourlyRate;

  return vec;
}

// ---- Hold state (verification-based hold/release) ----

interface HoldEntry {
  active: boolean;
  subThresholdCount: number;
}

const _holdState: Record<string, HoldEntry> = {};

function getHold(key: string): HoldEntry {
  if (!_holdState[key]) {
    _holdState[key] = { active: false, subThresholdCount: 0 };
  }
  return _holdState[key];
}

export function resetHoldState(): void {
  for (const key of Object.keys(_holdState)) {
    delete _holdState[key];
  }
}

// ---- Fire signal generation ----

export interface SignalContext {
  agentState: AgentState;
  pattern: PatternKind;
}

export function generateSignals(
  emotion: EmotionVector,
  ambient?: AmbientEstimator,
  ctx?: SignalContext,
): FireSignal[] {
  const signals: FireSignal[] = [];
  const ts = Date.now();
  const agentState: AgentState = ctx?.agentState ?? "exploring";
  const pattern: PatternKind = ctx?.pattern ?? "stagnation";

  const thr = (axis: EmotionAxis): number =>
    ambient ? ambient.effectiveThreshold(axis) : SPIKE_THRESHOLD;

  const sig = (kind: FireSignalKind, intensity: number): FireSignal =>
    ({ kind, intensity, ts, emotion, agentState, pattern });

  function shouldFire(axis: EmotionAxis): boolean {
    const threshold = thr(axis);
    const hold = getHold(axis);
    // seeking uses absolute value (both curiosity and desperation trigger)
    const value = axis === "seeking" ? Math.abs(emotion[axis]) : emotion[axis];

    if (value >= threshold) {
      hold.active = true;
      hold.subThresholdCount = 0;
      return true;
    }

    if (hold.active) {
      hold.subThresholdCount++;
      if (hold.subThresholdCount >= HOLD_RELEASE_COUNT) {
        hold.active = false;
        hold.subThresholdCount = 0;
        return false;
      }
      return true;
    }

    return false;
  }

  // flow suppresses all other signals
  if (shouldFire("flow")) {
    signals.push(sig("flow_active", emotion.flow));
    return signals;
  }

  // Compound signals (from profile)
  for (const compound of COMPOUNDS) {
    const fires = compound.requires.map(axis => shouldFire(axis));
    if (fires.every(Boolean)) {
      const intensities = compound.requires.map(axis => emotion[axis]);
      const intensity = compound.intensity === "max"
        ? Math.max(...intensities)
        : intensities.reduce((a, b) => a + b, 0);
      signals.push(sig(compound.id as FireSignalKind, intensity));
      if (compound.priority) return signals;
    }
  }

  // Individual spikes
  // For seeking: fire on absolute value (both curiosity and desperation are signal-worthy)
  const checks: Array<[EmotionAxis, FireSignalKind]> = [
    ["frustration", "frustration_spike"],
    ["seeking", "seeking_spike"],
    ["confidence", "confidence_sustained"],
    ["fatigue", "fatigue_rising"],
  ];

  for (const [axis, kind] of checks) {
    // Skip axes already consumed by compounds
    const inCompound = COMPOUNDS.some(c =>
      c.requires.includes(axis) && c.requires.every(a => shouldFire(a)),
    );
    if (inCompound) continue;

    if (shouldFire(axis)) {
      signals.push(sig(kind, emotion[axis]));
    }
  }

  return signals;
}

// ---- Format helpers ----

export function formatEmotion(e: EmotionVector): string {
  return AXES.map((a) => `${a}: ${e[a].toFixed(2)}`).join("  ");
}

export function formatSignals(signals: FireSignal[]): string {
  if (signals.length === 0) return "(no signals)";
  return signals.map((s) => `${s.kind} [${s.intensity.toFixed(2)}]`).join(", ");
}

export function getHoldSummary(): Record<string, { active: boolean; pending: number }> {
  const result: Record<string, { active: boolean; pending: number }> = {};
  for (const [key, entry] of Object.entries(_holdState)) {
    if (entry.active) {
      result[key] = { active: true, pending: entry.subThresholdCount };
    }
  }
  return result;
}
