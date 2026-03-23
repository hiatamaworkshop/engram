#!/usr/bin/env node
// ============================================================
// Engram — MCP Server (v2)
// ============================================================
//
// Cross-session semantic memory for AI coding assistants.
// Tools:
//   engram_pull    — search for relevant knowledge
//   engram_push    — submit capsuleSeeds (Claude extracts these)
//   engram_status  — statistics
//   engram_flag    — negative weight signal
//   engram_ls      — lightweight listing
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
  checkHealth, recallNodes, recallById, ingest, getStatus, scan, feedback, activateProject, deactivateProject,
} from "./gateway-client.js";
import { memoAdd, memoFormat } from "./hot-memo.js";
import { setWatch, ingestEvent, formatState, registerExecutor, loadExternalServices, routeOutput, registerSink, setLastPushNodeId, recordEngramWeights } from "./receptor/index.js";
import { startReceptorHttp, isReceptorPrimary, stopReceptorHttp } from "./receptor/http.js";
import { closeAllMcpClients } from "./receptor/mcp-executor.js";

const ctx = loadContext();

const server = new McpServer({
  name: "engram",
  version: "2.0.0",
});

// ============================================================
// Tool: engram_pull
// ============================================================

server.tool(
  "engram_pull",
  "Search stored knowledge. Semantic query or fetch by ID. Project-scoped by default.",
  {
    query: z.string().optional().describe("Natural language search query (omit if using entryId)"),
    entryId: z.string().optional().describe("Fetch a specific node by ID (omit if using query)"),
    crossProject: z.boolean().default(false).describe("Set true to search across all projects"),
    projectId: z.string().optional().describe("Override project scope (defaults to ENGRAM_PROJECT_ID or auto-detected)"),
    limit: z.number().min(1).max(30).default(5).describe("Max results to return"),
    minWeight: z.number().optional().describe("Only return nodes with weight >= this value (higher = more trusted)"),
    status: z.enum(["recent", "fixed"]).optional().describe("Only return nodes with this status"),
  },
  async ({ query, entryId, crossProject, projectId: explicitProjectId, limit, minWeight, status }) => {
    const health = await checkHealth(ctx);
    if (!health.ok) {
      return {
        content: [{ type: "text", text: health.diagnosis }],
        isError: true,
      };
    }

    const projectId = crossProject ? undefined : (explicitProjectId || ctx.defaultProjectId);

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
          r.content ? `    ${r.content}` : null,
          `    hits=${r.hitCount} weight=${r.weight} status=${r.status}`,
          `    tags: ${r.tags.join(", ") || "(none)"}`,
          `    id: ${r.id}`,
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text: detail + memoFormat("pull") }] };
      }

      // ---- search mode ----
      if (!query) {
        return {
          content: [{ type: "text", text: "Provide either query (search) or entryId (fetch by ID)." }],
        };
      }

      const response = await recallNodes(ctx, query, projectId, limit, minWeight, status);

      if (response.results.length === 0) {
        const scope = projectId ? ` in project:${projectId}` : "";
        const hints = [
          `No results for "${query}"${scope}.`,
          "",
          "Try:",
          "- Broaden your query (fewer specific terms)",
          minWeight !== undefined ? `- Remove minWeight filter (currently ${minWeight})` : null,
          projectId ? `- Search cross-project: crossProject=true` : null,
          "- Check engram_status() for project list and node counts",
          "- Browse tags with engram_ls",
        ].filter(Boolean).join("\n");
        return {
          content: [{ type: "text", text: hints }],
        };
      }

      const formatted = response.results.map((r, i) => {
        return [
          `[${i + 1}] ${r.summary}`,
          r.content ? `    ${r.content}` : null,
          `    hits=${r.hitCount} weight=${r.weight} status=${r.status} relevance=${r.relevance.toFixed(3)}`,
          `    tags: ${r.tags.join(", ") || "(none)"}`,
          `    id: ${r.id}`,
        ]
          .filter(Boolean)
          .join("\n");
      });

      // Record engram weights for persona loading weight distribution snapshot
      recordEngramWeights(response.results, "pull");

      const scope = projectId ? ` (project: ${projectId})` : " (cross-project)";
      const header = `Found ${response.results.length} results for "${query}"${scope}:\n`;

      return {
        content: [{ type: "text", text: header + formatted.join("\n\n") + memoFormat("pull") }],
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
// Tool: engram_push
// ============================================================

const nodeSeedSchema = z.object({
  summary: z.string().min(10).max(200).describe("Knowledge headline (10-200 chars). Specific, starts with verb/noun."),
  tags: z.array(z.string()).min(0).max(5).default([]).describe("0-5 lowercase hyphenated tags. Auto-generated from summary if empty."),
  content: z.string().optional().describe("Detailed explanation, rationale, gotchas for future reference."),
});

server.tool(
  "engram_push",
  "Submit 1-8 knowledge seeds. 1 seed = 1 topic. See CLAUDE.md for push guidelines.",
  {
    capsuleSeeds: z.array(nodeSeedSchema).min(1).max(8).describe("Pre-extracted knowledge nodes (1-8 NodeSeeds)"),
    projectId: z.string().optional().describe("Project identifier (defaults to ENGRAM_PROJECT_ID)"),
    trigger: z.enum(["session-end", "milestone", "git-commit", "error-resolved", "manual", "design-decision", "environment"])
      .default("session-end").describe("What triggered this ingestion"),
    sessionId: z.string().optional().describe("Session identifier (auto-generated if omitted)"),
  },
  async ({ capsuleSeeds, projectId, trigger, sessionId }) => {
    const health = await checkHealth(ctx);
    if (!health.ok) {
      return {
        content: [{ type: "text", text: health.diagnosis }],
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

      memoAdd(capsuleSeeds as Array<{ summary: string; tags?: string[] }>);

      // Link session points to this push event
      setLastPushNodeId(resolvedSessionId);

      const line = `Ingest ${result.status}: ${result.nodesIngested ?? 0} nodes stored for project:${result.projectId}.`;

      return {
        content: [{ type: "text", text: line + memoFormat("push") }],
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
    const health = await checkHealth(ctx);
    if (!health.ok) {
      return {
        content: [{ type: "text", text: health.diagnosis }],
        isError: true,
      };
    }

    try {
      const status = await getStatus(ctx, projectId);

      const instanceMode = isReceptorPrimary() ? "primary" : "secondary (receptor disabled)";
      const lines: string[] = [`Engram Status (user: ${ctx.userId}, instance: ${instanceMode})`];

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

      if (status.projects && status.projects.length > 0) {
        lines.push("", "Projects:");
        for (const p of status.projects) {
          lines.push(`  ${p.projectId} (${p.count} nodes)`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") + memoFormat("status") }],
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
// Tool: engram_flag
// ============================================================

server.tool(
  "engram_flag",
  "Negative weight signal for outdated/incorrect/superseded nodes. Positive feedback is automatic via recall hits.",
  {
    entryId: z.string().describe("The node ID to send feedback for (from recall/scan results)"),
    signal: z.enum(["outdated", "incorrect", "superseded", "merged"]).describe("Type of negative signal"),
    reason: z.string().optional().describe("Brief explanation of why this signal applies"),
  },
  async ({ entryId, signal, reason }) => {
    const health = await checkHealth(ctx);
    if (!health.ok) {
      return {
        content: [{ type: "text", text: health.diagnosis }],
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

      const summaryInfo = result.summary ? ` "${result.summary}"` : "";
      return {
        content: [{
          type: "text",
          text: `Feedback applied:${summaryInfo} ${entryId} signal=${signal} newWeight=${result.newWeight}` + memoFormat("flag"),
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
// Tool: engram_ls
// ============================================================

server.tool(
  "engram_ls",
  "List stored knowledge by tag/status. No embedding cost. For semantic search use engram_pull.",
  {
    projectId: z.string().optional().describe("Project identifier (defaults to ENGRAM_PROJECT_ID)"),
    tag: z.string().optional().describe("Filter by tag (exact match, e.g. 'docker')"),
    status: z.enum(["recent", "fixed"]).optional().describe("Filter by node status"),
    limit: z.number().min(1).max(30).default(10).describe("Max entries to return"),
    sort: z.enum(["recent", "weight"]).optional().describe("Sort order: 'recent' (newest first) or 'weight' (heaviest first)"),
  },
  async ({ projectId, tag, status, limit, sort }) => {
    const health = await checkHealth(ctx);
    if (!health.ok) {
      return {
        content: [{ type: "text", text: health.diagnosis }],
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
      const result = await scan(ctx, resolvedProjectId, limit, tag, status, sort);

      if (result.entries.length === 0) {
        const filters = [tag && `tag=${tag}`, status && `status=${status}`].filter(Boolean).join(", ");
        return {
          content: [{ type: "text", text: `No entries for project:${resolvedProjectId}${filters ? ` (${filters})` : ""}.\n\nHint: No knowledge stored yet. Use engram_push to add knowledge.` }],
        };
      }

      const lines = result.entries.map((e) => {
        const tags = e.tags.join(", ");
        return `[${e.id}] ${e.summary}\n    hits=${e.hitCount} w=${e.weight} status=${e.status} tags:${tags || "-"}`;
      });

      const filters = [tag && `tag=${tag}`, status && `status=${status}`].filter(Boolean).join(", ");
      const header = `project:${resolvedProjectId}${filters ? ` (${filters})` : ""} — ${result.entries.length}/${result.total} entries:\n`;

      return {
        content: [{ type: "text", text: header + lines.join("\n\n") + memoFormat("ls") }],
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
// Tool: engram_watch (receptor module)
// ============================================================

server.tool(
  "engram_watch",
  "Receptor watch mode. Controls behavior monitoring and emotion tracking.",
  {
    action: z.enum(["start", "stop", "status"]).optional()
      .describe("start=begin monitoring, stop=end+summary, omit or status=show current state"),
    learn: z.boolean().optional()
      .describe("Enable learn mode — auto-calibrate receptor sensitivity from session fire patterns. Only applies on start."),
    event: z.object({
      tool_name: z.string(),
      tool_input: z.record(z.unknown()).optional(),
      exit_code: z.number().optional(),
    }).optional().describe("[Internal] Hook event from Claude Code. Do not set manually."),
  },
  async ({ action, learn, event }) => {
    // Secondary instance: receptor is managed by the primary instance
    if (!isReceptorPrimary()) {
      return {
        content: [{
          type: "text",
          text: "Receptor unavailable: this is a secondary engram instance.\n" +
            "Another instance already owns the receptor (port " +
            (process.env.RECEPTOR_PORT ?? "3101") + ").\n\n" +
            "Functional: engram_pull, engram_push, engram_flag, engram_ls, engram_status\n" +
            "Disabled:   engram_watch (receptor, session points, weight snapshots, persona)",
        }],
      };
    }

    // Ingest event if provided
    if (event) {
      ingestEvent(event);
    }

    // Start/stop
    if (action === "start" || action === "stop") {
      const result = setWatch(action === "start", action === "start" ? learn : undefined);
      return {
        content: [{ type: "text", text: result.message }],
      };
    }

    // Status (default)
    return {
      content: [{ type: "text", text: formatState() }],
    };
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

  // Start receptor HTTP listener (receives PostToolUse hook events)
  // If port is already taken, another instance owns the receptor — this one becomes secondary.
  const { primary } = await startReceptorHttp();

  if (primary) {
    // Auto-start receptor watch (only primary instance)
    setWatch(true);
  } else {
    console.error(
      `[engram] Secondary instance: MCP tools (pull/push/flag/ls/status) are fully functional. ` +
      `Receptor watch, session points, weight snapshots, and persona loading are DISABLED ` +
      `(managed by the primary instance on port ${process.env.RECEPTOR_PORT ?? "3101"}).`
    );
  }

  // Register executors — receptor auto queue dispatches via service registry
  registerExecutor("engram_pull", {
    type: "internal",
    handler: async (method, context) => {
      // Build query from heatmap hot paths (what the agent is working on)
      const pathSegments = context.topPaths
        .flatMap(p => p.split("/").filter(Boolean).slice(-2))  // last 2 segments per path
        .filter((s, i, arr) => arr.indexOf(s) === i);          // unique
      const query = pathSegments.join(" ");
      if (!query) return;

      const projectId = ctx.defaultProjectId;
      const response = await recallNodes(ctx, query, projectId, 3);

      if (response.results.length > 0) {
        // Record weights from auto pull for persona loading weight snapshot
        recordEngramWeights(response.results, "auto_pull");

        const lines = response.results.map((r, i) =>
          `  ${i + 1}. ${r.summary} (w=${r.weight}, hits=${r.hitCount})`
        );
        routeOutput({
          methodId: method.id,
          toolName: "engram_pull",
          agentState: context.agentState,
          raw: `query: "${query}"\n${lines.join("\n")}`,
          output: method.action.output as import("./receptor/output-router.js").OutputConfig | undefined,
        });
        console.error(`[receptor] auto engram_pull: ${response.results.length} results for "${query}"`);
      }
    },
  });

  // Context snapshot — record session context to file sink only.
  // Does NOT push to engram (receptor meta-info pollutes user knowledge).
  // User can engram_push explicitly if the snapshot is valuable.
  registerExecutor("engram_context_push", {
    type: "internal",
    handler: async (method, context) => {
      if (context.topPaths.length === 0) return;

      const summary = `session context: ${context.agentState} | hot paths: ${context.topPaths.slice(0, 5).map(p => p.split("/").filter(Boolean).slice(-2).join("/")).join(", ")}`;
      const emotionSnapshot = Object.entries(context.emotion)
        .filter(([, v]) => v > 0.05)
        .map(([k, v]) => `${k}:${(v as number).toFixed(2)}`)
        .join(" ");

      const raw = emotionSnapshot ? `${summary}\nemotion: ${emotionSnapshot}` : summary;

      routeOutput({
        methodId: method.id,
        toolName: "engram_context_push",
        agentState: context.agentState,
        raw,
        output: method.action.output as import("./receptor/output-router.js").OutputConfig | undefined,
      });
      console.error(`[receptor] engram_context_push: ${summary}`);
    },
  });

  // Engram sink disabled — receptor results go to file sink only
  // (receptor-output/receptor-results.jsonl). Auto-pushing meta-info
  // pollutes the user's knowledge base. File is readable on demand.
  registerSink("engram", (_payload, _formatted) => {
    // no-op: file sink handles persistence
  });

  // Load external executor definitions (executor-services.json)
  loadExternalServices();

  // Activate project for Digestor scope
  if (ctx.defaultProjectId) {
    activateProject(ctx, ctx.defaultProjectId).catch((err) => {
      console.error(`[engram] activate failed (non-fatal): ${(err as Error).message}`);
    });
  }

  // Cleanup on process exit
  const cleanup = () => {
    // Stop receptor watch — triggers persona finalize, session-point flush, weight snapshot
    // Only primary instance owns the receptor; secondary skips to avoid clobbering data.
    if (isReceptorPrimary()) {
      setWatch(false);
      stopReceptorHttp(); // release port + remove discovery file
    }
    closeAllMcpClients().catch(() => {});
    if (ctx.defaultProjectId) {
      deactivateProject(ctx, ctx.defaultProjectId).catch(() => {});
    }
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  process.on("beforeExit", cleanup);
}

main().catch((err) => {
  console.error("[engram] Fatal:", err);
  process.exit(1);
});
