#!/bin/bash
# ============================================================
# Engram — Turn boundary forwarder (UserPromptSubmit / Stop)
# ============================================================
# Sends turn markers to ALL active receptor endpoints.
# Usage: set ENGRAM_TURN_TYPE=user or ENGRAM_TURN_TYPE=agent
#
# User turns also forward the hook stdin (UserPromptSubmit: { prompt, ... })
# as "hook", so the receptor can read prompt length and directive terms.
# The prompt goes to localhost only and is not stored by the receptor.

DISCOVERY_DIR="$HOME/.engram"
TYPE="${ENGRAM_TURN_TYPE:-${1:-unknown}}"
INPUT=$(cat)

if [ "$TYPE" = "user" ] && [ -n "$INPUT" ]; then
  PAYLOAD=$(printf '{"type":"%s","hook":%s}' "$TYPE" "$INPUT")
else
  PAYLOAD=$(printf '{"type":"%s"}' "$TYPE")
fi

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
