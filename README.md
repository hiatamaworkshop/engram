# Engram

Cross-session memory for AI coding agents. Knowledge that is used survives. Knowledge that isn't, dies.

Engram gives AI agents persistent, searchable memory across sessions — with a metabolic lifecycle that naturally expires unused knowledge and promotes frequently-recalled knowledge to permanent status. No external APIs. No LLM token cost. Fully local.

> Born from the [Sphere](https://github.com/hiatamaworkshop) project's philosophy: information has its own ecology. What lives, what dies, and what endures is determined by use — not by human curation.

## Philosophy

Most memory systems treat knowledge as an asset to hoard. Engram treats knowledge as a living thing.

- **Metabolism over accumulation** — Every node is born mortal (TTL countdown). Recall keeps it alive. Neglect lets it die. There is no restore. Push it again if you need it back.
- **No deduplication** — Re-pushing *is* the merge. The old version decays; the new one carries fresh context.
- **AI-first** — This is not a human knowledge base. The agent writes it, the agent searches it, the agent benefits. Humans just say "remember this."
- **Small core, swappable layers** — Local embedding (MiniLM) ships by default. Swap in OpenAI, Cohere, or any model. The tuning layer for each AI service can be replaced wholesale — no per-service hacks.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  AI Agent (Claude Code / any MCP client)        │
│    engram_pull · engram_push · engram_flag       │
│    engram_ls · engram_status                     │
└──────────────────┬──────────────────────────────┘
                   │ MCP (stdio)
┌──────────────────▼──────────────────────────────┐
│  MCP Server        (node process, stateless)    │
│    validates → forwards HTTP to Gateway         │
└──────────────────┬──────────────────────────────┘
                   │ HTTP
┌──────────────────▼──────────────────────────────┐
│  Gateway           Docker :3100                 │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐ │
│  │   Gate    │  │ Embedding │  │   Digestor   │ │
│  │(validate) │  │(MiniLM-L6)│  │ (10min batch)│ │
│  └──────────┘  └───────────┘  └──────────────┘ │
└──────────────────┬──────────────────────────────┘
                   │ REST
┌──────────────────▼──────────────────────────────┐
│  Qdrant            Docker :6333                 │
│  Vector search + payload storage + persistence  │
└─────────────────────────────────────────────────┘
```

**Two containers. Zero external dependencies.**

| Component | Role | Resource |
|-----------|------|----------|
| **Gateway** | HTTP API, embedding (all-MiniLM-L6-v2, 384d ONNX), Digestor batch engine | ~230 MB RAM |
| **Qdrant** | Vector search, payload storage, persistent volume | ~200 MB RAM |

## Quick Start

### 1. Start the containers

```bash
git clone https://github.com/hiatamaworkshop/engram.git
cd engram
docker compose up -d
# Verify:
curl http://localhost:3100/health
```

> First pull downloads the gateway image (~230 MB) and Qdrant image (~100 MB). Subsequent starts are instant.

### 2. Install the MCP server

```bash
npm install -g engram-memory
```

Or use without installing:

```bash
npx engram-memory
```

### 3. Register with Claude Code

Add to `~/.claude/settings.json`:

```jsonc
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "engram-memory"],
      "env": {
        "GATEWAY_URL": "http://localhost:3100"
      }
    }
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [{
          "type": "command",
          "command": "bash /absolute/path/to/engram/hooks/engram-session-recall.sh",
          "timeout": 15,
          "statusMessage": "Loading engram memory..."
        }]
      },
      {
        "matcher": "resume",
        "hooks": [{
          "type": "command",
          "command": "bash /absolute/path/to/engram/hooks/engram-session-recall.sh",
          "timeout": 15,
          "statusMessage": "Loading engram memory..."
        }]
      },
      {
        "matcher": "compact",
        "hooks": [{
          "type": "agent",
          "prompt": "A compact just completed. Review the compacted session summary and extract 2-5 key learnings, then call engram_push with trigger 'session-end'. Follow the formatting rules defined in engram_push tool description (SSOT). Do NOT include trivial operations or personal names."
        }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "bash /absolute/path/to/engram/hooks/engram-git-commit.sh",
          "timeout": 10
        }]
      }
    ]
  }
}
```

> Replace `/absolute/path/to/engram` with your actual clone path.

**What this does:**
- `startup` / `resume` hooks inject a knowledge briefing into every session automatically
- `compact` hook auto-pushes key learnings when context is compressed
- `PostToolUse` hook auto-pushes commit info on `git commit`

### 4. Add CLAUDE.md snippet (recommended)

Copy `CLAUDE.md.template` to your global `~/.claude/CLAUDE.md` or project-level `CLAUDE.md`:

```bash
cat CLAUDE.md.template >> ~/.claude/CLAUDE.md
```

This adds behavioral guidance for the agent. Tool specifications (parameter formats, character limits, tag rules) are defined in tool descriptions (SSOT) and do not need to be duplicated here.

### 5. Restart Claude Code

MCP server registration requires a restart. After restart, the session briefing hook will fire automatically.

---

### Alternative: Cursor / Other MCP Clients

Engram's core features (all 5 tools, Hot Memo, Digestor) work with **any MCP-compatible client**. Steps 1-2 are identical. Only the registration format differs.

#### Cursor

Add to `.cursor/mcp.json` (project-level) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "engram-memory"],
      "env": {
        "GATEWAY_URL": "http://localhost:3100"
      }
    }
  }
}
```

Then copy `CLAUDE.md.template` into your project's `.cursorrules` (or global rules):

```bash
cat CLAUDE.md.template >> .cursorrules
```

#### What about hooks?

Hooks (session briefing, compact backup, git commit auto-push) are Claude Code specific. Other clients rely on the **tool descriptions** instead — each tool's description includes proactive triggers (e.g., "call `engram_status` at session start") that guide any MCP-aware agent to use engram correctly without hooks. Hooks are a bonus, not a requirement.

## MCP Tools

| Tool | Purpose | When to use |
|------|---------|-------------|
| `engram_pull` | Semantic search or fetch by ID | Session start, before unfamiliar code, debugging |
| `engram_push` | Submit 1-8 capsuleSeeds | After milestones, bug fixes, design decisions |
| `engram_flag` | Negative weight signal (outdated/incorrect/superseded/merged) | When recall returns stale information |
| `engram_ls` | Lightweight listing by tag/status (no embedding cost) | Browsing entries, checking project state |
| `engram_status` | Store health, node counts, project list | Session start, diagnostics |

## How It Works

### Node Lifecycle

```
                  engram_push
                      │
                      ▼
               ┌─────────────┐
               │   recent     │  ← born with TTL (6h default)
               │   weight: 0  │
               └──────┬──────┘
                      │
          ┌───────────┼───────────┐
          │           │           │
     recall hit    no recall   engram_flag
     weight +0.35  TTL ticks    weight -2/-3
          │         down          │
          │           │           │
          ▼           ▼           ▼
   ┌────────────┐  ┌──────┐  ┌──────────┐
   │  promoted   │  │ died │  │ demoted  │
   │  → fixed    │  │      │  │ (if was  │
   │  (permanent)│  └──────┘  │  fixed)  │
   └────────────┘             └──────────┘

   Promotion: weight ≥ 3 AND hitCount ≥ 5
   Death: TTL ≤ 0 AND weight ≤ 0
   Demotion: fixed + negative flag → back to recent
```

### Digestor

The Digestor is a batch processor that runs every 10 minutes:

1. **Decay** — Subtract 0.1 weight from every `recent` node
2. **TTL countdown** — Decrement TTL by elapsed time
3. **Promote** — If `weight ≥ 3` AND `hitCount ≥ 5` → status becomes `fixed`
4. **Expire** — If `TTL ≤ 0` AND `weight ≤ 0` → node is deleted
5. **Hibernate** — Projects with no API activity for 30 minutes are skipped (TTL frozen)

Fixed nodes are never touched by the Digestor. They persist until explicitly flagged.

### Relic Nodes

Relic nodes are bootstrap knowledge — pre-installed as `fixed` on first startup. They serve as system-core anchors: how to use engram, tagging conventions, lifecycle rules.

Relics are *not* sacred. They live inside the same metabolic system. Flag them to demote, re-push to update. They are strong defaults, not permanent fixtures.

Default relics (`_engram_system` project):

| # | Topic |
|---|-------|
| 1 | Ingest formatting rules |
| 2 | Recommended tag taxonomy |
| 3 | Weight and lifecycle mechanics |
| 4 | Search modes (query / entryId / scan) |
| 5 | Digestor configuration |
| 6 | Trigger timing guide |
| 7 | Session start protocol |
| 8 | projectId resolution rules |
| 9 | Continuous ingest strategy |
| 10 | Flag usage guide |

## Configuration

### gateway.config.json

```json
{
  "server": { "port": 3100 },
  "upperLayer": {
    "qdrantUrl": "http://localhost:6333",
    "collection": "engram",
    "embeddingModel": "Xenova/all-MiniLM-L6-v2",
    "embeddingDimension": 384
  },
  "digestor": {
    "intervalMs": 600000,
    "promotionThreshold": 3,
    "promotionHitCount": 5,
    "decayPerBatch": 0.1,
    "ttlSeconds": 21600,
    "idleThresholdMs": 1800000
  }
}
```

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `intervalMs` | 600000 (10 min) | Digestor batch interval |
| `promotionThreshold` | 3 | Minimum weight for promotion |
| `promotionHitCount` | 5 | Minimum recall hits for promotion |
| `decayPerBatch` | 0.1 | Weight decay per Digestor tick |
| `ttlSeconds` | 21600 (6 hours) | Initial TTL for new nodes |
| `idleThresholdMs` | 1800000 (30 min) | Inactivity threshold for hibernation |

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | 3100 | Gateway HTTP port |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant endpoint (use `http://qdrant:6333` in Docker) |
| `GATEWAY_URL` | `http://localhost:3100` | MCP server → Gateway connection |
| `ENGRAM_USER_ID` | `"default"` | User identifier (stored on nodes when set) |
| `ENGRAM_PROJECT_ID` | auto-detected | Override auto-detected project scope |

### Gateway Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/recall` | Semantic search (query or entryId) |
| POST | `/ingest` | Submit capsuleSeeds |
| POST | `/feedback` | Weight signal |
| POST | `/activate` | Register project with Digestor |
| POST | `/deactivate` | Remove project from Digestor |
| GET | `/scan/:projectId` | List nodes (tag/status filter) |
| GET | `/status` | Store statistics |
| GET | `/health` | Health check |

## Development

```bash
# Build gateway from source
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build

# Build MCP server from source
cd mcp-server && npm install && npm run build
```

## FAQ

**How do I recover deleted knowledge?**
You don't. Push it again. That's the metabolism working as intended.

**Doesn't knowledge get duplicated without dedup?**
Re-pushing is the merge. The old node decays and dies. The new one carries updated context. Explicit dedup is unnecessary.

**What if I have 100,000 nodes?**
Your metabolism settings need tuning, not your infrastructure. If nodes accumulate that fast, increase decay or lower TTL.

**Is the search accurate without OpenAI embeddings?**
For project-scoped working notes, MiniLM-L6 is sufficient. This is not a knowledge base — it's metabolic memory. Swap in a larger model if you need it.

**What about rare but important knowledge?**
Recall it periodically to keep it alive, or ensure it reaches `fixed` status through natural use. If it's truly important, it will be used.

**How is this different from other MCP memory servers?**
Forgetting is the feature. Other memory tools accumulate everything forever. Engram lets unused knowledge die — because an AI agent's memory should reflect what's *actually relevant*, not everything it has ever seen.

## Roadmap

- [ ] Relic node auto-bootstrap on Gateway startup
- [ ] Export/import for fixed nodes (Gateway-level, not agent-level)
- [ ] Embedding model configuration (swap via config, not code)

## License

Apache License 2.0. See [LICENSE](LICENSE).

---

*Engram — memory that metabolizes.*

Designed by Hiatama Workshop · hiatamaworkshop@gmail.com
