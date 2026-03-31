// ============================================================
// Receptor — Command Counter (time-window driven)
// ============================================================
// Counts tool call types within sliding time windows.
// Classifies patterns: exploration, implementation, trial-and-error, etc.
// Provides "what is the agent doing" signal to emotion system.

import type { NormalizedAction, NormalizedEvent, TimeWindow, PatternKind } from "./types.js";

export type { PatternKind } from "./types.js";

// ---- Time window durations ----

const SHORT_WINDOW_MS = 300_000;     // 5 minutes — spike detection
const MEDIUM_WINDOW_MS = 1_800_000;  // 30 minutes — trend detection
// Meta window = entire session (no eviction)

export interface WindowSnapshot {
  counts: Record<NormalizedAction, number>;
  total: number;
  pattern: PatternKind;
  bashFailRate: number;
  editBashAlternation: number;
  turns: number;
  toolsPerTurn: number;
}

interface TurnMark {
  type: "user" | "agent";
  ts: number;
}

export class Commander {
  private shortWindow: NormalizedEvent[] = [];
  private mediumWindow: NormalizedEvent[] = [];
  private allEvents: NormalizedEvent[] = [];
  private _sessionStart = Date.now();
  private _turns: TurnMark[] = [];

  /** Record an event into all windows. */
  record(event: NormalizedEvent): void {
    this.shortWindow.push(event);
    this.mediumWindow.push(event);
    this.allEvents.push(event);
  }

  /** Record a turn boundary (user prompt or agent stop). */
  recordTurn(type: "user" | "agent"): void {
    this._turns.push({ type, ts: Date.now() });
  }

  /** Get snapshot for short-term window. */
  shortSnapshot(): WindowSnapshot {
    this._evict(this.shortWindow, SHORT_WINDOW_MS);
    return this._snapshot(this.shortWindow, SHORT_WINDOW_MS);
  }

  /** Get snapshot for medium-term window. */
  mediumSnapshot(): WindowSnapshot {
    this._evict(this.mediumWindow, MEDIUM_WINDOW_MS);
    return this._snapshot(this.mediumWindow, MEDIUM_WINDOW_MS);
  }

  /** Meta-level stats (entire session). */
  metaStats(): { totalEvents: number; elapsedMs: number } {
    return {
      totalEvents: this.allEvents.length,
      elapsedMs: Date.now() - this._sessionStart,
    };
  }

  /** Session-wide snapshot (all events, no eviction). For Prior Block footer. */
  sessionSnapshot(): WindowSnapshot {
    return this._snapshot(this.allEvents, Date.now() - this._sessionStart);
  }

  /** Clear (for testing). */
  clear(): void {
    this.shortWindow = [];
    this.mediumWindow = [];
    this.allEvents = [];
    this._turns = [];
    this._sessionStart = Date.now();
  }

  // ---- Internals ----

  private _evict(window: NormalizedEvent[], maxAge: number): void {
    const cutoff = Date.now() - maxAge;
    while (window.length > 0 && window[0].ts < cutoff) {
      window.shift();
    }
  }

  /** Count turns within a time window. */
  private _turnsInWindow(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    // Count "agent" stops as completed turns
    return this._turns.filter(t => t.ts >= cutoff && t.type === "agent").length;
  }

  private _snapshot(events: NormalizedEvent[], windowMs: number = SHORT_WINDOW_MS): WindowSnapshot {
    const counts: Record<NormalizedAction, number> = {
      file_read: 0,
      file_edit: 0,
      search: 0,
      shell_exec: 0,
      delegation: 0,
      memory_read: 0,
      memory_write: 0,
      user_prompt: 0,
    };

    let bashFails = 0;
    let bashTotal = 0;
    let editBashAlternation = 0;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      counts[e.action]++;

      if (e.action === "shell_exec") {
        bashTotal++;
        if (e.result === "failure") bashFails++;
      }

      // Detect Edit→Bash alternation
      if (i > 0) {
        const prev = events[i - 1];
        if (
          (prev.action === "file_edit" && e.action === "shell_exec") ||
          (prev.action === "shell_exec" && e.action === "file_edit")
        ) {
          editBashAlternation++;
        }
      }
    }

    const total = events.length;
    const bashFailRate = bashTotal > 0 ? bashFails / bashTotal : 0;
    const pattern = this._classifyPattern(counts, total, editBashAlternation, bashFailRate);
    const turns = this._turnsInWindow(windowMs);
    const toolsPerTurn = turns > 0 ? total / turns : 0;

    return { counts, total, pattern, bashFailRate, editBashAlternation, turns, toolsPerTurn };
  }

  private _classifyPattern(
    counts: Record<NormalizedAction, number>,
    total: number,
    editBashAlternation: number,
    bashFailRate: number,
  ): PatternKind {
    if (total === 0) return "stagnation";

    // Too few events for reliable classification
    if (total <= 3) return "stagnation";

    const readGrep = counts.file_read + counts.search;
    const editBash = counts.file_edit + counts.shell_exec;

    // Trial-and-error: high alternation with failures
    if (editBashAlternation >= 3 && bashFailRate > 0.4) return "trial_error";

    // Delegation: Agent calls dominate
    if (counts.delegation >= total * 0.3) return "delegation";

    // Wandering: lots of reading/searching, no edits
    if (readGrep >= total * 0.7 && counts.file_edit === 0) return "wandering";

    // Exploration: reading/searching dominant
    if (readGrep >= total * 0.6 && counts.file_edit <= total * 0.1) return "exploration";

    // Implementation: editing/executing dominant
    if (editBash >= total * 0.5) return "implementation";

    return "exploration"; // default
  }
}