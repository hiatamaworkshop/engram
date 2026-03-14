// ============================================================
// Receptor — Entry point
// ============================================================
// Loosely coupled module within engram MCP.
// Manages watch state, delegates to normalizer → commander/heatmap → emotion.
// engram index.ts imports only this file.

import type { NormalizedEvent, ReceptorState, EmotionVector, FireSignal } from "./types.js";
import { ZERO_EMOTION } from "./types.js";
import { normalize, type RawHookEvent } from "./normalizer.js";
import { PathHeatmap } from "./heatmap.js";
import { Commander } from "./commander.js";
import { computeEmotion, generateSignals, formatEmotion, formatSignals } from "./emotion.js";

// ---- Singleton state ----

let _watching = false;
let _startedAt: number | null = null;
let _eventCount = 0;
let _lastEmotion: EmotionVector = { ...ZERO_EMOTION };
let _lastSignals: FireSignal[] = [];
let _lastEvent: NormalizedEvent | undefined;

const heatmap = new PathHeatmap();
const commander = new Commander();

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

  // Compute emotion
  const shortSnap = commander.shortSnapshot();
  const mediumSnap = commander.mediumSnapshot();
  const meta = commander.metaStats();
  _lastEmotion = computeEmotion(shortSnap, mediumSnap, meta, heatmap, event);

  // Generate fire signals
  _lastSignals = generateSignals(_lastEmotion);

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

/** Format state for MCP tool response. */
export function formatState(): string {
  const state = getState();
  if (!state.watching) {
    return "Receptor: OFF\nUse engram_watch(enabled=true) to start monitoring.";
  }

  const elapsed = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
  const topPaths = heatmap.topPaths(5);
  const shortSnap = commander.shortSnapshot();

  const lines = [
    `Receptor: ON (${elapsed}s, ${state.eventCount} events)`,
    "",
    `Emotion: ${formatEmotion(state.lastEmotion)}`,
    `Signals: ${formatSignals(state.signals)}`,
    `Pattern: ${shortSnap.pattern} (short) / bash_fail=${(shortSnap.bashFailRate * 100).toFixed(0)}%`,
    "",
    "Hot paths:",
    ...topPaths.map((p) => `  ${p.path} (${p.count})`),
  ];

  return lines.join("\n");
}