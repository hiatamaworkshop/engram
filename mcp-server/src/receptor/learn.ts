// ============================================================
// Receptor — Learned Delta Auto-Learning (pure math, no LLM inference)
// ============================================================
// Adjusts receptor sensitivity per emotion axis based on session fire frequency.
// Opt-in via engram_watch start (learn: true).
//
// Concept: learned delta controls reception sensitivity — whether a scored
// method is accepted or rejected. This tunes the frequency of acceptance,
// not the quality of outcomes.

import * as fs from "node:fs";
import * as path from "node:path";
import type { EmotionAxis } from "./types.js";

// ---- Paths ----

const LEARNED_PATH = path.join(import.meta.dirname!, "receptor-learned.json");
const OUTPUT_DIR = path.join(
  process.env.ENGRAM_DATA_DIR ?? path.join(import.meta.dirname!, ".."),
  "receptor-output",
);
const SESSION_POINTS_PATH = path.join(OUTPUT_DIR, "session-points.jsonl");
const EMA_PATH = path.join(OUTPUT_DIR, "learn-ema.json");

// ---- Constants ----

const AXES: EmotionAxis[] = ["frustration", "seeking", "confidence", "fatigue"];
// flow excluded — A gate invariant

const DELTA_BOUND = 0.30;
const ALPHA = 0.03;       // learning rate (conservative — max ~0.03 change per session)
const EMA_BETA = 0.3;     // EMA smoothing for expected frequency (0.3 = recent-weighted)
const MIN_SESSION_MS = 300_000; // 5 min minimum session for learning

// ---- Signal label → primary emotion axis mapping ----
// Duplicated from passive.ts to avoid cross-module coupling

const LABEL_TO_AXES: Record<string, EmotionAxis[]> = {
  frustration_spike:            ["frustration"],
  seeking_spike:                ["seeking"],
  compound_frustration_seeking: ["frustration", "seeking"],
  confidence_sustained:         ["confidence"],
  fatigue_rising:               ["fatigue"],
  // flow_active excluded — A gate invariant
};

// ---- Types ----

interface EmaState {
  freq: Record<string, number>;  // expected fires/hour per axis
  sessions: number;              // number of sessions contributing
}

interface LearnedFile {
  $schema: string;
  delta: Record<string, number>;
}

// ---- Core ----

/**
 * Apply learned delta adjustment from this session's fire patterns.
 * Called on setWatch(false) when learn mode is active.
 * Returns summary string or null if session was too short.
 */
export function applyLearnedDelta(sessionDurationMs: number): string | null {
  if (sessionDurationMs < MIN_SESSION_MS) {
    console.error("[learn] session too short for learning:", Math.round(sessionDurationMs / 1000), "s");
    return null;
  }

  // 1. Read session points
  let lines: string[];
  try {
    const raw = fs.readFileSync(SESSION_POINTS_PATH, "utf-8").trim();
    if (!raw) return null;
    lines = raw.split("\n");
  } catch {
    console.error("[learn] no session-points.jsonl found");
    return null;
  }

  // 2. Count fires per axis
  const fireCounts: Record<string, number> = {};
  for (const axis of AXES) fireCounts[axis] = 0;

  for (const line of lines) {
    try {
      const point = JSON.parse(line) as { label: string };
      const axes = LABEL_TO_AXES[point.label];
      if (axes) {
        for (const axis of axes) {
          fireCounts[axis] = (fireCounts[axis] ?? 0) + 1;
        }
      }
    } catch { /* skip malformed lines */ }
  }

  // 3. Compute actual frequency (fires/hour)
  const sessionHours = sessionDurationMs / 3_600_000;
  const actualFreq: Record<string, number> = {};
  for (const axis of AXES) {
    actualFreq[axis] = (fireCounts[axis] ?? 0) / sessionHours;
  }

  // 4. Load or initialize EMA
  let ema: EmaState;
  try {
    ema = JSON.parse(fs.readFileSync(EMA_PATH, "utf-8")) as EmaState;
  } catch {
    // First session — initialize EMA to actual (no deviation on first run)
    ema = { freq: { ...actualFreq }, sessions: 0 };
  }

  // 5. Load current delta
  let learned: LearnedFile;
  try {
    learned = JSON.parse(fs.readFileSync(LEARNED_PATH, "utf-8")) as LearnedFile;
  } catch {
    learned = {
      $schema: "Learned delta per emotion axis. Adjusts passive receptor sensitivity. Bounds: ±0.30. Flow excluded (A gate invariant).",
      delta: {},
    };
  }

  // 6. Compute deviation and update delta per axis
  const changes: string[] = [];

  for (const axis of AXES) {
    const actual = actualFreq[axis] ?? 0;
    const expected = ema.freq[axis] ?? actual;

    // Normalized deviation: (actual - expected) / max(expected, 1.0)
    const deviation = (actual - expected) / Math.max(expected, 1.0);

    const oldDelta = learned.delta[axis] ?? 0;
    // Negative sign: firing too much → decrease delta (lower sensitivity)
    const newDelta = Math.max(-DELTA_BOUND, Math.min(DELTA_BOUND,
      oldDelta - ALPHA * deviation,
    ));

    const rounded = Math.round(newDelta * 1000) / 1000;
    if (rounded !== Math.round(oldDelta * 1000) / 1000) {
      const sign = rounded > oldDelta ? "+" : "";
      changes.push(`${axis.substring(0, 4)}:${sign}${(rounded - oldDelta).toFixed(3)}`);
    }
    learned.delta[axis] = rounded;

    // Update EMA
    ema.freq[axis] = EMA_BETA * actual + (1 - EMA_BETA) * (ema.freq[axis] ?? actual);
  }

  ema.sessions++;

  // 7. Write back
  try {
    fs.writeFileSync(LEARNED_PATH, JSON.stringify(learned, null, 2) + "\n");
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(EMA_PATH, JSON.stringify(ema, null, 2) + "\n");
  } catch (err) {
    console.error("[learn] write error:", err);
    return null;
  }

  if (changes.length === 0) {
    console.error("[learn] no delta changes (stable)");
    return "learn: stable";
  }

  const summary = `learn: ${changes.join(" ")}`;
  console.error(`[learn] ${summary} (session ${ema.sessions})`);
  return summary;
}
