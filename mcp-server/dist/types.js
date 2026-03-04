// ============================================================
// Engram MCP Server — shared types
// ============================================================
import { execSync } from "node:child_process";
import { basename, resolve } from "node:path";
export function loadContext() {
    const gatewayUrl = process.env.GATEWAY_URL || "http://localhost:3100";
    const userId = process.env.ENGRAM_USER_ID || "default";
    return {
        userId,
        gatewayUrl,
        defaultProjectId: process.env.ENGRAM_PROJECT_ID || detectProjectId(),
    };
}
/**
 * Auto-derive projectId from git remote or cwd.
 * Priority: git remote origin → cwd basename
 */
function detectProjectId() {
    try {
        const remote = execSync("git remote get-url origin", {
            encoding: "utf-8",
            timeout: 3000,
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        const match = remote.match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
        if (match)
            return match[1];
    }
    catch {
        // not a git repo or git not available
    }
    try {
        const name = basename(resolve("."));
        if (name && name !== "/" && name !== ".")
            return name;
    }
    catch {
        // ignore
    }
    return undefined;
}
//# sourceMappingURL=types.js.map