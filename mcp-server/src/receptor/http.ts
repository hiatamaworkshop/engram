// ============================================================
// Receptor — HTTP Listener (hook event ingestion)
// ============================================================
// Lightweight HTTP server on localhost:RECEPTOR_PORT (default 3101).
// Receives PostToolUse hook payloads from Claude Code, extracts
// relevant fields, and feeds into ingestEvent().
//
// The hook script is a dumb pipe (cat | curl). All parsing is here.

import { createServer, type Server } from "node:http";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ingestEvent } from "./index.js";
import type { RawHookEvent } from "./normalizer.js";

const PREFERRED_PORT = parseInt(process.env.RECEPTOR_PORT ?? "3101", 10);
const DISCOVERY_DIR = join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".engram");
const DISCOVERY_FILE = join(DISCOVERY_DIR, "receptor.port");

let _server: Server | null = null;
let _boundPort: number | null = null;

/** Write the bound port to discovery file so hook scripts can find it. */
function writeDiscovery(port: number): void {
  try {
    mkdirSync(DISCOVERY_DIR, { recursive: true });
    writeFileSync(DISCOVERY_FILE, String(port), "utf-8");
  } catch (err) {
    console.error(`[engram] Failed to write discovery file: ${(err as Error).message}`);
  }
}

/** Remove discovery file on shutdown. */
function removeDiscovery(): void {
  try {
    unlinkSync(DISCOVERY_FILE);
  } catch {
    // file may already be gone
  }
}

export function startReceptorHttp(): void {
  if (_server) return; // already started

  _server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/receptor") {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk; });
    req.on("end", () => {
      try {
        const json = JSON.parse(body);
        const event = parseHookPayload(json);
        if (event) {
          ingestEvent(event);
        }
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad request");
      }
    });
  });

  // Try preferred port first, fall back to OS-assigned port on conflict
  _server.listen(PREFERRED_PORT, "127.0.0.1", () => {
    _boundPort = (_server!.address() as { port: number }).port;
    writeDiscovery(_boundPort);
    console.error(`[engram] Receptor HTTP on 127.0.0.1:${_boundPort}`);
  });

  _server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[engram] Port ${PREFERRED_PORT} in use — binding to random port`);
      // Retry with port 0 (OS picks a free port)
      _server!.listen(0, "127.0.0.1", () => {
        _boundPort = (_server!.address() as { port: number }).port;
        writeDiscovery(_boundPort);
        console.error(`[engram] Receptor HTTP on 127.0.0.1:${_boundPort}`);
      });
    } else {
      console.error(`[engram] Receptor HTTP error: ${err.message}`);
      _server = null;
    }
  });
}

/** Stop HTTP server and clean up discovery file. */
export function stopReceptorHttp(): void {
  if (_server) {
    _server.close();
    _server = null;
    _boundPort = null;
    removeDiscovery();
  }
}

// ---- Payload parsing ----

/**
 * Parse Claude Code PostToolUse hook payload into RawHookEvent.
 *
 * Hook stdin JSON shape:
 *   { tool_name, tool_input, tool_response, session_id, ... }
 *
 * We extract: tool_name, tool_input (enriched), exit_code (for Bash).
 */
function parseHookPayload(json: Record<string, unknown>): RawHookEvent | null {
  const rawName = json.tool_name;
  if (!rawName || typeof rawName !== "string") return null;

  // Strip MCP prefix: mcp__engram__engram_pull → engram_pull
  let toolName = rawName;
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    toolName = parts[parts.length - 1];
  }

  const toolInput = (json.tool_input as Record<string, unknown>) ?? {};
  const toolResponse = json.tool_response;

  const event: RawHookEvent = {
    tool_name: toolName,
    tool_input: { ...toolInput },
  };

  // Bash: extract exit_code from tool_response
  if (toolName === "Bash") {
    event.exit_code = extractExitCode(toolResponse);
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

/**
 * Try to extract Bash exit code from tool_response.
 * Claude Code response format varies — try multiple strategies.
 */
function extractExitCode(response: unknown): number | undefined {
  if (response == null) return undefined;

  // Strategy 1: direct field
  if (typeof response === "object") {
    const r = response as Record<string, unknown>;
    if (typeof r.exit_code === "number") return r.exit_code;
    if (typeof r.exitCode === "number") return r.exitCode;
    if (typeof r.code === "number") return r.code;

    // Strategy 2: nested in content array
    if (Array.isArray(r.content)) {
      for (const item of r.content) {
        if (typeof item === "object" && item !== null) {
          const ci = item as Record<string, unknown>;
          if (typeof ci.exit_code === "number") return ci.exit_code;
          if (typeof ci.exitCode === "number") return ci.exitCode;
        }
      }
    }
  }

  return undefined;
}

/**
 * Try to extract search result count from Grep/Glob response.
 * Grep output often starts with "Found N files".
 */
function extractSearchResultCount(response: unknown): number | undefined {
  if (response == null) return undefined;

  // Try to get text content
  let text = "";
  if (typeof response === "string") {
    text = response;
  } else if (typeof response === "object") {
    const r = response as Record<string, unknown>;
    if (typeof r.text === "string") text = r.text;
    else if (Array.isArray(r.content)) {
      for (const item of r.content) {
        if (typeof item === "object" && item !== null) {
          const ci = item as Record<string, unknown>;
          if (typeof ci.text === "string") { text = ci.text; break; }
        }
      }
    }
  }

  if (!text) return undefined;

  // "Found N files" pattern (Grep files_with_matches)
  const foundMatch = text.match(/^Found (\d+) files?/m);
  if (foundMatch) return parseInt(foundMatch[1], 10);

  // "No files found" or empty
  if (/No files found|No matches/i.test(text)) return 0;

  // Count non-empty lines as fallback for file lists
  // (only if response looks like a file listing)
  if (text.includes("\n") && !text.includes(" ")) {
    const lines = text.trim().split("\n").filter(l => l.length > 0);
    if (lines.length > 0 && lines.every(l => l.includes("/") || l.includes("\\"))) {
      return lines.length;
    }
  }

  return undefined;
}