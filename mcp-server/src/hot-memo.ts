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
import { setDeliveryCarrier } from "./receptor/adoption.js";

const LAYER1_TAGS = new Set(["howto", "where", "why", "gotcha"]);
const MAX_HISTORY = 10;

type ToolContext = "push" | "pull" | "status" | "ls" | "flag";
type DcpRow = [string, string, string, string];

interface PushRecord {
  summary: string;
  flags: string[];
  timestamp: number;
}

/** One recall's best relevance. -1 when nothing came back at all. */
interface RecallRecord {
  query: string;
  topRelevance: number;
  timestamp: number;
}

/**
 * Below this a recall counts as weak. Mirrors WEAK_THRESHOLD in the
 * gateway's recall-log — both are provisional, both want the measured
 * distribution from GET /recall-log to replace them.
 */
const WEAK_RELEVANCE = 0.5;

const history: PushRecord[] = [];
const recallHistory: RecallRecord[] = [];
let toolCallsSinceLastPush = 0;
let _trendShownThisSession = false;
let _recallTrendShownThisSession = false;

// ---- Public API ----

/**
 * Summaries must be English. Not a style preference: summary is the only
 * embedded field, and the 0.92 dedup cut is language-dependent — measured
 * 2026-08-04, a negation of an existing summary scores 0.7958 in English
 * (kept as its own node) but 0.9221 in Japanese, i.e. silently merged into
 * the claim it contradicts. Matches CJK script ranges only (kana, unified
 * ideographs, hangul, fullwidth forms) — not bare non-ASCII, which would
 * flag legitimate English punctuation (—, ≥, →) and train the reader to
 * ignore the one flag that matters.
 */
const CJK_SCRIPT =
  /[　-ヿ㐀-䶿一-鿿豈-﫿가-힯＀-￯]/;

/** Record pushed seeds with quality flags. */
export function memoAdd(
  seeds: Array<{ summary: string; tags?: string[]; native?: unknown[] }>,
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
    if (CJK_SCRIPT.test(seed.summary)) {
      flags.push("non-english");
    }
    if (!seed.native) {
      flags.push("no-dcp");
    }

    history.push({
      summary: seed.summary.slice(0, 80),
      flags,
      timestamp: Date.now(),
    });
    if (history.length > MAX_HISTORY) history.shift();
  }
}

/**
 * Record how well a recall scored. The miss side of the ratchet: weight
 * says a node was pulled, this says a query found nothing worth pulling.
 * Pass -1 for topRelevance when the recall returned no results at all.
 */
export function memoRecordRecall(query: string, topRelevance: number): void {
  recallHistory.push({
    query: query.slice(0, 60),
    topRelevance,
    timestamp: Date.now(),
  });
  if (recallHistory.length > MAX_HISTORY) recallHistory.shift();
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

  // Layer 1b: System Core — weak recall on the pull that just happened.
  // Speaks only on a weak result, so a healthy pull stays silent.
  if (context === "pull" && recallHistory.length > 0) {
    const latest = recallHistory[recallHistory.length - 1];
    if (latest.topRelevance < WEAK_RELEVANCE) {
      const score = latest.topRelevance < 0 ? "none" : latest.topRelevance.toFixed(2);
      rows.push(["quality", "recall", "weak", `top=${score} | ${latest.query}`]);
    }
  }

  // Layer 2: Data Status — session push count on status/ls
  if ((context === "status" || context === "ls") && history.length > 0) {
    rows.push(["session", "push-count", String(history.length), "this-session"]);
  }

  // Layer 2b: Data Status — weak recall tally on status/ls
  if ((context === "status" || context === "ls") && recallHistory.length > 0) {
    const weak = recallHistory.filter((r) => r.topRelevance < WEAK_RELEVANCE).length;
    if (weak > 0) {
      rows.push(["session", "recall-weak", `${weak}/${recallHistory.length}`, "this-session"]);
    }
  }

  // Layer 3b: Data Menial — repeated weak recall. Knowledge that exists but
  // cannot be found is a summary-vocabulary problem, not a value problem.
  if (recallHistory.length >= 3 && !_recallTrendShownThisSession) {
    const recent = recallHistory.slice(-3);
    const weak = recent.filter((r) => r.topRelevance < WEAK_RELEVANCE).length;
    if (weak >= 2) {
      rows.push(["trend", "recall-weak", `${weak}/3`, "summary-vocabulary or missing knowledge"]);
      _recallTrendShownThisSession = true;
    }
  }

  // Layer 3: Data Menial — trend detection across recent pushes (once per session).
  // Generic over every flag: a rule that only warns per-push is a rule that can
  // be ignored three times in a row without anything escalating.
  if (history.length >= 3 && !_trendShownThisSession) {
    const recent = history.slice(-3);
    const counts = new Map<string, number>();
    for (const p of recent) {
      for (const f of p.flags) counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    const repeated = [...counts.entries()]
      .filter(([, n]) => n >= 2)
      .map(([f]) => f);
    if (repeated.length > 0) {
      rows.push(["trend", "push-quality", repeated.join(","), "recent-3"]);
      _trendShownThisSession = true;
    }
  }

  // Layer 4: Meta — push frequency nudge
  if (toolCallsSinceLastPush >= 20 && history.length > 0) {
    rows.push(["meta", "push-freq", String(toolCallsSinceLastPush), "no-push"]);
  }

  // Layer 5: Receptor — passive receptor recommendations (DCP rows)
  // engram_status is the one carrier that is not a memory_read/write event
  setDeliveryCarrier(context !== "status");
  const receptorRows = drainRecommendationsDcp();
  rows.push(...receptorRows);

  // Layer 6: Executor results — unified ring buffer (DCP rows)
  const subsystemRows = formatSubsystemDcp();
  rows.push(...subsystemRows);

  // Layer 7: Pre-neuron monitors — immune system alerts (DCP rows)
  const preNeuronRows = formatPreNeuronDcp();
  rows.push(...preNeuronRows);

  if (rows.length === 0) return "";

  // Abbreviated $S — field names defined in CLAUDE.md.template, not repeated per response
  const header = '["$S","hotmemo:v1"]';
  const dataLines = rows.map((r) => JSON.stringify(r));
  return "\n\n" + [header, ...dataLines].join("\n");
}