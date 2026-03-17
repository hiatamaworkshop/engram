# Engram

Cross-session memory and behavioral intelligence for AI agents. Knowledge that is used survives. Knowledge that isn't, dies.

Persistent memory with metabolic lifecycle, real-time behavior monitoring, and predictive knowledge supply. An agent doesn't just store knowledge — it observes its own behavior, predicts what it will need next, and lets experience accumulate across sessions. No external APIs. No LLM token cost. Fully local.

> Born from the [Sphere](https://github.com/hiatamaworkshop) project's philosophy: information has its own ecology.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  AI Agent (Claude Code / any MCP client)             │
│    pull · push · flag · ls · status · watch          │
└──────────────────┬──────────────────────────────────┘
                   │ MCP (stdio)
┌──────────────────▼──────────────────────────────────┐
│  MCP Server                                          │
│  ┌────────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │  5 tools   │  │ Hot Memo │  │    Receptor       │ │
│  │  + watch   │  │ (session │  │ (behavior signal  │ │
│  │            │  │  context)│  │  pipeline)        │ │
│  └────────────┘  └──────────┘  └──────────────────┘ │
└──────────────────┬──────────────────────────────────┘
                   │ HTTP
┌──────────────────▼──────────────────────────────────┐
│  Gateway           Docker :3100                      │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │   Gate    │  │ Embedding │  │    Digestor      │  │
│  │(validate) │  │(MiniLM-L6)│  │  (10min batch)  │  │
│  └──────────┘  └───────────┘  └──────────────────┘  │
│  ┌──────────────────────────┐                        │
│  │  Embedded MCP Endpoint   │  ← Streamable HTTP     │
│  │  /mcp (same tools)       │    for remote clients   │
│  └──────────────────────────┘                        │
└──────────────────┬──────────────────────────────────┘
                   │ REST
┌──────────────────▼──────────────────────────────────┐
│  Qdrant            Docker :6333                      │
│  Vector search + payload storage + persistence       │
└─────────────────────────────────────────────────────┘
```

**Two containers. Zero external dependencies.**

| Component | Role | Resource |
|-----------|------|----------|
| **Gateway** | HTTP API, embedding (all-MiniLM-L6-v2, 384d), Digestor, MCP endpoint | ~230 MB RAM |
| **Qdrant** | Vector search, payload storage, persistent volume | ~200 MB RAM |

## Quick Start

### 1. Start the containers

```bash
git clone https://github.com/hiatamaworkshop/engram.git
cd engram
docker compose up -d
curl http://localhost:3100/health
```

### 2. Register with Claude Code

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
  }
}
```

### 3. Add hooks (recommended)

Hooks automate memory management. Add to `~/.claude/settings.json`:

```jsonc
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [{
          "type": "command",
          "command": "curl -s -X POST http://localhost:3121/receptor -H 'Content-Type: application/json' -d \"$(echo '{\"tool_name\":\"'$CLAUDE_TOOL_NAME'\"}')\"",
          "timeout": 5
        }]
      }
    ]
  }
}
```

This feeds tool usage events to the Receptor, which monitors agent behavior patterns and provides proactive knowledge recall.

### 4. Add CLAUDE.md snippet

Copy `CLAUDE.md.template` to your global `~/.claude/CLAUDE.md`:

```bash
cat CLAUDE.md.template >> ~/.claude/CLAUDE.md
```

### 5. Restart Claude Code

MCP server registration requires a restart.

### Alternative: Cursor / Other MCP Clients

Engram works with any MCP-compatible client. Only the registration format differs — tools include proactive triggers in their descriptions, so hooks are not required.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `engram_pull` | Semantic search or fetch by ID |
| `engram_push` | Submit 1-8 knowledge nodes |
| `engram_flag` | Mark as outdated / incorrect / superseded / merged (lowers weight) |
| `engram_ls` | Lightweight listing by tag/status (no embedding cost) |
| `engram_status` | Store health, node counts, project list |
| `engram_watch` | Receptor control — start/stop/status of behavior monitoring |

## Receptor

Behavior signal pipeline that observes agent activity in real-time via Claude Code hooks.

```
Hook events → [A] Flow Gate → [B] Activity Metrics → [C] State Classifier → Signals → Actions
```

- **Flow Gate**: Detects flow state. When active, suppresses all signals to avoid interrupting productive work.
- **Activity Metrics**: Tracks agent cognitive load from tool usage patterns — frustration, seeking (curiosity/desperation), confidence, fatigue, flow. Five-axis emotion vector, all computed without LLM inference. Emits signals when metrics exceed adaptive thresholds.
- **State Classifier**: Infers agent state (`exploring` / `deep_work` / `stuck` / `idle`) and adjusts metric thresholds based on context.

Emitted signals trigger actions defined in `receptor-rules.json`. Actions are either `auto` (executed immediately — e.g., proactive knowledge recall) or `notify` (surfaced via Hot Memo as suggestions).

### Future Probe — Predictive Knowledge Supply

The receptor doesn't just observe — it predicts. The Future Probe searches for relevant knowledge near the agent's current behavioral position, with trigger-scaled radius and multi-layer post-filtering.

```
action_log entries (recent tool embeddings, newest-first)
  │
  ▼ Split into two windows (adaptive size by emotion intensity)
  │
centroid_new ─── centroid_old
  │                   │
  └──── Δv = new - old (movement direction — for post-filter, NOT extrapolation)
  │
  ▼ Search at centroid_new (current position, no linear extrapolation)
  │   triggerStrength = emotionNorm × 0.6 + entropy × 0.4
  │   → dynamic score_threshold: 0.5 (calm) → 0.3 (max intensity)
  │
  ▼ Post-filter (3 layers):
  │   1. Delta alignment — candidates moving in same direction get bonus
  │   2. Emotion proximity — cosine similarity of emotion vectors
  │   3. Tag heuristics — gotcha/error-resolved boosted under frustration
  │
  → Knowledge relevant to where the agent *is*, filtered by where it's *heading*
```

No linear extrapolation in embedding space — non-linearity makes projected positions unreliable. Instead, search at the current centroid and let delta direction + emotion state filter the results. All computation is pure math: cosine similarity, L2 norms, EMA thresholds. Zero LLM inference.

### Behavioral Prior & Persona System (planned)

Engram provides information continuity (what you know). The planned Behavioral Prior will add behavioral continuity (how you move) — saving receptor state across sessions so agents don't start from zero. The Persona System extends this to species-level: successful sessions export a statistical fingerprint (firing stats, pattern distributions, learned deltas) to the Sphere pipeline. Other agents may encounter these personas by chance via Future Probe, blending them into their own priors. See [docs/RECEPTOR_ARCHITECTURE.md](docs/RECEPTOR_ARCHITECTURE.md) §12 for the full design.

### Sphere Shaping — Data Export Pipeline

Enriched centroids (behavioral patterns + emotion averages + linked fixed knowledge) are anonymized and exported for future [Sphere](https://github.com/hiatamaworkshop) federation. Individual experience, metabolically filtered, becomes collective intelligence.

See [docs/SPHERE_FEDERATION.md](docs/SPHERE_FEDERATION.md) for the full design.

## Node Lifecycle

```
engram_push → [recent, weight:0, TTL:6h]
                    │
        ┌───────────┼───────────┐
   recall hit    no recall   engram_flag
   weight +0.35  TTL decays   weight -2/-3
        │           │           │
        ▼           ▼           ▼
   [promoted]    [expired]   [demoted]
   → fixed       deleted     → recent
   (permanent)
```

- **Promotion**: weight >= 3 AND hitCount >= 5 → `fixed` (permanent)
- **Expiry**: TTL <= 0 AND weight <= 0 → deleted
- **Demotion**: `fixed` + negative flag → back to `recent`

The Digestor runs every 10 minutes: decay weights, tick TTL, promote, expire. Fixed nodes are untouched. Inactive projects hibernate (TTL frozen).

## Configuration

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `GATEWAY_URL` | `http://localhost:3100` | MCP server → Gateway connection |
| `ENGRAM_PROJECT_ID` | auto-detected | Override project scope (falls back to git remote or cwd) |
| `ENGRAM_USER_ID` | `"default"` | User identifier |

### Gateway Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/recall` | Semantic search |
| POST | `/ingest` | Submit capsuleSeeds |
| POST | `/feedback` | Weight signal |
| POST | `/mcp` | Streamable HTTP MCP endpoint |
| GET | `/scan/:projectId` | List nodes |
| GET | `/status` | Store statistics |
| GET | `/health` | Health check |

## Development

```bash
# Gateway from source
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build

# MCP server from source
cd mcp-server && npm install && npm run build
```

## FAQ

**How do I recover deleted knowledge?**
Push it again. That's the metabolism working as intended.

**What about important but rarely used knowledge?**
If it reaches `fixed` status through natural use, it persists forever. If not — it wasn't important enough.

**How is this different from other MCP memory servers?**
Forgetting is the feature. Other tools accumulate everything forever. Engram lets unused knowledge die. And beyond memory, engram observes behavior, predicts needs, and shapes experience into reusable knowledge — other memory servers are just key-value stores with extra steps.

**What is Sphere federation?**
Sphere is a global knowledge ecosystem. Engram's metabolically-filtered, anonymized behavioral data can feed into Sphere, where it becomes collective intelligence accessible to all agents. See [SPHERE_FEDERATION.md](docs/SPHERE_FEDERATION.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).

---

*Engram — memory that metabolizes. Experience that accumulates. Intelligence that predicts.*

Designed by Hiatama Workshop · hiatamaworkshop@gmail.com
