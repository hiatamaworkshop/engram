// ============================================================
// Receptor — Output Router
// ============================================================
// Routes executor results to declared output targets.
// Decouples executor logic from specific output sinks
// (hotmemo, engram, log, etc.).
//
// Targets are declared per-method in receptor-rules.json:
//   "output": { "targets": ["hotmemo", "log"], "format": "summary", "maxLength": 200 }
//
// Default (omitted output): { targets: ["hotmemo"], format: "raw" }

import { pushAutoResult } from "./passive.js";

// ---- Types ----

export interface OutputConfig {
  targets: OutputTarget[];
  format?: "raw" | "summary" | "json";
  maxLength?: number;
}

export type OutputTarget = "hotmemo" | "log" | "engram" | "silent";

export interface OutputPayload {
  methodId: string;
  toolName: string;
  agentState: string;
  raw: string;
  output?: OutputConfig;
}

// ---- Default config ----

const DEFAULT_OUTPUT: OutputConfig = {
  targets: ["hotmemo"],
  format: "raw",
};

// ---- Sink registry ----

type SinkFn = (payload: OutputPayload, formatted: string) => void | Promise<void>;

const _sinks = new Map<OutputTarget, SinkFn>();

/** Register a sink handler for an output target. */
export function registerSink(target: OutputTarget, fn: SinkFn): void {
  _sinks.set(target, fn);
}

// ---- Built-in sinks ----

// hotmemo: push to passive.ts autoResults (existing mechanism)
registerSink("hotmemo", (payload, formatted) => {
  pushAutoResult(formatted);
});

// log: stderr output (visible in MCP server logs)
registerSink("log", (payload, formatted) => {
  console.error(`[output-router] ${payload.methodId}: ${formatted}`);
});

// silent: discard (useful for testing or fire-and-forget methods)
registerSink("silent", () => {});

// engram: deferred — registered by index.ts when ctx is available
// (receptor module has no direct access to engram API)

// ---- Format ----

function formatResult(payload: OutputPayload): string {
  const config = payload.output ?? DEFAULT_OUTPUT;
  const prefix = `[receptor → ${payload.toolName}] ${payload.agentState}`;

  switch (config.format) {
    case "json": {
      // Try to parse and re-serialize compactly
      try {
        const parsed = JSON.parse(payload.raw);
        const compact = JSON.stringify(parsed);
        const text = `${prefix} | ${compact}`;
        return config.maxLength ? text.slice(0, config.maxLength) : text;
      } catch {
        // Not valid JSON — fall through to raw
      }
      const text = `${prefix} | ${payload.raw}`;
      return config.maxLength ? text.slice(0, config.maxLength) : text;
    }

    case "summary": {
      // Truncate to maxLength, preserving prefix
      const text = `${prefix} | ${payload.raw}`;
      if (config.maxLength && text.length > config.maxLength) {
        return text.slice(0, config.maxLength - 3) + "...";
      }
      return text;
    }

    case "raw":
    default: {
      const text = `${prefix} | ${payload.raw}`;
      return config.maxLength ? text.slice(0, config.maxLength) : text;
    }
  }
}

// ---- Router ----

/**
 * Route an executor's result to all declared output targets.
 * Non-blocking — sink errors are logged but do not propagate.
 */
export function routeOutput(payload: OutputPayload): void {
  const config = payload.output ?? DEFAULT_OUTPUT;
  const formatted = formatResult(payload);

  for (const target of config.targets) {
    const sink = _sinks.get(target);
    if (!sink) {
      console.error(`[output-router] unknown target "${target}" for method ${payload.methodId}`);
      continue;
    }

    try {
      const result = sink(payload, formatted);
      // Handle async sinks (fire-and-forget)
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(err => {
          console.error(`[output-router] sink "${target}" error:`, err);
        });
      }
    } catch (err) {
      console.error(`[output-router] sink "${target}" error:`, err);
    }
  }
}
