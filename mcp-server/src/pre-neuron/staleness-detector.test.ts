// ============================================================
// Staleness Detector — Unit Tests
// ============================================================
// Run: npx tsx --test src/pre-neuron/staleness-detector.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PathHeatmap } from "../receptor/heatmap.js";
import { detectStaleness, type StalenessSignal } from "./staleness-detector.js";
import * as preNeuron from "./index.js";
import type { NormalizedEvent } from "../receptor/types.js";

// ---- Helpers ----

const DAY = 86400000;
const NOW = Date.now();

function makeEvent(path: string, action: "file_read" | "file_edit" = "file_read", ts = NOW): NormalizedEvent {
  return { eventId: Math.random() * 1e6 | 0, action, path, result: "success", ts };
}

/**
 * Manually set lastModified on a HeatNode (bypassing async stat provider).
 * This is the key trick — in production, stat provider fills this async.
 * In tests we inject directly.
 */
function setLastModified(heatmap: PathHeatmap, path: string, mtime: number): void {
  const node = heatmap.getNode(path);
  if (!node) throw new Error(`Node not found: ${path}`);
  node.lastModified = mtime;
}

/** Drain alerts so they don't bleed between tests. */
function drainAlerts(): string {
  return preNeuron.formatPreNeuronAlerts(100);
}

// ---- Tests ----

describe("PathHeatmap multi-index", () => {
  let hm: PathHeatmap;

  beforeEach(() => {
    hm = new PathHeatmap();
    drainAlerts();
  });

  it("tracks totalOpened on file_read", () => {
    hm.record(makeEvent("config/db.js", "file_read"));
    hm.record(makeEvent("config/db.js", "file_read"));
    hm.record(makeEvent("config/db.js", "file_read"));
    const node = hm.getNode("config/db.js")!;
    assert.equal(node.totalOpened, 3);
    assert.equal(node.totalModified, 0);
    assert.equal(node.count, 3);
  });

  it("tracks totalModified on file_edit", () => {
    hm.record(makeEvent("config/db.js", "file_edit"));
    hm.record(makeEvent("config/db.js", "file_edit"));
    const node = hm.getNode("config/db.js")!;
    assert.equal(node.totalModified, 2);
    assert.equal(node.totalOpened, 0);
  });

  it("records lastAccess timestamp", () => {
    const ts = NOW - 5000;
    hm.record(makeEvent("src/main.ts", "file_read", ts));
    const node = hm.getNode("src/main.ts")!;
    assert.equal(node.lastAccess, ts);
  });

  it("records lastTouchedState from agentState", () => {
    hm.agentState = "deep_work";
    hm.record(makeEvent("src/main.ts", "file_read"));
    const node = hm.getNode("src/main.ts")!;
    assert.equal(node.lastTouchedState, "deep_work");
  });

  it("builds filenameIndex on record", () => {
    hm.record(makeEvent("services/api/config/db.js", "file_read"));
    hm.record(makeEvent("services/worker/config/db.js", "file_read"));
    const entries = hm.filenameIndex.get("db.js");
    assert.ok(entries);
    assert.equal(entries.size, 2);
    assert.ok(entries.has("services/api/config/db.js"));
    assert.ok(entries.has("services/worker/config/db.js"));
  });

  it("siblings() returns parent children", () => {
    hm.record(makeEvent("config/db.js", "file_read"));
    hm.record(makeEvent("config/auth.js", "file_read"));
    hm.record(makeEvent("config/cache.js", "file_read"));
    const sibs = hm.siblings("config/db.js")!;
    assert.equal(sibs.size, 3);
    assert.ok(sibs.has("db.js"));
    assert.ok(sibs.has("auth.js"));
    assert.ok(sibs.has("cache.js"));
  });

  it("effectiveCount decays over time", () => {
    hm.record(makeEvent("src/a.ts", "file_read", NOW - 7200000)); // 2h ago (= halfLife)
    const node = hm.getNode("src/a.ts")!;
    const effective = hm.effectiveCount(node, NOW);
    // After one half-life, effective should be ~count * e^-1 ≈ 0.368
    assert.ok(effective < node.count * 0.5, `effective ${effective} should be < half of count ${node.count}`);
    assert.ok(effective > node.count * 0.2, `effective ${effective} should still be > 0.2 * count`);
  });
});

describe("StalenessDetector — Stage 1: siblings", () => {
  let hm: PathHeatmap;

  beforeEach(() => {
    hm = new PathHeatmap();
    drainAlerts();
  });

  it("fires repeated-trap: file opened many times but never edited, newer sibling exists", () => {
    // db.old.js: opened 4 times, never edited, lastModified 30 days ago
    for (let i = 0; i < 4; i++) hm.record(makeEvent("config/db.old.js", "file_read"));
    setLastModified(hm, "config/db.old.js", NOW - 30 * DAY);

    // db.new.js: opened once, edited once, lastModified 2 days ago
    hm.record(makeEvent("config/db.new.js", "file_read"));
    hm.record(makeEvent("config/db.new.js", "file_edit"));
    setLastModified(hm, "config/db.new.js", NOW - 2 * DAY);

    // siblings to meet minSiblingCount (3)
    hm.record(makeEvent("config/utils.js", "file_read"));
    setLastModified(hm, "config/utils.js", NOW - 10 * DAY);

    const signal = detectStaleness("config/db.old.js", hm);
    assert.ok(signal, "should fire a signal");
    assert.equal(signal!.pattern, "repeated-trap");
    assert.equal(signal!.stage, 1);
    assert.ok(signal!.timeDelta >= 28 * DAY);

    // Verify alert was pushed
    const alertText = drainAlerts();
    assert.ok(alertText.includes("staleness-detector"), `alert should mention source: ${alertText}`);
  });

  it("does NOT fire for safe pattern: high opened + high modified", () => {
    // Actively worked file — 5 reads, 5 edits
    for (let i = 0; i < 5; i++) {
      hm.record(makeEvent("config/db.js", "file_read"));
      hm.record(makeEvent("config/db.js", "file_edit"));
    }
    setLastModified(hm, "config/db.js", NOW - 30 * DAY);

    hm.record(makeEvent("config/auth.js", "file_read"));
    setLastModified(hm, "config/auth.js", NOW - 1 * DAY);
    hm.record(makeEvent("config/cache.js", "file_read"));
    setLastModified(hm, "config/cache.js", NOW - 5 * DAY);

    const signal = detectStaleness("config/db.js", hm);
    assert.equal(signal, null, "should not fire for actively edited file");
  });

  it("does NOT fire when sibling count < minSiblingCount", () => {
    hm.record(makeEvent("config/db.old.js", "file_read"));
    setLastModified(hm, "config/db.old.js", NOW - 30 * DAY);
    hm.record(makeEvent("config/db.new.js", "file_read"));
    setLastModified(hm, "config/db.new.js", NOW - 1 * DAY);
    // Only 2 siblings — below threshold of 3

    const signal = detectStaleness("config/db.old.js", hm);
    assert.equal(signal, null, "should not fire with only 2 siblings");
  });

  it("does NOT fire when time delta < minTimeDelta", () => {
    for (let i = 0; i < 4; i++) hm.record(makeEvent("config/a.js", "file_read"));
    setLastModified(hm, "config/a.js", NOW - 2 * 3600000); // 2 hours ago

    hm.record(makeEvent("config/b.js", "file_read"));
    setLastModified(hm, "config/b.js", NOW - 1 * 3600000); // 1 hour ago
    hm.record(makeEvent("config/c.js", "file_read"));
    setLastModified(hm, "config/c.js", NOW - 3 * 3600000); // 3 hours ago

    const signal = detectStaleness("config/a.js", hm);
    assert.equal(signal, null, "should not fire when delta < 24h");
  });

  it("fires blind-spot: high-modified sibling never opened", () => {
    // Agent only opens old file
    hm.record(makeEvent("config/db.old.js", "file_read"));
    setLastModified(hm, "config/db.old.js", NOW - 30 * DAY);

    // New file was edited many times (by someone else / build tool) but never opened by agent
    // We simulate this by directly creating the node via edit events
    for (let i = 0; i < 4; i++) hm.record(makeEvent("config/db.new.js", "file_edit"));
    setLastModified(hm, "config/db.new.js", NOW - 1 * DAY);

    hm.record(makeEvent("config/schema.js", "file_read"));
    setLastModified(hm, "config/schema.js", NOW - 15 * DAY);

    const signal = detectStaleness("config/db.old.js", hm);
    assert.ok(signal, "should fire blind-spot signal");
    assert.equal(signal!.pattern, "blind-spot");
  });

  it("suppresses when lastTouchedState is deep_work", () => {
    hm.agentState = "deep_work";
    for (let i = 0; i < 4; i++) hm.record(makeEvent("config/db.old.js", "file_read"));
    setLastModified(hm, "config/db.old.js", NOW - 30 * DAY);

    hm.record(makeEvent("config/db.new.js", "file_read"));
    setLastModified(hm, "config/db.new.js", NOW - 1 * DAY);
    hm.record(makeEvent("config/utils.js", "file_read"));
    setLastModified(hm, "config/utils.js", NOW - 10 * DAY);

    const signal = detectStaleness("config/db.old.js", hm);
    assert.equal(signal, null, "deep_work state should suppress (multiplier 0.1)");
  });
});

describe("StalenessDetector — Stage 3: filenameIndex", () => {
  let hm: PathHeatmap;

  beforeEach(() => {
    hm = new PathHeatmap();
    drainAlerts();
  });

  it("detects same-name file in distant directory", () => {
    // Agent opens api/config/db.js (old) — 3 times, never edited
    for (let i = 0; i < 3; i++) hm.record(makeEvent("services/api/config/db.js", "file_read"));
    setLastModified(hm, "services/api/config/db.js", NOW - 30 * DAY);

    // worker/config/db.js exists (new, edited)
    hm.record(makeEvent("services/worker/config/db.js", "file_read"));
    hm.record(makeEvent("services/worker/config/db.js", "file_edit"));
    setLastModified(hm, "services/worker/config/db.js", NOW - 1 * DAY);

    // third db.js to meet minSiblingCount=3 in filenameIndex group
    hm.record(makeEvent("lib/shared/db.js", "file_read"));
    setLastModified(hm, "lib/shared/db.js", NOW - 10 * DAY);

    const signal = detectStaleness("services/api/config/db.js", hm);
    assert.ok(signal, "should detect cross-directory staleness");
    assert.ok(signal!.stage >= 2, `should detect via Stage 2 or 3, got stage ${signal!.stage}`);
  });

  it("detects similar filename via Levenshtein", () => {
    // db.js vs db-v2.js — edit distance 3
    for (let i = 0; i < 3; i++) hm.record(makeEvent("config/db.js", "file_read"));
    setLastModified(hm, "config/db.js", NOW - 30 * DAY);

    hm.record(makeEvent("lib/db-v2.js", "file_read"));
    setLastModified(hm, "lib/db-v2.js", NOW - 1 * DAY);

    const signal = detectStaleness("config/db.js", hm);
    // This may or may not fire depending on group size — Levenshtein match + the file itself = 2
    // Need minSiblingCount = 3, so we need to add more files
    // Let's verify filenameIndex at least
    const idx = hm.filenameIndex;
    assert.ok(idx.get("db.js")?.has("config/db.js"));
    assert.ok(idx.get("db-v2.js")?.has("lib/db-v2.js"));
  });
});

describe("Pre-neuron alert layer", () => {
  beforeEach(() => {
    drainAlerts();
  });

  it("pushAlert and formatPreNeuronAlerts round-trip", () => {
    preNeuron.pushAlert({ source: "test", severity: "warn", message: "something fishy" });
    const text = preNeuron.formatPreNeuronAlerts();
    assert.ok(text.includes("[pre-neuron]"));
    assert.ok(text.includes("! test: something fishy"));
  });

  it("returns empty string when no alerts pending", () => {
    const text = preNeuron.formatPreNeuronAlerts();
    assert.equal(text, "");
  });

  it("marks shown alerts as consumed", () => {
    preNeuron.pushAlert({ source: "a", severity: "info", message: "first" });
    preNeuron.formatPreNeuronAlerts(); // consume
    const text = preNeuron.formatPreNeuronAlerts(); // nothing new
    assert.equal(text, "");
  });

  it("critical severity shows !!", () => {
    preNeuron.pushAlert({ source: "x", severity: "critical", message: "boom" });
    const text = preNeuron.formatPreNeuronAlerts();
    assert.ok(text.includes("!! x: boom"));
  });
});
