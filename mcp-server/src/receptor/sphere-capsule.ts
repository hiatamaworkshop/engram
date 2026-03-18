// ============================================================
// Sphere Capsule Schema (imported from sphere-original)
// ============================================================
// Source: sphere-original/services/periphery/src/types/capsule.ts
// Schema version: 4 (L1-L4 hierarchy)
//
// This is a local copy of the Sphere submission format.
// engram uses this to shape SpherePayload → ExperienceCapsule
// before sending to Facade /push → Sphere /sphere/contribute.
//
// If Sphere schema changes, update CAPSULE_SCHEMA_VERSION and
// the interfaces below to match.

export const CAPSULE_SCHEMA_VERSION = 4;

/**
 * Node Seed: Pre-incarnation node data.
 *
 * Access Level Hierarchy:
 *   L1: tags (header) — spatial coordinates (vectorized by Sphere)
 *   L2: summary — headline (sensed from afar)
 *   L3: content — main detail (read when focused)
 *   L4: sourceNodeId, links, ref_url — references
 */
export interface NodeSeed {
  tags: string[];
  summary: string;
  content?: string;
  sourceNodeId?: string;
  links?: string[];
  ref_url?: string;
  flags: number;            // 16-bit NodeFlag
}

/**
 * Node Evaluation: Score for existing node (no new content).
 * h/w/d: 0-10 scale, neutral = 5.
 */
export interface NodeEvaluation {
  nodeId: string;
  h: number;                // heat
  w: number;                // weight
  d: number;                // decay (higher = faster)
  context?: string;
}

/**
 * Experience Capsule: Container for agent contributions.
 *
 * Constraints:
 *   - topTier: max 2 nodes
 *   - normalNodes: max 10 nodes
 *   - ghostNodes: max 3 nodes
 *   - total payload: max 8192 bytes
 */
export interface ExperienceCapsule {
  schemaVersion: number;
  topTier: NodeSeed[];
  normalNodes: NodeSeed[];
  ghostNodes: NodeSeed[];
  evaluations: NodeEvaluation[];
  timestamp: number;
}

/**
 * Create an empty capsule with correct schema version.
 */
export function createEmptyCapsule(): ExperienceCapsule {
  return {
    schemaVersion: CAPSULE_SCHEMA_VERSION,
    topTier: [],
    normalNodes: [],
    ghostNodes: [],
    evaluations: [],
    timestamp: Date.now(),
  };
}