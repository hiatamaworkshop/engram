// ============================================================
// Receptor — Subsystem FIFO
// ============================================================
// Generic ring buffer for subsystem execution results.
// One-line format: systemName | functionType | timestamp | message
//
// Capacity: 20 entries (configurable).
// Hotmemo: shows only unseen entries (shownAt marker).
// engram_watch: shows all entries regardless.

// ---- Types ----

interface FifoEntry {
  system: string;
  fn: string;
  ts: number;
  message: string;
  shownAt: number;  // 0 = unseen
}

export interface SubsystemEntry {
  system: string;
  fn: string;
  ts: number;
  message: string;
}

// ---- Constants ----

const FIFO_CAPACITY = 20;

// ---- State ----

let _fifo: FifoEntry[] = [];

// ---- Push ----

/**
 * Push a subsystem result into the FIFO.
 * Oldest entry is dropped when capacity is reached.
 */
export function pushSubsystemResult(entry: SubsystemEntry): void {
  _fifo.push({ ...entry, shownAt: 0 });
  if (_fifo.length > FIFO_CAPACITY) _fifo.shift();
}

// ---- Read ----

/**
 * Format unseen entries for hotmemo display (max displayLimit).
 * Marks returned entries as shown. Returns empty string if nothing new.
 */
export function formatSubsystemResults(displayLimit = 5): string {
  const unseen = _fifo.filter(e => e.shownAt === 0);
  if (unseen.length === 0) return "";

  const now = Date.now();
  const shown = unseen.slice(-displayLimit);
  for (const e of shown) e.shownAt = now;

  return shown.map(e => formatLine(e)).join("\n");
}

/**
 * Get all entries (for detailed inspection / engram_watch).
 */
export function allSubsystemResults(): SubsystemEntry[] {
  return _fifo.map(({ shownAt: _, ...rest }) => rest);
}

/**
 * Number of entries currently stored.
 */
export function subsystemCount(): number {
  return _fifo.length;
}

// ---- Clear ----

/** Clear all entries (e.g. on watch restart). */
export function clearSubsystem(): void {
  _fifo = [];
}

// ---- Format ----

function formatLine(e: FifoEntry): string {
  const ts = new Date(e.ts).toISOString().replace("T", " ").slice(0, 19);
  return `${e.system} | ${e.fn} | ${ts} | ${e.message}`;
}