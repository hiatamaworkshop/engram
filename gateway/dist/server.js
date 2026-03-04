import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { handleRecall } from "./handlers/recall.js";
import { handleIngest } from "./handlers/ingest.js";
import { handleStatus } from "./handlers/status.js";
import { handleScan } from "./handlers/scan.js";
import { handleFeedback } from "./handlers/feedback.js";
import { initUpperLayer, checkUpperLayerHealth, getUpperLayerStats } from "./upper-layer/index.js";
import { startDigestor, stopDigestor, addActiveProject, removeActiveProject, getActiveProjects, updateTtl, getTtlSeconds, touchProject } from "./digestor.js";
const cfg = loadConfig();
const PORT = parseInt(process.env.PORT ?? String(cfg.server.port), 10);
const startTime = Date.now();
// ---- UpperLayer init (Qdrant + embedding) ----
initUpperLayer(cfg.upperLayer).catch((err) => {
    console.warn(`[gateway] UpperLayer init failed (non-fatal): ${err.message}`);
});
// ---- HTTP helpers ----
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            try {
                const raw = Buffer.concat(chunks).toString("utf-8");
                resolve(raw ? JSON.parse(raw) : {});
            }
            catch {
                reject(new Error("Invalid JSON body"));
            }
        });
        req.on("error", reject);
    });
}
function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
}
// ---- Router ----
async function handleRequest(req, res) {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    // POST /recall
    if (method === "POST" && url === "/recall") {
        try {
            const body = (await readBody(req));
            if (body.projectId)
                touchProject(body.projectId);
            const result = await handleRecall(body);
            sendJson(res, 200, result);
        }
        catch (err) {
            sendJson(res, 400, { error: err.message });
        }
        return;
    }
    // POST /ingest
    if (method === "POST" && url === "/ingest") {
        try {
            const body = (await readBody(req));
            if (body.projectId)
                touchProject(body.projectId);
            const result = await handleIngest(body);
            sendJson(res, result.status === "accepted" ? 202 : 422, result);
        }
        catch (err) {
            sendJson(res, 400, { error: err.message });
        }
        return;
    }
    // POST /activate
    if (method === "POST" && url === "/activate") {
        try {
            const body = (await readBody(req));
            if (!body.projectId) {
                sendJson(res, 400, { error: "projectId is required" });
                return;
            }
            addActiveProject(body.projectId);
            if (body.ttlSeconds && body.ttlSeconds > 0) {
                updateTtl(body.ttlSeconds);
            }
            sendJson(res, 200, { status: "activated", projectId: body.projectId, ttlSeconds: getTtlSeconds() });
        }
        catch (err) {
            sendJson(res, 400, { error: err.message });
        }
        return;
    }
    // POST /deactivate
    if (method === "POST" && url === "/deactivate") {
        try {
            const body = (await readBody(req));
            if (!body.projectId) {
                sendJson(res, 400, { error: "projectId is required" });
                return;
            }
            await removeActiveProject(body.projectId);
            sendJson(res, 200, { status: "deactivated", projectId: body.projectId });
        }
        catch (err) {
            sendJson(res, 400, { error: err.message });
        }
        return;
    }
    // POST /feedback
    if (method === "POST" && url === "/feedback") {
        try {
            const body = (await readBody(req));
            const result = await handleFeedback(body);
            const code = result.status === "applied" ? 200 : result.status === "not-found" ? 404 : 400;
            sendJson(res, code, result);
        }
        catch (err) {
            sendJson(res, 400, { error: err.message });
        }
        return;
    }
    // GET /status
    if (method === "GET" && url.startsWith("/status")) {
        try {
            const parsed = new URL(url, "http://localhost");
            const projectId = parsed.searchParams.get("projectId") ?? undefined;
            const result = await handleStatus(projectId);
            sendJson(res, 200, result);
        }
        catch (err) {
            sendJson(res, 500, { error: err.message });
        }
        return;
    }
    // GET /scan/:projectId?limit=10
    const scanMatch = method === "GET" && url.match(/^\/scan\/([^/?]+)/);
    if (scanMatch) {
        try {
            const projectId = decodeURIComponent(scanMatch[1]);
            touchProject(projectId);
            const parsed = new URL(url, "http://localhost");
            const limit = parseInt(parsed.searchParams.get("limit") ?? "10", 10);
            const tag = parsed.searchParams.get("tag") ?? undefined;
            const status = parsed.searchParams.get("status");
            const result = await handleScan(projectId, Math.min(Math.max(limit, 1), 30), tag, status);
            sendJson(res, 200, result);
        }
        catch (err) {
            sendJson(res, 500, { error: err.message });
        }
        return;
    }
    // GET /health
    if (method === "GET" && url === "/health") {
        const ulOk = await checkUpperLayerHealth();
        const health = {
            status: ulOk ? "ok" : "degraded",
            service: "engram-gateway",
            uptime: Math.floor((Date.now() - startTime) / 1000),
            downstream: {
                qdrant: ulOk ? "ok" : "unreachable",
                embedding: getUpperLayerStats().embeddingReady ? "ok" : "not-ready",
            },
        };
        sendJson(res, 200, health);
        return;
    }
    // GET /
    if (method === "GET" && url === "/") {
        sendJson(res, 200, {
            service: "engram-gateway",
            version: "2.0.0",
            endpoints: {
                "POST /recall": "Search for relevant knowledge (query or entryId)",
                "POST /ingest": "Submit capsuleSeeds",
                "POST /feedback": "Submit weight signal (outdated, incorrect, superseded, merged)",
                "POST /activate": "Add project to Digestor scope",
                "POST /deactivate": "Remove project from Digestor scope",
                "GET  /scan/:projectId": "Lightweight listing (?limit=10&tag=xxx&status=recent|fixed)",
                "GET  /status": "Store stats (total, recent, fixed)",
                "GET  /health": "Health check",
            },
            store: getUpperLayerStats(),
            activeProjects: getActiveProjects(),
        });
        return;
    }
    sendJson(res, 404, { error: "Not found" });
}
// ---- Start ----
const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
        console.error("[gateway] Unhandled error:", err);
        if (!res.headersSent) {
            sendJson(res, 500, { error: "Internal server error" });
        }
    });
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.listen(PORT, () => {
    console.log(`[engram-gateway] Listening on port ${PORT}`);
    console.log(`[engram-gateway] qdrant: ${cfg.upperLayer?.qdrantUrl ?? "http://localhost:6333"}`);
    // Start Digestor
    const qdrantUrl = cfg.upperLayer?.qdrantUrl ?? "http://localhost:6333";
    const collection = cfg.upperLayer?.collection ?? "engram";
    startDigestor({ ...cfg.digestor, qdrantUrl, collection });
});
// ---- Graceful shutdown ----
function shutdown(signal) {
    console.log(`[engram-gateway] ${signal} received — shutting down`);
    stopDigestor();
    server.close(() => {
        console.log("[engram-gateway] HTTP server closed");
        process.exit(0);
    });
    setTimeout(() => {
        console.warn("[engram-gateway] Forcing exit after timeout");
        process.exit(1);
    }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
//# sourceMappingURL=server.js.map