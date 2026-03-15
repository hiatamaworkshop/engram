#!/usr/bin/env npx tsx
// ============================================================
// Receptor — Scenario Simulator (time-aware)
// ============================================================
// Feeds synthetic event sequences with simulated timestamps.
// Overrides Date.now() to control time progression.
//
// Usage: npx tsx src/receptor/simulate.ts [scenario]
// Scenarios: exploration, trial_error, implementation, mixed

import { setWatch, ingestEvent, formatState, registerExecutor } from "./index.js";
import { formatRecommendations, drainRecommendations, formatAutoResults, drainAutoResults } from "./passive.js";
import type { RawHookEvent } from "./normalizer.js";
import type { OutputConfig } from "./output-router.js";
import { routeOutput } from "./output-router.js";

// ---- Mock executors ----
// Register mock executors so the full pipeline (fire → dispatch → execute → output) is testable.

registerExecutor("engram_pull", {
  type: "internal",
  handler: async (method, context) => {
    const query = context.topPaths.map(p => p.split("/").slice(-2).join("/")).join(" ");
    const mockResult = `[mock] engram_pull query="${query}" (${context.agentState})`;
    routeOutput({
      methodId: method.id,
      toolName: "engram_pull",
      agentState: context.agentState,
      raw: mockResult,
      output: method.action.output as OutputConfig | undefined,
    });
    console.error(`  >> EXECUTOR: ${mockResult}`);
  },
});

registerExecutor("engram_context_push", {
  type: "internal",
  handler: async (method, context) => {
    const summary = `state=${context.agentState} paths=[${context.topPaths.slice(0, 3).join(",")}]`;
    const mockResult = `[mock] engram_context_push: ${summary}`;
    routeOutput({
      methodId: method.id,
      toolName: "engram_context_push",
      agentState: context.agentState,
      raw: mockResult,
      output: method.action.output as OutputConfig | undefined,
    });
    console.error(`  >> EXECUTOR: ${mockResult}`);
  },
});

// ---- Time control ----
// Override Date.now() so all modules see our simulated time

let _simTime = Date.now();
const _realDateNow = Date.now.bind(Date);
Date.now = () => _simTime;

function advanceSec(sec: number): void {
  _simTime += sec * 1000;
}

// ---- Event factory ----

function ev(tool: string, opts?: { exit_code?: number; path?: string; resultCount?: number }): RawHookEvent {
  return {
    tool_name: tool,
    tool_input: {
      file_path: opts?.path,
      path: opts?.path,
      resultCount: opts?.resultCount,
    },
    exit_code: opts?.exit_code,
  };
}

// ---- Scenarios ----

interface ScenarioEvent {
  raw: RawHookEvent;
  delaySec?: number;  // seconds to advance BEFORE this event (default: 10)
  label?: string;
}

interface Scenario {
  name: string;
  description: string;
  events: ScenarioEvent[];
}

const scenarios: Record<string, Scenario> = {
  // Exploration: lots of reading and searching, no edits
  exploration: {
    name: "exploration",
    description: "Agent reading/searching codebase — should trigger hunger/uncertainty",
    events: [
      { raw: ev("Read", { path: "src/index.ts" }), label: "read index", delaySec: 0 },
      { raw: ev("Grep", { path: "src/", resultCount: 5 }), label: "grep results" },
      { raw: ev("Read", { path: "src/types.ts" }), label: "read types" },
      { raw: ev("Grep", { path: "src/", resultCount: 0 }), label: "grep empty" },
      { raw: ev("Read", { path: "src/utils.ts" }), label: "read utils" },
      { raw: ev("Glob", { path: "src/**/*.ts", resultCount: 12 }), label: "glob" },
      { raw: ev("Read", { path: "src/config.ts" }), label: "read config" },
      { raw: ev("Read", { path: "src/server.ts" }), label: "read server" },
      { raw: ev("Grep", { path: "src/", resultCount: 3 }), label: "grep results" },
      { raw: ev("Read", { path: "docs/README.md" }), label: "read docs" },
      { raw: ev("engram_pull"), label: "engram pull (memory search)" },
      { raw: ev("Read", { path: "src/handler.ts" }), label: "read handler" },
    ],
  },

  // Trial-and-error: edit → bash fail → edit → bash fail...
  trial_error: {
    name: "trial_error",
    description: "Agent stuck in edit-fail loop — should trigger frustration spike",
    events: [
      { raw: ev("Read", { path: "src/main.ts" }), label: "read file", delaySec: 0 },
      { raw: ev("Edit", { path: "src/main.ts" }), label: "edit attempt 1", delaySec: 15 },
      { raw: ev("Bash", { exit_code: 1 }), label: "bash FAIL", delaySec: 5 },
      { raw: ev("Edit", { path: "src/main.ts" }), label: "edit attempt 2", delaySec: 20 },
      { raw: ev("Bash", { exit_code: 1 }), label: "bash FAIL", delaySec: 5 },
      { raw: ev("Edit", { path: "src/main.ts" }), label: "edit attempt 3", delaySec: 15 },
      { raw: ev("Bash", { exit_code: 1 }), label: "bash FAIL", delaySec: 5 },
      { raw: ev("Grep", { resultCount: 0 }), label: "grep empty (desperate)", delaySec: 30 },
      { raw: ev("Edit", { path: "src/main.ts" }), label: "edit attempt 4", delaySec: 20 },
      { raw: ev("Bash", { exit_code: 1 }), label: "bash FAIL", delaySec: 5 },
      { raw: ev("Edit", { path: "src/main.ts" }), label: "edit attempt 5", delaySec: 15 },
      { raw: ev("Bash", { exit_code: 0 }), label: "bash SUCCESS (finally)", delaySec: 5 },
    ],
  },

  // Implementation: edit+bash succeeding, productive flow
  implementation: {
    name: "implementation",
    description: "Agent in productive implementation — should trigger flow/confidence",
    events: [
      { raw: ev("Read", { path: "src/feature.ts" }), label: "read target file", delaySec: 0 },
      { raw: ev("Edit", { path: "src/feature.ts" }), label: "edit feature", delaySec: 20 },
      { raw: ev("Bash", { exit_code: 0 }), label: "bash OK (build)", delaySec: 5 },
      { raw: ev("Edit", { path: "src/feature.ts" }), label: "edit more", delaySec: 30 },
      { raw: ev("Bash", { exit_code: 0 }), label: "bash OK (test)", delaySec: 5 },
      { raw: ev("Edit", { path: "src/feature.ts" }), label: "edit refinement", delaySec: 20 },
      { raw: ev("Edit", { path: "src/types.ts" }), label: "edit types", delaySec: 15 },
      { raw: ev("Bash", { exit_code: 0 }), label: "bash OK (build)", delaySec: 5 },
      { raw: ev("Edit", { path: "src/feature.ts" }), label: "edit final", delaySec: 25 },
      { raw: ev("Bash", { exit_code: 0 }), label: "bash OK (all tests)", delaySec: 10 },
      { raw: ev("Edit", { path: "src/index.ts" }), label: "wire up", delaySec: 15 },
      { raw: ev("Bash", { exit_code: 0 }), label: "bash OK (final)", delaySec: 5 },
    ],
  },

  // Mixed: exploration → trial_error → recovery → flow
  // Time gaps between phases simulate real work (~6 min per phase)
  mixed: {
    name: "mixed",
    description: "Realistic session: explore → get stuck → recover → flow",
    events: [
      // Phase 1: exploration (~2 min)
      { raw: ev("Read", { path: "src/main.ts" }), label: "[explore] read", delaySec: 0 },
      { raw: ev("Grep", { resultCount: 3 }), label: "[explore] grep", delaySec: 15 },
      { raw: ev("Read", { path: "src/config.ts" }), label: "[explore] read", delaySec: 20 },
      { raw: ev("Grep", { resultCount: 0 }), label: "[explore] grep empty", delaySec: 10 },

      // Phase 2: trial-and-error (~5 min)
      { raw: ev("Edit", { path: "src/main.ts" }), label: "[stuck] edit 1", delaySec: 30 },
      { raw: ev("Bash", { exit_code: 1 }), label: "[stuck] FAIL", delaySec: 5 },
      { raw: ev("Edit", { path: "src/main.ts" }), label: "[stuck] edit 2", delaySec: 25 },
      { raw: ev("Bash", { exit_code: 1 }), label: "[stuck] FAIL", delaySec: 5 },
      { raw: ev("Edit", { path: "src/main.ts" }), label: "[stuck] edit 3", delaySec: 20 },
      { raw: ev("Bash", { exit_code: 1 }), label: "[stuck] FAIL", delaySec: 5 },
      { raw: ev("Edit", { path: "src/main.ts" }), label: "[stuck] edit 4", delaySec: 20 },
      { raw: ev("Bash", { exit_code: 1 }), label: "[stuck] FAIL", delaySec: 5 },

      // Phase 3: recovery (~2 min) — some time gap (thinking/reading docs)
      { raw: ev("Grep", { resultCount: 5 }), label: "[recover] grep found", delaySec: 60 },
      { raw: ev("Read", { path: "src/helper.ts" }), label: "[recover] read", delaySec: 15 },
      { raw: ev("Edit", { path: "src/main.ts" }), label: "[recover] edit fix", delaySec: 30 },
      { raw: ev("Bash", { exit_code: 0 }), label: "[recover] SUCCESS", delaySec: 5 },

      // Phase 4: flow (~6 min — enough for stuck events to fall off 5-min window)
      { raw: ev("Edit", { path: "src/main.ts" }), label: "[flow] edit", delaySec: 20 },
      { raw: ev("Bash", { exit_code: 0 }), label: "[flow] OK", delaySec: 5 },
      { raw: ev("Edit", { path: "src/test.ts" }), label: "[flow] test edit", delaySec: 25 },
      { raw: ev("Bash", { exit_code: 0 }), label: "[flow] tests pass", delaySec: 5 },
      { raw: ev("Edit", { path: "src/main.ts" }), label: "[flow] polish", delaySec: 20 },
      { raw: ev("Bash", { exit_code: 0 }), label: "[flow] OK", delaySec: 5 },
      { raw: ev("Edit", { path: "src/feature.ts" }), label: "[flow] new feature", delaySec: 30 },
      { raw: ev("Bash", { exit_code: 0 }), label: "[flow] OK", delaySec: 5 },
      { raw: ev("Edit", { path: "src/feature.ts" }), label: "[flow] iterate", delaySec: 25 },
      { raw: ev("Bash", { exit_code: 0 }), label: "[flow] OK", delaySec: 5 },
      { raw: ev("Edit", { path: "src/test.ts" }), label: "[flow] test", delaySec: 20 },
      { raw: ev("Bash", { exit_code: 0 }), label: "[flow] all pass", delaySec: 5 },
    ],
  },
};

// ---- Runner ----

function run(scenarioName: string) {
  const scenario = scenarios[scenarioName];
  if (!scenario) {
    console.error(`Unknown scenario: ${scenarioName}`);
    console.error(`Available: ${Object.keys(scenarios).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Scenario: ${scenario.name}`);
  console.log(scenario.description);
  console.log("=".repeat(60));

  // Start watch
  _simTime = _realDateNow();
  const start = setWatch(true);
  console.log(`\n${start.message}\n`);

  let totalElapsed = 0;

  // Feed events
  for (let i = 0; i < scenario.events.length; i++) {
    const { raw, label, delaySec = 10 } = scenario.events[i];
    advanceSec(delaySec);
    totalElapsed += delaySec;

    const mins = Math.floor(totalElapsed / 60);
    const secs = totalElapsed % 60;
    const timeStr = `${mins}:${String(secs).padStart(2, "0")}`;
    console.log(`--- [${timeStr}] Event ${i + 1}/${scenario.events.length}: ${label ?? raw.tool_name} ---`);
    ingestEvent(raw);
    console.log(formatState());

    // Show receptor outputs (notify recommendations + auto results)
    const recs = formatRecommendations();
    if (recs) {
      console.log(`\n  ★ NOTIFY: ${recs}`);
      drainRecommendations();
    }
    const auto = formatAutoResults();
    if (auto) {
      console.log(`\n  ★ AUTO: ${auto}`);
      drainAutoResults();
    }
    console.log("");
  }

  // Stop watch
  const stop = setWatch(false);
  console.log(stop.message);
}

// ---- Main ----

const scenarioName = process.argv[2] ?? "mixed";
run(scenarioName);