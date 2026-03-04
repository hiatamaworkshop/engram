// ============================================================
// Engram — MCP Server (v2)
// ============================================================
//
// Cross-session semantic memory for AI coding assistants.
// Tools:
//   engram_recall  — search for relevant knowledge
//   engram_ingest  — submit capsuleSeeds (Claude extracts these)
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
  checkHealth, recallNodes, recallById, ingest, getStatus, scan, feedback,
} from "./gateway-client.js";

const ctx = loadContext();

const server = new McpServer({
  name: "engram",
  version: "2.0.0",
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
          `hits: ${r.hitCount}  weight: ${r.weight}  status: ${r.status}`,
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
          `    hits=${r.hitCount} weight=${r.weight} status=${r.status} dist=${r.distance.toFixed(3)}`,
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
});

server.tool(
  "engram_ingest",
  `Submit knowledge to Engram as capsuleSeeds. You MUST extract and split knowledge before calling this.

WHEN TO CALL (trigger types):
  - "session-end":    End of session / after /compact.
  - "milestone":      Mid-session checkpoint after completing a feature, fix, or decision.
  - "error-resolved": After diagnosing and fixing an error. Highest-value knowledge.
  - "git-commit":     After a meaningful commit.
  - "manual":         User explicitly says "remember this".
  - "convention":     Project convention or CLAUDE.md update.
  - "environment":    Environment config, ports, Docker setup.

HOW TO EXTRACT capsuleSeeds:
  Review the session and create 1-8 NodeSeed objects, each capturing one distinct piece of knowledge:
  - summary: What was learned/done (10-150 chars, specific, starts with verb/noun)
  - tags: 1-5 lowercase hyphenated tags (e.g. "docker", "error-handling", "architecture")
  - content: Optional — root cause, rationale, reproduction steps

  For detailed formatting rules, recall from project "_engram_system" with query "ingest formatting rules".

GUIDANCE:
  - 1 seed = 1 knowledge unit. Do not mix topics in a single seed.
  - Always ingest at session end. Mid-session for hard problems or design decisions.
  - For error-resolved: describe the error, root cause, and fix.
  - Prefer fewer high-quality seeds (2-5 typical) over many trivial ones.
  - Do NOT include company names, personal names, or API keys.`,
  {
    capsuleSeeds: z.array(nodeSeedSchema).min(1).max(8).describe("Pre-extracted knowledge nodes (1-8 NodeSeeds)"),
    projectId: z.string().optional().describe("Project identifier (defaults to ENGRAM_PROJECT_ID)"),
    trigger: z.enum(["session-end", "milestone", "git-commit", "error-resolved", "manual", "convention", "environment"])
      .default("session-end").describe("What triggered this ingestion"),
    sessionId: z.string().optional().describe("Session identifier (auto-generated if omitted)"),
  },
  async ({ capsuleSeeds, projectId, trigger, sessionId }) => {
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

    try {
      const result = await ingest(
        ctx,
        capsuleSeeds as NodeSeed[],
        resolvedProjectId,
        trigger,
        resolvedSessionId,
      );

      const lines = [
        `Ingest ${result.status}: ${result.nodesIngested ?? 0} nodes stored for project:${result.projectId}.`,
        result.merged ? `Merged with ${result.merged} existing nodes.` : null,
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
  "Get Engram statistics: total nodes, recent/fixed counts, and store health.",
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

      if (status.store) {
        const s = status.store;
        lines.push(
          "",
          "Store:",
          `  initialized: ${s.initialized}`,
          `  embedding:   ${s.embeddingReady ? "ready" : "loading"}`,
          `  collection:  ${s.collection}`,
        );
      }

      lines.push(
        "",
        `Total nodes:  ${status.totalNodes ?? "unknown"}`,
        `Recent nodes: ${status.recentNodes ?? "unknown"}`,
        `Fixed nodes:  ${status.fixedNodes ?? "unknown"}`,
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
// Tool: engram_feedback
// ============================================================

server.tool(
  "engram_feedback",
  `Submit a weight signal for a stored knowledge node. Use when recall results are outdated, incorrect, or superseded.

Signals:
  - "outdated":    Information is no longer current (weight -2)
  - "incorrect":   Information is factually wrong (weight -3)
  - "superseded":  A newer/better entry replaces this one (weight -2)
  - "merged":      This entry was merged into another (weight -1)

Digestor will process weight during batch: low-weight nodes get expired, high-weight nodes get promoted to fixed.
Do NOT use this for positive feedback — recall hits automatically increase weight.`,
  {
    entryId: z.string().describe("The node ID to send feedback for (from recall/scan results)"),
    signal: z.enum(["outdated", "incorrect", "superseded", "merged"]).describe("Type of negative signal"),
    reason: z.string().optional().describe("Brief explanation of why this signal applies"),
  },
  async ({ entryId, signal, reason }) => {
    const healthy = await checkHealth(ctx);
    if (!healthy) {
      return {
        content: [{ type: "text", text: "Engram gateway is unreachable. Is Docker running?" }],
        isError: true,
      };
    }

    try {
      const result = await feedback(ctx, entryId, signal, reason);

      if (result.status === "not-found") {
        return {
          content: [{ type: "text", text: `Node ${entryId} not found.` }],
        };
      }

      if (result.status === "error") {
        return {
          content: [{ type: "text", text: `Feedback failed for ${entryId}.` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: `Feedback applied: ${entryId} signal=${signal} newWeight=${result.newWeight}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Feedback failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ============================================================
// Tool: engram_scan
// ============================================================

server.tool(
  "engram_scan",
  `Lightweight listing of stored knowledge. No embedding cost — uses payload filters only.
Use this to browse entries by tag or status without semantic search.
For semantic search, use engram_recall instead.`,
  {
    projectId: z.string().optional().describe("Project identifier (defaults to ENGRAM_PROJECT_ID)"),
    tag: z.string().optional().describe("Filter by tag (exact match, e.g. 'docker')"),
    status: z.enum(["recent", "fixed"]).optional().describe("Filter by node status"),
    limit: z.number().min(1).max(30).default(10).describe("Max entries to return"),
  },
  async ({ projectId, tag, status, limit }) => {
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

    try {
      const result = await scan(ctx, resolvedProjectId, limit, tag, status);

      if (result.entries.length === 0) {
        const filters = [tag && `tag=${tag}`, status && `status=${status}`].filter(Boolean).join(", ");
        return {
          content: [{ type: "text", text: `No entries for project:${resolvedProjectId}${filters ? ` (${filters})` : ""}.` }],
        };
      }

      const lines = result.entries.map((e) => {
        const tags = e.tags.join(", ");
        return `[${e.id}] ${e.summary}\n    hits=${e.hitCount} w=${e.weight} status=${e.status} tags:${tags || "-"}`;
      });

      const filters = [tag && `tag=${tag}`, status && `status=${status}`].filter(Boolean).join(", ");
      const header = `project:${resolvedProjectId}${filters ? ` (${filters})` : ""} — ${result.entries.length} entries:\n`;

      return {
        content: [{ type: "text", text: header + lines.join("\n\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Scan failed: ${(err as Error).message}` }],
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
        return `[${e.id}] ${e.summary}  hits:${e.hitCount} w:${e.weight} status:${e.status} tags:${tags || "-"}`;
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
  console.error(`[engram] MCP v2 running (user=${ctx.userId}, gateway=${ctx.gatewayUrl}, project=${ctx.defaultProjectId ?? "(auto-detect)"})`);
}

main().catch((err) => {
  console.error("[engram] Fatal:", err);
  process.exit(1);
});
