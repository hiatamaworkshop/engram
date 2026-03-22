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
import { ingestEvent, recordTurn, getState, getDebugSnapshot, flushWeightSnapshot, getPriorResult } from "./index.js";
import { getSnapshots as personaGetSnapshots } from "./persona-snapshot.js";
import { buildPriorBlock, formatPriorBlock, loadWeightSnapshot } from "./persona-prior.js";
import type { SessionPointWithGap } from "./persona-prior.js";
import type { RawHookEvent } from "./normalizer.js";

const PREFERRED_PORT = parseInt(process.env.RECEPTOR_PORT ?? "3101", 10);
const DISCOVERY_DIR = join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".engram");
const DISCOVERY_FILE = join(DISCOVERY_DIR, `receptor.${process.pid}.port`);

let _server: Server | null = null;
let _boundPort: number | null = null;
let _isPrimary = false;

/** Whether this instance owns the receptor port (primary instance). */
export function isReceptorPrimary(): boolean {
  return _isPrimary;
}

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

export function startReceptorHttp(): Promise<{ primary: boolean }> {
  if (_server) return Promise.resolve({ primary: _isPrimary });

  return new Promise((resolve) => {
  _server = createServer((req, res) => {
    // ---- GET debug endpoints (test/inspection) ----
    if (req.method === "GET") {
      res.setHeader("Content-Type", "application/json");

      // GET /debug — full debug snapshot (session points, weights, persona snapshots, emotion)
      if (req.url === "/debug") {
        const sp = getDebugSnapshot();
        const persona = personaGetSnapshots();
        const state = getState();
        res.writeHead(200);
        res.end(JSON.stringify({
          receptor: {
            watching: state.watching,
            eventCount: state.eventCount,
            emotion: state.lastEmotion,
            signals: state.signals.map(s => ({ kind: s.kind, intensity: s.intensity })),
          },
          sessionPoints: sp.sessionPoints,
          weightEntries: sp.weightEntries,
          personaSnapshots: persona,
          priorResult: getPriorResult(),
          meta: {
            workTimeMs: sp.workTimeMs,
            sessionActive: sp.sessionActive,
            recentFires: sp.recentFires,
          },
        }, null, 2));
        return;
      }

      // GET /debug/prior-block — generate Prior Block from current session data (test endpoint)
      if (req.url === "/debug/prior-block") {
        const sp = getDebugSnapshot();
        const points: SessionPointWithGap[] = sp.sessionPoints.map((p: any, i: number, arr: any[]) => ({
          point: p,
          gapMs: i === 0 ? 0 : p.t - arr[i - 1].t,
        }));
        if (points.length === 0) {
          res.writeHead(200);
          res.end(JSON.stringify({ error: "no session points yet", pointCount: 0 }));
          return;
        }
        const weights = sp.weightEntries.length > 0 ? sp.weightEntries : loadWeightSnapshot();
        const prior = getPriorResult() ?? { applied: false, source: "none" };
        const block = buildPriorBlock(points, weights, prior);
        if (!block) {
          res.writeHead(200);
          res.end(JSON.stringify({ error: "buildPriorBlock returned null" }));
          return;
        }
        const formatted = formatPriorBlock(block);
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.writeHead(200);
        res.end(formatted);
        return;
      }

      // GET /debug/flush — manual flush: write weight snapshot + session points to disk now
      if (req.url === "/debug/flush") {
        flushWeightSnapshot();
        res.writeHead(200);
        res.end(JSON.stringify({ flushed: true, ts: Date.now() }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    // /turn — turn boundary marker + optional dialogue ingestion
    if (req.url === "/turn") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        try {
          const json = JSON.parse(body);
          const type = json.type as string; // "user" or "agent"
          recordTurn(type === "user" ? "user" : "agent");

          // Dialogue ingestion: if user turn carries content, ingest as user_prompt
          if (type === "user" && typeof json.content === "string") {
            ingestEvent({
              tool_name: "UserPromptSubmit",
              prompt_content: json.content,
            });
          }

          res.writeHead(200);
          res.end("ok");
        } catch {
          res.writeHead(400);
          res.end("bad request");
        }
      });
      return;
    }

    if (req.url !== "/receptor") {
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

  // Try preferred port — if in use, another instance already owns the receptor.
  // Do NOT fall back to a random port; instead mark this as secondary instance.
  _server.listen(PREFERRED_PORT, "127.0.0.1", () => {
    _boundPort = (_server!.address() as { port: number }).port;
    _isPrimary = true;
    writeDiscovery(_boundPort);
    console.error(`[engram] Receptor HTTP on 127.0.0.1:${_boundPort} (primary)`);
    resolve({ primary: true });
  });

  _server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[engram] Port ${PREFERRED_PORT} already in use — another engram instance owns the receptor. ` +
        `This instance runs as secondary (MCP tools only, no receptor watch).`
      );
      _server!.close();
      _server = null;
      _isPrimary = false;
      resolve({ primary: false });
    } else {
      console.error(`[engram] Receptor HTTP error: ${err.message}`);
      _server = null;
      _isPrimary = false;
      resolve({ primary: false });
    }
  });
  }); // end Promise
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

  // UserPromptSubmit: extract prompt content from tool_input
  if (toolName === "UserPromptSubmit") {
    const input = (json.tool_input as Record<string, unknown>) ?? {};
    return {
      tool_name: "UserPromptSubmit",
      prompt_content: (input.content as string) ?? (input.prompt as string) ?? "",
    };
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
 *
 * Actual Claude Code PostToolUse payload (verified 2026-03-14):
 *   tool_response: { stdout, stderr, interrupted, isImage, noOutputExpected }
 *   On failure:    { stdout, stderr, interrupted, returnCodeInterpretation, ... }
 *
 * There is NO explicit exit_code field. We infer failure from:
 *   1. returnCodeInterpretation exists (any non-success result)
 *   2. stderr is non-empty (fallback heuristic)
 *   3. interrupted === true
 */
function extractExitCode(response: unknown): number | undefined {
  if (response == null) return undefined;

  if (typeof response === "object") {
    const r = response as Record<string, unknown>;

    // Direct exit_code field (future-proofing)
    if (typeof r.exit_code === "number") return r.exit_code;
    if (typeof r.exitCode === "number") return r.exitCode;

    // Interrupted → treat as failure
    if (r.interrupted === true) return 130; // SIGINT convention

    // returnCodeInterpretation exists → non-zero exit
    if (typeof r.returnCodeInterpretation === "string") return 1;

    // stderr non-empty → likely failure (heuristic)
    if (typeof r.stderr === "string" && r.stderr.trim().length > 0) {
      // Some commands output to stderr legitimately (e.g. npm warnings)
      // Only treat as failure if stdout is empty
      if (typeof r.stdout === "string" && r.stdout.trim().length === 0) {
        return 1;
      }
    }
  }

  return undefined;
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