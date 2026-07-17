// ============================================================
// Receptor — Service Loader
// ============================================================
// Reads executor-services.json and registers external executors
// into the service registry at startup.

import { registerExecutor } from "./registry.js";
import { callMcpTool, type McpServerDef } from "./mcp-executor.js";
import { routeOutput, type OutputConfig } from "./output-router.js";
import { processMyceliumResult } from "./mycelium-sink.js";
import { checkMyceliumCacheGate, pushMyceliumCache } from "./mycelium-cache.js";
import services from "./executor-services.json" with { type: "json" };

// ---- Types (JSON schema) ----

interface ServiceDef {
  tool: string;
  type: "mcp" | "shell" | "http";
  server?: McpServerDef;
}

// ---- Post-processors ----
// Optional per-tool hook: receives the raw result, may perform side
// effects (e.g. gateway write-back) and return a replacement string
// for output routing. Returning null keeps the original result.
// Tools may register multiple — each runs off the same raw result,
// and non-null returns are joined (not clobbered) into the final output.

type PostProcessor = (raw: string, args: Record<string, unknown>) => Promise<string | null>;

const postProcessors: Record<string, PostProcessor[]> = {
  mycelium_filter: [processMyceliumResult, pushMyceliumCache],
};

// ---- Pre-gates ----
// Optional per-tool hook: runs BEFORE the external tool call. Returning
// skip:true means the call is skipped entirely (e.g. a valid cache hit) —
// result (if given) is routed directly in place of the tool's own output.

type PreGate = (args: Record<string, unknown>) => Promise<{ skip: boolean; result?: string }>;

const preGates: Record<string, PreGate> = {
  mycelium_filter: checkMyceliumCacheGate,
};

// ---- Loader ----

/**
 * Load executor-services.json and register all external executors.
 * Called once at startup after internal executors are registered.
 */
export function loadExternalServices(): void {
  const defs = (services as { services: ServiceDef[] }).services;

  for (const def of defs) {
    if (def.type === "mcp" && def.server) {
      const serverDef = def.server;
      const toolName = def.tool;

      registerExecutor(toolName, {
        type: "mcp",
        handler: async (method, context) => {
          try {
            const args: Record<string, unknown> = { ...method.action.args };
            // Inject heatmap query for search-type tools
            if (context.topPaths.length > 0 && !args.query) {
              const pathSegments = context.topPaths
                .flatMap(p => p.split("/").filter(Boolean).slice(-2))
                .filter((s, i, arr) => arr.indexOf(s) === i);
              args.query = pathSegments.join(" ");
            }

            const gate = preGates[toolName];
            if (gate) {
              const g = await gate(args);
              if (g.skip) {
                if (g.result) {
                  routeOutput({
                    methodId: method.id,
                    toolName,
                    agentState: context.agentState,
                    raw: g.result,
                    output: method.action.output as OutputConfig | undefined,
                  });
                }
                console.error(`[service-loader] ${toolName}: cache hit, call skipped`);
                return;
              }
            }

            let result = await callMcpTool(serverDef, toolName, args);

            const posts = postProcessors[toolName] ?? [];
            if (result && posts.length > 0) {
              const summaries: string[] = [];
              for (const pp of posts) {
                try {
                  const replaced = await pp(result, args);
                  if (replaced !== null) summaries.push(replaced);
                } catch (err) {
                  console.error(`[service-loader] ${toolName} post-process failed:`, err);
                }
              }
              if (summaries.length > 0) result = summaries.join(" | ");
            }

            if (result) {
              routeOutput({
                methodId: method.id,
                toolName,
                agentState: context.agentState,
                raw: result,
                output: method.action.output as OutputConfig | undefined,
              });
              console.error(`[service-loader] ${toolName}: ok`);
            }
          } catch (err) {
            console.error(`[service-loader] ${toolName} failed:`, err);
          }
        },
      });

      console.error(`[service-loader] registered: ${toolName} (mcp → ${serverDef.command})`);
    }
    // shell / http: future
  }
}
