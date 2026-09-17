// Run: npx tsx --test src/receptor/labels.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { FireSignal, NormalizedEvent } from "./types.js";
import { ZERO_EMOTION } from "./types.js";
import {
  isAgentVisible, sampleForLabel, recordForLabel, clearLabelSampler, setLabelSampleSink,
  summarize, unlabeled, type DispatchedMethod, type LabelSample, type LabelRecord,
} from "./labels.js";

const notify: DispatchedMethod = { id: "frustration_alert", mode: "notify", action: {} };
const fileOnly: DispatchedMethod = { id: "path_suggest", mode: "auto", action: { output: { targets: ["file"] } } };
const sig: FireSignal = {
  kind: "frustration_spike", intensity: 0.71234, ts: 0,
  emotion: { ...ZERO_EMOTION, frustration: 0.7 }, agentState: "stuck", pattern: "trial_error",
};

let out: LabelSample[] = [];
beforeEach(() => {
  clearLabelSampler();
  out = [];
  setLabelSampleSink((s) => out.push(s));
});

describe("sampler", () => {
  it("visibility follows mode and output targets", () => {
    assert.equal(isAgentVisible(notify), true);
    assert.equal(isAgentVisible(fileOnly), false);
    assert.equal(isAgentVisible({ id: "x", mode: "auto", action: {} }), true); // router default hotmemo
    assert.equal(isAgentVisible({ id: "fp", mode: "background", action: { output: { targets: ["subsystem", "log"] } } }), true);
  });

  it("ignores dispatches the agent never sees", () => {
    sampleForLabel([fileOnly], [sig]);
    assert.equal(out.length, 0);
  });

  it("samples 1 in 5 visible dispatches, capped at 10", () => {
    for (let i = 0; i < 100; i++) sampleForLabel([notify, fileOnly], [sig]);
    assert.equal(out.length, 10);
    assert.deepEqual(out[0].methods, ["frustration_alert"]);
  });

  it("keeps the last 20 events with their paths", () => {
    for (let i = 1; i <= 25; i++) {
      recordForLabel({ eventId: i, action: "shell_exec", path: `cmd ${i}`, result: "success", ts: 0 } as NormalizedEvent);
    }
    sampleForLabel([notify], [sig]);
    assert.equal(out[0].events.length, 20);
    assert.equal(out[0].events[0].eventId, 6);
    assert.equal(out[0].signals[0].intensity, 0.712);
  });
});

describe("labels", () => {
  const rec = (id: string, over: boolean): LabelRecord => ({
    id, labeledAt: 0,
    axes: { frustration: over ? "over" : "ok" },
    signals: { frustration_spike: !over },
    failures: { "3": false },
  });

  it("unlabeled excludes labeled ids", () => {
    const samples = [{ id: "a" }, { id: "b" }] as LabelSample[];
    assert.deepEqual(unlabeled(samples, [rec("a", true)]).map(s => s.id), ["b"]);
  });

  it("summarize counts direction per axis, signal validity, failure truth", () => {
    const s = summarize([rec("a", true), rec("b", false)]);
    assert.deepEqual(s.axes.frustration, { over: 1, ok: 1, under: 0 });
    assert.deepEqual(s.axes.seeking, { over: 0, ok: 0, under: 0 });
    assert.deepEqual(s.signals.frustration_spike, { valid: 1, invalid: 1 });
    assert.deepEqual(s.failures, { real: 0, notReal: 2 });
  });
});
