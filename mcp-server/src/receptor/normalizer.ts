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
}

// ---- Normalize ----

export function normalize(raw: RawHookEvent): NormalizedEvent | null {
  const { tool_name, tool_input, exit_code } = raw;

  // engram tools → memory_read / memory_write
  if (tool_name.startsWith("engram_pull") || tool_name === "engram_ls") {
    return {
      action: "memory_read",
      ts: Date.now(),
      result: "success", // hit/miss determined by response content
    };
  }
  if (tool_name === "engram_push" || tool_name === "engram_flag") {
    return {
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

  return { action, path, result, ts: Date.now() };
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