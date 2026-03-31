// ============================================================
// Receptor — HTTP Listener (hook event ingestion)
// ============================================================
// Lightweight HTTP server on localhost:RECEPTOR_PORT (default 3101).
// Receives PostToolUse hook payloads from Claude Code, extracts
// relevant fields, and feeds into ingestEvent().
//
// The hook script is a dumb pipe (cat | curl). All parsing is here.

import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync, unlinkSync, mkdirSync, readdirSync } from "node:fs";
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

/** Remove discovery files whose PID is no longer alive. */
function cleanStaleDiscovery(): void {
  try {
    const files = readdirSync(DISCOVERY_DIR);
    for (const f of files) {
      const m = f.match(/^receptor\.(\d+)\.port$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      if (pid === process.pid) continue; // skip self
      try {
        process.kill(pid, 0); // probe — throws if dead
      } catch {
        // PID is dead — remove stale file
        try {
          unlinkSync(join(DISCOVERY_DIR, f));
          console.error(`[engram] Cleaned stale discovery file: ${f}`);
        } catch { /* ignore */ }
      }
    }
  } catch {
    // DISCOVERY_DIR may not exist yet
  }
}

/** Probe whether something is actually listening on the given port. */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/debug", method: "GET", timeout: 1000 }, (res) => {
      // Only consider alive if we get a 200 with valid JSON body.
      // TIME_WAIT ghosts on Windows can sometimes accept connections briefly.
      if (res.statusCode !== 200) {
        res.resume();
        resolve(false);
        return;
      }
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk; });
      res.on("end", () => {
        try {
          JSON.parse(body);
          resolve(true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ---- HTTP request handler (extracted so it can be reused on retry) ----

function requestHandler(req: IncomingMessage, res: ServerResponse): void {
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
}

// ---- Bind helpers ----

// ---- Retry configuration ----
// VSCode restart takes a few seconds; Windows TIME_WAIT can hold the port
// for up to 30s after the previous process exits. Graduated retries cover
// the realistic window without blocking startup for too long.
const RETRY_DELAYS_MS = [1500, 3000, 5000, 5000]; // total ~14.5s max wait

/** Try to bind once. Resolves true on success, false on EADDRINUSE. Rejects on other errors. */
function attemptBind(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    _server = createServer(requestHandler);
    _server.listen(PREFERRED_PORT, "127.0.0.1", () => {
      _boundPort = (_server!.address() as { port: number }).port;
      _isPrimary = true;
      writeDiscovery(_boundPort);
      resolve(true);
    });
    _server.on("error", (err: NodeJS.ErrnoException) => {
      _server?.close();
      _server = null;
      if (err.code === "EADDRINUSE") {
        resolve(false);
      } else {
        reject(err);
      }
    });
  });
}

/** Attempt to bind to PREFERRED_PORT with graduated retries for TIME_WAIT recovery. */
async function tryBind(resolve: (result: { primary: boolean }) => void): Promise<void> {
  // First attempt — may succeed immediately
  try {
    if (await attemptBind()) {
      console.error(`[engram] Receptor HTTP on 127.0.0.1:${_boundPort} (primary)`);
      resolve({ primary: true });
      return;
    }
  } catch (err) {
    console.error(`[engram] Receptor HTTP error: ${(err as Error).message}`);
    _isPrimary = false;
    resolve({ primary: false });
    return;
  }

  // Port is in use — check if a live instance actually owns it
  const alive = await probePort(PREFERRED_PORT);
  if (alive) {
    console.error(`[engram] Port ${PREFERRED_PORT} in use by live instance — running as secondary (will monitor).`);
    _isPrimary = false;
    resolve({ primary: false });
    // The primary may die later — schedule background promotion to take over.
    scheduleBackgroundPromotion();
    return;
  }

  // Port held by dead/ghost process (TIME_WAIT) — retry with graduated delays
  console.error(`[engram] Port ${PREFERRED_PORT} EADDRINUSE but no live listener — retrying...`);

  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[i]));
    try {
      if (await attemptBind()) {
        console.error(`[engram] Receptor HTTP on 127.0.0.1:${_boundPort} (primary, retry ${i + 1})`);
        resolve({ primary: true });
        return;
      }
    } catch (err) {
      console.error(`[engram] Retry ${i + 1} error: ${(err as Error).message}`);
      break;
    }
    // Still EADDRINUSE — check again if something new claimed it
    const nowAlive = await probePort(PREFERRED_PORT);
    if (nowAlive) {
      console.error(`[engram] Port ${PREFERRED_PORT} now claimed by live instance — running as secondary.`);
      _isPrimary = false;
      resolve({ primary: false });
      return;
    }
    console.error(`[engram] Retry ${i + 1}/${RETRY_DELAYS_MS.length} — port still in TIME_WAIT...`);
  }

  console.error(`[engram] All retries exhausted — running as secondary (will promote in background).`);
  _isPrimary = false;
  resolve({ primary: false });

  // Background promotion: keep trying to claim primary after startup completes.
  // This covers the case where TIME_WAIT outlasts the initial retry window.
  scheduleBackgroundPromotion();
}

export function startReceptorHttp(): Promise<{ primary: boolean }> {
  if (_server) return Promise.resolve({ primary: _isPrimary });

  cleanStaleDiscovery();

  return new Promise((resolve) => {
    tryBind(resolve);
  });
}

// ---- Background promotion ----
// If initial retries fail (TIME_WAIT outlasted the window), keep trying
// in the background so the instance can self-promote to primary once the
// port is free — without requiring a VSCode restart.

const BG_PROMOTE_INTERVAL_MS = 10_000; // check every 10s
const BG_PROMOTE_MAX_ATTEMPTS = 18;    // give up after ~3 minutes
let _bgPromoteTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleBackgroundPromotion(): void {
  let attempts = 0;

  const tick = async () => {
    attempts++;
    if (_isPrimary || _server) {
      // Already promoted or server exists — stop
      _bgPromoteTimer = null;
      return;
    }
    if (attempts > BG_PROMOTE_MAX_ATTEMPTS) {
      console.error(`[engram] Background promotion gave up after ${attempts - 1} attempts.`);
      _bgPromoteTimer = null;
      return;
    }

    // If a live instance appeared, stay secondary
    const alive = await probePort(PREFERRED_PORT);
    if (alive) {
      console.error(`[engram] Background promotion: live instance detected — staying secondary.`);
      _bgPromoteTimer = null;
      return;
    }

    try {
      if (await attemptBind()) {
        console.error(`[engram] Receptor HTTP on 127.0.0.1:${_boundPort} (primary, background promotion)`);
        _bgPromoteTimer = null;
        return;
      }
    } catch {
      // non-EADDRINUSE error — stop trying
      _bgPromoteTimer = null;
      return;
    }

    // Still TIME_WAIT — schedule next attempt
    _bgPromoteTimer = setTimeout(tick, BG_PROMOTE_INTERVAL_MS);
  };

  _bgPromoteTimer = setTimeout(tick, BG_PROMOTE_INTERVAL_MS);
}

/** Stop HTTP server and clean up discovery file. */
export function stopReceptorHttp(): void {
  if (_bgPromoteTimer) {
    clearTimeout(_bgPromoteTimer);
    _bgPromoteTimer = null;
  }
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
