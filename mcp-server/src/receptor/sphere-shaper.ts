// ============================================================
// Receptor — Sphere Shaper (anonymization + data export)
// ============================================================
// Transforms enriched centroid data into Sphere-ready payloads.
//
// Three stages:
//   1. anonymize(): strip identifying info (paths, projectId, local text)
//   2. shape → ExperienceCapsule (Sphere submission format)
//   3. push to Facade /push (HTTP) with JSONL fallback
//
// Two Facade interaction patterns (both use techStack/domain for routing):
//   - push: SpherePayload → ExperienceCapsule → POST /push (this file)
//   - lookup: future_probe → POST /lookup (handled in future-probe.ts)
// Facade resolves domain → Sphere internally (DNS-like). Agents never see
// individual Sphere endpoints — they only know the Facade URL.

import type { EnrichedCentroid, LinkedKnowledge } from "./future-probe.js";
import type { Persona } from "./persona-snapshot.js";
import type { EmotionVector, ProjectMeta } from "./types.js";
import {
  CAPSULE_SCHEMA_VERSION,
  createEmptyCapsule,
  type ExperienceCapsule,
  type NodeSeed,
} from "./sphere-capsule.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- Anonymized centroid (what leaves the machine) ----

export interface SpherePayload {
  centroid_embedding: number[];
  emotion_avg: Partial<EmotionVector>;
  entropy_range: [number, number];
  pattern: string;            // state transitions only (no paths)
  outcome: string;
  linked_knowledge: LinkedKnowledge[];
  window_size: number;
  alpha: number;
  ts: number;
  version: number;            // schema version for forward compat
  // Facade routing metadata — categorical, not identifying
  techStack?: string[];       // from ProjectMeta
  domain?: string[];          // from ProjectMeta
}

const SCHEMA_VERSION = 2;

// ---- Anonymization ----

/** Regex patterns that indicate local/identifying content. */
const PATH_PATTERN = /(?:[A-Za-z]:)?(?:\/|\\)[\w\-./\\]+/g;
const PROJECT_ID_PATTERN = /projectId[=:]\s*["']?[\w\-./]+["']?/gi;

/**
 * Scrub a text field of file paths and projectId references.
 * Replaces full paths with last 2 segments (preserving semantic meaning).
 */
function scrubText(text: string): string {
  return text
    .replace(PATH_PATTERN, (match) => {
      const segs = match.replace(/\\/g, "/").split("/").filter(Boolean);
      return segs.length <= 2 ? segs.join("/") : segs.slice(-2).join("/");
    })
    .replace(PROJECT_ID_PATTERN, "");
}

/**
 * Scrub linked knowledge summaries of identifying content.
 */
function scrubLinkedKnowledge(linked: LinkedKnowledge[]): LinkedKnowledge[] {
  return linked.map(lk => ({
    summary: scrubText(lk.summary),
    tags: lk.tags.filter(t => !isIdentifyingTag(t)),
    similarity: lk.similarity,
  }));
}

/** Tags that are likely project-specific identifiers. */
function isIdentifyingTag(tag: string): boolean {
  // Keep generic knowledge-type tags, filter project-specific ones
  const safePatterns = [
    "howto", "where", "why", "gotcha",
    "gateway", "mcp-server", "receptor", "docker",
    "qdrant", "embedding", "passive", "centroid",
    "future-probe", "action-logger", "error-resolved",
  ];
  return !safePatterns.includes(tag) && /[A-Z]/.test(tag);
}

/**
 * Validate that a pattern string contains only state transitions.
 * Pattern should be like "stuck→exploring→deep_work", not contain paths.
 */
function scrubPattern(pattern: string): string {
  // State names are safe; scrub anything that looks like a path
  return scrubText(pattern);
}

// ---- Project metadata (optional, for Facade routing) ----

let _projectMeta: ProjectMeta | null = null;

/**
 * Set project metadata for Sphere routing.
 * Called once at startup from index.ts or config.
 * techStack/domain are categorical — they survive anonymization.
 */
export function setProjectMeta(meta: ProjectMeta): void {
  _projectMeta = meta;
}

export function getProjectMeta(): ProjectMeta | null {
  return _projectMeta;
}

// ---- Shaping: EnrichedCentroid → SpherePayload ----

/**
 * Transform an enriched centroid into an anonymized Sphere payload.
 * Attaches techStack/domain from ProjectMeta if available (for Facade routing).
 */
export function shapeForSphere(enriched: EnrichedCentroid): SpherePayload {
  const payload: SpherePayload = {
    centroid_embedding: enriched.centroid_embedding,
    emotion_avg: enriched.emotion_avg,
    entropy_range: enriched.entropy_range,
    pattern: scrubPattern(enriched.pattern),
    outcome: enriched.outcome,
    linked_knowledge: scrubLinkedKnowledge(enriched.linked_knowledge),
    window_size: enriched.window_size,
    alpha: enriched.alpha,
    ts: enriched.ts,
    version: SCHEMA_VERSION,
  };

  if (_projectMeta) {
    if (_projectMeta.techStack.length > 0) payload.techStack = _projectMeta.techStack;
    if (_projectMeta.domain.length > 0) payload.domain = _projectMeta.domain;
  }

  return payload;
}

// ---- SpherePayload → ExperienceCapsule conversion ----

/**
 * Derive initialHeat from emotion intensity.
 * High emotion = high heat (more likely to survive in Sphere).
 * Range: 20 (calm) – 80 (intense).
 */
function deriveHeat(emotionAvg: Partial<EmotionVector>): number {
  const vals = [
    emotionAvg.frustration ?? 0,
    emotionAvg.seeking ?? 0,
    emotionAvg.confidence ?? 0,
    emotionAvg.fatigue ?? 0,
    emotionAvg.flow ?? 0,
  ];
  const mag = Math.sqrt(vals.reduce((s, v) => s + v * v, 0));
  return Math.round(20 + Math.min(1, mag) * 60);
}

/**
 * Convert SpherePayload → ExperienceCapsule for Sphere /sphere/contribute.
 *
 * Mapping:
 *   - topTier[0]: centroid summary (pattern + outcome + emotion digest)
 *   - normalNodes: linked_knowledge items (each becomes a NodeSeed)
 *   - ghostNodes: empty
 *   - evaluations: empty (centroid is contribution, not evaluation)
 */
export function toCapsule(payload: SpherePayload): ExperienceCapsule {
  const capsule = createEmptyCapsule();
  capsule.timestamp = payload.ts;

  // Centroid itself as top-tier node
  const emotionDigest = Object.entries(payload.emotion_avg)
    .filter(([, v]) => v !== undefined && Math.abs(v) > 0.1)
    .map(([k, v]) => `${k}:${v!.toFixed(1)}`)
    .join(" ");

  const centroidSeed: NodeSeed = {
    tags: [...(payload.techStack ?? []), ...(payload.domain ?? [])],
    summary: `${payload.pattern} → ${payload.outcome} [${emotionDigest}]`,
    content: JSON.stringify({
      entropy_range: payload.entropy_range,
      window_size: payload.window_size,
      alpha: payload.alpha,
      version: payload.version,
    }),
    flags: 0,
  };
  capsule.topTier.push(centroidSeed);

  // Linked knowledge as normal nodes
  for (const lk of payload.linked_knowledge) {
    const seed: NodeSeed = {
      tags: lk.tags,
      summary: lk.summary,
      flags: 0,
    };
    capsule.normalNodes.push(seed);
  }

  return capsule;
}

/**
 * Convert PersonaPayload → ExperienceCapsule.
 * Persona is a behavioral fingerprint — single normal node.
 */
export function personaToCapsule(payload: PersonaPayload): ExperienceCapsule {
  const capsule = createEmptyCapsule();
  capsule.timestamp = payload.ts;

  const p = payload.persona;
  const seed: NodeSeed = {
    tags: [
      "persona",
      ...(payload.techStack ?? []),
      ...(payload.domain ?? []),
    ],
    summary: `persona: ${p.emotionProfile.dominantAxis} dominant, confidence=${p.emotionProfile.meanEmotion.confidence.toFixed(2)}`,
    content: JSON.stringify(p),
    flags: 0,
  };
  capsule.normalNodes.push(seed);

  return capsule;
}

// ---- Facade HTTP push ----

/**
 * Push a capsule to Facade /push.
 * Returns true if accepted, false on failure (caller falls back to JSONL).
 */
async function pushToFacade(capsule: ExperienceCapsule): Promise<boolean> {
  const facadeUrl = _projectMeta?.facadeUrl;
  if (!facadeUrl) return false;

  try {
    const res = await fetch(`${facadeUrl}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capsule,
        source: "engram-receptor",
        techStack: _projectMeta?.techStack ?? [],
        domain: _projectMeta?.domain ?? [],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { accepted?: number };
      console.error(`[sphere-shaper] facade push ok: accepted=${data.accepted ?? "?"}`);
      return true;
    }
    console.error(`[sphere-shaper] facade push rejected: ${res.status}`);
    return false;
  } catch (err) {
    console.error("[sphere-shaper] facade push error:", err);
    return false;
  }
}

// ---- File export (JSONL fallback) ----

const SPHERE_OUTPUT_DIR = path.join(
  process.env.ENGRAM_DATA_DIR ?? path.join(import.meta.dirname!, ".."),
  "receptor-output",
);
const SPHERE_OUTPUT_PATH = path.join(SPHERE_OUTPUT_DIR, "sphere-ready.jsonl");

/**
 * Append a shaped payload to sphere-ready.jsonl.
 * Used as fallback when Facade is unreachable.
 */
export function writeSpherePayload(payload: SpherePayload): void {
  try {
    fs.mkdirSync(SPHERE_OUTPUT_DIR, { recursive: true });
    fs.appendFileSync(SPHERE_OUTPUT_PATH, JSON.stringify(payload) + "\n");
    console.error(
      `[sphere-shaper] wrote payload: pattern=${payload.pattern} linked=${payload.linked_knowledge.length} v=${SCHEMA_VERSION}`,
    );
  } catch (err) {
    console.error("[sphere-shaper] write error:", err);
  }
}

/**
 * Full pipeline: enrich → anonymize → capsule → push (HTTP with JSONL fallback).
 * Skips export if linked_knowledge is empty — no fixed-node grounding = no export.
 */
export async function exportEnrichedCentroid(enriched: EnrichedCentroid): Promise<SpherePayload | null> {
  if (enriched.linked_knowledge.length === 0) {
    console.error("[sphere-shaper] skip: no linked_knowledge (0 fixed-node hits)");
    return null;
  }
  const payload = shapeForSphere(enriched);
  const capsule = toCapsule(payload);

  const pushed = await pushToFacade(capsule);
  if (!pushed) {
    writeSpherePayload(payload);
  }
  return payload;
}

// ============================================================
// Persona export — statistical fingerprint → sphere-ready.jsonl
// ============================================================
// Accepted data types: EnrichedCentroid, Persona.
// Anything else is rejected. Attachments must conform to these formats.

/** Persona payload wrapper for sphere-ready.jsonl. */
export interface PersonaPayload {
  type: "persona";
  persona: Persona;
  ts: number;
  version: number;
  techStack?: string[];
  domain?: string[];
}

/**
 * Shape a Persona for Sphere export.
 * Persona is already anonymized by design (no paths, no projectId, only metrics).
 * Attaches techStack/domain from ProjectMeta for routing.
 */
function shapePersonaForSphere(persona: Persona): PersonaPayload {
  const payload: PersonaPayload = {
    type: "persona",
    persona,
    ts: persona.ts,
    version: SCHEMA_VERSION,
  };

  if (_projectMeta) {
    if (_projectMeta.techStack.length > 0) payload.techStack = _projectMeta.techStack;
    if (_projectMeta.domain.length > 0) payload.domain = _projectMeta.domain;
  }

  return payload;
}

/**
 * Full pipeline: validate → shape → capsule → push (HTTP with JSONL fallback).
 * Persona must have ≥2 snapshots to be worth exporting.
 */
export async function exportPersona(persona: Persona): Promise<PersonaPayload | null> {
  if (persona.sessionMeta.snapshotCount < 2) {
    console.error("[sphere-shaper] persona skip: insufficient snapshots");
    return null;
  }

  const payload = shapePersonaForSphere(persona);
  const capsule = personaToCapsule(payload);

  const pushed = await pushToFacade(capsule);
  if (!pushed) {
    try {
      fs.mkdirSync(SPHERE_OUTPUT_DIR, { recursive: true });
      fs.appendFileSync(SPHERE_OUTPUT_PATH, JSON.stringify(payload) + "\n");
      console.error(
        `[sphere-shaper] wrote persona: dominant=${persona.emotionProfile.dominantAxis} ` +
        `snaps=${persona.sessionMeta.snapshotCount}`,
      );
    } catch (err) {
      console.error("[sphere-shaper] persona write error:", err);
    }
  }

  return payload;
}
