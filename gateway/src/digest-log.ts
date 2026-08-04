// ============================================================
// Digest Log — metabolism observation (deaths, demotions, promotions)
// ============================================================
// Third leg of the lifecycle observation set: dedup-log watches birth,
// recall-log watches search, this watches the metabolism's verdicts.
// Until now they went to console.log and scrolled away — for a system
// whose whole thesis is "usage is the arbiter", the arbiter's rulings
// were the least observed signal in it.
//
// The one question this exists to answer: of the nodes that die, how
// many died UNSEEN (hitCount 0)? A high unseen rate is either healthy
// garbage collection or knowledge nobody could find — and recall-log's
// weak-query list is the cross-reference that tells those apart.
//
// Observation only. Nothing here changes what lives or dies.

const MAX_EVENTS = 200;
const MAX_TICKS = 100;

export interface LifecycleEvent {
  /** What happened: node deleted, fixed→recent, or recent→fixed. */
  kind: "death" | "demotion" | "promotion";
  summary: string;
  projectId: string;
  /** Weight at the moment of the verdict. */
  weight: number;
  /** Recall count over the node's whole life. 0 on a death = died unseen. */
  hitCount: number;
  /** Node age in ms at the verdict, -1 when ingestedAt was missing. */
  ageMs: number;
  ts: number;
}

export interface DigestTick {
  projectId: string;
  total: number;
  promoted: number;
  expired: number;
  demoted: number;
  decayMultiplier: number;
  ts: number;
}

const events: LifecycleEvent[] = [];
const ticks: DigestTick[] = [];

/** Record one lifecycle verdict. Called from the digestor batch — must never throw. */
export function recordLifecycle(event: LifecycleEvent): void {
  events.push({ ...event, summary: event.summary.slice(0, 120) });
  if (events.length > MAX_EVENTS) events.shift();
}

/** Record one project batch tick (only ticks that touched nodes are worth keeping). */
export function recordTick(tick: DigestTick): void {
  ticks.push(tick);
  if (ticks.length > MAX_TICKS) ticks.shift();
}

/** Age histogram edges in hours. TTL default is 6h — the 6h bucket is the natural death age. */
const AGE_BUCKETS_H = [1, 6, 24, 168];

export interface DigestStats {
  ticks: number;
  promoted: number;
  expired: number;
  demoted: number;
  /** Deaths with hitCount 0 — never recalled in their whole life. */
  diedUnseen: number;
  /** diedUnseen / expired, 0 when no deaths. */
  unseenRate: number;
  /** Death age histogram: "<1h" | "1-6h" | "6-24h" | "1-7d" | ">7d" → count. */
  deathAges: Record<string, number>;
  /** Most recent lifecycle events, newest first. */
  recent: LifecycleEvent[];
}

function ageLabel(ageMs: number): string {
  if (ageMs < 0) return "unknown";
  const h = ageMs / 3_600_000;
  if (h < AGE_BUCKETS_H[0]) return "<1h";
  if (h < AGE_BUCKETS_H[1]) return "1-6h";
  if (h < AGE_BUCKETS_H[2]) return "6-24h";
  if (h < AGE_BUCKETS_H[3]) return "1-7d";
  return ">7d";
}

export function getDigestStats(recentLimit = 10): DigestStats {
  let promoted = 0;
  let expired = 0;
  let demoted = 0;
  let diedUnseen = 0;
  const deathAges: Record<string, number> = {};

  for (const e of events) {
    if (e.kind === "promotion") promoted++;
    else if (e.kind === "demotion") demoted++;
    else {
      expired++;
      if (e.hitCount === 0) diedUnseen++;
      const label = ageLabel(e.ageMs);
      deathAges[label] = (deathAges[label] ?? 0) + 1;
    }
  }

  return {
    ticks: ticks.length,
    promoted,
    expired,
    demoted,
    diedUnseen,
    unseenRate: expired > 0 ? Math.round((diedUnseen / expired) * 100) / 100 : 0,
    deathAges,
    recent: [...events].reverse().slice(0, recentLimit),
  };
}

/** Test/maintenance hook. */
export function clearDigestLog(): void {
  events.length = 0;
  ticks.length = 0;
}
