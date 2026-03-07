# Engram Changes — 2026-03-07

## 1. UpperLayer Retry (fix)

**Problem**: UpperLayer checked Qdrant health once at startup. If Qdrant was
temporarily unreachable (Docker startup race, optimizer pause), UpperLayer
permanently disabled itself. Gateway reported `status: degraded` until
manually restarted.

**Fix**: Added `scheduleRetry()` with exponential backoff (5s → 10s → 30s → 60s).
On reconnect, UpperLayer completes initialization (collection setup + embedding warmup)
and transitions to `initialized: true`.

**File**: `gateway/src/upper-layer/index.ts`

## 2. Streamable HTTP MCP Endpoint (feat)

**What**: Gateway now serves MCP protocol over Streamable HTTP at `/mcp`.
Previously, MCP was only available via the separate `mcp-server` process (stdio transport).

**Architecture**:

```
Before:
  Claude Code → spawn npx engram-memory → stdin/stdout (MCP) → HTTP → Gateway → Qdrant

After (additional path):
  Any MCP client → POST http://localhost:3100/mcp → Gateway → UpperLayer → Qdrant
```

The stdio path (`npx engram-memory`) remains fully functional. The `/mcp` endpoint
is an additional transport option.

**Key difference**: The embedded MCP server calls UpperLayer APIs directly — no HTTP
round-trip through the Gateway's own REST endpoints. Lower latency, no self-referential
requests.

**Tools available** (same as mcp-server):

| Tool | Purpose |
|------|---------|
| `engram_pull` | Semantic search or fetch by ID |
| `engram_push` | Submit capsuleSeeds |
| `engram_status` | Store health and statistics |
| `engram_flag` | Negative weight signal |
| `engram_ls` | Lightweight listing |

**Session management**: Uses `mcp-session-id` header. Each POST without a session
creates a new `StreamableHTTPServerTransport` + `McpServer` instance. GET streams
SSE for an existing session. DELETE closes a session.

**Files**:
- `gateway/src/mcp-endpoint.ts` — MCP server factory + HTTP handler
- `gateway/src/server.ts` — Route mount at `/mcp`

**Dependencies added to gateway**: `@modelcontextprotocol/sdk`, `zod`

## 3. Smithery Configuration (chore)

Added `smithery.yaml` to repo root for Smithery MCP registry.
Note: Smithery currently requires a publicly accessible HTTP URL for registration.
Local Docker deployments need a tunnel (ngrok) or cloud hosting to register.

## 4. GHCR Image

Gateway Docker image updated at `ghcr.io/hiatamaworkshop/engram-gateway:latest`
with both changes included.
