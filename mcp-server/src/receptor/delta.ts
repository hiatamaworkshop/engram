// ============================================================
// Receptor — Sensitivity delta (calibrated base + learned residual)
// ============================================================
// Two writers, two files, never the same one:
//
//   calibrated  src/receptor/receptor-calibrated.json   calibrate.ts (developer,
//               committed, recomputed from scenarios)
//   learned     receptor-output/learned-delta.json       learn.ts (this environment,
//               runtime data — outside dist so a rebuild cannot wipe it)
//
// effective = clamp(calibrated + learned, ±DELTA_BOUND)
//
// Before this split both wrote receptor-learned.json: calibrate recomputed from
// zero and silently erased whatever learn mode had accumulated, and learn wrote
// into dist/, which the next `npm run build` overwrote.

import * as fs from "node:fs";
import * as path from "node:path";
import calibratedFile from "./receptor-calibrated.json" with { type: "json" };

export const DELTA_BOUND = 0.30;

export type Delta = Record<string, number>;

export const LEARNED_DELTA_PATH = path.join(
  process.env.ENGRAM_DATA_DIR ?? path.join(import.meta.dirname ?? ".", ".."),
  "receptor-output",
  "learned-delta.json",
);

export function clampDelta(v: number): number {
  return Math.max(-DELTA_BOUND, Math.min(DELTA_BOUND, v));
}

export function calibratedDelta(): Delta {
  return { ...(calibratedFile as { delta: Delta }).delta };
}

/** Learned residual. Empty when learn mode has never completed a session. */
export function loadLearnedDelta(): Delta {
  try {
    const raw = JSON.parse(fs.readFileSync(LEARNED_DELTA_PATH, "utf-8")) as { delta?: Delta };
    return raw.delta ?? {};
  } catch {
    return {};
  }
}

export function saveLearnedDelta(delta: Delta): void {
  fs.mkdirSync(path.dirname(LEARNED_DELTA_PATH), { recursive: true });
  fs.writeFileSync(LEARNED_DELTA_PATH, JSON.stringify({
    $schema: "Learned residual per emotion axis, added on top of receptor-calibrated.json. Written by learn.ts.",
    delta,
  }, null, 2) + "\n");
}

/** What the passive receptor actually applies. */
export function effectiveDelta(learned: Delta = loadLearnedDelta()): Delta {
  const cal = calibratedDelta();
  const out: Delta = {};
  for (const axis of new Set([...Object.keys(cal), ...Object.keys(learned)])) {
    out[axis] = Math.round(clampDelta((cal[axis] ?? 0) + (learned[axis] ?? 0)) * 1000) / 1000;
  }
  return out;
}
