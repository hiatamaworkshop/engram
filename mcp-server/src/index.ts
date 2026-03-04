// ============================================================
// Engram — MCP Server
// ============================================================
//
// Cross-session semantic memory for AI coding assistants.
// Tools:
//   engram_recall  — search for relevant knowledge
//   engram_ingest  — submit session knowledge (capsuleSeeds)
//   engram_status  — statistics
// Resources:
//   engram://scan/{projectId} — lightweight listing
//
// Transport: stdio (Claude Code spawns this process directly)
//
// Environment:
//   GATEWAY_URL        — Gateway HTTP endpoint (default: http://localhost:3100)
//   ENGRAM_USER_ID     — User identifier (default: "default")
//   ENGRAM_PROJECT_ID  — Override auto-detected project ID

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadContext } from "./types.js";
import type { NodeSeed } from "./types.js";
import {
  checkHealth, recallNodes, recallById, ingest, getStatus, scan,
} from "./gateway-client.js";

const ctx = loadContext();

const server = new McpServer({
  name: "engram",
  version: "1.0.0",
});

// ============================================================
// Tool: engram_recall
// ============================================================

server.tool(
  "engram_recall",
  `Search Engram for relevant cross-session knowledge. Project-scoped by default.

Modes:
  - query: Semantic search across stored knowledge
  - entryId: Fetch a specific node by ID (from scan results)

Set crossProject=true to search across ALL projects.`,
  {
    query: z.string().optional().describe("Natural language search query (omit if using entryId)"),
    entryId: z.string().optional().describe("Fetch a specific node by ID (omit if using query)"),
    crossProject: z.boolean().default(false).describe("Set true to search across all projects"),
    limit: z.number().min(1).max(30).default(5).describe("Max results to return"),
  },
  async ({ query, entryId, crossProject, limit }) => {
    const healthy = await checkHealth(ctx);
    if (!healthy) {
      return {
        content: [{ type: "text", text: "Engram gateway is unreachable. Is Docker running?" }],
        isError: true,
      };
    }

    const projectId = crossProject ? undefined : ctx.defaultProjectId;

    try {
      // ---- sense mode ----
      if (entryId) {
        const response = await recallById(ctx, entryId);
        if (response.results.length === 0) {
          return {
            content: [{ type: "text", text: response.message ?? `Node ${entryId} not found.` }],
          };
        }
        const r = response.results[0];
        const detail = [
          r.summary,
          r.content ? `\n${r.content}` : null,
          "",
          `weight: ${r.weight}  hitCount: ${r.hitCount}  status: ${r.status}`,
          `tags: ${r.tags.join(", ") || "(none)"}`,
          `id: ${r.id}  timestamp: ${r.timestamp}`,
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text: detail }] };
      }

      // ---- search mode ----
      if (!query) {
        return {
          content: [{ type: "text", text: "Provide either query (search) or entryId (fetch by ID)." }],
        };
      }

      const response = await recallNodes(ctx, query, projectId, limit);

      if (response.results.length === 0) {
        const scope = projectId ? ` in project:${projectId}` : "";
        return {
          content: [{ type: "text", text: `No results found for "${query}"${scope}.` }],
        };
      }

      const formatted = response.results.map((r, i) => {
        return [
          `[${i + 1}] ${r.summary}`,
          r.content ? `    ${r.content}` : null,
          `    weight=${r.weight} hits=${r.hitCount} status=${r.status} dist=${r.distance.toFixed(3)}`,
          `    tags: ${r.tags.join(", ") || "(none)"}`,
          `    id: ${r.id}`,
        ]
          .filter(Boolean)
          .join("\n");
      });

      const scope = projectId ? ` (project: ${projectId})` : " (cross-project)";
      const header = `Found ${response.results.length} results for "${query}"${scope}:\n`;

      return {
        content: [{ type: "text", text: header + formatted.join("\n\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Recall failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ============================================================
// Tool: engram_ingest
// ============================================================

const nodeSeedSchema = z.object({
  summary: z.string().min(10).max(200).describe("Knowledge headline (10-200 chars). Specific, starts with verb/noun."),
  tags: z.array(z.string()).min(1).max(5).describe("1-5 lowercase hyphenated tags."),
  content: z.string().optional().describe("Detailed explanation, rationale, gotchas for future reference."),
  weight: z.number().min(0).max(1).optional().describe("Importance 0.0-1.0 (default 0.5). Error fixes = 0.8+, trivial config = 0.3."),
});

server.tool(
  "engram_ingest",
  `Submit knowledge to Engram as pre-extracted NodeSeeds. You MUST extract knowledge into capsuleSeeds before calling this.

WHEN TO CALL (trigger types):
  - "session-end":    End of session / after /compact. Captures full session summary.
  - "milestone":      Mid-session checkpoint after completing a feature, fix, or decision.
  - "error-resolved": After diagnosing and fixing an error. Highest-value knowledge.
  - "git-commit":     After a meaningful commit. Include commit messages and diff stat.

HOW TO EXTRACT capsuleSeeds:
  Review the session and create 1-8 NodeSeed objects, each capturing one distinct piece of knowledge:
  - summary: What was learned/done (10-200 chars, specific)
  - tags: 1-5 lowercase tags (e.g. "rust", "error-handling", "docker", "bugfix")
  - content: Optional deeper explanation
  - weight: 0.0-1.0 importance (error fixes 0.8+, trivial 0.3)

GUIDANCE:
  - Always ingest at session end. Mid-session for hard problems or design decisions.
  - For error-resolved: describe the error, root cause, and fix.
  - Prefer fewer high-quality nodes over many trivial ones.
  - Do NOT include company names, personal names, or API keys in summaries.`,
  {
    compactText: z.string().min(1).describe("Compact session summary text"),
    capsuleSeeds: z.array(nodeSeedSchema).min(1).max(8).describe("Pre-extracted knowledge nodes (1-8 NodeSeeds)"),
    projectId: z.string().optional().describe("Project identifier (defaults to ENGRAM_PROJECT_ID)"),
    sessionId: z.string().optional().describe("Session identifier (auto-generated if omitted)"),
    timestamp: z.number().optional().describe("Unix timestamp in seconds (auto-generated if omitted)"),
    trigger: z.enum(["session-end", "milestone", "git-commit", "error-resolved"]).default("session-end")
      .describe("What triggered this ingestion"),
    durationMinutes: z.number().optional().describe("Session duration in minutes"),
    filesModified: z.array(z.string()).optional().describe("Files modified during the session"),
    outcome: z.enum(["completed", "abandoned", "partial"]).optional().describe("Session outcome"),
    gitDiffStat: z.string().optional().describe("Git diff stat summary"),
    commitMessages: z.array(z.string()).optional().describe("Commit messages"),
  },
  async ({ compactText, capsuleSeeds, projectId, sessionId, timestamp, trigger, durationMinutes, filesModified, outcome, gitDiffStat, commitMessages }) => {
    const healthy = await checkHealth(ctx);
    if (!healthy) {
      return {
        content: [{ type: "text", text: "Engram gateway is unreachable. Is Docker running?" }],
        isError: true,
      };
    }

    const resolvedProjectId = projectId || ctx.defaultProjectId;
    if (!resolvedProjectId) {
      return {
        content: [{ type: "text", text: "projectId is required. Set ENGRAM_PROJECT_ID or pass projectId explicitly." }],
        isError: true,
      };
    }

    const resolvedSessionId = sessionId || randomUUID();
    const resolvedTimestamp = timestamp ?? Math.floor(Date.now() / 1000);

    try {
      const result = await ingest(
        ctx,
        compactText,
        {
          projectId: resolvedProjectId,
          sessionId: resolvedSessionId,
          timestamp: resolvedTimestamp,
          durationMinutes,
          filesModified,
          outcome,
          gitDiffStat,
          commitMessages,
        },
        capsuleSeeds as NodeSeed[],
        trigger,
      );

      const lines = [
        `Ingest ${result.status}: ${result.nodesIngested ?? 0} nodes stored for project:${result.projectId}.`,
        result.reason ? `Detail: ${result.reason}` : null,
      ].filter(Boolean);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Ingest failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ============================================================
// Tool: engram_status
// ============================================================

server.tool(
  "engram_status",
  "Get Engram statistics: total nodes, amber nodes, and UpperLayer health.",
  {
    projectId: z.string().optional().describe("Project filter"),
  },
  async ({ projectId }) => {
    const healthy = await checkHealth(ctx);
    if (!healthy) {
      return {
        content: [{ type: "text", text: "Engram gateway is unreachable. Is Docker running?" }],
        isError: true,
      };
    }

    try {
      const status = await getStatus(ctx, projectId);

      const lines: string[] = [`Engram Status (user: ${ctx.userId})`];

      if (status.upperLayer) {
        const ul = status.upperLayer;
        lines.push(
          "",
          "UpperLayer:",
          `  initialized: ${ul.initialized}`,
          `  embedding:   ${ul.embeddingReady ? "ready" : "loading"}`,
          `  collection:  ${ul.collection}`,
        );
      }

      lines.push(
        "",
        `Total nodes: ${status.totalNodes ?? "unknown"}`,
        `Amber nodes: ${status.amberNodes ?? "unknown"}`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Status failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ============================================================
// Resource: engram://scan/{projectId}
// ============================================================

server.resource(
  "project-scan",
  "engram://scan/{projectId}",
  { description: "Lightweight listing of stored knowledge for a project." },
  async (uri) => {
    const projectId = uri.pathname.split("/").pop() ?? "";
    if (!projectId) {
      return {
        contents: [{ uri: uri.href, mimeType: "text/plain", text: "Missing projectId in URI." }],
      };
    }

    try {
      const result = await scan(ctx, projectId);

      if (result.entries.length === 0) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/plain",
            text: `No entries for project:${projectId}.`,
          }],
        };
      }

      const lines = result.entries.map((e) => {
        const tags = e.tags.join(", ");
        return `[${e.id}] ${e.summary}  w:${e.weight} hits:${e.hitCount} status:${e.status} tags:${tags || "-"}`;
      });

      const header = `project:${projectId} — ${result.entries.length}/${result.total} entries`;

      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: header + "\n" + lines.join("\n"),
        }],
      };
    } catch {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: `Scan unavailable (Gateway unreachable).`,
        }],
      };
    }
  },
);

// ============================================================
// Start
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[engram] MCP running (user=${ctx.userId}, gateway=${ctx.gatewayUrl}, project=${ctx.defaultProjectId ?? "(auto-detect)"})`);
}

main().catch((err) => {
  console.error("[engram] Fatal:", err);
  process.exit(1);
});
