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
