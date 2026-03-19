#!/bin/bash
# ============================================================
# Engram — Receptor event forwarder (PostToolUse hook)
# ============================================================
# Reads Claude Code PostToolUse stdin, POSTs to ALL active receptor
# HTTP endpoints. Each MCP process writes receptor.{pid}.port.
# Failed endpoints are cleaned up (stale process detection).
# Non-blocking: curl with --max-time 1, silent failure.

DISCOVERY_DIR="$HOME/.engram"
INPUT=$(cat)

for portfile in "$DISCOVERY_DIR"/receptor.*.port; do
  [ -f "$portfile" ] || continue
  PORT=$(cat "$portfile")
  (
    printf '%s' "$INPUT" | curl -s -o /dev/null --max-time 1 \
      -X POST "http://127.0.0.1:${PORT}/receptor" \
      -H "Content-Type: application/json" \
      -d @- 2>/dev/null || rm -f "$portfile" 2>/dev/null
  ) &
done
wait 2>/dev/null

exit 0