// ============================================================
// Receptor — Hook payload parsing
// ============================================================
// Turns a raw Claude Code hook stdin JSON into RawHookEvent.
// Kept apart from http.ts so it can be tested without starting the
// receptor (http.ts pulls in the whole engine through index.js).

import type { RawHookEvent } from "./normalizer.js";

/** Tools whose tool_response carries shell exit semantics. */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/**
 * Parse a Claude Code PostToolUse / PostToolUseFailure payload.
 *
 * Measured 2026-09-17 (docs/RECEPTOR_PRECISION_GAPS.md §1):
 *   PostToolUse         — successful calls only.
 *                         { tool_name, tool_input, tool_response, ... }
 *   PostToolUseFailure  — every real failure: non-zero shell exit, Read of a
 *                         missing file, ... No tool_response.
 *                         { tool_name, tool_input, error, is_interrupt, ... }
 *   Neither             — pre-execution validation errors (Edit old_string
 *                         not found). These are invisible to hooks.
 */
export function parseHookPayload(json: Record<string, unknown>): RawHookEvent | null {
  const rawName = json.tool_name;
  if (!rawName || typeof rawName !== "string") return null;

  // Strip MCP prefix: mcp__engram__engram_pull → engram_pull
  let toolName = rawName;
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    toolName = parts[parts.length - 1];
  }

  // UserPromptSubmit: extract prompt content from tool_input
  if (toolName === "UserPromptSubmit") {
    const input = (json.tool_input as Record<string, unknown>) ?? {};
    return {
      tool_name: "UserPromptSubmit",
      prompt_content: (input.content as string) ?? (input.prompt as string) ?? "",
    };
  }

  const toolInput = (json.tool_input as Record<string, unknown>) ?? {};
  const event: RawHookEvent = {
    tool_name: toolName,
    tool_input: { ...toolInput },
  };

  if (json.hook_event_name === "PostToolUseFailure") {
    return parseFailure(event, json);
  }

  const toolResponse = json.tool_response;

  if (SHELL_TOOLS.has(toolName)) {
    event.exit_code = 0;
    event.interrupted = extractInterrupted(toolResponse);
    // A non-zero exit reaching PostToolUse is one the tool itself declared
    // not an error (grep "No matches found"). Real failures never land here.
    if (hasReturnCodeInterpretation(toolResponse)) event.empty = true;
  }

  // Search tools: inject resultCount into tool_input for normalizer
  if (toolName === "Grep" || toolName === "Glob") {
    const count = extractSearchResultCount(toolResponse);
    if (count !== undefined) {
      event.tool_input = { ...event.tool_input, resultCount: count };
    }
  }

  return event;
}

function parseFailure(event: RawHookEvent, json: Record<string, unknown>): RawHookEvent | null {
  if (json.is_interrupt === true) {
    event.interrupted = true;
    return event;
  }

  const error = typeof json.error === "string" ? json.error : "";

  if (SHELL_TOOLS.has(event.tool_name)) {
    // Only an explicit exit code counts. Any other failure text (timeouts,
    // denials — not yet measured) is left out of bashFailRate rather than
    // guessed into it.
    const m = error.match(/^Exit code (\d+)/);
    if (!m) return null;
    event.exit_code = parseInt(m[1], 10);
    return event;
  }

  event.failed = true;
  return event;
}

function hasReturnCodeInterpretation(response: unknown): boolean {
  if (response == null || typeof response !== "object") return false;
  const v = (response as Record<string, unknown>).returnCodeInterpretation;
  return typeof v === "string" && v.length > 0;
}

/**
 * Detect user interrupt (Ctrl-C) from tool_response.
 *
 * Kept out of exit_code on purpose: an interrupt is a human-side
 * signal, not evidence the command failed. Folding it into exit_code puts
 * it in bashFailRate, so "user cancelled a slow command" reads as
 * trial-and-error frustration and drags the state toward stuck.
 */
function extractInterrupted(response: unknown): boolean {
  if (response == null || typeof response !== "object") return false;
  return (response as Record<string, unknown>).interrupted === true;
}

/**
 * Try to extract search result count from Grep/Glob response.
 *
 * Actual Claude Code PostToolUse payload (verified 2026-03-14):
 *   Grep: { mode, filenames: [...], numFiles: N }
 *   Glob: { filenames: [...], numFiles: N, durationMs, truncated }
 *
 * Primary: numFiles field (structured JSON).
 * Fallback: filenames array length, then text pattern matching.
 */
function extractSearchResultCount(response: unknown): number | undefined {
  if (response == null) return undefined;

  if (typeof response === "object") {
    const r = response as Record<string, unknown>;

    // Primary: numFiles field (Grep & Glob both provide this)
    if (typeof r.numFiles === "number") return r.numFiles;

    // Secondary: count filenames array
    if (Array.isArray(r.filenames)) return r.filenames.length;

    // Grep content mode: may have numMatches or similar
    if (typeof r.numMatches === "number") return r.numMatches;

    // Fallback: text-based extraction (for future format changes)
    let text = "";
    if (typeof r.text === "string") text = r.text;
    else if (Array.isArray(r.content)) {
      for (const item of r.content) {
        if (typeof item === "object" && item !== null) {
          const ci = item as Record<string, unknown>;
          if (typeof ci.text === "string") { text = ci.text; break; }
        }
      }
    }

    if (text) {
      const foundMatch = text.match(/^Found (\d+) (?:files?|total)/m);
      if (foundMatch) return parseInt(foundMatch[1], 10);
      if (/No files found|No matches/i.test(text)) return 0;
    }
  }

  // String response (unlikely but defensive)
  if (typeof response === "string") {
    const m = response.match(/^Found (\d+) (?:files?|total)/m);
    if (m) return parseInt(m[1], 10);
    if (/No files found|No matches/i.test(response)) return 0;
  }

  return undefined;
}
