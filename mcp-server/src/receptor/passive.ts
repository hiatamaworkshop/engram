// ============================================================
// Receptor — Passive Receptor (interpretation layer)
// ============================================================
// Receives FireSignal[] from B neuron, scores methods from
// receptor-rules.json, and routes results by delivery mode.
//
// Scoring formula:
//   score(method, signal) =
//       signalMatch    (0 or 1)
//     × stateMatch     (1.0 or 0.3)
//     × signal.intensity
//     × method.trigger.sensitivity
//     × (1 - falsePositiveRate)
//     × receptorSuppression²       // axis-specific refractory
//
// Receptor desensitization: after firing, the receptor absorbs the
// signal's emotion vector. High satiation on an axis suppresses
// future signals on THAT axis, while remaining receptive to others.

import type { FireSignal, EmotionVector, EmotionAxis } from "./types.js";
import { ZERO_EMOTION } from "./types.js";
import rules from "./receptor-rules.json" with { type: "json" };
import learned from "./receptor-learned.json" with { type: "json" };

// ---- Types ----

interface MethodTrigger {
  signals: string[];
  states: string[];
  sensitivity: number;
  frequency: "low" | "medium" | "high";
}

interface MethodOutput {
  targets: string[];
  format?: "raw" | "summary" | "json";
  maxLength?: number;
}

interface MethodAction {
  tool?: string;
  args?: Record<string, unknown>;
  message?: string;
  output?: MethodOutput;
}

interface MethodDef {
  id: string;
  type: string;
  mode: "auto" | "notify" | "background";
  trigger: MethodTrigger;
  action: MethodAction;
}

export interface ScoredMethod {
  id: string;
  type: string;
  mode: "auto" | "notify" | "background";
  score: number;
  action: MethodAction;
}

// ---- Constants ----

/** Score threshold — methods below this are silent. */
const FIRE_THRESHOLD = 0.15;

/** State mismatch suppression factor (not zero — design doc says ×0.3). */
const STATE_MISMATCH_FACTOR = 0.3;

/** Cooldown per frequency level (ms).
 *  Calibrated to Claude interaction time scale. */
const RECENCY_COOLDOWN: Record<string, number> = {
  low:    2_400_000,  // 40 min
  medium: 1_200_000,  // 20 min
  high:     300_000,  //  5 min
};

/** Signal kind → primary emotion axes.
 *  Used to determine which receptor axes provide suppression. */
const SIGNAL_AXES: Record<string, EmotionAxis[]> = {
  frustration_spike:            ["frustration"],
  seeking_spike:                ["seeking"],
  compound_frustration_seeking: ["frustration", "seeking"],
  confidence_sustained:         ["confidence"],
  fatigue_rising:               ["fatigue"],
  flow_active:                  ["flow"],
};

const EMOTION_KEYS: EmotionAxis[] = [
  "frustration", "seeking", "confidence", "fatigue", "flow",
];

// ---- Learned delta (cross-session calibration) ----

const DELTA_BOUND = 0.30;
const _learnedDelta: Record<string, number> = {};

// Load and clamp deltas from receptor-learned.json
{
  const raw = (learned as { delta: Record<string, number> }).delta;
  for (const [axis, val] of Object.entries(raw)) {
    _learnedDelta[axis] = Math.max(-DELTA_BOUND, Math.min(DELTA_BOUND, val));
  }
}

/** Get learned delta for a signal kind's primary axis. Returns 0 if unknown. */
function learnedDelta(signalKind: string): number {
  const axes = SIGNAL_AXES[signalKind];
  if (!axes || axes.length === 0) return 0;
  // Use max absolute delta across signal's axes
  let maxDelta = 0;
  for (const axis of axes) {
    const d = _learnedDelta[axis] ?? 0;
    if (Math.abs(d) > Math.abs(maxDelta)) maxDelta = d;
  }
  return maxDelta;
}

// ---- State ----

const methods: MethodDef[] = rules.methods as MethodDef[];

/** Per-method receptor state — emotion vector that accumulates on fire. */
interface ReceptorMark {
  emotion: EmotionVector;
  ts: number;
}
const _receptorState: Record<string, ReceptorMark> = {};

/** Emotion of the best-matching signal per method (set during evaluate, consumed by dispatch). */
const _evalEmotions: Map<string, EmotionVector> = new Map();

/** Accumulated recommendations (notify mode). FIFO — oldest entry dropped when full. */
const PENDING_MAX = 3;
let _pending: ScoredMethod[] = [];


// ---- Receptor suppression (axis-specific refractory) ----

/**
 * Compute receptor suppression for a method + signal kind.
 *
 * After firing, the receptor's emotion vector is high on the axes
 * that triggered the fire. This acts as defense — high satiation
 * on the signal's primary axis(es) suppresses future reception.
 *
 * Other axes remain low → the receptor stays receptive to different signals.
 * Decay is linear over cooldown: receptor fully recovers when cooldown elapses.
 *
 * Returns: suppression factor (0 = fully suppressed, 1 = fully receptive).
 */
function receptorSuppression(
  methodId: string,
  signalKind: string,
  frequency: string,
  now: number,
): number {
  const state = _receptorState[methodId];
  if (!state) return 1.0; // never fired — fully receptive

  const cooldown = RECENCY_COOLDOWN[frequency] ?? RECENCY_COOLDOWN.low;
  const elapsed = now - state.ts;
  if (elapsed >= cooldown) return 1.0; // fully recovered

  // Linear time factor: 1.0 at fire → 0.0 at cooldown
  const remaining = 1 - elapsed / cooldown;

  // Find the signal's primary axes
  const axes = SIGNAL_AXES[signalKind];
  if (!axes || axes.length === 0) return 1.0; // unknown signal — no suppression

  // Max receptor satiation on relevant axes (decayed by time)
  let maxLevel = 0;
  for (const axis of axes) {
    const level = state.emotion[axis] * remaining;
    if (level > maxLevel) maxLevel = level;
  }

  // Suppression: high level → low receptivity, squared for receptor dominance
  const receptivity = 1 - maxLevel;
  return receptivity * receptivity;
}

/**
 * Blend the incoming signal's emotion into the receptor's state (simple average).
 * Decays existing state to present time before blending.
 */
function blendReceptor(methodId: string, signalEmotion: EmotionVector, now: number, frequency: string): void {
  const cooldown = RECENCY_COOLDOWN[frequency] ?? RECENCY_COOLDOWN.low;

  // Decay existing state to present time
  let current: EmotionVector;
  const existing = _receptorState[methodId];
  if (existing) {
    const elapsed = now - existing.ts;
    const remaining = Math.max(0, 1 - elapsed / cooldown);
    current = {} as EmotionVector;
    for (const axis of EMOTION_KEYS) {
      current[axis] = existing.emotion[axis] * remaining;
    }
  } else {
    current = { ...ZERO_EMOTION };
  }

  // Simple average blend
  const blended = {} as EmotionVector;
  for (const axis of EMOTION_KEYS) {
    blended[axis] = (current[axis] + signalEmotion[axis]) / 2;
  }

  _receptorState[methodId] = { emotion: blended, ts: now };
}

// ---- Scoring ----

function signalMatch(trigger: MethodTrigger, signalKind: string): number {
  if (trigger.signals.includes("*")) return 1.0; // wildcard — match all signals
  return trigger.signals.includes(signalKind) ? 1.0 : 0.0;
}

function stateMatch(trigger: MethodTrigger, agentState: string): number {
  return trigger.states.includes(agentState) ? 1.0 : STATE_MISMATCH_FACTOR;
}

function scoreMethod(method: MethodDef, signal: FireSignal): number {
  const sm = signalMatch(method.trigger, signal.kind);
  if (sm === 0) return 0; // fast path — no match, no score

  const suppression = receptorSuppression(
    method.id, signal.kind, method.trigger.frequency, signal.ts,
  );

  const delta = learnedDelta(signal.kind);

  return sm
    * stateMatch(method.trigger, signal.agentState)
    * signal.intensity
    * method.trigger.sensitivity
    * (1 + delta)
    * suppression;
}

// ---- Evaluate ----

/**
 * Evaluate all methods against incoming signals.
 * Returns threshold-exceeding methods sorted by score (descending).
 * Multiple methods can fire simultaneously (no argmax).
 */
function evaluate(signals: FireSignal[]): ScoredMethod[] {
  const flowActive = signals.some(s => s.kind === "flow_active");

  _evalEmotions.clear();
  const results: ScoredMethod[] = [];

  for (const method of methods) {
    // A gate: flow_active → suppress all except observation methods
    if (flowActive && method.type !== "observation") continue;
    // Best score across all signals for this method
    let bestScore = 0;
    let bestEmotion: EmotionVector | undefined;
    for (const signal of signals) {
      const s = scoreMethod(method, signal);
      if (s > bestScore) {
        bestScore = s;
        bestEmotion = signal.emotion;
      }
    }

    if (bestScore >= FIRE_THRESHOLD) {
      _evalEmotions.set(method.id, bestEmotion!);
      results.push({
        id: method.id,
        type: method.type,
        mode: method.mode,
        score: bestScore,
        action: method.action,
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---- Dispatch ----

/** Auto-mode execution results (consumed by method resolver). */
let _autoQueue: ScoredMethod[] = [];

function dispatch(fired: ScoredMethod[]): void {
  const now = Date.now();

  for (const method of fired) {
    // Look up method definition for frequency
    const methodDef = methods.find(m => m.id === method.id);
    const signalEmotion = _evalEmotions.get(method.id);

    // Blend receptor state with incoming signal's emotion vector
    if (methodDef && signalEmotion) {
      blendReceptor(method.id, signalEmotion, now, methodDef.trigger.frequency);
    }

    switch (method.mode) {
      case "auto":
        _autoQueue.push(method);
        break;
      case "notify":
        _pending.push(method);
        if (_pending.length > PENDING_MAX) _pending.shift();
        break;
      case "background":
        // Execute silently — output visibility controlled by action.output targets
        // (typically ["engram", "log"] — no hotmemo, so agent never sees results)
        _autoQueue.push(method);
        break;
    }
  }
}

// ---- Signal listener (entry point) ----

/**
 * Process incoming fire signals. Called by receptor index.ts via onSignal().
 * This is the passive receptor's single entry point.
 */
export function onFireSignals(signals: FireSignal[]): void {
  if (signals.length === 0) return;

  const fired = evaluate(signals);
  if (fired.length > 0) {
    dispatch(fired);
  }
}

// ---- Public API ----

/**
 * Drain pending notify recommendations.
 * Returns accumulated recommendations and clears the buffer.
 * Called by hotmemo layer to format for agent display.
 */
export function drainRecommendations(): ScoredMethod[] {
  const result = _pending;
  _pending = [];
  return result;
}

/**
 * Drain auto-execution queue.
 * Returns methods that should be executed immediately.
 * Called by method resolver (future).
 */
export function drainAutoQueue(): ScoredMethod[] {
  const result = _autoQueue;
  _autoQueue = [];
  return result;
}


/**
 * Format pending recommendations for hotmemo display.
 * Returns empty string if nothing to recommend (zero noise).
 */
export function formatRecommendations(): string {
  if (_pending.length === 0) return "";

  const lines = _pending.map(m => {
    if (m.action.message) return m.action.message;
    if (m.action.tool) return `consider: ${m.action.tool}`;
    return m.id;
  });

  // Deduplicate
  const unique = [...new Set(lines)];
  return `[receptor] ${unique.join(" | ")}`;
}