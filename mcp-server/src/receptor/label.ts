#!/usr/bin/env npx tsx
// ============================================================
// Receptor — Human labeling CLI (RECEPTOR_PRECISION_GAPS §7)
// ============================================================
// Usage:  npx tsx src/receptor/label.ts            label unlabeled samples
//         npx tsx src/receptor/label.ts --report   summarize labels so far
//
// Keys:   axis     + over   = ok   - under   s skip
//         y / n    valid / not valid          s skip
//         q        quit (labels given so far are kept)

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  LABEL_AXES, QUEUE_PATH, LABELS_PATH, readJsonl, unlabeled, summarize,
  type LabelSample, type LabelRecord, type AxisLabel,
} from "./labels.js";

class Quit extends Error {}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const lines = rl[Symbol.asyncIterator]();

async function ask(prompt: string, allowed: string[]): Promise<string> {
  for (;;) {
    process.stdout.write(prompt);
    const next = await lines.next();
    if (next.done) throw new Quit();
    const a = String(next.value).trim().toLowerCase();
    if (a === "q") throw new Quit();
    if (allowed.includes(a)) return a;
    console.log(`  (${allowed.join(" ")} / q)`);
  }
}

function show(s: LabelSample, n: number, total: number): void {
  console.log(`\n=== sample ${n}/${total}  ${new Date(s.ts).toLocaleString()}  id=${s.id}`);
  console.log(`state=${s.agentState}  pattern=${s.pattern}  fired=${s.methods.join(",")}`);
  console.log(`signals: ${s.signals.map(x => `${x.kind}(${x.intensity})`).join(", ")}`);
  console.log("emotion: " + Object.entries(s.emotion).map(([k, v]) => `${k}=${v.toFixed(2)}`).join("  "));
  console.log("recent events (oldest first):");
  for (const e of s.events) {
    const mark = e.result && e.result !== "success" ? ` [${e.result}]` : "";
    console.log(`  #${e.eventId} ${e.action}${mark} ${e.path ?? ""}`);
  }
}

async function labelOne(s: LabelSample): Promise<LabelRecord> {
  const rec: LabelRecord = { id: s.id, labeledAt: Date.now(), axes: {}, signals: {}, failures: {} };
  const axisMap: Record<string, AxisLabel> = { "+": "over", "=": "ok", "-": "under" };

  for (const axis of LABEL_AXES) {
    const a = await ask(`  ${axis} ${s.emotion[axis].toFixed(2)}  [+ = - s] > `, ["+", "=", "-", "s"]);
    if (a !== "s") rec.axes[axis] = axisMap[a];
  }
  for (const sig of s.signals) {
    const a = await ask(`  signal ${sig.kind} valid? [y n s] > `, ["y", "n", "s"]);
    if (a !== "s") rec.signals[sig.kind] = a === "y";
  }
  for (const e of s.events.filter(e => e.result === "failure")) {
    const a = await ask(`  #${e.eventId} ${e.action} ${e.path ?? ""} really failed? [y n s] > `, ["y", "n", "s"]);
    if (a !== "s") rec.failures[String(e.eventId)] = a === "y";
  }
  return rec;
}

function pct(n: number, d: number): string {
  return (d === 0 ? "-" : `${Math.round((n / d) * 100)}%`).padStart(4);
}

function report(): void {
  const labels = readJsonl<LabelRecord>(LABELS_PATH);
  const queued = readJsonl<LabelSample>(QUEUE_PATH).length;
  const s = summarize(labels);
  console.log(`labels: ${s.labeled}  (queue: ${queued}, unlabeled: ${queued - s.labeled})\n`);
  console.log("axis          over    ok  under   n");
  for (const a of LABEL_AXES) {
    const x = s.axes[a];
    const n = x.over + x.ok + x.under;
    console.log(`${a.padEnd(12)} ${pct(x.over, n)}  ${pct(x.ok, n)}  ${pct(x.under, n)}  ${n}`);
  }
  console.log("\nsignal                          valid   n");
  for (const [k, v] of Object.entries(s.signals)) {
    const n = v.valid + v.invalid;
    console.log(`${k.padEnd(30)} ${pct(v.valid, n)}   ${n}`);
  }
  const fn = s.failures.real + s.failures.notReal;
  console.log(`\nfailure judged correctly: ${pct(s.failures.real, fn)}  (n=${fn})`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--report")) {
    report();
    rl.close();
    return;
  }

  const todo = unlabeled(readJsonl<LabelSample>(QUEUE_PATH), readJsonl<LabelRecord>(LABELS_PATH));
  if (todo.length === 0) {
    console.log(`nothing to label (${QUEUE_PATH})`);
    rl.close();
    return;
  }

  console.log(`${todo.length} unlabeled. Judge the direction only: is the value too high, right, or too low for what the events show?`);
  let done = 0;
  try {
    for (const s of todo) {
      show(s, done + 1, todo.length);
      const rec = await labelOne(s);
      fs.mkdirSync(path.dirname(LABELS_PATH), { recursive: true });
      fs.appendFileSync(LABELS_PATH, JSON.stringify(rec) + "\n");
      done++;
    }
  } catch (err) {
    if (!(err instanceof Quit)) throw err;
  }
  console.log(`\nlabeled ${done}. → ${LABELS_PATH}`);
  rl.close();
}

main();
