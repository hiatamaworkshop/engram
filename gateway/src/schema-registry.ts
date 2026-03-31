/**
 * DCP Schema Registry — loads schema definitions from gateway/schemas/
 * and provides validation + lookup by schema ID.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = resolve(__dirname, "..", "schemas");

export interface DcpSchema {
  $dcp: "schema";
  id: string;
  description: string;
  fields: string[];
  fieldCount: number;
  types: Record<string, SchemaFieldType>;
  examples?: unknown[][];
}

export interface SchemaFieldType {
  type: string | string[];
  enum?: (string | number)[];
  min?: number;
  max?: number;
  length?: number;
  items?: string;
  description?: string;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

// ── Registry singleton ──────────────────────────────────────────

const registry = new Map<string, DcpSchema>();

export function loadSchemas(): void {
  registry.clear();
  let files: string[];
  try {
    files = readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    console.warn("[schema-registry] schemas/ directory not found, skipping");
    return;
  }

  for (const file of files) {
    try {
      const raw = readFileSync(resolve(SCHEMAS_DIR, file), "utf-8");
      const schema = JSON.parse(raw) as DcpSchema;
      if (schema.$dcp === "schema" && schema.id) {
        registry.set(schema.id, schema);
      }
    } catch (e) {
      console.warn(`[schema-registry] failed to load ${file}:`, e);
    }
  }

  console.log(
    `[schema-registry] loaded ${registry.size} schemas: ${[...registry.keys()].join(", ")}`,
  );
}

export function getSchema(id: string): DcpSchema | undefined {
  return registry.get(id);
}

export function listSchemas(): string[] {
  return [...registry.keys()];
}

// ── Interactive Schema — abbreviated / expanded hints ────────────

/**
 * Generate a short hash from schema content for abbreviated reference.
 * 4 hex chars (~65k space) — enough for schema identity, not security.
 */
function schemaHash(schema: DcpSchema): string {
  const raw = schema.id + schema.fields.join(",");
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  }
  return ((h >>> 0) & 0xffff).toString(16).padStart(4, "0");
}

/**
 * Stage 0: Compliant push — minimal abbreviated reference.
 * ~10 tokens in agent context. Peripheral vision only.
 * e.g. "$S:knowledge:v1#a3f2 [expand:GET /schemas/knowledge:v1]"
 */
export function abbreviatedHint(schemaId: string): string | null {
  const schema = registry.get(schemaId);
  if (!schema) return null;
  const hash = schemaHash(schema);
  return `$S:${schemaId}#${hash} [expand:GET /schemas/${schemaId}]`;
}

/**
 * Stage 1: Non-compliant push — abbreviated + field summary.
 * Shows fields and key type info so agent can self-correct on next push.
 * e.g. "$S:knowledge:v1#a3f2 [action(add|replace|...) domain detail confidence:0-1] [expand:GET /schemas/knowledge:v1]"
 */
export function expandedHint(schemaId: string): string | null {
  const schema = registry.get(schemaId);
  if (!schema) return null;
  const hash = schemaHash(schema);

  const fieldDescs = schema.fields.map((f) => {
    const t = schema.types[f];
    if (!t) return f;
    if (t.enum) return `${f}(${t.enum.join("|")})`;
    if (t.min !== undefined && t.max !== undefined) return `${f}:${t.min}-${t.max}`;
    return f;
  });

  return `$S:${schemaId}#${hash} [${fieldDescs.join(" ")}] [expand:GET /schemas/${schemaId}]`;
}

/**
 * Determine which hint to return based on push compliance.
 * @param seeds - the pushed seeds
 * @param defaultSchemaId - fallback schema ID (e.g. "knowledge:v1")
 */
export function determineSchemaHint(
  seeds: Array<{ native?: unknown[]; schema?: string }>,
  defaultSchemaId: string = "knowledge:v1",
): string | null {
  // Check if ALL seeds have valid native + schema
  const allCompliant = seeds.every((s) => s.native && Array.isArray(s.native) && s.schema);

  if (allCompliant) {
    // Stage 0: abbreviated only — minimal cost
    const schemaId = seeds[0].schema || defaultSchemaId;
    return abbreviatedHint(schemaId);
  }

  // Stage 1: expanded — show fields so agent learns
  return expandedHint(defaultSchemaId);
}

// ── Validation ──────────────────────────────────────────────────

export function validateNative(
  native: unknown[],
  schemaId: string,
): SchemaValidationResult {
  const schema = registry.get(schemaId);
  if (!schema) {
    return { valid: false, errors: [`unknown schema: ${schemaId}`] };
  }

  const errors: string[] = [];

  // field count check
  if (native.length !== schema.fieldCount) {
    errors.push(
      `field count mismatch: expected ${schema.fieldCount}, got ${native.length}`,
    );
  }

  // per-field type check (best effort, not exhaustive)
  const checkLen = Math.min(native.length, schema.fields.length);
  for (let i = 0; i < checkLen; i++) {
    const fieldName = schema.fields[i];
    const fieldType = schema.types[fieldName];
    const value = native[i];
    if (!fieldType) continue;

    const err = validateField(value, fieldType, fieldName);
    if (err) errors.push(err);
  }

  return { valid: errors.length === 0, errors };
}

function validateField(
  value: unknown,
  fieldType: SchemaFieldType,
  fieldName: string,
): string | null {
  // null check for union types
  if (value === null) {
    const types = Array.isArray(fieldType.type)
      ? fieldType.type
      : [fieldType.type];
    if (types.includes("null")) return null;
    return `${fieldName}: null not allowed`;
  }

  const actualType = typeof value;
  const allowedTypes = Array.isArray(fieldType.type)
    ? fieldType.type
    : [fieldType.type];

  // type check
  if (actualType === "object" && Array.isArray(value)) {
    if (!allowedTypes.includes("array")) {
      return `${fieldName}: expected ${allowedTypes.join("|")}, got array`;
    }
    if (fieldType.length !== undefined && value.length !== fieldType.length) {
      return `${fieldName}: expected array length ${fieldType.length}, got ${value.length}`;
    }
    return null;
  }

  if (actualType === "object" && !Array.isArray(value)) {
    if (!allowedTypes.includes("object")) {
      return `${fieldName}: expected ${allowedTypes.join("|")}, got object`;
    }
    return null;
  }

  if (!allowedTypes.includes(actualType)) {
    return `${fieldName}: expected ${allowedTypes.join("|")}, got ${actualType}`;
  }

  // enum check
  if (fieldType.enum && !fieldType.enum.includes(value as string | number)) {
    return `${fieldName}: value "${value}" not in enum [${fieldType.enum.join(", ")}]`;
  }

  // range check for numbers
  if (actualType === "number") {
    if (fieldType.min !== undefined && (value as number) < fieldType.min) {
      return `${fieldName}: ${value} < min ${fieldType.min}`;
    }
    if (fieldType.max !== undefined && (value as number) > fieldType.max) {
      return `${fieldName}: ${value} > max ${fieldType.max}`;
    }
  }

  return null;
}
