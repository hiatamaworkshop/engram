// ============================================================
// Receptor — MCP Executor
// ============================================================
// Spawns external MCP servers as child processes (stdio transport),
// maintains a connection pool, and executes tool calls.
//
// One MCP server process can serve multiple tools — connections
// are pooled by server identity (command + args + cwd).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---- Types ----

export interface McpServerDef {
  command: string;
  args?: string[];
  cwd?: string;     // relative to executor-services.json location
  env?: Record<string, string>;
}

interface PoolEntry {
  client: Client;
  transport: StdioClientTransport;
  refCount: number;  // number of tools using this connection
}

// ---- Connection pool ----

const _pool = new Map<string, PoolEntry>();

/** Stable key for deduplicating server connections. */
function serverKey(def: McpServerDef): string {
  const cwd = def.cwd ? resolve(configDir(), def.cwd) : process.cwd();
  return `${def.command}|${(def.args ?? []).join(",")}|${cwd}`;
}

// Directory of this file (used to resolve relative cwd in executor-services.json)
let _configDir: string | undefined;
function configDir(): string {
  if (!_configDir) {
    _configDir = dirname(fileURLToPath(import.meta.url));
  }
  return _configDir;
}

/** Get or create a pooled MCP client connection. */
async function getClient(def: McpServerDef): Promise<Client> {
  const key = serverKey(def);
  const existing = _pool.get(key);
  if (existing) {
    existing.refCount++;
    return existing.client;
  }

  const cwd = def.cwd ? resolve(configDir(), def.cwd) : process.cwd();
  const transport = new StdioClientTransport({
    command: def.command,
    args: def.args ?? [],
    cwd,
    env: { ...process.env, ...def.env } as Record<string, string>,
  });

  const client = new Client({ name: "receptor-executor", version: "0.1.0" });
  await client.connect(transport);

  _pool.set(key, { client, transport, refCount: 1 });
  console.error(`[mcp-executor] connected: ${def.command} ${(def.args ?? []).join(" ")} (cwd: ${cwd})`);

  return client;
}

// ---- Public API ----

/**
 * Call a tool on an external MCP server.
 * Connection is lazily established and pooled.
 */
export async function callMcpTool(
  serverDef: McpServerDef,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const client = await getClient(serverDef);
  const result = await client.callTool({ name: toolName, arguments: args });

  // Extract text content from MCP response
  const texts = (result.content as Array<{ type: string; text?: string }>)
    .filter(c => c.type === "text" && c.text)
    .map(c => c.text!);

  return texts.join("\n");
}

/** Shut down all pooled connections (call on process exit). */
export async function closeAllMcpClients(): Promise<void> {
  for (const [key, entry] of _pool) {
    try {
      await entry.client.close();
      console.error(`[mcp-executor] closed: ${key}`);
    } catch {
      // ignore close errors on shutdown
    }
  }
  _pool.clear();
}
