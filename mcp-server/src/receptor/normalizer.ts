// ============================================================
// Receptor — Environment Mapper (Agent Framework Normalizer)
// ============================================================
// Translates framework-specific tool names into normalized events.
// receptor modules only see NormalizedEvent — never raw tool names.
//
// Currently supports: Claude Code hooks
// Future: Cursor, custom agents (swap mapping config)

import type { NormalizedAction, NormalizedEvent } from "./types.js";

// ---- Claude Code hook mapping ----

const CLAUDE_CODE_MAP: Record<string, NormalizedAction> = {
  Read: "file_read",
  Edit: "file_edit",
  Write: "file_edit",
  MultiEdit: "file_edit",
  Grep: "search",
  Glob: "search",
  Bash: "shell_exec",
  Agent: "delegation",
  // engram tools are detected by prefix in normalize()
};

// ---- Raw hook event (from Claude Code hook shell script) ----

export interface RawHookEvent {
  tool_name: string;
  tool_input?: Record<string, unknown>;
  exit_code?: number;
  // Claude Code hooks provide these fields
  prompt_content?: string;  // UserPromptSubmit: raw user text (used for length only)
}

// ---- Event ID (session-scoped monotonic counter) ----

let _nextEventId = 1;

// ---- Dialogue tracking state ----

const PROMPT_MIN_LENGTH = 40; // cutoff: ignore short directives and acknowledgments
let _lastPromptTs = 0;

// ---- Normalize ----

export function normalize(raw: RawHookEvent): NormalizedEvent | null {
  const { tool_name, tool_input, exit_code } = raw;
  const eventId = _nextEventId++;

  // UserPromptSubmit → user_prompt (dialogue input)
  if (tool_name === "UserPromptSubmit") {
    const content = raw.prompt_content ?? (tool_input?.content as string) ?? "";
    const length = content.length;
    if (length < PROMPT_MIN_LENGTH) return null; // cutoff

    const now = Date.now();
    const interval = _lastPromptTs > 0 ? now - _lastPromptTs : 0;
    _lastPromptTs = now;

    return {
      eventId,
      action: "user_prompt",
      ts: now,
      result: "success",
      promptLength: length,
      turnInterval: interval,
    };
  }

  // engram tools → memory_read / memory_write
  if (tool_name.startsWith("engram_pull") || tool_name === "engram_ls") {
    return {
      eventId,
      action: "memory_read",
      ts: Date.now(),
      result: "success", // hit/miss determined by response content
    };
  }
  if (tool_name === "engram_push" || tool_name === "engram_flag") {
    return {
      eventId,
      action: "memory_write",
      ts: Date.now(),
      result: "success",
    };
  }

  const action = CLAUDE_CODE_MAP[tool_name];
  if (!action) return null; // unknown tool — skip

  // Extract path from tool_input
  const path = extractPath(tool_input);

  // Determine result
  let result: NormalizedEvent["result"] = "success";
  if (action === "shell_exec" && exit_code !== undefined && exit_code !== 0) {
    result = "failure";
  }
  if (action === "search" && tool_input) {
    // Grep/Glob with 0 results → empty
    const count = tool_input.resultCount ?? tool_input.matchCount;
    if (count === 0) result = "empty";
  }

  return { eventId, action, path, result, ts: Date.now() };
}

// ---- Path extraction ----

function extractPath(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  // Claude Code tools use various field names
  return (
    (input.file_path as string) ??
    (input.path as string) ??
    (input.pattern as string) ??
    (input.command as string)?.slice(0, 200) ?? // truncate long commands
    undefined
  );
}