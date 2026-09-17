// ============================================================
// Adoption observer — Unit Tests
// ============================================================
// Run: npx tsx --test src/receptor/adoption.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedEvent, NormalizedAction, PatternKind } from "./types.js";
import {
  ADOPTION_WINDOW, noteDelivered, observeEvent, closeAdoption, clearAdoption,
  setAdoptionSink, extractBasenames, type AdoptionRecord,
} from "./adoption.js";

let log: AdoptionRecord[] = [];
let id = 0;

const ev = (action: NormalizedAction, p?: string, result: NormalizedEvent["result"] = "success"): NormalizedEvent =>
  ({ eventId: ++id, action, path: p, result, ts: Date.now() });

function feed(n: number, e: () => NormalizedEvent, pattern: PatternKind = "exploration") {
  for (let i = 0; i < n; i++) observeEvent(e(), pattern);
}

beforeEach(() => {
  clearAdoption();
  log = [];
  setAdoptionSink((r) => log.push(r));
});

describe("extractBasenames", () => {
  it("keeps multi-dot names whole and ignores numbers", () => {
    const b = extractBasenames('[{"path":"src/receptor/hook-payload.test.ts"}] score 0.85 v1.2');
    assert.deepEqual([...b], ["hook-payload.test.ts"]);
  });
});

describe("paths rule (executor results)", () => {
  it("touching a named path within the window is adopted", () => {
    noteDelivered("engram_probe_light", "see src/receptor/emotion.ts for decay");
    observeEvent(ev("memory_read"), "exploration"); // the delivering engram call
    observeEvent(ev("search", "decay"), "exploration");
    observeEvent(ev("file_read", "C:\\repo\\src\\receptor\\emotion.ts"), "exploration");
    assert.equal(log.length, 1);
    assert.equal(log[0].verdict, "adopted");
    assert.equal(log[0].after, 2);
  });

  it("a path already being read before delivery proves nothing", () => {
    observeEvent(ev("file_read", "src/emotion.ts"), "exploration");
    noteDelivered("path_suggest", '[{"path":"src/emotion.ts"}]');
    feed(ADOPTION_WINDOW, () => ev("file_read", "src/emotion.ts"));
    assert.equal(log[0].verdict, "undecidable");
  });

  it("failed reads do not count as touching", () => {
    noteDelivered("engram_probe", "fix is in normalizer.ts");
    feed(ADOPTION_WINDOW, () => ev("file_read", "normalizer.ts", "failure"));
    assert.equal(log[0].verdict, "ignored");
  });
});

describe("message rules", () => {
  it("push reminder: the delivering call's own event is not the push", () => {
    noteDelivered("engram_push_reminder", "confidence high");
    observeEvent(ev("memory_write"), "implementation");
    assert.equal(log.length, 0);
    observeEvent(ev("memory_write"), "implementation");
    assert.equal(log[0].verdict, "adopted");
  });

  it("frustration alert: leaving trial_error is adopted", () => {
    observeEvent(ev("shell_exec"), "trial_error");
    noteDelivered("frustration_alert", "frustration sustained");
    feed(ADOPTION_WINDOW - 1, () => ev("shell_exec"), "trial_error");
    feed(1, () => ev("file_read", "a.ts"), "exploration");
    assert.equal(log[0].verdict, "adopted");
  });

  it("frustration alert outside trial_error is undecidable", () => {
    observeEvent(ev("file_read", "a.ts"), "exploration");
    noteDelivered("frustration_alert", "frustration sustained");
    feed(ADOPTION_WINDOW, () => ev("shell_exec"), "trial_error");
    assert.equal(log[0].verdict, "undecidable");
  });

  it("user prompts do not advance the window", () => {
    noteDelivered("engram_push_reminder", "confidence high");
    feed(ADOPTION_WINDOW * 2, () => ev("user_prompt"));
    assert.equal(log.length, 0);
  });

  it("session end: fatigue warning adopted, others undecidable", () => {
    noteDelivered("fatigue_warning", "fatigue accumulating");
    noteDelivered("engram_push_reminder", "confidence high");
    closeAdoption();
    assert.deepEqual(log.map(r => [r.method, r.verdict]), [
      ["fatigue_warning", "adopted"],
      ["engram_push_reminder", "undecidable"],
    ]);
  });
});
