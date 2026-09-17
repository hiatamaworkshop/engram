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

    // The seed is the commit's rationale, not its diff. A subject-only commit
    // says nothing git log does not already say, and those dumps died unseen
    // in digest-log — so no body, no push.
    const why = execSync('git log -1 --pretty=format:%b', { encoding: 'utf8' })
      .split('\\n')
      .filter(l => !/^[A-Za-z-]+: .*<[^>]*>\\s*$/.test(l))  // Co-Authored-By etc.
      .join('\\n')
      .trim();
    if (!why) process.exit(0);

    // English-only summaries: this path bypasses hot-memo's non-english flag,
    // and a ja summary can merge into the claim it contradicts (0.9221 > 0.92).
    if (/[　-ヿ㐀-䶿一-鿿豈-﫿가-힯＀-￯]/.test(msg)) {
      process.exit(0);
    }

    let files = [];
    try {
      files = execSync('git diff --name-only HEAD~1 HEAD', { encoding: 'utf8' }).trim().split('\\n');
    } catch {
      // Initial commit — no HEAD~1
      try {
        files = execSync('git show --name-only --pretty=format: HEAD', { encoding: 'utf8' }).trim().split('\\n');
      } catch { /* give up on file list */ }
    }
    files = files.filter(Boolean);

    // Layer 2 tags: top-level areas the commit touched
    const areas = [...new Set(files
      .filter(f => f.includes('/'))
      .map(f => f.split('/')[0].replace(/^\\./, '').toLowerCase())
      .filter(Boolean))].slice(0, 3);

    const MAX_FILES = 15;
    const fileList = files.slice(0, MAX_FILES).join('\\n')
      + (files.length > MAX_FILES ? '\\n(+' + (files.length - MAX_FILES) + ' more)' : '');
    const content = why + (fileList ? '\\n\\nFiles:\\n' + fileList : '');

    const body = {
      projectId,
      trigger: 'git-commit',
      capsuleSeeds: [{ summary: msg.slice(0, 150), tags: ['why', 'git-commit', ...areas], content }]
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
