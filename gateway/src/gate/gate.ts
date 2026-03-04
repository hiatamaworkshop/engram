// ============================================================
// Gate — stateless validator (Engram v2)
// ============================================================
//
// Validates capsuleSeeds structure. No compactText validation needed.

import type { IngestRequest, NodeSeed } from "../types.js";
import { SEED_CONSTRAINTS } from "./constraints.js";

export interface GateError {
  code: string;
  message: string;
}

export interface GateResult {
  valid: boolean;
  errors: GateError[];
}

/**
 * Validate an ingest request.
 */
export function validateIngest(body: IngestRequest): GateResult {
  const errors: GateError[] = [];

  if (!body) {
    errors.push({ code: "EMPTY_BODY", message: "Request body is empty." });
    return { valid: false, errors };
  }

  // ---- projectId ----
  if (!body.projectId) {
    errors.push({ code: "MISSING_PROJECT_ID", message: "projectId is required." });
  } else if (body.projectId.length > SEED_CONSTRAINTS.maxProjectIdLength) {
    errors.push({ code: "PROJECT_ID_TOO_LONG", message: `projectId too long: ${body.projectId.length} > ${SEED_CONSTRAINTS.maxProjectIdLength}.` });
  }

  // ---- capsuleSeeds ----
  if (!body.capsuleSeeds || !Array.isArray(body.capsuleSeeds) || body.capsuleSeeds.length === 0) {
    errors.push({ code: "NO_SEEDS", message: "capsuleSeeds must be a non-empty array." });
    return { valid: false, errors };
  }

  if (body.capsuleSeeds.length > 8) {
    errors.push({ code: "TOO_MANY_SEEDS", message: `Too many capsuleSeeds: ${body.capsuleSeeds.length} > 8.` });
  }

  // ---- validate each seed ----
  for (let i = 0; i < body.capsuleSeeds.length; i++) {
    const seed = body.capsuleSeeds[i];
    const prefix = `seed[${i}]`;
    validateSeed(seed, prefix, errors);
  }

  // ---- sessionId ----
  if (body.sessionId && body.sessionId.length > SEED_CONSTRAINTS.maxSessionIdLength) {
    errors.push({ code: "SESSION_ID_TOO_LONG", message: `sessionId too long: ${body.sessionId.length} > ${SEED_CONSTRAINTS.maxSessionIdLength}.` });
  }

  return { valid: errors.length === 0, errors };
}

function validateSeed(seed: NodeSeed, prefix: string, errors: GateError[]): void {
  // summary
  if (!seed.summary || seed.summary.trim().length < SEED_CONSTRAINTS.minSummaryLength) {
    errors.push({ code: "SUMMARY_TOO_SHORT", message: `${prefix}: summary too short (min ${SEED_CONSTRAINTS.minSummaryLength}).` });
  }
  if (seed.summary && seed.summary.length > SEED_CONSTRAINTS.maxSummaryLength) {
    errors.push({ code: "SUMMARY_TOO_LONG", message: `${prefix}: summary too long: ${seed.summary.length} > ${SEED_CONSTRAINTS.maxSummaryLength}.` });
  }

  // tags (optional — auto-generated if empty)
  if (seed.tags && !Array.isArray(seed.tags)) {
    errors.push({ code: "INVALID_TAGS", message: `${prefix}: tags must be an array.` });
  }
  if (seed.tags && Array.isArray(seed.tags) && seed.tags.length > SEED_CONSTRAINTS.maxTags) {
    errors.push({ code: "TOO_MANY_TAGS", message: `${prefix}: too many tags: ${seed.tags.length} > ${SEED_CONSTRAINTS.maxTags}.` });
  }

  // content
  if (seed.content && seed.content.length > SEED_CONSTRAINTS.maxContentLength) {
    errors.push({ code: "CONTENT_TOO_LONG", message: `${prefix}: content too long: ${seed.content.length} > ${SEED_CONSTRAINTS.maxContentLength}.` });
  }
}
