// ============================================================
// Receptor — Entry point
// ============================================================
// Loosely coupled module within engram MCP.
// Manages watch state, delegates to normalizer → commander/heatmap → emotion.
// Three-layer neuron model: A (flow gate) + B (emotion) + C (meta).
// engram index.ts imports only this file.

import type { NormalizedEvent, ReceptorState, EmotionVector, EmotionAxis, FireSignal, AgentState } from "./types.js";
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
import {
  onFireSignals, formatRecommendations, drainRecommendations, drainAutoQueue,
  type ScoredMethod,
} from "./passive.js";

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

// ---- Passive receptor (interpretation layer) ----
// Registered as built-in listener. Scores methods from receptor-rules.json.
_listeners.push(onFireSignals);

// Re-export passive receptor API for hotmemo integration
export { formatRecommendations, drainRecommendations, drainAutoQueue };

// ---- Method executor (via service registry) ----

export interface ExecutorContext {
  topPaths: string[];
  emotion: EmotionVector;
  agentState: AgentState;
}

// Re-export registry API so callers can register executors via receptor/index
export { registerExecutor, registeredTools } from "./registry.js";
export { loadExternalServices } from "./service-loader.js";
export { routeOutput, registerSink } from "./output-router.js";
export {
  formatSubsystemResults, allSubsystemResults, subsystemCount, clearSubsystem,
} from "./subsystem-fifo.js";
import { registerExecutor as _regExec, resolveAndExecute } from "./registry.js";
import { routeOutput as _routeOut, type OutputConfig } from "./output-router.js";
import { formatSubsystemResults as _fmtSub, clearSubsystem } from "./subsystem-fifo.js";

// ---- Internal executor: path_suggest ----
// Reads heatmap directly (no external dependency). Output via routeOutput.

_regExec("path_suggest", {
  type: "internal",
  handler: async (method, context) => {
    const top = heatmap.topPaths(10);
    if (top.length === 0) return;

    const raw = JSON.stringify(top);
    _routeOut({
      methodId: method.id,
      toolName: "path_suggest",
      agentState: context.agentState,
      raw,
      output: method.action.output as OutputConfig | undefined,
    });
    console.error(`[receptor] path_suggest: ${top.length} paths`);
  },
});

/** Format subsystem FIFO for hotmemo Layer 7. Shows newest 3 entries. */
export function formatSubsystemForHotmemo(): string {
  const body = _fmtSub(3);
  if (!body) return "";
  return `[subsystem]\n${body}`;
}

/** Drain auto queue and dispatch via registry. Non-blocking (fire-and-forget). */
function executeAutoQueue(): void {
  const queue = drainAutoQueue();
  if (queue.length === 0) return;

  const context: ExecutorContext = {
    topPaths: heatmap.topPaths(5).map(p => p.path),
    emotion: { ..._lastEmotion },
    agentState: metaNeuron.state,
  };

  for (const method of queue) {
    resolveAndExecute(method, context).catch(err => {
      console.error(`[receptor] executor error (${method.id}):`, err);
    });
  }
}

// ---- Turn tracking ----

/** Record a turn boundary event from UserPromptSubmit / Stop hooks. */
export function recordTurn(type: "user" | "agent"): void {
  commander.recordTurn(type);
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
    clearSubsystem();
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

    // Method resolver: execute auto queue (fire-and-forget)
    executeAutoQueue();
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

// ---- Formatting helpers ----

/** ASCII bar: ▓ filled, ░ empty. width = max chars for the bar portion. */
function bar(value: number, max: number, width = 10): string {
  const filled = Math.round((Math.min(value, max) / max) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/** Format elapsed time as human-readable. */
function fmtElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

/** Format action counts as compact mini-bar. */
function fmtCounts(snap: { counts: Record<string, number>; total: number }): string {
  const labels: [string, string][] = [
    ["file_read", "Rd"],
    ["file_edit", "Ed"],
    ["search", "Sr"],
    ["shell_exec", "Sh"],
    ["delegation", "Ag"],
    ["memory_read", "Mr"],
    ["memory_write", "Mw"],
  ];
  const parts: string[] = [];
  for (const [key, label] of labels) {
    const n = snap.counts[key] ?? 0;
    if (n > 0) parts.push(`${label}:${n}`);
  }
  return parts.length > 0 ? parts.join(" ") : "(empty)";
}

/** Render heatmap as indented tree (top branches only, max depth 3). */
function fmtHeatmapTree(hmap: PathHeatmap, maxLeaves = 5): string {
  const top = hmap.topPaths(maxLeaves);
  if (top.length === 0) return "";

  // Build a simple tree from flat paths
  interface TreeNode { count: number; children: Map<string, TreeNode> }
  const root: TreeNode = { count: 0, children: new Map() };

  for (const { path, count } of top) {
    const segs = path.split("/");
    let node = root;
    for (const seg of segs) {
      if (!node.children.has(seg)) {
        node.children.set(seg, { count: 0, children: new Map() });
      }
      node = node.children.get(seg)!;
    }
    node.count = count;
  }

  const lines: string[] = [];
  const renderNode = (node: TreeNode, prefix: string, depth: number): void => {
    const entries = [...node.children.entries()];
    for (let i = 0; i < entries.length; i++) {
      const [name, child] = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const countStr = child.count > 0 ? ` (${child.count})` : "";
      lines.push(`${prefix}${connector}${name}${countStr}`);
      if (child.children.size > 0 && depth < 3) {
        renderNode(child, prefix + (isLast ? "    " : "│   "), depth + 1);
      }
    }
  };
  renderNode(root, "    ", 0);
  return lines.join("\n");
}

/** Format state for MCP tool response — three-layer neuron monitor. */
export function formatState(): string {
  const state = getState();
  if (!state.watching) {
    return "Receptor: OFF\nUse engram_watch(action='start') to begin monitoring.";
  }

  const elapsed = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
  const shortSnap = commander.shortSnapshot();
  const mediumSnap = commander.mediumSnapshot();
  const rate = elapsed > 0 ? (state.eventCount / (elapsed / 60)).toFixed(1) : "0.0";

  // ---- Header ----
  const lines: string[] = [
    `Receptor: ON  ${fmtElapsed(elapsed)}  ${state.eventCount} events  ${rate}/min`,
  ];

  // ---- A: Flow gate (hard neuron) ----
  const flowThr = ambient.effectiveThreshold("flow");
  const flowVal = state.lastEmotion.flow;
  const flowFiring = flowVal >= flowThr;
  lines.push("");
  lines.push(`[A] Flow gate: ${flowFiring ? "ACTIVE — suppressing all" : "open"}`);
  lines.push(`    flow ${bar(flowVal, 1)} ${flowVal.toFixed(2)}  thr=${flowThr.toFixed(2)}`);

  // ---- B: Emotion engine (soft neuron) ----
  lines.push("");
  lines.push("[B] Emotion");

  const axes: EmotionAxis[] = ["frustration", "hunger", "uncertainty", "confidence", "fatigue", "flow"];
  const holdSummary = getHoldSummary();

  for (const axis of axes) {
    const val = state.lastEmotion[axis];
    const thr = ambient.effectiveThreshold(axis);
    const base = ambient.baseline(axis);
    const field = ambient.fieldAdjustment[axis];

    let marker = "  ";
    if (val >= thr) marker = "! ";       // firing
    else if (holdSummary[axis]) marker = "~ ";  // hold (pending release)

    const fieldStr = Math.abs(field) > 0.001 ? ` C:${field > 0 ? "+" : ""}${field.toFixed(2)}` : "";
    // Show threshold marker on the bar
    const thrPos = Math.round(Math.min(thr, 1) * 10);
    const barStr = bar(val, 1);
    const barWithThr = barStr.substring(0, thrPos) + "|" + barStr.substring(thrPos + 1);
    const abbr = axis.substring(0, 4).toUpperCase().padEnd(4);
    lines.push(`    ${marker}${abbr} ${barWithThr} ${val.toFixed(2)}  base=${base.toFixed(2)}${fieldStr}`);
  }

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
    lines.push(`    field: ${fieldParts.join(" ")}`);
  }

  // ---- Commander: action breakdown ----
  lines.push("");
  const turnInfo5 = shortSnap.turns > 0 ? `  turns=${shortSnap.turns} t/t=${shortSnap.toolsPerTurn.toFixed(1)}` : "";
  const turnInfo30 = mediumSnap.turns > 0 ? `  turns=${mediumSnap.turns} t/t=${mediumSnap.toolsPerTurn.toFixed(1)}` : "";
  lines.push(`Pattern: ${shortSnap.pattern}(5m) ${mediumSnap.pattern}(30m)  bash_fail=${(shortSnap.bashFailRate * 100).toFixed(0)}%`);
  lines.push(`  5m:  [${fmtCounts(shortSnap)}] n=${shortSnap.total}${turnInfo5}`);
  if (mediumSnap.total !== shortSnap.total) {
    lines.push(`  30m: [${fmtCounts(mediumSnap)}] n=${mediumSnap.total}${turnInfo30}`);
  }

  // ---- Heatmap tree ----
  const tree = fmtHeatmapTree(heatmap, 5);
  if (tree) {
    lines.push("");
    lines.push(`Heatmap (${heatmap.totalHits} hits):`);
    lines.push(tree);
  }

  if (ambient.isSilenced) {
    lines.push("");
    lines.push("** silence gate active **");
  }

  return lines.join("\n");
}