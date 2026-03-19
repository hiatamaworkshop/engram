// ============================================================
// Phase 4: Lifecycle — Unit Tests
// ============================================================
// Tests: work-time window, Index Vector compression, metabolism.
// Run: npx tsx --test src/pre-neuron/lifecycle.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PathHeatmap } from "../receptor/heatmap.js";
import type { NormalizedEvent, IndexVector } from "../receptor/types.js";

// ---- Helpers ----

const DAY = 86400000;
const HOUR = 3600000;
const MIN = 60000;
const NOW = Date.now();

function makeEvent(path: string, action: "file_read" | "file_edit" = "file_read", ts = NOW): NormalizedEvent {
  return { eventId: Math.random() * 1e6 | 0, action, path, result: "success", ts };
}

function setLastModified(heatmap: PathHeatmap, path: string, mtime: number): void {
  const node = heatmap.getNode(path);
  if (!node) throw new Error(`Node not found: ${path}`);
  node.lastModified = mtime;
}

// ---- Work-time window tests ----

describe("PathHeatmap work-time window", () => {
  let hm: PathHeatmap;

  beforeEach(() => {
    hm = new PathHeatmap();
  });

  it("accumulates active time within idle threshold", () => {
    const t0 = NOW;
    hm.record(makeEvent("a.ts", "file_read", t0));
    hm.record(makeEvent("b.ts", "file_read", t0 + 5 * MIN)); // 5 min gap
    hm.record(makeEvent("c.ts", "file_read", t0 + 10 * MIN)); // 5 min gap

    // Total: 10 min of active time
    assert.equal(hm.cumulativeActiveMs, 10 * MIN);
  });

  it("skips idle gaps beyond threshold", () => {
    const t0 = NOW;
    hm.record(makeEvent("a.ts", "file_read", t0));
    hm.record(makeEvent("b.ts", "file_read", t0 + 5 * MIN));  // +5 min active
    // 2 hour gap (idle) — idleThresholdMs = 30min
    hm.record(makeEvent("c.ts", "file_read", t0 + 2 * HOUR + 5 * MIN));
    hm.record(makeEvent("d.ts", "file_read", t0 + 2 * HOUR + 10 * MIN)); // +5 min active

    // Should be 10 min total (5 + 5), not 2h10m
    assert.equal(hm.cumulativeActiveMs, 10 * MIN);
  });

  it("first event starts at zero cumulative", () => {
    hm.record(makeEvent("a.ts", "file_read", NOW));
    assert.equal(hm.cumulativeActiveMs, 0); // no gap to measure yet
  });

  it("multiple idle gaps are all skipped", () => {
    const t0 = NOW;
    hm.record(makeEvent("a.ts", "file_read", t0));
    hm.record(makeEvent("b.ts", "file_read", t0 + 10 * MIN));       // +10 min
    // 1 hour idle
    hm.record(makeEvent("c.ts", "file_read", t0 + HOUR + 10 * MIN));
    hm.record(makeEvent("d.ts", "file_read", t0 + HOUR + 20 * MIN)); // +10 min
    // 8 hour idle (sleep)
    hm.record(makeEvent("e.ts", "file_read", t0 + 9 * HOUR + 20 * MIN));
    hm.record(makeEvent("f.ts", "file_read", t0 + 9 * HOUR + 25 * MIN)); // +5 min

    // Total active: 10 + 10 + 5 = 25 min
    assert.equal(hm.cumulativeActiveMs, 25 * MIN);
  });
});

// ---- Index Vector compression tests ----

describe("PathHeatmap Index Vector compression", () => {
  let hm: PathHeatmap;

  beforeEach(() => {
    hm = new PathHeatmap();
  });

  it("runMetabolism expires old nodes beyond activeWindow", () => {
    const t0 = NOW;
    // Record some files
    hm.record(makeEvent("config/a.js", "file_read", t0));
    hm.record(makeEvent("config/b.js", "file_read", t0));
    hm.record(makeEvent("config/c.js", "file_read", t0));
    setLastModified(hm, "config/a.js", t0 - 10 * DAY);
    setLastModified(hm, "config/b.js", t0 - 5 * DAY);
    setLastModified(hm, "config/c.js", t0 - 1 * DAY);

    // Simulate 49 hours of active work time (beyond 48h activeWindow)
    // by adding events at 1-minute intervals for a while, then a final event
    let ts = t0 + MIN;
    for (let i = 0; i < 10; i++) {
      hm.record(makeEvent("src/main.ts", "file_read", ts));
      ts += MIN;
    }

    // Manually push cumulative past activeWindow for config files
    // by accessing only src/main.ts beyond the window
    // Since config/* was last accessed at t0, their leafActiveTime = 0
    // We need cumulativeActiveMs > activeWindow (48h = 172800000ms)
    // Trick: directly manipulate for test purposes
    // Instead, let's use a more direct approach — record many events
    // Actually, the test should verify the mechanism, not simulate real time.
    // Let's use a simpler approach: record at t0, then fast-forward cumulative.

    // The metabolism checks: cumulativeActiveMs - leafActiveTime > activeWindow
    // leafActiveTime for config/* = 0 (set at t0 when cumulative was 0)
    // So we need cumulativeActiveMs > activeWindow

    // Record a burst of events to push cumulative time
    // 1440 events at 2-min intervals = 48h of active time
    let burstTs = t0 + 100 * MIN; // start after initial events
    for (let i = 0; i < 1441; i++) {
      hm.record(makeEvent("src/work.ts", "file_read", burstTs));
      burstTs += 2 * MIN;
    }

    // Now cumulative should be > 48h
    assert.ok(hm.cumulativeActiveMs > 48 * HOUR, `cumulative ${hm.cumulativeActiveMs} should be > 48h`);

    // Run metabolism — config/* should expire
    const expired = hm.runMetabolism();
    assert.ok(expired >= 3, `should expire at least 3 nodes, got ${expired}`);

    // Config nodes should be gone
    assert.equal(hm.getNode("config/a.js"), undefined);
    assert.equal(hm.getNode("config/b.js"), undefined);
    assert.equal(hm.getNode("config/c.js"), undefined);

    // Index vectors should exist
    assert.ok(hm.indexVectors.length >= 3, `should have at least 3 index vectors`);
  });

  it("Index Vector has 6-dimensional normalized vector", () => {
    const t0 = NOW;
    // Create enough siblings for percentile calculation
    hm.record(makeEvent("config/a.js", "file_read", t0));
    hm.record(makeEvent("config/a.js", "file_read", t0 + MIN));
    hm.record(makeEvent("config/b.js", "file_read", t0 + 2 * MIN));
    hm.record(makeEvent("config/c.js", "file_edit", t0 + 3 * MIN));
    hm.record(makeEvent("config/d.js", "file_read", t0 + 4 * MIN));
    setLastModified(hm, "config/a.js", t0 - 30 * DAY);
    setLastModified(hm, "config/b.js", t0 - 10 * DAY);
    setLastModified(hm, "config/c.js", t0 - 1 * DAY);
    setLastModified(hm, "config/d.js", t0 - 5 * DAY);

    // Push cumulative past activeWindow
    let ts = t0 + 100 * MIN;
    for (let i = 0; i < 1441; i++) {
      hm.record(makeEvent("src/work.ts", "file_read", ts));
      ts += 2 * MIN;
    }

    hm.runMetabolism();

    const vectors = hm.indexVectors;
    assert.ok(vectors.length > 0, "should have index vectors");

    for (const v of vectors) {
      assert.equal(v.vector.length, 6, `vector should be 6-dimensional: ${v.path}`);
      for (const val of v.vector) {
        assert.ok(val >= 0 && val <= 1, `each axis should be 0.0-1.0, got ${val}`);
      }
      assert.ok(v.lastSeen > 0, "lastSeen should be set");
      assert.ok(v.path.length > 0, "path should be set");
    }
  });

  it("filenameIndex persists through Index Vector compression", () => {
    const t0 = NOW;
    hm.record(makeEvent("config/db.js", "file_read", t0));
    hm.record(makeEvent("config/auth.js", "file_read", t0));
    hm.record(makeEvent("config/cache.js", "file_read", t0));

    // Verify filenameIndex before
    assert.ok(hm.filenameIndex.get("db.js")?.has("config/db.js"));

    // Push past activeWindow
    let ts = t0 + 100 * MIN;
    for (let i = 0; i < 1441; i++) {
      hm.record(makeEvent("src/work.ts", "file_read", ts));
      ts += 2 * MIN;
    }

    hm.runMetabolism();

    // filenameIndex should still have the entries (preserved for Stage 3)
    assert.ok(hm.filenameIndex.get("db.js")?.has("config/db.js"),
      "filenameIndex should persist through compression");
  });

  it("does not expire recently accessed nodes", () => {
    const t0 = NOW;

    // Push cumulative past activeWindow first
    let ts = t0;
    for (let i = 0; i < 1441; i++) {
      hm.record(makeEvent("src/work.ts", "file_read", ts));
      ts += 2 * MIN;
    }

    // Now record config files AFTER the window — they should NOT expire
    hm.record(makeEvent("config/fresh.js", "file_read", ts));
    hm.record(makeEvent("config/fresh.js", "file_read", ts + MIN));

    const expired = hm.runMetabolism();

    // fresh.js should survive (its leafActiveTime is near current cumulative)
    assert.ok(hm.getNode("config/fresh.js") !== undefined, "recently accessed node should survive");
  });
});

// ---- Expire handler / sink integration tests ----

describe("PathHeatmap expire handler", () => {
  let hm: PathHeatmap;

  beforeEach(() => {
    hm = new PathHeatmap();
  });

  it("calls expire handler with expired Index Vectors", () => {
    const received: IndexVector[] = [];
    hm.setExpireHandler((vectors) => {
      received.push(...vectors);
    });

    const t0 = NOW;
    hm.record(makeEvent("config/old.js", "file_read", t0));
    setLastModified(hm, "config/old.js", t0 - 30 * DAY);

    // Push past activeWindow
    let ts = t0 + 100 * MIN;
    for (let i = 0; i < 1441; i++) {
      hm.record(makeEvent("src/work.ts", "file_read", ts));
      ts += 2 * MIN;
    }

    hm.runMetabolism();

    assert.ok(received.length > 0, "expire handler should be called");
    assert.ok(received.some((v) => v.path === "config/old.js"), "should include expired path");
  });

  it("trapCount increments via incrementTrapCount", () => {
    const t0 = NOW;
    hm.record(makeEvent("config/trap.js", "file_read", t0));

    // Push past activeWindow
    let ts = t0 + 100 * MIN;
    for (let i = 0; i < 1441; i++) {
      hm.record(makeEvent("src/work.ts", "file_read", ts));
      ts += 2 * MIN;
    }

    hm.runMetabolism();

    const vec = hm.indexVectors.find((v) => v.path === "config/trap.js");
    assert.ok(vec, "should have index vector for trap.js");
    assert.equal(vec!.trapCount, 0);

    const found = hm.incrementTrapCount("config/trap.js");
    assert.ok(found, "incrementTrapCount should find the vector");
    assert.equal(vec!.trapCount, 1);
  });
});

// ---- Index Vector TTL/LRU limits ----

describe("Index Vector limits", () => {
  let hm: PathHeatmap;

  beforeEach(() => {
    hm = new PathHeatmap();
  });

  it("runMetabolism returns 0 when no nodes are expired", () => {
    const t0 = NOW;
    hm.record(makeEvent("a.ts", "file_read", t0));
    hm.record(makeEvent("b.ts", "file_read", t0 + MIN));

    const expired = hm.runMetabolism();
    assert.equal(expired, 0);
  });
});
