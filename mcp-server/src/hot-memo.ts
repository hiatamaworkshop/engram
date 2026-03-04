// ============================================================
// Hot Memo — Layered, conditional session awareness
// ============================================================
// Each layer independently decides whether to speak.
// If none speak, the memo is silent. Zero noise.

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

  // Layer 3: Data Menial — trend detection across recent pushes
  if (history.length >= 3) {
    const recent = history.slice(-3);
    const briefCount = recent.filter((p) => p.flags.includes("brief")).length;
    if (briefCount >= 2) {
      layers.push("[trend] recent pushes have brief summaries");
    }
    const noTagCount = recent.filter((p) => p.flags.includes("no type tag")).length;
    if (noTagCount >= 2) {
      layers.push("[trend] recent pushes missing type tags");
    }
  }

  // Layer 4: Meta — push frequency nudge
  if (toolCallsSinceLastPush >= 20 && history.length > 0) {
    layers.push(`[meta] no push in ${toolCallsSinceLastPush} tool calls`);
  }

  if (layers.length === 0) return "";
  return "\n\n" + layers.join("\n");
}
