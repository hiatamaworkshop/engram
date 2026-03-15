// ============================================================
// Receptor — Service Registry + Method Resolver
// ============================================================
// Service Registry: Map<toolName, ExecutorEntry> — "what executors exist"
// Method Resolver:  action.tool → registry lookup → dispatch
//
// Executor types:
//   internal — in-process function call (e.g. engram_pull via recallNodes)
//   mcp      — MCP tool call (future)
//   shell    — shell command (future)
//   http     — HTTP request (future)

import type { ScoredMethod } from "./passive.js";
import type { ExecutorContext } from "./index.js";

// ---- Executor types ----

export type ExecutorType = "internal" | "mcp" | "shell" | "http";

export interface ExecutorEntry {
  type: ExecutorType;
  handler: (method: ScoredMethod, context: ExecutorContext) => Promise<void>;
}

// ---- Registry ----

const _registry = new Map<string, ExecutorEntry>();

/** Register an executor for a tool name. */
export function registerExecutor(toolName: string, entry: ExecutorEntry): void {
  _registry.set(toolName, entry);
}

/** Unregister an executor. */
export function unregisterExecutor(toolName: string): boolean {
  return _registry.delete(toolName);
}

/** Check if an executor is registered. */
export function hasExecutor(toolName: string): boolean {
  return _registry.has(toolName);
}

/** List all registered tool names. */
export function registeredTools(): string[] {
  return [..._registry.keys()];
}

// ---- Method Resolver ----

/**
 * Resolve a ScoredMethod's action.tool to a registered executor and run it.
 * Returns true if dispatched, false if no executor found (notify-only methods
 * with action.message and no action.tool are expected — not an error).
 */
export async function resolveAndExecute(
  method: ScoredMethod,
  context: ExecutorContext,
): Promise<boolean> {
  const toolName = method.action.tool;
  if (!toolName) return false; // notify-only (message-based), no executor needed

  const entry = _registry.get(toolName);
  if (!entry) {
    console.error(`[registry] no executor for tool "${toolName}" (method: ${method.id})`);
    return false;
  }

  await entry.handler(method, context);
  return true;
}
