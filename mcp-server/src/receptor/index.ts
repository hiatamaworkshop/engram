// ============================================================
// Receptor — Entry point
// ============================================================
// Loosely coupled module within engram MCP.
// Manages watch state, delegates to normalizer → commander/heatmap → emotion.
// Three-layer neuron model: A (flow gate) + B (emotion) + C (meta).
// engram index.ts imports only this file.

import type { NormalizedEvent, ReceptorState, EmotionVector, EmotionAxis, FireSignal } from "./types.js";
import { ZERO_EMOTION } from "./types.js";
import { normalize, type RawHookEvent } from "./normalizer.js";
import { PathHeatmap } from "./heatmap.js";
import { Commander } from "./commander.js";
import {
  EmotionAccumulator, computeImpulse, generateSignals, resetHoldState,
  formatSignals, getHoldSummary,
} from "./emotion.js";
import { AmbientEstimator } from "./ambient.js";
import { MetaNeuron } from "./meta.js";

// ---- Singleton state ----

let _watching = false;
let _startedAt: number | null = null;
let _eventCount = 0;
let _lastEmotion: EmotionVector = { ...ZERO_EMOTION };
let _lastSignals: FireSignal[] = [];
let _lastEvent: NormalizedEvent | undefined;

const heatmap = new PathHeatmap();
const commander = new Commander();
const ambient = new AmbientEstimator();
const metaNeuron = new MetaNeuron();
const accumulator = new EmotionAccumulator();

// ---- Signal listeners (connection targets register here) ----

type SignalListener = (signals: FireSignal[]) => void;
const _listeners: SignalListener[] = [];

export function onSignal(listener: SignalListener): void {
  _listeners.push(listener);
}

// ---- Public API ----

/** Toggle watch mode. Returns new state. */
export function setWatch(enabled: boolean): { watching: boolean; message: string } {
  if (enabled && !_watching) {
    _watching = true;
    _startedAt = Date.now();
    _eventCount = 0;
    _lastEmotion = { ...ZERO_EMOTION };
    _lastSignals = [];
    heatmap.clear();
    commander.clear();
    ambient.clear();
    metaNeuron.clear();
    accumulator.clear();
    resetHoldState();
    return { watching: true, message: "Receptor watch started. Monitoring agent behavior." };
  }
  if (!enabled && _watching) {
    const elapsed = _startedAt ? Math.round((Date.now() - _startedAt) / 1000) : 0;
    const msg = `Receptor watch stopped. ${_eventCount} events recorded in ${elapsed}s.`;
    _watching = false;
    _startedAt = null;
    return { watching: false, message: msg };
  }
  return {
    watching: _watching,
    message: _watching ? "Already watching." : "Already stopped.",
  };
}

/** Ingest a raw hook event. Called from hook shell script via HTTP or internal. */
export function ingestEvent(raw: RawHookEvent): void {
  if (!_watching) return;

  const event = normalize(raw);
  if (!event) return;

  _eventCount++;
  _lastEvent = event;

  // Feed to subsystems
  heatmap.record(event);
  commander.record(event);

  // Compute impulse from this event (B neuron input)
  const shortSnap = commander.shortSnapshot();
  const sessionMeta = commander.metaStats();
  const impulse = computeImpulse(shortSnap, sessionMeta, event, heatmap);

  // Accumulate with time decay (stateful — all axes decay toward 0)
  _lastEmotion = accumulator.update(impulse, event.ts);

  // Update ambient baseline (EMA tracking)
  ambient.update(_lastEmotion, event.ts);

  // Heatmap shift → baseline reset (volumechange → recalibration)
  const shift = heatmap.detectShift();
  if (shift.shifted) {
    ambient.reset();
  }

  // Meta neuron C: derive state + adjust ambient field (before signal generation)
  // observe() records previous cycle's signals into FIFO; process() derives current state
  metaNeuron.observe(_lastSignals);
  metaNeuron.process(_lastEmotion, shortSnap.pattern, ambient, ambient.isSilenced);

  // Generate fire signals with dynamic thresholds + hold/release (B neuron output)
  // Signals carry full context: emotion vector + agentState + pattern
  _lastSignals = generateSignals(_lastEmotion, ambient, {
    agentState: metaNeuron.state,
    pattern: shortSnap.pattern,
  });

  // Meta: flow disruption (spike during flow → push flow down)
  const disruptions = metaNeuron.checkFlowDisruption(_lastEmotion, _lastSignals);
  for (const d of disruptions) {
    accumulator.disrupt(d.axis, d.delta);
  }
  if (disruptions.length > 0) {
    _lastEmotion = accumulator.values;
  }

  // Notify listeners (connection targets)
  if (_lastSignals.length > 0) {
    for (const listener of _listeners) {
      try {
        listener(_lastSignals);
      } catch {
        // listeners must not crash receptor
      }
    }
  }
}

/** Get current receptor state (for engram_watch status). */
export function getState(): ReceptorState {
  return {
    watching: _watching,
    startedAt: _startedAt,
    eventCount: _eventCount,
    lastEmotion: { ..._lastEmotion },
    signals: [..._lastSignals],
  };
}

/** Format state for MCP tool response — three-layer neuron monitor. */
export function formatState(): string {
  const state = getState();
  if (!state.watching) {
    return "Receptor: OFF\nUse engram_watch(enabled=true) to start monitoring.";
  }

  const elapsed = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
  const shortSnap = commander.shortSnapshot();
  const mediumSnap = commander.mediumSnapshot();
  const topPaths = heatmap.topPaths(3);

  // ---- Header ----
  const lines: string[] = [
    `Receptor: ON (${elapsed}s, ${state.eventCount} events)`,
  ];

  // ---- A: Flow gate (hard neuron) ----
  // A is the simplest: flow above threshold → suppress everything
  const flowThr = ambient.effectiveThreshold("flow");
  const flowVal = state.lastEmotion.flow;
  const flowFiring = flowVal >= flowThr;
  lines.push("");
  lines.push(`[A] Flow gate: ${flowFiring ? "ACTIVE — suppressing all" : "open"}`);
  lines.push(`    flow=${flowVal.toFixed(2)} thr=${flowThr.toFixed(2)}`);

  // ---- B: Emotion engine (soft neuron) ----
  lines.push("");
  lines.push("[B] Emotion");

  const axes: EmotionAxis[] = ["frustration", "hunger", "uncertainty", "confidence", "fatigue", "flow"];
  const holdSummary = getHoldSummary();

  // Emotion values with threshold comparison
  const emotionParts: string[] = [];
  for (const axis of axes) {
    const val = state.lastEmotion[axis];
    const thr = ambient.effectiveThreshold(axis);
    const base = ambient.baseline(axis);
    const field = ambient.fieldAdjustment[axis];

    let marker = "  ";
    if (val >= thr) marker = "! "; // firing
    else if (holdSummary[axis]) marker = "~ "; // hold (pending release)

    const fieldStr = field !== 0 ? ` field=${field > 0 ? "+" : ""}${field.toFixed(2)}` : "";
    emotionParts.push(`    ${marker}${axis}: ${val.toFixed(2)} | base=${base.toFixed(2)} thr=${thr.toFixed(2)}${fieldStr}`);
  }
  lines.push(...emotionParts);

  // Hold states
  const activeHolds = Object.entries(holdSummary);
  if (activeHolds.length > 0) {
    const holdStr = activeHolds.map(([k, v]) => `${k}(${v.pending}/${3})`).join(" ");
    lines.push(`    holds: ${holdStr}`);
  }

  // Signals
  lines.push(`    signals: ${formatSignals(state.signals)}`);

  // ---- C: Meta neuron ----
  lines.push("");
  lines.push(`[C] ${metaNeuron.format()}`);

  // Field adjustments from C (show only non-zero)
  const fieldParts: string[] = [];
  for (const axis of axes) {
    const f = ambient.fieldAdjustment[axis];
    if (Math.abs(f) > 0.001) {
      fieldParts.push(`${axis}:${f > 0 ? "+" : ""}${f.toFixed(2)}`);
    }
  }
  if (fieldParts.length > 0) {
    lines.push(`    field emission: ${fieldParts.join(" ")}`);
  }

  // ---- Context ----
  lines.push("");
  lines.push(`Pattern: ${shortSnap.pattern}(5m) ${mediumSnap.pattern}(30m) bash_fail=${(shortSnap.bashFailRate * 100).toFixed(0)}%`);
  if (topPaths.length > 0) {
    lines.push(`Hot: ${topPaths.map(p => `${p.path}(${p.count})`).join(" ")}`);
  }
  if (ambient.isSilenced) {
    lines.push("** silence gate active **");
  }

  return lines.join("\n");
}