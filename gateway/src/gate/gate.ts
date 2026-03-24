// ============================================================
// Gate — stateless validator (Engram v2)
// ============================================================
//
// Validates capsuleSeeds structure. No compactText validation needed.

import type { IngestRequest, NodeSeed } from "../types.js";
import { SEED_CONSTRAINTS } from "./constraints.js";
import { getSchema, validateNative } from "../schema-registry.js";

export interface GateError {
  code: string;
  message: string;
}

export interface GateWarning {
  code: string;
  message: string;
}

export interface GateResult {
  valid: boolean;
  errors: GateError[];
  warnings?: GateWarning[];
}

/**
 * Validate an ingest request.
 */
export function validateIngest(body: IngestRequest): GateResult {
  const errors: GateError[] = [];
  const warnings: GateWarning[] = [];

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
    validateSeed(seed, prefix, errors, warnings);
  }

  // ---- sessionId ----
  if (body.sessionId && body.sessionId.length > SEED_CONSTRAINTS.maxSessionIdLength) {
    errors.push({ code: "SESSION_ID_TOO_LONG", message: `sessionId too long: ${body.sessionId.length} > ${SEED_CONSTRAINTS.maxSessionIdLength}.` });
  }

  return { valid: errors.length === 0, errors, warnings: warnings.length > 0 ? warnings : undefined };
}

function validateSeed(seed: NodeSeed, prefix: string, errors: GateError[], warnings: GateWarning[]): void {
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

  // ---- DCP validation (Phase 1: warn, not reject) ----

  if (!seed.native) {
    // No native field — DCP format recommended
    warnings.push({
      code: "DCP_RECOMMENDED",
      message: `${prefix}: DCP native format recommended. Include 'native' and 'schema' fields. See DATA_COST_PROTOCOL.md.`,
    });
  } else {
    // native provided — validate structure
    if (!Array.isArray(seed.native)) {
      errors.push({ code: "NATIVE_NOT_ARRAY", message: `${prefix}: native must be an array (DCP compact positional format).` });
    } else if (seed.schema) {
      // schema provided — validate against registry
      const schema = getSchema(seed.schema);
      const result = validateNative(seed.native, seed.schema);
      if (!result.valid) {
        // (A) Include schema definition in error so LLM can self-correct
        const schemaHint = schema
          ? ` — schema ${seed.schema}: fields=[${schema.fields.join(",")}]` +
            Object.entries(schema.types).map(([k, v]) =>
              ` ${k}:${Array.isArray(v.type) ? v.type.join("|") : v.type}${v.enum ? `(${v.enum.join("|")})` : ""}`
            ).join(",")
          : "";
        for (const err of result.errors) {
          errors.push({ code: "DCP_SCHEMA_VIOLATION", message: `${prefix}: ${err}${schemaHint}` });
        }
      }
    } else {
      // native without schema — warn
      warnings.push({
        code: "DCP_NO_SCHEMA",
        message: `${prefix}: native field present but no schema ID. Include 'schema' for validation.`,
      });
    }
  }
}
