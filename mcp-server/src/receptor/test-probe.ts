#!/usr/bin/env tsx
// ============================================================
// Manual test: future_probe → enriched centroid → sphere shaper
// ============================================================
// Usage:  npx tsx src/receptor/test-probe.ts
//
// Requires: Qdrant running on localhost:6333 with action_log data (≥2 entries)
//           Gateway running on localhost:3100

import { buildQuery, buildEnrichedCentroid, executeSearch, formatResults } from "./future-probe.js";
import { shapeForSphere, exportEnrichedCentroid } from "./sphere-shaper.js";
import type { ProbeContext } from "./future-probe.js";

const ctx: ProbeContext = {
  topPaths: ["mcp-server/src/receptor/future-probe.ts", "mcp-server/src/receptor/index.ts"],
  emotion: {
    frustration: 0.3,
    seeking: -0.4,
    confidence: 0.2,
    fatigue: 0.1,
    flow: 0.1,
  },
  agentState: "exploring",
  entropy: 1.2,
  projectId: process.env.ENGRAM_PROJECT_ID || "engram",
};

async function main() {
  console.log("=== future_probe test ===\n");

  // 1. Build query (centroid Δv)
  console.log("[1] buildQuery...");
  const query = await buildQuery(ctx);
  if (!query) {
    console.log("  -> null (insufficient action_log data, need ≥2 entries)");
    process.exit(1);
  }
  console.log(`  -> vector dim=${query.vector.length} α=${query.alpha.toFixed(3)} window=${query.windowSize}`);
  console.log(`  -> centroidNow[0..4] = [${query.centroidNow.slice(0, 5).map(v => v.toFixed(4)).join(", ")}]`);

  // 2. Execute search
  console.log("\n[2] executeSearch...");
  const results = await executeSearch(query, ctx.projectId);
  console.log(`  -> ${results.length} results`);
  if (results.length > 0) {
    console.log(formatResults(results).split("\n").map(l => "     " + l).join("\n"));
  }

  // 3. Build enriched centroid
  console.log("\n[3] buildEnrichedCentroid...");
  const enriched = await buildEnrichedCentroid(ctx);
  if (!enriched) {
    console.log("  -> null");
    process.exit(1);
  }
  console.log(`  -> pattern: ${enriched.pattern}`);
  console.log(`  -> outcome: ${enriched.outcome}`);
  console.log(`  -> entropy_range: [${enriched.entropy_range.join(", ")}]`);
  console.log(`  -> emotion_avg:`, JSON.stringify(enriched.emotion_avg));
  console.log(`  -> linked_knowledge: ${enriched.linked_knowledge.length} fixed nodes`);
  for (const lk of enriched.linked_knowledge) {
    console.log(`     - "${lk.summary}" [${lk.tags.join(",")}] sim=${lk.similarity}`);
  }
  console.log(`  -> window_size: ${enriched.window_size}, alpha: ${enriched.alpha.toFixed(3)}`);

  // 4. Shape for Sphere (anonymize)
  console.log("\n[4] shapeForSphere (anonymize)...");
  const payload = shapeForSphere(enriched);
  console.log(`  -> pattern: ${payload.pattern}`);
  console.log(`  -> linked summaries (anonymized):`);
  for (const lk of payload.linked_knowledge) {
    console.log(`     - "${lk.summary}" [${lk.tags.join(",")}] sim=${lk.similarity}`);
  }
  console.log(`  -> version: ${payload.version}`);

  // 5. Export (write to sphere-ready.jsonl)
  console.log("\n[5] exportEnrichedCentroid -> sphere-ready.jsonl...");
  exportEnrichedCentroid(enriched);
  console.log("  -> done");

  // 6. Show final payload
  console.log("\n=== Sphere-ready payload ===");
  const display = { ...payload, centroid_embedding: `[${payload.centroid_embedding.length}d]` };
  console.log(JSON.stringify(display, null, 2));
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
