// ============================================================
// Lightweight Amber — hitCount-based state transitions
// ============================================================
//
// fresh  → amber:   hitCount >= AMBER_THRESHOLD
// fresh  → fossil:  no recall for FOSSIL_DAYS
// amber:            permanent (never degrades)
// fossil:           LRU eviction candidate
//

import type { AmberStatus } from "./types.js";

const AMBER_THRESHOLD = 3;
const FOSSIL_DAYS = 30;
const FOSSIL_MS = FOSSIL_DAYS * 24 * 60 * 60 * 1000;

export interface AmberMeta {
  hitCount: number;
  status: AmberStatus;
  lastRecalledAt: number | null;
  createdAt: number;
}

/**
 * Evaluate next status after a recall hit.
 * Returns updated fields (hitCount, status, lastRecalledAt).
 */
export function onRecallHit(current: AmberMeta): Partial<AmberMeta> {
  const newHitCount = current.hitCount + 1;
  const now = Date.now();

  // Amber is permanent
  if (current.status === "amber") {
    return { hitCount: newHitCount, lastRecalledAt: now };
  }

  // Promote to amber
  if (newHitCount >= AMBER_THRESHOLD) {
    return { hitCount: newHitCount, status: "amber", lastRecalledAt: now };
  }

  // Stay fresh (or revive from fossil)
  return { hitCount: newHitCount, status: "fresh", lastRecalledAt: now };
}

/**
 * Check if a node should decay to fossil.
 * Called periodically or on access.
 */
export function shouldFossilize(meta: AmberMeta): boolean {
  if (meta.status === "amber") return false;

  const lastActive = meta.lastRecalledAt ?? meta.createdAt;
  return Date.now() - lastActive > FOSSIL_MS;
}

/**
 * Default amber metadata for new nodes.
 */
export function newAmberMeta(): AmberMeta {
  return {
    hitCount: 0,
    status: "fresh",
    lastRecalledAt: null,
    createdAt: Date.now(),
  };
}
