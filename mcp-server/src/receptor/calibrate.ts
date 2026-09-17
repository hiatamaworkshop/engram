#!/usr/bin/env npx tsx
// ============================================================
// Receptor — Calibration Script (Phase 1: single-event evaluation)
// ============================================================
// Runs scenarios from calibration-scenarios.json through the emotion
// engine, compares actual output with expected (y), and computes
// per-axis learnedDelta corrections.
//
// Usage:  npx tsx src/receptor/calibrate.ts [--dry-run] [--verbose]
//
// Output: writes receptor-calibrated.json (unless --dry-run) — the base only.
// learn.ts's residual lives in receptor-output/learned-delta.json and is
// never touched here (delta.ts).

import { EmotionAccumulator, computeImpulse } from "./emotion.js";
import { normalize, type RawHookEvent } from "./normalizer.js";
import type { EmotionVector, EmotionAxis, PatternKind } from "./types.js";
import { ZERO_EMOTION } from "./types.js";
import type { WindowSnapshot } from "./commander.js";
import scenarios from "./calibration-scenarios.json" with { type: "json" };
import { DELTA_BOUND, clampDelta, calibratedDelta, loadLearnedDelta } from "./delta.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- CLI flags ----

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const VERBOSE = args.includes("--verbose");

// ---- Constants ----

const LEARNING_RATE = 0.5;  // how aggressively to correct
const CALIBRATION_AXES: EmotionAxis[] = [
  "frustration", "seeking", "confidence", "fatigue",
];
// flow excluded — A gate invariant

// ---- Types ----

interface ScenarioDef {
  id: string;
  description: string;
  pattern: string;
  events: RawHookEvent[];
  expected: Record<string, number>;
}

interface ScenarioResult {
  id: string;
  actual: EmotionVector;
  expected: Record<string, number>;
  errors: Record<string, number>;
}

// ---- Simulation ----

/**
 * Run a single scenario through a fresh EmotionAccumulator.
 * Returns the final emotion vector after all events.
 */
function simulate(scenario: ScenarioDef): EmotionVector {
  const acc = new EmotionAccumulator();
  const intervalMs = (scenarios as { intervalMs: number }).intervalMs ?? 5000;
  let ts = Date.now();

  // Synthetic WindowSnapshot — pattern is declared per-scenario
  const snap: WindowSnapshot = {
    counts: {} as Record<string, number>,
    total: scenario.events.length,
    pattern: scenario.pattern as PatternKind,
    bashFailRate: 0,
    editBashAlternation: 0,
    turns: 0,
    toolsPerTurn: 0,
  };

  const sessionMeta = {
    totalEvents: scenario.events.length,
    elapsedMs: scenario.events.length * intervalMs,
  };

  for (const rawEvent of scenario.events) {
    const event = normalize(rawEvent);
    if (!event) continue;

    // Override timestamp with synthetic time
    (event as { ts: number }).ts = ts;

    const impulse = computeImpulse(snap, sessionMeta, event);
    acc.update(impulse, ts);

    ts += intervalMs;
  }

  return acc.values;
}

// ---- Run all scenarios ----

function runAll(): ScenarioResult[] {
  const defs = (scenarios as { scenarios: ScenarioDef[] }).scenarios;
  const results: ScenarioResult[] = [];

  for (const scenario of defs) {
    const actual = simulate(scenario);
    const errors: Record<string, number> = {};

    for (const axis of CALIBRATION_AXES) {
      const exp = scenario.expected[axis] ?? 0;
      const act = actual[axis];
      // positive error = actual too low (need more sensitivity)
      // negative error = actual too high (need less sensitivity)
      errors[axis] = exp - act;
    }

    results.push({ id: scenario.id, actual, expected: scenario.expected, errors });
  }

  return results;
}

// ---- Delta computation ----

function computeDeltas(results: ScenarioResult[]): Record<string, number> {
  const newDelta: Record<string, number> = {};

  for (const axis of CALIBRATION_AXES) {
    // Mean error across all scenarios
    const meanError = results.reduce((sum, r) => sum + (r.errors[axis] ?? 0), 0) / results.length;

    // Phase 1: compute from zero (idempotent — same scenarios always produce same δ)
    const updated = meanError * LEARNING_RATE;

    // Clamp to bounds, round to 3 decimal places
    newDelta[axis] = Math.round(Math.max(-DELTA_BOUND, Math.min(DELTA_BOUND, updated)) * 1000) / 1000;
  }

  return newDelta;
}

// ---- Output ----

function printResults(results: ScenarioResult[], newDelta: Record<string, number>): void {
  console.log("=== Calibration Phase 1: Single-Event Evaluation ===\n");

  for (const r of results) {
    console.log(`[${r.id}]`);
    for (const axis of CALIBRATION_AXES) {
      const act = r.actual[axis].toFixed(3);
      const exp = (r.expected[axis] ?? 0).toFixed(3);
      const err = (r.errors[axis] ?? 0).toFixed(3);
      const marker = Math.abs(r.errors[axis] ?? 0) > 0.1 ? " <<<" : "";
      console.log(`  ${axis.padEnd(12)} actual=${act}  expected=${exp}  error=${err}${marker}`);
    }
    console.log();
  }

  console.log("--- Calibrated delta update ---");
  const currentDelta = calibratedDelta();
  for (const axis of CALIBRATION_AXES) {
    const prev = (currentDelta[axis] ?? 0).toFixed(3);
    const next = newDelta[axis].toFixed(3);
    const change = prev !== next ? ` (${prev} → ${next})` : " (unchanged)";
    console.log(`  ${axis.padEnd(12)} δ = ${next}${change}`);
  }

  const learnedNow = loadLearnedDelta();
  console.log(`\n--- Effective after write (calibrated + learned residual) ---`);
  for (const axis of CALIBRATION_AXES) {
    const eff = clampDelta(newDelta[axis] + (learnedNow[axis] ?? 0));
    console.log(`  ${axis.padEnd(12)} ${eff.toFixed(3)}  (learned ${(learnedNow[axis] ?? 0).toFixed(3)})`);
  }
  if (Object.keys(learnedNow).length === 0) console.log("  (no learned residual yet)");
  console.log();
}

function writeDelta(newDelta: Record<string, number>): void {
  const output = {
    $schema: "Calibrated delta per emotion axis (base). Written by calibrate.ts from calibration-scenarios.json. learn.ts adds a residual on top (receptor-output/learned-delta.json). Bounds: ±0.30. Flow excluded (A gate invariant).",
    delta: newDelta,
  };

  const filePath = path.join(import.meta.dirname!, "receptor-calibrated.json");
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2) + "\n");
  console.log(`✓ Written to ${filePath}`);
}

// ---- Main ----

function main(): void {
  const results = runAll();
  const newDelta = computeDeltas(results);

  printResults(results, newDelta);

  if (DRY_RUN) {
    console.log("(dry-run — no file written)");
  } else {
    writeDelta(newDelta);
    console.log("\nRebuild (npx tsc) and restart MCP server for changes to take effect.");
  }
}

main();
