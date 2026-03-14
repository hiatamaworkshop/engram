// ============================================================
// Receptor — Command Counter (time-window driven)
// ============================================================
// Counts tool call types within sliding time windows.
// Classifies patterns: exploration, implementation, trial-and-error, etc.
// Provides "what is the agent doing" signal to emotion system.

import type { NormalizedAction, NormalizedEvent, TimeWindow } from "./types.js";

// ---- Time window durations ----

const SHORT_WINDOW_MS = 300_000;     // 5 minutes — spike detection
const MEDIUM_WINDOW_MS = 1_800_000;  // 30 minutes — trend detection
// Meta window = entire session (no eviction)

export type PatternKind =
  | "exploration"     // Read+Grep high, Edit low → hunger
  | "implementation"  // Edit+Bash high, Grep low → flow/confidence
  | "trial_error"     // Edit→Bash alternating → frustration
  | "wandering"       // Grep+Read high, Edit 0 → uncertainty
  | "delegation"      // Agent high → isolation
  | "stagnation";     // all low → fatigue

export interface WindowSnapshot {
  counts: Record<NormalizedAction, number>;
  total: number;
  pattern: PatternKind;
  bashFailRate: number;
  editBashAlternation: number;
}

export class Commander {
  private shortWindow: NormalizedEvent[] = [];
  private mediumWindow: NormalizedEvent[] = [];
  private allEvents: NormalizedEvent[] = [];
  private _sessionStart = Date.now();

  /** Record an event into all windows. */
  record(event: NormalizedEvent): void {
    this.shortWindow.push(event);
    this.mediumWindow.push(event);
    this.allEvents.push(event);
  }

  /** Get snapshot for short-term window. */
  shortSnapshot(): WindowSnapshot {
    this._evict(this.shortWindow, SHORT_WINDOW_MS);
    return this._snapshot(this.shortWindow);
  }

  /** Get snapshot for medium-term window. */
  mediumSnapshot(): WindowSnapshot {
    this._evict(this.mediumWindow, MEDIUM_WINDOW_MS);
    return this._snapshot(this.mediumWindow);
  }

  /** Meta-level stats (entire session). */
  metaStats(): { totalEvents: number; elapsedMs: number } {
    return {
      totalEvents: this.allEvents.length,
      elapsedMs: Date.now() - this._sessionStart,
    };
  }

  /** Clear (for testing). */
  clear(): void {
    this.shortWindow = [];
    this.mediumWindow = [];
    this.allEvents = [];
    this._sessionStart = Date.now();
  }

  // ---- Internals ----

  private _evict(window: NormalizedEvent[], maxAge: number): void {
    const cutoff = Date.now() - maxAge;
    while (window.length > 0 && window[0].ts < cutoff) {
      window.shift();
    }
  }

  private _snapshot(events: NormalizedEvent[]): WindowSnapshot {
    const counts: Record<NormalizedAction, number> = {
      file_read: 0,
      file_edit: 0,
      search: 0,
      shell_exec: 0,
      delegation: 0,
      memory_read: 0,
      memory_write: 0,
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

    return { counts, total, pattern, bashFailRate, editBashAlternation };
  }

  private _classifyPattern(
    counts: Record<NormalizedAction, number>,
    total: number,
    editBashAlternation: number,
    bashFailRate: number,
  ): PatternKind {
    if (total === 0) return "stagnation";

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

    // Stagnation: very few events
    if (total <= 2) return "stagnation";

    return "exploration"; // default
  }
}