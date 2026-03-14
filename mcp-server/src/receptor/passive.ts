// ============================================================
// Receptor — Passive Receptor (interpretation layer)
// ============================================================
// Receives FireSignal[] from B neuron, scores methods from
// receptor-rules.json, and routes results by delivery mode.
//
// Scoring formula (from PASSIVE_RECEPTOR_DESIGN.md):
//   score(method, signal) =
//       signalMatch    (0 or 1)
//     × stateMatch     (1.0 or 0.3)
//     × signal.intensity
//     × method.trigger.sensitivity
//     × (1 - falsePositiveRate)          // learnedDelta (future)
//     × recencyDecay(frequency)          // anti-spam
//
// Does NOT know what executes the methods — that is method resolver's job.

import type { FireSignal, FireSignalKind, AgentState } from "./types.js";
import rules from "./receptor-rules.json" with { type: "json" };

// ---- Types ----

interface MethodTrigger {
  signals: string[];
  states: string[];
  sensitivity: number;
  frequency: "low" | "medium" | "high";
}

interface MethodAction {
  tool?: string;
  args?: Record<string, unknown>;
  message?: string;
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

/** Recency decay constants per frequency level (ms). */
const RECENCY_COOLDOWN: Record<string, number> = {
  low: 120_000,     // 2 min — fire at most once per 2 min
  medium: 60_000,   // 1 min
  high: 15_000,     // 15s
};

// ---- State ----

const methods: MethodDef[] = rules.methods as MethodDef[];

/** Last fire timestamp per method id. */
const _lastFired: Record<string, number> = {};

/** Accumulated recommendations (notify mode). Drained on read. */
let _pending: ScoredMethod[] = [];

// ---- Scoring ----

function signalMatch(trigger: MethodTrigger, signalKind: string): number {
  return trigger.signals.includes(signalKind) ? 1.0 : 0.0;
}

function stateMatch(trigger: MethodTrigger, agentState: string): number {
  return trigger.states.includes(agentState) ? 1.0 : STATE_MISMATCH_FACTOR;
}

function recencyDecay(methodId: string, frequency: string, now: number): number {
  const last = _lastFired[methodId];
  if (!last) return 1.0;

  const cooldown = RECENCY_COOLDOWN[frequency] ?? RECENCY_COOLDOWN.low;
  const elapsed = now - last;
  if (elapsed >= cooldown) return 1.0;

  // Linear decay: 0 at fire time → 1 at cooldown
  return elapsed / cooldown;
}

function falsePositiveRate(_methodType: string): number {
  // learnedDelta — future: load from receptor-learned.json
  return 0;
}

function scoreMethod(method: MethodDef, signal: FireSignal): number {
  const sm = signalMatch(method.trigger, signal.kind);
  if (sm === 0) return 0; // fast path — no match, no score

  return sm
    * stateMatch(method.trigger, signal.agentState)
    * signal.intensity
    * method.trigger.sensitivity
    * (1 - falsePositiveRate(method.type))
    * recencyDecay(method.id, method.trigger.frequency, signal.ts);
}

// ---- Evaluate ----

/**
 * Evaluate all methods against incoming signals.
 * Returns threshold-exceeding methods sorted by score (descending).
 * Multiple methods can fire simultaneously (no argmax).
 */
function evaluate(signals: FireSignal[]): ScoredMethod[] {
  // A gate: flow_active → suppress all
  if (signals.some(s => s.kind === "flow_active")) {
    return [];
  }

  const results: ScoredMethod[] = [];

  for (const method of methods) {
    // Best score across all signals for this method
    let bestScore = 0;
    for (const signal of signals) {
      const s = scoreMethod(method, signal);
      if (s > bestScore) bestScore = s;
    }

    if (bestScore >= FIRE_THRESHOLD) {
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
    // Record fire time for recency decay
    _lastFired[method.id] = now;

    switch (method.mode) {
      case "auto":
        _autoQueue.push(method);
        break;
      case "notify":
        _pending.push(method);
        break;
      case "background":
        // future: background execution
        _pending.push(method); // for now, treat as notify
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
