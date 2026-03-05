#!/bin/bash
# ============================================================
# Engram — Post git-commit auto-push hook
# ============================================================
# Triggered on PostToolUse/Bash. Detects git commit commands,
# extracts commit info, and pushes to engram gateway.
# Non-blocking: exits immediately for non-commit commands.

# Fast pre-filter (avoids spawning node for most Bash calls)
INPUT=$(cat)
printf '%s' "$INPUT" | grep -q 'git commit' || exit 0

# Use node for JSON parsing + gateway POST
printf '%s' "$INPUT" | node -e "
let data = '';
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => data += c);
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(data);
    const command = input.tool_input?.command || '';

    // Only trigger on actual git commit (not amend, not dry-run)
    if (!/git\s+commit\b/.test(command) || /--amend|--dry-run/.test(command)) {
      process.exit(0);
    }

    const { execSync } = require('child_process');
    const gateway = process.env.ENGRAM_GATEWAY_URL || 'http://localhost:3100';
    const userId = process.env.ENGRAM_USER_ID || 'default';

    // Auto-detect projectId: env → git remote → cwd basename → 'general'
    let projectId = process.env.ENGRAM_PROJECT_ID || '';
    if (!projectId) {
      try {
        const remote = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
        const m = remote.match(/\/([^/]+\/[^/]+?)(?:\.git)?$/);
        if (m) projectId = m[1];
      } catch {}
    }
    if (!projectId) {
      const cwd = process.cwd();
      const home = require('os').homedir();
      projectId = cwd !== home ? require('path').basename(cwd) : 'general';
    }

    // Extract latest commit info
    const msg = execSync('git log -1 --pretty=format:%s', { encoding: 'utf8' }).trim();
    let files = '', stats = '';
    try {
      files = execSync('git diff --name-only HEAD~1 HEAD', { encoding: 'utf8' }).trim();
      stats = execSync('git diff --stat HEAD~1 HEAD', { encoding: 'utf8' }).trim();
    } catch {
      // Initial commit — no HEAD~1
      try {
        files = execSync('git show --name-only --pretty=format: HEAD', { encoding: 'utf8' }).trim();
      } catch { /* give up on file list */ }
    }

    const summary = 'git commit: ' + msg.slice(0, 130);
    const content = files
      ? 'Changed files:\\n' + files + (stats ? '\\n\\nDiff stats:\\n' + stats : '')
      : '';

    const body = {
      projectId,
      trigger: 'git-commit',
      capsuleSeeds: [{ summary, tags: ['git-commit'], content }]
    };
    if (userId && userId !== 'default') body.userId = userId;

    const res = await fetch(gateway + '/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      console.log('[engram] Commit pushed: ' + msg.slice(0, 60));
    }
  } catch {
    // Silent fail — never block the user
  }
  process.exit(0);
});
" 2>/dev/null

exit 0
