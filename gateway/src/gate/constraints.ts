// ============================================================
// Gate — constraints (Engram v2)
// ============================================================

export const SEED_CONSTRAINTS = {
  minSummaryLength: 10,
  maxSummaryLength: 200,
  maxContentLength: 2000,
  minTags: 1,
  maxTags: 5,
  maxProjectIdLength: 128,
  maxSessionIdLength: 128,
} as const;
