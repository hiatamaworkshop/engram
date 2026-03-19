#!/bin/bash
# ============================================================
# Engram — Turn boundary forwarder (UserPromptSubmit / Stop)
# ============================================================
# Sends lightweight turn markers to ALL active receptor endpoints.
# Usage: set ENGRAM_TURN_TYPE=user or ENGRAM_TURN_TYPE=agent

DISCOVERY_DIR="$HOME/.engram"
TYPE="${ENGRAM_TURN_TYPE:-${1:-unknown}}"

PAYLOAD=$(printf '{"type":"%s"}' "$TYPE")

for portfile in "$DISCOVERY_DIR"/receptor.*.port; do
  [ -f "$portfile" ] || continue
  PORT=$(cat "$portfile")
  (
    printf '%s' "$PAYLOAD" | curl -s -o /dev/null --max-time 1 \
      -X POST "http://127.0.0.1:${PORT}/turn" \
      -H "Content-Type: application/json" \
      -d @- 2>/dev/null || rm -f "$portfile" 2>/dev/null
  ) &
done
wait 2>/dev/null

exit 0