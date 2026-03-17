// ============================================================
// Receptor — Sphere Shaper (anonymization + data export)
// ============================================================
// Transforms enriched centroid data into Sphere-ready payloads.
//
// Two stages:
//   1. anonymize(): strip identifying info (paths, projectId, local text)
//   2. export to sphere-ready.jsonl (structured JSON, one per line)
//
// Sphere upload itself is NOT wired here — just the data pipeline
// that produces clean, shaped output ready for future federation.
//
// Two Facade interaction patterns (both use techStack/domain for routing):
//   - push: sphere-ready.jsonl → POST /push { payload, techStack, domain } (batch upload)
//   - lookup: future_probe → POST /lookup { vector, techStack, domain } (stateless search)
// Facade resolves domain → Sphere internally (DNS-like). Agents never see
// individual Sphere endpoints — they only know the Facade URL.

import type { EnrichedCentroid, LinkedKnowledge } from "./future-probe.js";
import type { Persona } from "./persona-snapshot.js";
import type { EmotionVector, ProjectMeta } from "./types.js";
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

// ---- File export ----

const SPHERE_OUTPUT_DIR = path.join(
  process.env.ENGRAM_DATA_DIR ?? path.join(import.meta.dirname!, ".."),
  "receptor-output",
);
const SPHERE_OUTPUT_PATH = path.join(SPHERE_OUTPUT_DIR, "sphere-ready.jsonl");

/**
 * Append a shaped payload to sphere-ready.jsonl.
 * One JSON object per line — ready for batch upload when Sphere is wired.
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
 * Full pipeline: enrich → anonymize → write.
 * Skips write if linked_knowledge is empty — no fixed-node grounding = no export.
 */
export function exportEnrichedCentroid(enriched: EnrichedCentroid): SpherePayload | null {
  if (enriched.linked_knowledge.length === 0) {
    console.error("[sphere-shaper] skip: no linked_knowledge (0 fixed-node hits)");
    return null;
  }
  const payload = shapeForSphere(enriched);
  writeSpherePayload(payload);
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
 * Full pipeline: validate → shape → write.
 * Persona must have ≥2 snapshots to be worth exporting.
 */
export function exportPersona(persona: Persona): PersonaPayload | null {
  if (persona.sessionMeta.snapshotCount < 2) {
    console.error("[sphere-shaper] persona skip: insufficient snapshots");
    return null;
  }

  const payload = shapePersonaForSphere(persona);

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

  return payload;
}
