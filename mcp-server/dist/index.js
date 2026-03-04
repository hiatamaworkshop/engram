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
import { checkHealth, recallNodes, recallById, ingest, getStatus, scan, feedback, activateProject, deactivateProject, } from "./gateway-client.js";
const ctx = loadContext();
const server = new McpServer({
    name: "engram",
    version: "2.0.0",
});
// ============================================================
// Tool: engram_pull
// ============================================================
server.tool("engram_pull", `Search Engram for relevant cross-session knowledge. Project-scoped by default.

Modes:
  - query: Semantic search across stored knowledge
  - entryId: Fetch a specific node by ID (from scan results)

Set crossProject=true to search across ALL projects.

WHEN TO CALL (proactive triggers):
  - **Session start**: ALWAYS recall before diving into work. Query your current task.
  - **Before unfamiliar code**: Recall project structure, file paths, conventions.
  - **Before repeating a search**: If you're about to grep/glob for something you've searched before, recall first.
  - **User says "memo/notes/記録/メモ/作業メモ/what did we do/previous session"**: Recall relevant history.
  - **Debugging**: Recall error patterns — past you may have solved this already.
  - **Cross-project**: When tech stack is similar, set crossProject=true to leverage other projects.`, {
    query: z.string().optional().describe("Natural language search query (omit if using entryId)"),
    entryId: z.string().optional().describe("Fetch a specific node by ID (omit if using query)"),
    crossProject: z.boolean().default(false).describe("Set true to search across all projects"),
    projectId: z.string().optional().describe("Override project scope (defaults to ENGRAM_PROJECT_ID or auto-detected)"),
    limit: z.number().min(1).max(30).default(5).describe("Max results to return"),
    minWeight: z.number().optional().describe("Only return nodes with weight >= this value (higher = more trusted)"),
    status: z.enum(["recent", "fixed"]).optional().describe("Only return nodes with this status"),
}, async ({ query, entryId, crossProject, projectId: explicitProjectId, limit, minWeight, status }) => {
    const healthy = await checkHealth(ctx);
    if (!healthy) {
        return {
            content: [{ type: "text", text: "Engram gateway is unreachable. Is Docker running?" }],
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
                r.content ? `\n${r.content}` : null,
                "",
                `hits: ${r.hitCount}  weight: ${r.weight}  status: ${r.status}`,
                `tags: ${r.tags.join(", ") || "(none)"}`,
                `id: ${r.id}`,
            ].filter(Boolean).join("\n");
            return { content: [{ type: "text", text: detail }] };
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
            return {
                content: [{ type: "text", text: `No results found for "${query}"${scope}.\n\nHint: No knowledge exists for this topic yet. Consider ingesting relevant knowledge with engram_push.` }],
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
        const scope = projectId ? ` (project: ${projectId})` : " (cross-project)";
        const header = `Found ${response.results.length} results for "${query}"${scope}:\n`;
        // Contextual hints
        const hints = [];
        const avgRelevance = response.results.reduce((s, r) => s + r.relevance, 0) / response.results.length;
        if (avgRelevance < 0.3) {
            hints.push("Low relevance scores. Use more specific keywords in summary when ingesting.");
        }
        if (response.results.every((r) => r.status === "recent")) {
            hints.push("All results are recent (no fixed nodes). Recall more often to build weight and promote nodes.");
        }
        const hintText = hints.length > 0 ? `\n\nHint: ${hints.join(" ")}` : "";
        return {
            content: [{ type: "text", text: header + formatted.join("\n\n") + hintText }],
        };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Recall failed: ${err.message}` }],
            isError: true,
        };
    }
});
// ============================================================
// Tool: engram_push
// ============================================================
const nodeSeedSchema = z.object({
    summary: z.string().min(10).max(200).describe("Knowledge headline (10-200 chars). Specific, starts with verb/noun."),
    tags: z.array(z.string()).min(1).max(5).describe("1-5 lowercase hyphenated tags."),
    content: z.string().optional().describe("Detailed explanation, rationale, gotchas for future reference."),
});
server.tool("engram_push", `Submit knowledge to Engram as capsuleSeeds. You MUST extract and split knowledge before calling this.

WHEN TO CALL (trigger types):
  - "session-end":    End of session / after /compact.
  - "milestone":      Mid-session checkpoint after completing a feature, fix, or decision.
  - "error-resolved": After diagnosing and fixing an error. Highest-value knowledge.
  - "git-commit":     After a meaningful commit.
  - "manual":         User explicitly says "remember this".
  - "convention":     Project convention or CLAUDE.md update.
  - "environment":    Environment config, ports, Docker setup.

PROACTIVE TRIGGERS — do NOT wait to be asked:
  - **After fixing a bug**: Ingest the error, root cause, and fix immediately.
  - **After discovering file paths/structure**: Ingest so future sessions skip the grep.
  - **After a design decision**: Ingest the "why" before you forget.
  - **User says "メモ/memo/記録/notes/remember/覚えて"**: Ingest what they want remembered.
  - **Before /compact**: Last chance — ingest key learnings NOW.
  - The more mundane the knowledge (file paths, build commands, config locations), the MORE valuable it is.

HOW TO EXTRACT capsuleSeeds:
  Review the session and create 1-8 NodeSeed objects, each capturing one distinct piece of knowledge:
  - summary: What was learned/done (10-150 chars, specific, starts with verb/noun)
  - tags: 1-5 lowercase hyphenated tags (e.g. "docker", "error-handling", "architecture")
  - content: Optional — root cause, rationale, reproduction steps

  For detailed formatting rules, pull from project "_engram_system" with query "ingest formatting rules".

GUIDANCE:
  - 1 seed = 1 knowledge unit. Do not mix topics in a single seed.
  - Always ingest at session end. Mid-session for hard problems or design decisions.
  - For error-resolved: describe the error, root cause, and fix.
  - Prefer fewer high-quality seeds (2-5 typical) over many trivial ones.
  - Do NOT include company names, personal names, or API keys.`, {
    capsuleSeeds: z.array(nodeSeedSchema).min(1).max(8).describe("Pre-extracted knowledge nodes (1-8 NodeSeeds)"),
    projectId: z.string().optional().describe("Project identifier (defaults to ENGRAM_PROJECT_ID)"),
    trigger: z.enum(["session-end", "milestone", "git-commit", "error-resolved", "manual", "convention", "environment"])
        .default("session-end").describe("What triggered this ingestion"),
    sessionId: z.string().optional().describe("Session identifier (auto-generated if omitted)"),
}, async ({ capsuleSeeds, projectId, trigger, sessionId }) => {
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
        const result = await ingest(ctx, capsuleSeeds, resolvedProjectId, trigger, resolvedSessionId);
        const lines = [
            `Ingest ${result.status}: ${result.nodesIngested ?? 0} nodes stored for project:${result.projectId}.`,
            result.merged ? `Merged with ${result.merged} existing nodes.` : null,
            result.reason ? `Detail: ${result.reason}` : null,
        ].filter(Boolean);
        // Fetch current total for context
        try {
            const st = await getStatus(ctx, resolvedProjectId);
            lines.push(`Project total: ${st.totalNodes} nodes (${st.fixedNodes} fixed, ${st.recentNodes} recent).`);
        }
        catch { /* non-fatal */ }
        return {
            content: [{ type: "text", text: lines.join("\n") }],
        };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Ingest failed: ${err.message}` }],
            isError: true,
        };
    }
});
// ============================================================
// Tool: engram_status
// ============================================================
server.tool("engram_status", "Get Engram statistics: total nodes, recent/fixed counts, and store health.", {
    projectId: z.string().optional().describe("Project filter"),
}, async ({ projectId }) => {
    const healthy = await checkHealth(ctx);
    if (!healthy) {
        return {
            content: [{ type: "text", text: "Engram gateway is unreachable. Is Docker running?" }],
            isError: true,
        };
    }
    try {
        const status = await getStatus(ctx, projectId);
        const lines = [`Engram Status (user: ${ctx.userId})`];
        if (status.store) {
            const s = status.store;
            lines.push("", "Store:", `  initialized: ${s.initialized}`, `  embedding:   ${s.embeddingReady ? "ready" : "loading"}`, `  collection:  ${s.collection}`);
        }
        lines.push("", `Total nodes:  ${status.totalNodes ?? "unknown"}`, `Recent nodes: ${status.recentNodes ?? "unknown"}`, `Fixed nodes:  ${status.fixedNodes ?? "unknown"}`);
        if (status.projects && status.projects.length > 0) {
            lines.push("", "Projects:");
            for (const p of status.projects) {
                lines.push(`  ${p.projectId} (${p.count} nodes)`);
            }
        }
        // Contextual hints
        const hints = [];
        const total = status.totalNodes ?? 0;
        const fixed = status.fixedNodes ?? 0;
        if (total === 0) {
            hints.push("Empty store. Start ingesting knowledge with engram_push.");
        }
        else if (fixed === 0) {
            hints.push("No fixed nodes yet. Recall existing knowledge to build weight and trigger promotion.");
        }
        if (hints.length > 0) {
            lines.push("", `Hint: ${hints.join(" ")}`);
        }
        return {
            content: [{ type: "text", text: lines.join("\n") }],
        };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Status failed: ${err.message}` }],
            isError: true,
        };
    }
});
// ============================================================
// Tool: engram_flag
// ============================================================
server.tool("engram_flag", `Submit a weight signal for a stored knowledge node. Use when recall results are outdated, incorrect, or superseded.

Signals:
  - "outdated":    Information is no longer current (weight -2)
  - "incorrect":   Information is factually wrong (weight -3)
  - "superseded":  A newer/better entry replaces this one (weight -2)
  - "merged":      This entry was merged into another (weight -1)

Digestor will process weight during batch: low-weight nodes get expired, high-weight nodes get promoted to fixed.
Do NOT use this for positive feedback — recall hits automatically increase weight.`, {
    entryId: z.string().describe("The node ID to send feedback for (from recall/scan results)"),
    signal: z.enum(["outdated", "incorrect", "superseded", "merged"]).describe("Type of negative signal"),
    reason: z.string().optional().describe("Brief explanation of why this signal applies"),
}, async ({ entryId, signal, reason }) => {
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
        const summaryInfo = result.summary ? ` "${result.summary}"` : "";
        return {
            content: [{
                    type: "text",
                    text: `Feedback applied:${summaryInfo} ${entryId} signal=${signal} newWeight=${result.newWeight}`,
                }],
        };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Feedback failed: ${err.message}` }],
            isError: true,
        };
    }
});
// ============================================================
// Tool: engram_ls
// ============================================================
server.tool("engram_ls", `Lightweight listing of stored knowledge. No embedding cost — uses payload filters only.
Use this to browse entries by tag or status without semantic search.
For semantic search, use engram_pull instead.`, {
    projectId: z.string().optional().describe("Project identifier (defaults to ENGRAM_PROJECT_ID)"),
    tag: z.string().optional().describe("Filter by tag (exact match, e.g. 'docker')"),
    status: z.enum(["recent", "fixed"]).optional().describe("Filter by node status"),
    limit: z.number().min(1).max(30).default(10).describe("Max entries to return"),
}, async ({ projectId, tag, status, limit }) => {
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
                content: [{ type: "text", text: `No entries for project:${resolvedProjectId}${filters ? ` (${filters})` : ""}.\n\nHint: No knowledge stored yet. Use engram_push to add knowledge.` }],
            };
        }
        const lines = result.entries.map((e) => {
            const tags = e.tags.join(", ");
            return `[${e.id}] ${e.summary}\n    hits=${e.hitCount} w=${e.weight} status=${e.status} tags:${tags || "-"}`;
        });
        const filters = [tag && `tag=${tag}`, status && `status=${status}`].filter(Boolean).join(", ");
        const header = `project:${resolvedProjectId}${filters ? ` (${filters})` : ""} — ${result.entries.length}/${result.total} entries:\n`;
        // Contextual hints
        const hints = [];
        const negativeWeight = result.entries.filter((e) => e.weight < 0);
        if (negativeWeight.length > 0) {
            hints.push(`${negativeWeight.length} nodes have negative weight and will be expired by Digestor.`);
        }
        if (result.entries.length < result.total) {
            hints.push(`Showing ${result.entries.length} of ${result.total}. Increase limit to see more.`);
        }
        const hintText = hints.length > 0 ? `\n\nHint: ${hints.join(" ")}` : "";
        return {
            content: [{ type: "text", text: header + lines.join("\n\n") + hintText }],
        };
    }
    catch (err) {
        return {
            content: [{ type: "text", text: `Scan failed: ${err.message}` }],
            isError: true,
        };
    }
});
// ============================================================
// Resource: engram://scan/{projectId}
// ============================================================
server.resource("project-scan", "engram://scan/{projectId}", { description: "Lightweight listing of stored knowledge for a project." }, async (uri) => {
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
    }
    catch {
        return {
            contents: [{
                    uri: uri.href,
                    mimeType: "text/plain",
                    text: `Scan unavailable (Gateway unreachable).`,
                }],
        };
    }
});
// ============================================================
// Start
// ============================================================
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[engram] MCP v2 running (user=${ctx.userId}, gateway=${ctx.gatewayUrl}, project=${ctx.defaultProjectId ?? "(auto-detect)"})`);
    // Activate project for Digestor scope
    if (ctx.defaultProjectId) {
        activateProject(ctx, ctx.defaultProjectId).catch((err) => {
            console.error(`[engram] activate failed (non-fatal): ${err.message}`);
        });
    }
    // Deactivate on process exit
    const cleanup = () => {
        if (ctx.defaultProjectId) {
            deactivateProject(ctx, ctx.defaultProjectId).catch(() => { });
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
//# sourceMappingURL=index.js.map