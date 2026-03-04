// ============================================================
// Hot Memo — In-memory FIFO of session pushes with quality flags
// ============================================================
// Mirrors what the agent has pushed this session. Appended to
// every tool response so the agent sees its own push history.

const LAYER1_TAGS = new Set(["howto", "where", "why", "gotcha"]);
const MAX_ITEMS = 10;

interface MemoItem {
  summary: string;
  flags: string[];
}

const fifo: MemoItem[] = [];

/** Record pushed seeds with quality flags. */
export function memoAdd(
  seeds: Array<{ summary: string; tags?: string[] }>,
): void {
  for (const seed of seeds) {
    const flags: string[] = [];
    const tags = seed.tags ?? [];

    if (tags.length > 0 && !tags.some((t) => LAYER1_TAGS.has(t))) {
      flags.push("no type tag");
    }
    if (seed.summary.length < 20) {
      flags.push("brief");
    }

    fifo.push({ summary: seed.summary.slice(0, 80), flags });
    if (fifo.length > MAX_ITEMS) fifo.shift();
  }
}

/** Format memo for response append. Empty string if nothing cached. */
export function memoFormat(): string {
  if (fifo.length === 0) return "";

  const lines = fifo.map((m) => {
    const f = m.flags.length > 0 ? ` [${m.flags.join(", ")}]` : "";
    return `  - ${m.summary}${f}`;
  });

  return `\n\n[Memo] ${fifo.length} pushes this session:\n${lines.join("\n")}`;
}
