// ============================================================
// Gate — stateless validator (Periphery Membrane パターン)
// ============================================================
//
// 「処理する価値があるか」を構造判定する膜。
// LLM 不使用。constraints.ts の定義に準拠。
// 全チェックを走査し、エラーを収集して返す (fail-fast ではない)。

import type { IngestRequest } from "../types.js";
import {
  COMPACT_CONSTRAINTS,
  META_CONSTRAINTS,
  TEMPLATE_PATTERNS,
  LOW_QUALITY_PATTERNS,
  GATE_ERROR_CODES,
  type GateErrorCode,
} from "./constraints.js";

export interface GateError {
  code: GateErrorCode;
  message: string;
}

export interface GateResult {
  valid: boolean;
  errors: GateError[];
  /** sanitize 済みの compactText (trim + 超過切り詰め) */
  sanitizedText?: string;
}

const VALID_OUTCOMES = new Set(["completed", "abandoned", "partial"]);

/**
 * Validate an ingest request against Gate constraints.
 * Returns all errors (not just the first).
 */
export function validateIngest(body: IngestRequest): GateResult {
  const errors: GateError[] = [];

  // ---- body existence ----
  if (!body || (!body.compactText && !body.meta)) {
    errors.push({ code: GATE_ERROR_CODES.EMPTY_BODY, message: "Request body is empty or missing required fields." });
    return { valid: false, errors };
  }

  const raw = body.compactText ?? "";
  const trimmed = raw.trim();
  const meta = body.meta;

  // ---- compact text: length ----
  if (trimmed.length < COMPACT_CONSTRAINTS.minLength) {
    errors.push({
      code: GATE_ERROR_CODES.COMPACT_TOO_SHORT,
      message: `Compact text too short: ${trimmed.length} < ${COMPACT_CONSTRAINTS.minLength} chars.`,
    });
  }

  if (trimmed.length > COMPACT_CONSTRAINTS.maxLength) {
    errors.push({
      code: GATE_ERROR_CODES.COMPACT_TOO_LONG,
      message: `Compact text too long: ${trimmed.length} > ${COMPACT_CONSTRAINTS.maxLength} chars. Will be truncated.`,
    });
  }

  // ---- compact text: payload bytes ----
  const byteLength = Buffer.byteLength(trimmed, "utf-8");
  if (byteLength > COMPACT_CONSTRAINTS.maxPayloadBytes) {
    errors.push({
      code: GATE_ERROR_CODES.PAYLOAD_TOO_LARGE,
      message: `Payload too large: ${byteLength} > ${COMPACT_CONSTRAINTS.maxPayloadBytes} bytes.`,
    });
  }

  // ---- compact text: template detection ----
  if (TEMPLATE_PATTERNS.some((p) => p.test(trimmed))) {
    errors.push({
      code: GATE_ERROR_CODES.TEMPLATE_CONTENT,
      message: "Compact text appears to be a template with no real content.",
    });
  }

  // ---- compact text: low quality ----
  if (LOW_QUALITY_PATTERNS.some((p) => p.test(trimmed))) {
    errors.push({
      code: GATE_ERROR_CODES.LOW_QUALITY_CONTENT,
      message: "Compact text has no information content.",
    });
  }

  // ---- meta: required fields ----
  if (!meta?.projectId) {
    errors.push({ code: GATE_ERROR_CODES.MISSING_PROJECT_ID, message: "meta.projectId is required." });
  }
  if (!meta?.sessionId) {
    errors.push({ code: GATE_ERROR_CODES.MISSING_SESSION_ID, message: "meta.sessionId is required." });
  }
  if (!meta?.timestamp) {
    errors.push({ code: GATE_ERROR_CODES.MISSING_TIMESTAMP, message: "meta.timestamp is required." });
  }

  // ---- meta: field bounds ----
  if (meta?.projectId && meta.projectId.length > META_CONSTRAINTS.maxProjectIdLength) {
    errors.push({
      code: GATE_ERROR_CODES.PROJECT_ID_TOO_LONG,
      message: `projectId too long: ${meta.projectId.length} > ${META_CONSTRAINTS.maxProjectIdLength}.`,
    });
  }

  if (meta?.sessionId && meta.sessionId.length > META_CONSTRAINTS.maxSessionIdLength) {
    errors.push({
      code: GATE_ERROR_CODES.SESSION_ID_TOO_LONG,
      message: `sessionId too long: ${meta.sessionId.length} > ${META_CONSTRAINTS.maxSessionIdLength}.`,
    });
  }

  if (meta?.timestamp && meta.timestamp < META_CONSTRAINTS.minTimestamp) {
    errors.push({
      code: GATE_ERROR_CODES.INVALID_TIMESTAMP,
      message: `timestamp too old: ${meta.timestamp} < ${META_CONSTRAINTS.minTimestamp} (2020-01-01).`,
    });
  }

  // ---- meta: optional array bounds ----
  if (meta?.filesModified) {
    if (meta.filesModified.length > META_CONSTRAINTS.maxFilesModified) {
      errors.push({
        code: GATE_ERROR_CODES.TOO_MANY_FILES,
        message: `Too many filesModified: ${meta.filesModified.length} > ${META_CONSTRAINTS.maxFilesModified}.`,
      });
    }
    for (const f of meta.filesModified) {
      if (f.length > META_CONSTRAINTS.maxFilePathLength) {
        errors.push({
          code: GATE_ERROR_CODES.FILE_PATH_TOO_LONG,
          message: `File path too long: ${f.length} > ${META_CONSTRAINTS.maxFilePathLength}.`,
        });
        break; // 1つ報告すれば十分
      }
    }
  }

  if (meta?.commitMessages) {
    if (meta.commitMessages.length > META_CONSTRAINTS.maxCommitMessages) {
      errors.push({
        code: GATE_ERROR_CODES.TOO_MANY_COMMITS,
        message: `Too many commitMessages: ${meta.commitMessages.length} > ${META_CONSTRAINTS.maxCommitMessages}.`,
      });
    }
    for (const m of meta.commitMessages) {
      if (m.length > META_CONSTRAINTS.maxCommitMessageLength) {
        errors.push({
          code: GATE_ERROR_CODES.COMMIT_MESSAGE_TOO_LONG,
          message: `Commit message too long: ${m.length} > ${META_CONSTRAINTS.maxCommitMessageLength}.`,
        });
        break;
      }
    }
  }

  if (meta?.gitDiffStat && meta.gitDiffStat.length > META_CONSTRAINTS.maxGitDiffStatLength) {
    errors.push({
      code: GATE_ERROR_CODES.COMMIT_MESSAGE_TOO_LONG,
      message: `gitDiffStat too long: ${meta.gitDiffStat.length} > ${META_CONSTRAINTS.maxGitDiffStatLength}.`,
    });
  }

  if (meta?.outcome && !VALID_OUTCOMES.has(meta.outcome)) {
    errors.push({
      code: GATE_ERROR_CODES.INVALID_OUTCOME,
      message: `Invalid outcome: "${meta.outcome}". Must be completed | abandoned | partial.`,
    });
  }

  // ---- result ----
  const sanitizedText = trimmed.slice(0, COMPACT_CONSTRAINTS.maxLength);

  return {
    valid: errors.length === 0,
    errors,
    sanitizedText: errors.length === 0 ? sanitizedText : undefined,
  };
}
