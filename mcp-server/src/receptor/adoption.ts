// ============================================================
// Receptor — Adoption observer (RECEPTOR_PRECISION_GAPS §4)
// ============================================================
// Did the agent act on what the receptor told it? Deterministic matching
// over the next K tool events. Record-only: verdicts go to a JSONL log and
// are NOT fed into learnedDelta yet — first see whether they are sane.
//
// The window opens at *delivery* (the hotmemo attached to an engram tool
// response), not at fire time: a recommendation still sitting in the pending
// buffer has not been seen by anyone.
//
// Anything that cannot be judged is logged "undecidable" and must never be
// used as a learning signal. A wrong "adopted" teaches more harm than silence.

import type { NormalizedEvent, PatternKind } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { RECEPTOR_OUTPUT_DIR } from "./data-dir.js";

/** Tool events (user prompts excluded) a delivery stays open for. */
export const ADOPTION_WINDOW = 10;

export type Verdict = "adopted" | "ignored" | "undecidable";

export interface AdoptionRecord {
  ts: number;
  method: string;
  verdict: Verdict;
  reason: string;
  /** Tool events between delivery and the adopting event (adopted only). */
  after?: number;
}

type Rule = "paths" | "leave_trial_error" | "push" | "push_or_stop";

interface Open {
  method: string;
  rule: Rule;
  deliveredTs: number;
  seen: number;
  /** Basenames named in the delivered text and not touched just before it. */
  candidates: Set<string>;
  deliveryPattern: PatternKind;
  /** The engram call that carried the hotmemo reports its own hook event. */
  swallowMemory: boolean;
}

// ---- Method → rule ----
// Methods delivered as a message with no referent are judged by behaviour;
// everything delivered as a result text is judged by the paths it names.

const MESSAGE_RULES: Record<string, Rule> = {
  frustration_alert: "leave_trial_error",
  engram_push_reminder: "push",
  fatigue_warning: "push_or_stop",
};

// ---- State ----

let _open: Open[] = [];
let _pattern: PatternKind = "stagnation";
/** Basenames touched in the last ADOPTION_WINDOW tool events. */
let _recentTouched: string[] = [];

type Sink = (rec: AdoptionRecord) => void;
let _sink: Sink = fileSink;

export function setAdoptionSink(fn: Sink): void {
  _sink = fn;
}

// ---- Delivery ----

/**
 * Whether the engram call carrying the next hotmemo reports its own hook event
 * as memory_read / memory_write. engram_status does not normalize to either,
 * so after a status delivery the next memory event is the agent's own.
 */
let _carrierObserved = true;

export function setDeliveryCarrier(observedAsMemoryEvent: boolean): void {
  _carrierObserved = observedAsMemoryEvent;
}

/** A recommendation or executor result reached the agent via hotmemo. */
export function noteDelivered(method: string, text: string): void {
  const rule: Rule = MESSAGE_RULES[method] ?? "paths";
  const touched = new Set(_recentTouched);
  const candidates = new Set([...extractBasenames(text)].filter(b => !touched.has(b)));
  _open.push({
    method, rule,
    deliveredTs: Date.now(),
    seen: 0,
    candidates,
    deliveryPattern: _pattern,
    swallowMemory: _carrierObserved,
  });
}

// ---- Observation ----

/** Feed every normalized event, with the pattern after recording it. */
export function observeEvent(event: NormalizedEvent, pattern: PatternKind): void {
  _pattern = pattern;
  if (event.action === "user_prompt") return;

  const base = event.result !== "failure" &&
    (event.action === "file_read" || event.action === "file_edit") &&
    event.path ? basename(event.path) : undefined;

  const still: Open[] = [];
  for (const o of _open) {
    if (o.swallowMemory && (event.action === "memory_read" || event.action === "memory_write")) {
      o.swallowMemory = false;
      still.push(o);
      continue;
    }
    o.swallowMemory = false;
    o.seen++;

    const hit = matches(o, event, base);
    if (hit) {
      emit(o, "adopted", hit, o.seen);
    } else if (o.seen >= ADOPTION_WINDOW) {
      closeAtWindowEnd(o);
    } else {
      still.push(o);
    }
  }
  _open = still;

  if (base) {
    _recentTouched.push(base);
    if (_recentTouched.length > ADOPTION_WINDOW) _recentTouched.shift();
  }
}

function matches(o: Open, event: NormalizedEvent, base: string | undefined): string | null {
  switch (o.rule) {
    case "paths":
      return base && o.candidates.has(base) ? `touched ${base}` : null;
    case "push":
    case "push_or_stop":
      // engram_flag also normalizes to memory_write; rare enough to accept.
      return event.action === "memory_write" ? "memory_write" : null;
    case "leave_trial_error":
      return null; // judged only at window end
  }
}

function closeAtWindowEnd(o: Open): void {
  switch (o.rule) {
    case "paths":
      if (o.candidates.size === 0) emit(o, "undecidable", "no new path named");
      else emit(o, "ignored", `none of ${o.candidates.size} named paths touched`);
      return;
    case "leave_trial_error":
      if (o.deliveryPattern !== "trial_error") emit(o, "undecidable", `delivered during ${o.deliveryPattern}`);
      else if (_pattern !== "trial_error") emit(o, "adopted", `trial_error → ${_pattern}`, o.seen);
      else emit(o, "ignored", "still trial_error");
      return;
    case "push":
    case "push_or_stop":
      emit(o, "ignored", "no memory_write");
      return;
  }
}

/** Watch stopped: close every open window. */
export function closeAdoption(): void {
  for (const o of _open) {
    if (o.rule === "push_or_stop") emit(o, "adopted", "session ended", o.seen);
    else emit(o, "undecidable", `session ended after ${o.seen} events`);
  }
  _open = [];
}

export function clearAdoption(): void {
  _open = [];
  _pattern = "stagnation";
  _recentTouched = [];
  _carrierObserved = true;
}

// ---- Helpers ----

function emit(o: Open, verdict: Verdict, reason: string, after?: number): void {
  try {
    _sink({ ts: Date.now(), method: o.method, verdict, reason, ...(after !== undefined ? { after } : {}) });
  } catch {
    // observation must not crash the receptor
  }
}

function basename(p: string): string {
  const segs = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return (segs[segs.length - 1] ?? "").toLowerCase();
}

/** File-like tokens (name.ext) mentioned in a delivered text. */
export function extractBasenames(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/([\w-]+(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,5})\b/g)) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

const SINK_PATH = path.join(RECEPTOR_OUTPUT_DIR, "adoption.jsonl");

function fileSink(rec: AdoptionRecord): void {
  fs.mkdirSync(path.dirname(SINK_PATH), { recursive: true });
  fs.appendFileSync(SINK_PATH, JSON.stringify(rec) + "\n");
}
