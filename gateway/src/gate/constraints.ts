// ============================================================
// Gate — constraints (Engram v2)
// ============================================================
//
// Seed-level constraints. Compact text validation removed.

export const SEED_CONSTRAINTS = {
  minSummaryLength: 10,
  maxSummaryLength: 200,
  maxContentLength: 2000,
  minTags: 1,
  maxTags: 5,
} as const;

/** Low quality summary patterns — reject these */
export const LOW_QUALITY_PATTERNS: readonly RegExp[] = [
  /^(.)\1{10,}$/,               // repeated chars
  /^[\s\n\r\t]+$/,              // whitespace only
  /^[.\-_=*#]{10,}$/,           // decoration only
];
