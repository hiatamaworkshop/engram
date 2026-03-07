// ============================================================
// Engram Gateway — Embedded MCP Endpoint (Streamable HTTP)
// ============================================================
//
// Mounts at /mcp on the Gateway HTTP server.
// Same tools as mcp-server/src/index.ts but calls UpperLayer
// directly instead of proxying through HTTP.
//
// This enables Smithery / remote MCP clients to connect via
// Streamable HTTP without needing a separate stdio process.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  ingestNodes,
  searchNodes,
  listNodes,
  getNodeById,
  applyFeedback,
  getUpperLayerStats,
  getNodeCounts,
  listProjects,
} from "./upper-layer/index.js";
import { touchProject } from "./digestor.js";

// ---- MCP Server instance ----

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "engram",
    version: "2.0.0",
  });

  // ---- engram_pull ----
  server.tool(
    "engram_pull",
    `Search Engram for relevant cross-session knowledge. Project-scoped by default.

Modes:
  - query: Semantic search across stored knowledge
  - entryId: Fetch a specific node by ID (from scan results)

Set crossProject=true to search across ALL projects.`,
    {
      query: z.string().optional().describe("Natural language search query"),
      entryId: z.string().optional().describe("Fetch a specific node by ID"),
      crossProject: z.boolean().default(false).describe("Search across all projects"),
      projectId: z.string().optional().describe("Project scope"),
      limit: z.number().min(1).max(30).default(5).describe("Max results"),
      minWeight: z.number().optional().describe("Min weight filter"),
      status: z.enum(["recent", "fixed"]).optional().describe("Status filter"),
    },
    async ({ query, entryId, crossProject, projectId, limit, minWeight, status }) => {
      try {
        if (entryId) {
          const node = await getNodeById(entryId);
          if (!node) {
            return { content: [{ type: "text" as const, text: `Node ${entryId} not found.` }] };
          }
          const detail = [
            node.summary,
            node.content ? `\n${node.content}` : null,
            "",
            `hits: ${node.hitCount}  weight: ${node.weight}  status: ${node.status}`,
            `tags: ${node.tags.join(", ") || "(none)"}`,
            `id: ${node.id}`,
          ].filter(Boolean).join("\n");
          return { content: [{ type: "text" as const, text: detail }] };
        }

        if (!query) {
          return { content: [{ type: "text" as const, text: "Provide either query or entryId." }] };
        }

        const scopedProject = crossProject ? undefined : projectId;
        if (scopedProject) touchProject(scopedProject);

        const results = await searchNodes({
          query,
          projectId: scopedProject,
          limit,
          minWeight,
          status,
        });

        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No results for "${query}".` }] };
        }

        const formatted = results.map((r, i) => [
          `[${i + 1}] ${r.summary}`,
          r.content ? `    ${r.content}` : null,
          `    hits=${r.hitCount} weight=${r.weight} status=${r.status} relevance=${r.relevance.toFixed(3)}`,
          `    tags: ${r.tags.join(", ") || "(none)"}`,
          `    id: ${r.id}`,
        ].filter(Boolean).join("\n"));

        const scope = scopedProject ? ` (project: ${scopedProject})` : " (cross-project)";
        return { content: [{ type: "text" as const, text: `Found ${results.length} results for "${query}"${scope}:\n` + formatted.join("\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Recall failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ---- engram_push ----
  const nodeSeedSchema = z.object({
    summary: z.string().min(10).max(200),
    tags: z.array(z.string()).min(0).max(5).default([]),
    content: z.string().optional(),
  });

  server.tool(
    "engram_push",
    `Submit knowledge to Engram as capsuleSeeds. 1 seed = 1 knowledge unit.`,
    {
      capsuleSeeds: z.array(nodeSeedSchema).min(1).max(8).describe("1-8 NodeSeeds"),
      projectId: z.string().describe("Project identifier"),
      trigger: z.enum(["session-end", "milestone", "git-commit", "error-resolved", "manual", "convention", "environment"])
        .default("session-end"),
      sessionId: z.string().optional(),
    },
    async ({ capsuleSeeds, projectId, trigger, sessionId }) => {
      try {
        touchProject(projectId);
        const result = await ingestNodes(
          capsuleSeeds.map(s => ({
            summary: s.summary,
            tags: s.tags ?? [],
            content: s.content,
          })),
          projectId,
          trigger,
          sessionId || randomUUID(),
        );
        return { content: [{ type: "text" as const, text: `Ingest accepted: ${result.ingested} nodes stored for project:${projectId}.` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Ingest failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ---- engram_status ----
  server.tool(
    "engram_status",
    "Get Engram statistics: total nodes, recent/fixed counts, and store health.",
    {
      projectId: z.string().optional(),
    },
    async ({ projectId }) => {
      try {
        const stats = getUpperLayerStats();
        const counts = await getNodeCounts(projectId);
        const projects = await listProjects();

        const lines = [
          "Engram Status",
          "",
          "Store:",
          `  initialized: ${stats.initialized}`,
          `  embedding:   ${stats.embeddingReady ? "ready" : "loading"}`,
          `  collection:  ${stats.collection}`,
          "",
          `Total nodes:  ${counts.total}`,
          `Recent nodes: ${counts.recent}`,
          `Fixed nodes:  ${counts.fixed}`,
        ];

        if (projects.length > 0) {
          lines.push("", "Projects:");
          for (const p of projects) {
            lines.push(`  ${p.projectId} (${p.count} nodes)`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Status failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ---- engram_flag ----
  server.tool(
    "engram_flag",
    `Submit a negative weight signal for a stored knowledge node.
Signals: outdated (-2), incorrect (-3), superseded (-2), merged (-1).`,
    {
      entryId: z.string().describe("Node ID"),
      signal: z.enum(["outdated", "incorrect", "superseded", "merged"]),
      reason: z.string().optional(),
    },
    async ({ entryId, signal, reason }) => {
      try {
        const result = await applyFeedback(entryId, signal, reason);
        if (result.status === "not-found") {
          return { content: [{ type: "text" as const, text: `Node ${entryId} not found.` }] };
        }
        return { content: [{ type: "text" as const, text: `Feedback applied: ${entryId} signal=${signal} newWeight=${result.newWeight}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Feedback failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ---- engram_ls ----
  server.tool(
    "engram_ls",
    "Lightweight listing of stored knowledge. No embedding cost.",
    {
      projectId: z.string().describe("Project identifier"),
      tag: z.string().optional(),
      status: z.enum(["recent", "fixed"]).optional(),
      limit: z.number().min(1).max(30).default(10),
      sort: z.enum(["recent", "weight"]).optional(),
    },
    async ({ projectId, tag, status, limit, sort }) => {
      try {
        touchProject(projectId);
        const entries = await listNodes(projectId, limit, { tag, status, sort });
        if (entries.length === 0) {
          return { content: [{ type: "text" as const, text: `No entries for project:${projectId}.` }] };
        }
        const lines = entries.map(e =>
          `[${e.id}] ${e.summary}\n    hits=${e.hitCount} w=${e.weight} status=${e.status} tags:${e.tags.join(", ") || "-"}`
        );
        return { content: [{ type: "text" as const, text: `project:${projectId} — ${entries.length} entries:\n` + lines.join("\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Scan failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  return server;
}

// ---- HTTP handler for /mcp ----

// Map of sessionId -> transport for session management
const transports = new Map<string, StreamableHTTPServerTransport>();

export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "POST") {
    // Check for existing session
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    // New session — create transport + server
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
    });

    transport.onclose = () => {
      const id = [...transports.entries()].find(([, t]) => t === transport)?.[0];
      if (id) transports.delete(id);
    };

    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  if (req.method === "GET") {
    // SSE stream for existing session
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing or invalid session ID" }));
    return;
  }

  if (req.method === "DELETE") {
    // Close session
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      transports.delete(sessionId);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Session not found" }));
    return;
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
}
