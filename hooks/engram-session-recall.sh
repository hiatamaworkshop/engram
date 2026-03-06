#!/bin/bash
# ============================================================
# Engram — Session Start Hook
# ============================================================
# 1. Auto-detect projectId → write to CLAUDE_ENV_FILE
# 2. Call gateway /status + /scan (sort=recent) → context briefing
#
# Exit 0 + stdout → injected into conversation context.
# If gateway is down, exit 0 with a note (non-blocking).

GATEWAY="${ENGRAM_GATEWAY_URL:-http://localhost:3100}"

# --- Auto-detect projectId and export via CLAUDE_ENV_FILE ---
if [ -n "$CLAUDE_ENV_FILE" ]; then
  DETECTED_PID=""
  # Priority 1: git remote origin → owner/repo
  REMOTE=$(git remote get-url origin 2>/dev/null)
  if [ -n "$REMOTE" ]; then
    DETECTED_PID=$(echo "$REMOTE" | sed -E 's#.*/([^/]+/[^/]+?)(\.git)?$#\1#')
  fi
  # Priority 2: cwd basename (skip if home dir)
  if [ -z "$DETECTED_PID" ]; then
    CWD=$(pwd)
    HOME_DIR=$(cd ~ && pwd)
    if [ "$CWD" != "$HOME_DIR" ]; then
      DETECTED_PID=$(basename "$CWD")
    else
      DETECTED_PID="general"
    fi
  fi
  if [ -n "$DETECTED_PID" ]; then
    echo "export ENGRAM_PROJECT_ID=\"$DETECTED_PID\"" >> "$CLAUDE_ENV_FILE"
  fi
fi

# --- Check gateway health ---
HEALTH=$(curl -sf --max-time 3 "$GATEWAY/health" 2>/dev/null)
if [ $? -ne 0 ]; then
  echo "[engram] Gateway unreachable — skipping session recall."
  exit 0
fi

# --- Check downstream status (embedding/qdrant) ---
DEGRADED=$(echo "$HEALTH" | node -e 'var d="";process.stdin.on("data",function(c){d+=c});process.stdin.on("end",function(){try{var h=JSON.parse(d),i=[],ds=h.downstream||{};if(ds.embedding&&ds.embedding!="ok")i.push("embedding:"+ds.embedding);if(ds.qdrant&&ds.qdrant!="ok")i.push("qdrant:"+ds.qdrant);if(i.length>0)console.log(i.join(", "))}catch(e){}})' 2>/dev/null)

if [ -n "$DEGRADED" ]; then
  echo "[engram] WARNING: Gateway degraded ($DEGRADED)."
  echo "  Push/recall will silently fail. Advise user: docker restart engram-gateway"
  echo "  If persistent, check: docker logs engram-gateway --tail 20"
  echo ""
fi

# --- Use node for JSON parsing (jq not available on Windows) ---
ENGRAM_PID="${DETECTED_PID:-general}"
node -e "
const gateway = process.env.GATEWAY || 'http://localhost:3100';
const projectId = '$ENGRAM_PID';

async function main() {
  try {
    // Status
    const statusRes = await fetch(\`\${gateway}/status\`);
    const status = await statusRes.json();
    const projects = (status.projects || []).map(p => \`\${p.projectId} (\${p.count})\`).join(', ');
    const total = status.totalNodes || 0;

    console.log('=== Engram Session Briefing ===');
    console.log(\`Store: \${total} nodes | Projects: \${projects || 'none'}\`);
    console.log(\`Active project: \${projectId}\`);
    console.log('');

    // Scan recent nodes for detected project
    const allEntries = [];
    try {
      const scanRes = await fetch(\`\${gateway}/scan/\${encodeURIComponent(projectId)}?sort=recent&limit=5\`);
      const scanData = await scanRes.json();
      for (const e of (scanData.entries || [])) {
        allEntries.push({ ...e, projectId });
      }
    } catch { /* skip */ }

    // Also scan cross-project (top 3 other projects)
    const otherProjects = (status.projects || [])
      .map(p => p.projectId)
      .filter(p => !p.startsWith('_') && p !== projectId)
      .slice(0, 2);
    for (const pid of otherProjects) {
      try {
        const scanRes = await fetch(\`\${gateway}/scan/\${encodeURIComponent(pid)}?sort=recent&limit=3\`);
        const scanData = await scanRes.json();
        for (const e of (scanData.entries || [])) {
          allEntries.push({ ...e, projectId: pid });
        }
      } catch { /* skip */ }
    }

    if (allEntries.length > 0) {
      console.log('Recent knowledge:');
      for (const e of allEntries.slice(0, 10)) {
        console.log(\`- [\${e.status}] \${e.summary} (w=\${e.weight}, hits=\${e.hitCount}, project:\${e.projectId})\`);
      }
      console.log('');
    }

    console.log('ACTION REQUIRED:');
    console.log('1. Call engram_pull with your current task query to check for prior knowledge.');
    console.log('2. Push milestones, bug fixes, and design decisions throughout the session.');
    console.log('3. Flag any recalled knowledge that is outdated or wrong.');
    console.log('=== End Briefing ===');
  } catch (err) {
    console.log('[engram] Briefing failed: ' + err.message);
  }
}
main();
" 2>/dev/null

exit 0
