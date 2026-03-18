// ============================================================
// Hot Memo — Layered, conditional session awareness
// ============================================================
// Each layer independently decides whether to speak.
// If none speak, the memo is silent. Zero noise.

import { formatRecommendations, drainRecommendations, formatSubsystemForHotmemo } from "./receptor/index.js";
import { formatPreNeuronAlerts } from "./pre-neuron/index.js";

const LAYER1_TAGS = new Set(["howto", "where", "why", "gotcha"]);
const MAX_HISTORY = 10;

type ToolContext = "push" | "pull" | "status" | "ls" | "flag";

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
      flags.push("no type tag");
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

/** Build contextual memo. Returns empty string if nothing to say. */
export function memoFormat(context: ToolContext): string {
  toolCallsSinceLastPush++;

  const layers: string[] = [];

  // Layer 1: System Core — immediate quality feedback on latest push
  if (context === "push" && history.length > 0) {
    const latest = history[history.length - 1];
    if (latest.flags.length > 0) {
      layers.push(`[quality] ${latest.flags.join(", ")}`);
    }
  }

  // Layer 2: Data Status — session push count on status/ls
  if ((context === "status" || context === "ls") && history.length > 0) {
    layers.push(`[session] ${history.length} pushes this session`);
  }

  // Layer 3: Data Menial — trend detection across recent pushes (once per session)
  if (history.length >= 3 && !_trendShownThisSession) {
    const recent = history.slice(-3);
    const briefCount = recent.filter((p) => p.flags.includes("brief")).length;
    const noTagCount = recent.filter((p) => p.flags.includes("no type tag")).length;
    if (briefCount >= 2 || noTagCount >= 2) {
      const parts: string[] = [];
      if (briefCount >= 2) parts.push("brief summaries");
      if (noTagCount >= 2) parts.push("missing type tags");
      layers.push(`[trend] recent pushes: ${parts.join(", ")}`);
      _trendShownThisSession = true;
    }
  }

  // Layer 4: Meta — push frequency nudge
  if (toolCallsSinceLastPush >= 20 && history.length > 0) {
    layers.push(`[meta] no push in ${toolCallsSinceLastPush} tool calls`);
  }

  // Layer 5: Receptor — passive receptor recommendations
  const receptorLine = formatRecommendations();
  if (receptorLine) {
    layers.push(receptorLine);
    drainRecommendations(); // consume after display
  }

  // Layer 6: Executor results — unified ring buffer (all executors + subsystems)
  const subsystemLine = formatSubsystemForHotmemo();
  if (subsystemLine) {
    layers.push(subsystemLine);
  }

  // Layer 7: Pre-neuron monitors — immune system alerts (staleness, blind spots)
  const preNeuronLine = formatPreNeuronAlerts();
  if (preNeuronLine) {
    layers.push(preNeuronLine);
  }

  if (layers.length === 0) return "";
  return "\n\n" + layers.join("\n");
}