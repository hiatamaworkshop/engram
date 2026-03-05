// ============================================================
// Engram MCP Server → Gateway HTTP client
// ============================================================
// ---- Health (cached) ----
let _healthCache = null;
const HEALTH_CACHE_TTL = 30_000;
export async function checkHealth(ctx) {
    if (_healthCache && Date.now() - _healthCache.at < HEALTH_CACHE_TTL) {
        return _healthCache.ok;
    }
    try {
        const res = await fetch(`${ctx.gatewayUrl}/health`);
        _healthCache = { ok: res.ok, at: Date.now() };
        return res.ok;
    }
    catch {
        _healthCache = { ok: false, at: Date.now() };
        return false;
    }
}
// ---- Recall (search mode) ----
export async function recallNodes(ctx, query, projectId, limit = 10, minWeight, status) {
    const body = { query, projectId, limit };
    if (minWeight !== undefined)
        body.minWeight = minWeight;
    if (status)
        body.status = status;
    const res = await fetch(`${ctx.gatewayUrl}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`Gateway /recall ${res.status}: ${await res.text()}`);
    }
    return (await res.json());
}
// ---- Recall (sense mode — single node by ID) ----
export async function recallById(ctx, entryId) {
    const res = await fetch(`${ctx.gatewayUrl}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId }),
    });
    if (!res.ok) {
        throw new Error(`Gateway /recall ${res.status}: ${await res.text()}`);
    }
    return (await res.json());
}
// ---- Scan ----
export async function scan(ctx, projectId, limit = 10, tag, status, sort) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (tag)
        params.set("tag", tag);
    if (status)
        params.set("status", status);
    if (sort)
        params.set("sort", sort);
    const res = await fetch(`${ctx.gatewayUrl}/scan/${encodeURIComponent(projectId)}?${params}`);
    if (!res.ok) {
        throw new Error(`Gateway /scan ${res.status}: ${await res.text()}`);
    }
    return (await res.json());
}
// ---- Ingest (v2: minimal params) ----
export async function ingest(ctx, capsuleSeeds, projectId, trigger, sessionId) {
    const body = {
        capsuleSeeds,
        projectId,
        trigger,
    };
    if (sessionId)
        body.sessionId = sessionId;
    if (ctx.userId && ctx.userId !== "default")
        body.userId = ctx.userId;
    const res = await fetch(`${ctx.gatewayUrl}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`Gateway /ingest ${res.status}: ${await res.text()}`);
    }
    return (await res.json());
}
// ---- Feedback (weight adjustment) ----
export async function feedback(ctx, entryId, signal, reason) {
    const body = { entryId, signal };
    if (reason)
        body.reason = reason;
    const res = await fetch(`${ctx.gatewayUrl}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`Gateway /feedback ${res.status}: ${await res.text()}`);
    }
    return (await res.json());
}
// ---- Activate / Deactivate (Digestor project scope) ----
export async function activateProject(ctx, projectId, ttlSeconds) {
    const body = { projectId };
    if (ttlSeconds)
        body.ttlSeconds = ttlSeconds;
    const res = await fetch(`${ctx.gatewayUrl}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`Gateway /activate ${res.status}: ${await res.text()}`);
    }
}
export async function deactivateProject(ctx, projectId) {
    const res = await fetch(`${ctx.gatewayUrl}/deactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
    });
    if (!res.ok) {
        throw new Error(`Gateway /deactivate ${res.status}: ${await res.text()}`);
    }
}
// ---- Status ----
export async function getStatus(ctx, projectId) {
    const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const res = await fetch(`${ctx.gatewayUrl}/status${params}`);
    if (!res.ok) {
        throw new Error(`Gateway /status ${res.status}: ${await res.text()}`);
    }
    return (await res.json());
}
//# sourceMappingURL=gateway-client.js.map