/**
 * Generate synthetic receptor firing data in 3 formats:
 * - DCP compact array (positional, schema-separated)
 * - JSON (key-value objects)
 * - Natural language (human-readable sentences)
 */

import { writeFileSync, mkdirSync } from "fs";

const AGENT_STATES = [
  "idle", "exploring", "deep_work", "stuck", "reviewing", "transitioning"
] as const;

const HOT_PATHS = [
  "receptor/learn.ts", "receptor/scorer.ts", "receptor/executor.ts",
  "gateway/routes.ts", "mcp-server/index.ts", "persona/loader.ts",
  "prior-block/builder.ts", "heatmap/decay.ts"
];

const STATE_LABELS: Record<string, string> = {
  idle: "idle with no active task",
  exploring: "exploring the codebase",
  deep_work: "in deep focused work",
  stuck: "stuck on a problem",
  reviewing: "reviewing code changes",
  transitioning: "transitioning between tasks",
};

interface FiringRecord {
  t: number;
  valence: number;
  agentState: string;
  intensity: number;
  frustration: number;
  seeking: number;
  confidence: number;
  fatigue: number;
  flow: number;
  hotPath: string;
}

function generateRecords(count: number): FiringRecord[] {
  const records: FiringRecord[] = [];
  let t = 0;

  for (let i = 0; i < count; i++) {
    const state = AGENT_STATES[Math.floor(Math.random() * AGENT_STATES.length)];
    const fru = +(Math.random() * 0.8).toFixed(2);
    const seek = +(Math.random() * 0.8).toFixed(2);
    const conf = +(Math.random() * 0.8).toFixed(2);
    const fati = +(Math.random() * 0.6).toFixed(2);
    const flow = +(Math.random() * 1.0).toFixed(2);

    records.push({
      t,
      valence: +((conf + flow - fru - fati) / 2).toFixed(3),
      agentState: state,
      intensity: +((fru + seek + conf + flow) / 4).toFixed(3),
      frustration: fru,
      seeking: seek,
      confidence: conf,
      fatigue: fati,
      flow,
      hotPath: HOT_PATHS[Math.floor(Math.random() * HOT_PATHS.length)],
    });

    t += Math.floor(Math.random() * 5000) + 500;
  }
  return records;
}

// --- DCP format ---
function toDCP(records: FiringRecord[]): string {
  const schema = '["$S","arc",["t","valence","state","intensity","fru","seek","conf","fati","flow","hotPath"]]';
  const lines = records.map(r =>
    JSON.stringify(["A", r.t, r.valence, r.agentState, r.intensity,
      r.frustration, r.seeking, r.confidence, r.fatigue, r.flow, r.hotPath])
  );
  return schema + "\n" + lines.join("\n") + "\n";
}

// --- JSON format ---
function toJSON(records: FiringRecord[]): string {
  return records.map(r => JSON.stringify(r)).join("\n") + "\n";
}

// --- Natural language format ---
function toNL(records: FiringRecord[]): string {
  return records.map(r =>
    `At timestamp ${r.t}, the agent was ${STATE_LABELS[r.agentState] || r.agentState} ` +
    `with intensity ${r.intensity}. Emotions: frustration ${r.frustration}, ` +
    `seeking ${r.seeking}, confidence ${r.confidence}, fatigue ${r.fatigue}, ` +
    `flow ${r.flow}. Valence balance was ${r.valence}. ` +
    `Working on ${r.hotPath}.`
  ).join("\n") + "\n";
}

// --- Generate for multiple sizes ---
mkdirSync("data", { recursive: true });

for (const size of [100, 1000, 10000]) {
  const records = generateRecords(size);
  const tag = `${size}`;

  writeFileSync(`data/records-${tag}.json`, JSON.stringify(records));
  writeFileSync(`data/dcp-${tag}.txt`, toDCP(records));
  writeFileSync(`data/json-${tag}.jsonl`, toJSON(records));
  writeFileSync(`data/nl-${tag}.txt`, toNL(records));

  console.log(`Generated ${size} records:`);
  console.log(`  DCP:  ${Buffer.byteLength(toDCP(records))} bytes`);
  console.log(`  JSON: ${Buffer.byteLength(toJSON(records))} bytes`);
  console.log(`  NL:   ${Buffer.byteLength(toNL(records))} bytes`);
}
