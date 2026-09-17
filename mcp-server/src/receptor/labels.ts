// ============================================================
// Receptor — Human labels (RECEPTOR_PRECISION_GAPS §7, teacher = human)
// ============================================================
// Sampler: when the receptor fires something the agent will see, keep the
// window that produced it. A human later labels it with label.ts.
// Labels are record-only — not fed into learnedDelta until the report has
// been looked at.
//
// Asks for the *direction* of error, never a number:
//   axis:    over | ok | under
//   signal:  valid (bool)
//   failure: really a failure (bool)
//
// Raw text kept: tool path / command (NormalizedEvent.path, already cut to
// 200 chars). No tool output, no prompt text. Local file only.

import * as fs from "node:fs";
import * as path from "node:path";
import type { EmotionVector, FireSignal, NormalizedEvent, PatternKind, AgentState } from "./types.js";
import { RECEPTOR_OUTPUT_DIR } from "./data-dir.js";

export const LABEL_AXES = ["frustration", "seeking", "confidence", "fatigue"] as const;
export type LabelAxis = typeof LABEL_AXES[number];
export type AxisLabel = "over" | "ok" | "under";

export const QUEUE_PATH = path.join(RECEPTOR_OUTPUT_DIR, "label-queue.jsonl");
export const LABELS_PATH = path.join(RECEPTOR_OUTPUT_DIR, "labels.jsonl");

const SAMPLE_EVERY = 5;
const SAMPLE_CAP = 10;
const WINDOW = 20;

export interface LabelSample {
  id: string;
  ts: number;
  methods: string[];
  agentState: AgentState;
  pattern: PatternKind;
  emotion: EmotionVector;
  signals: { kind: string; intensity: number }[];
  events: { eventId: number; action: string; result?: string; path?: string }[];
}

export interface LabelRecord {
  id: string;
  labeledAt: number;
  axes: Partial<Record<LabelAxis, AxisLabel>>;
  signals: Record<string, boolean>;
  failures: Record<string, boolean>;
}

/** A method the agent will actually see (hotmemo), as opposed to file/log only. */
export interface DispatchedMethod {
  id: string;
  mode: "auto" | "notify" | "background";
  action: { output?: { targets: string[] } };
}

export function isAgentVisible(m: DispatchedMethod): boolean {
  if (m.mode === "notify") return true;
  const targets = m.action.output?.targets ?? ["hotmemo"]; // output-router default
  return targets.includes("hotmemo") || targets.includes("subsystem");
}

// ---- Sampler state ----

let _recent: NormalizedEvent[] = [];
let _dispatches = 0;
let _sampled = 0;

type Sink = (s: LabelSample) => void;
let _sink: Sink = (s) => {
  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  fs.appendFileSync(QUEUE_PATH, JSON.stringify(s) + "\n");
};

export function setLabelSampleSink(fn: Sink): void {
  _sink = fn;
}

export function recordForLabel(event: NormalizedEvent): void {
  _recent.push(event);
  if (_recent.length > WINDOW) _recent.shift();
}

/** Called with what the passive receptor just dispatched and the signals behind it. */
export function sampleForLabel(fired: DispatchedMethod[], signals: FireSignal[]): void {
  const visible = fired.filter(isAgentVisible);
  if (visible.length === 0 || signals.length === 0) return;
  if (_sampled >= SAMPLE_CAP) return;
  if (_dispatches++ % SAMPLE_EVERY !== 0) return;

  const s0 = signals[0];
  try {
    _sink({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      ts: Date.now(),
      methods: visible.map(m => m.id),
      agentState: s0.agentState,
      pattern: s0.pattern,
      emotion: { ...s0.emotion },
      signals: signals.map(s => ({ kind: s.kind, intensity: Math.round(s.intensity * 1000) / 1000 })),
      events: _recent.map(e => ({ eventId: e.eventId, action: e.action, result: e.result, path: e.path })),
    });
    _sampled++;
  } catch {
    // sampling must not crash the receptor
  }
}

export function clearLabelSampler(): void {
  _recent = [];
  _dispatches = 0;
  _sampled = 0;
}

// ---- Files ----

export function readJsonl<T>(file: string): T[] {
  try {
    return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).flatMap(l => {
      try { return [JSON.parse(l) as T]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

export function unlabeled(samples: LabelSample[], labels: LabelRecord[]): LabelSample[] {
  const done = new Set(labels.map(l => l.id));
  return samples.filter(s => !done.has(s.id));
}

// ---- Report ----

export interface LabelSummary {
  labeled: number;
  axes: Record<LabelAxis, { over: number; ok: number; under: number }>;
  signals: Record<string, { valid: number; invalid: number }>;
  failures: { real: number; notReal: number };
}

export function summarize(labels: LabelRecord[]): LabelSummary {
  const axes = Object.fromEntries(LABEL_AXES.map(a => [a, { over: 0, ok: 0, under: 0 }])) as LabelSummary["axes"];
  const signals: LabelSummary["signals"] = {};
  const failures = { real: 0, notReal: 0 };

  for (const l of labels) {
    for (const a of LABEL_AXES) {
      const v = l.axes[a];
      if (v) axes[a][v]++;
    }
    for (const [kind, ok] of Object.entries(l.signals)) {
      signals[kind] ??= { valid: 0, invalid: 0 };
      signals[kind][ok ? "valid" : "invalid"]++;
    }
    for (const ok of Object.values(l.failures)) {
      failures[ok ? "real" : "notReal"]++;
    }
  }
  return { labeled: labels.length, axes, signals, failures };
}
