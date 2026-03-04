// ============================================================
// Engram MCP Server — shared types
// ============================================================

import { execSync } from "node:child_process";
import { basename, resolve } from "node:path";

// ============================================================
// Context — per-user identity
// ============================================================

export interface EngramContext {
  userId: string;
  gatewayUrl: string;
  defaultProjectId?: string;
}

export function loadContext(): EngramContext {
  const gatewayUrl = process.env.GATEWAY_URL || "http://localhost:3100";
  const userId = process.env.ENGRAM_USER_ID || "default";

  return {
    userId,
    gatewayUrl,
    defaultProjectId: process.env.ENGRAM_PROJECT_ID || detectProjectId(),
  };
}

/**
 * Auto-derive projectId from git remote or cwd.
 * Priority: ENGRAM_PROJECT_ID env (checked in loadContext) → git remote origin → cwd basename
 * Skips cwd fallback if cwd is the user's home directory (avoids silent mis-scoping).
 */
function detectProjectId(): string | undefined {
  // 1. git remote origin → "owner/repo" format
  try {
    const remote = execSync("git remote get-url origin", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const match = remote.match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {
    // not a git repo or git not available
  }

  // 2. cwd basename — but NOT if cwd is the user's home directory
  try {
    const cwd = resolve(".");
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home && resolve(home) === cwd) {
      // Home directory — return undefined to force explicit projectId
      return undefined;
    }
    const name = basename(cwd);
    if (name && name !== "/" && name !== ".") return name;
  } catch {
    // ignore
  }

  return undefined;
}

// ============================================================
// Node status (v2: recent/fixed)
// ============================================================

export type NodeStatus = "recent" | "fixed";

// ============================================================
// NodeSeed — knowledge unit extracted by Claude
// ============================================================

export interface NodeSeed {
  summary: string;
  tags: string[];
  content?: string;
}

// ============================================================
// Ingest trigger types
// ============================================================

export type IngestTrigger =
  | "session-end"
  | "milestone"
  | "git-commit"
  | "error-resolved"
  | "manual"
  | "convention"
  | "environment";

// ============================================================
// Feedback signal types (weight adjustment)
// ============================================================

export type FeedbackSignal = "outdated" | "incorrect" | "superseded" | "merged";
