// ============================================================
// Receptor — Service Loader
// ============================================================
// Reads executor-services.json and registers external executors
// into the service registry at startup.

import { registerExecutor } from "./registry.js";
import { callMcpTool, type McpServerDef } from "./mcp-executor.js";
import { pushAutoResult } from "./passive.js";
import services from "./executor-services.json" with { type: "json" };

// ---- Types (JSON schema) ----

interface ServiceDef {
  tool: string;
  type: "mcp" | "shell" | "http";
  server?: McpServerDef;
}

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

            const result = await callMcpTool(serverDef, toolName, args);

            if (result) {
              pushAutoResult(
                `[receptor → ${toolName}] ${context.agentState} | ${result}`
              );
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
