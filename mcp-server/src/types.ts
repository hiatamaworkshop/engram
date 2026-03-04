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
 * Priority: git remote origin → cwd basename
 */
function detectProjectId(): string | undefined {
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

  try {
    const name = basename(resolve("."));
    if (name && name !== "/" && name !== ".") return name;
  } catch {
    // ignore
  }

  return undefined;
}

// ============================================================
// Project metadata
// ============================================================

export interface ProjectMeta {
  projectId: string;
  sessionId: string;
  timestamp: number;
  durationMinutes?: number;
  filesModified?: string[];
  toolSummary?: {
    edits: number;
    bashCommands: number;
    searches: number;
  };
  userIntentFirstMessage?: string;
  outcome?: "completed" | "abandoned" | "partial";
  gitDiffStat?: string;
  commitMessages?: string[];
}

// ============================================================
// NodeSeed — knowledge unit extracted by Claude
// ============================================================

export interface NodeSeed {
  summary: string;
  tags: string[];
  content?: string;
  weight?: number;    // 0.0 - 1.0 (default 0.5)
}
