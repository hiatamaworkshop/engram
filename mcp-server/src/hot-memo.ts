// ============================================================
// Hot Memo — DCP-native layered session awareness
// ============================================================
// Each layer independently decides whether to speak.
// If none speak, the memo is silent. Zero noise.
//
// DCP schema: hotmemo:v1
//   ["$S","hotmemo:v1",4,"layer","source","signal","detail"]
//   ["quality","push","no-type-tag","summary < 20 chars"]
//   ["receptor","passive","suggest","engram_pull"]
//   ["subsystem","action_logger","fire_signal","frustration_spike(0.8)"]
//   ["pre-neuron","staleness-detector","stale","path"]

import { drainRecommendationsDcp, formatSubsystemDcp } from "./receptor/index.js";
import { formatPreNeuronDcp } from "./pre-neuron/index.js";

const LAYER1_TAGS = new Set(["howto", "where", "why", "gotcha"]);
const MAX_HISTORY = 10;

type ToolContext = "push" | "pull" | "status" | "ls" | "flag";
type DcpRow = [string, string, string, string];

interface PushRecord {
  summary: string;
  flags: string[];
  timestamp: number;
}

const history: PushRecord[] = [];
let toolCallsSinceLastPush = 0;
let _trendShownThisSession = false;

// ---- Public API ----

/** Record pushed seeds with quality flags. */
export function memoAdd(
  seeds: Array<{ summary: string; tags?: string[] }>,
): void {
  toolCallsSinceLastPush = 0;

  for (const seed of seeds) {
    const flags: string[] = [];
    const tags = seed.tags ?? [];

    if (tags.length > 0 && !tags.some((t) => LAYER1_TAGS.has(t))) {
      flags.push("no-type-tag");
    }
    if (seed.summary.length < 20) {
      flags.push("brief");
    }

    history.push({
      summary: seed.summary.slice(0, 80),
      flags,
      timestamp: Date.now(),
    });
    if (history.length > MAX_HISTORY) history.shift();
  }
}

/** Build DCP-native contextual memo. Returns empty string if nothing to say. */
export function memoFormat(context: ToolContext): string {
  toolCallsSinceLastPush++;

  const rows: DcpRow[] = [];

  // Layer 1: System Core — immediate quality feedback on latest push
  if (context === "push" && history.length > 0) {
    const latest = history[history.length - 1];
    for (const flag of latest.flags) {
      rows.push(["quality", "push", flag, latest.summary]);
    }
  }

  // Layer 2: Data Status — session push count on status/ls
  if ((context === "status" || context === "ls") && history.length > 0) {
    rows.push(["session", "push-count", String(history.length), "this-session"]);
  }

  // Layer 3: Data Menial — trend detection across recent pushes (once per session)
  if (history.length >= 3 && !_trendShownThisSession) {
    const recent = history.slice(-3);
    const briefCount = recent.filter((p) => p.flags.includes("brief")).length;
    const noTagCount = recent.filter((p) => p.flags.includes("no-type-tag")).length;
    if (briefCount >= 2 || noTagCount >= 2) {
      const parts: string[] = [];
      if (briefCount >= 2) parts.push("brief");
      if (noTagCount >= 2) parts.push("no-type-tag");
      rows.push(["trend", "push-quality", parts.join(","), "recent-3"]);
      _trendShownThisSession = true;
    }
  }

  // Layer 4: Meta — push frequency nudge
  if (toolCallsSinceLastPush >= 20 && history.length > 0) {
    rows.push(["meta", "push-freq", String(toolCallsSinceLastPush), "no-push"]);
  }

  // Layer 5: Receptor — passive receptor recommendations (DCP rows)
  const receptorRows = drainRecommendationsDcp();
  rows.push(...receptorRows);

  // Layer 6: Executor results — unified ring buffer (DCP rows)
  const subsystemRows = formatSubsystemDcp();
  rows.push(...subsystemRows);

  // Layer 7: Pre-neuron monitors — immune system alerts (DCP rows)
  const preNeuronRows = formatPreNeuronDcp();
  rows.push(...preNeuronRows);

  if (rows.length === 0) return "";

  const header = '["$S","hotmemo:v1",4,"layer","source","signal","detail"]';
  const dataLines = rows.map((r) => JSON.stringify(r));
  return "\n\n" + [header, ...dataLines].join("\n");
}