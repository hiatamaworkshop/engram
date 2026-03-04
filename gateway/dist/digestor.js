// ============================================================
// Engram — Digestor (project-scoped batch metabolism)
// ============================================================
//
// Processes ONLY the active project's recent nodes:
//   - weight >= promotionThreshold → promote to "fixed"
//   - ingestedAt + ttlMs < now && weight <= 0 → delete (expired)
//   - otherwise → leave for next batch
//
// Inactive projects are never touched → natural hibernation.
import { scrollPoints, setPayload, deletePoints, } from "./upper-layer/qdrant-client.js";
export const DEFAULT_DIGESTOR_CONFIG = {
    intervalMs: 300_000, // 5 minutes
    promotionThreshold: 5,
    ttlMs: 604_800_000, // 7 days
    qdrantUrl: "http://localhost:6333",
    collection: "engram",
};
// ---- State ----
const activeProjects = new Set();
let timer = null;
let config = { ...DEFAULT_DIGESTOR_CONFIG };
// ---- Public API ----
export function addActiveProject(projectId) {
    activeProjects.add(projectId);
    console.log(`[digestor] project activated: ${projectId} (active: ${activeProjects.size})`);
}
export async function removeActiveProject(projectId) {
    // Run final batch before deactivation
    await runProjectBatch(projectId, Date.now()).catch((err) => {
        console.warn(`[digestor] final batch failed for ${projectId}: ${err.message}`);
    });
    activeProjects.delete(projectId);
    console.log(`[digestor] project deactivated: ${projectId} (active: ${activeProjects.size})`);
}
export function getActiveProjects() {
    return [...activeProjects];
}
export function startDigestor(partial) {
    config = { ...DEFAULT_DIGESTOR_CONFIG, ...partial };
    if (timer)
        clearInterval(timer);
    timer = setInterval(() => {
        runBatch().catch((err) => {
            console.warn(`[digestor] batch error: ${err.message}`);
        });
    }, config.intervalMs);
    console.log(`[digestor] started (interval=${config.intervalMs}ms, threshold=${config.promotionThreshold}, ttl=${config.ttlMs}ms)`);
}
export function updateInterval(intervalMs) {
    config.intervalMs = intervalMs;
    if (timer) {
        clearInterval(timer);
        timer = setInterval(() => {
            runBatch().catch((err) => {
                console.warn(`[digestor] batch error: ${err.message}`);
            });
        }, config.intervalMs);
    }
    console.log(`[digestor] interval updated: ${intervalMs}ms`);
}
export function getIntervalMs() {
    return config.intervalMs;
}
export function updateTtl(ttlMs) {
    config.ttlMs = ttlMs;
    console.log(`[digestor] ttl updated: ${ttlMs}ms`);
}
export function getTtlMs() {
    return config.ttlMs;
}
export function stopDigestor() {
    if (timer) {
        clearInterval(timer);
        timer = null;
        console.log("[digestor] stopped");
    }
}
// ---- Batch processing ----
async function runBatch() {
    if (activeProjects.size === 0)
        return;
    const now = Date.now();
    for (const projectId of activeProjects) {
        await runProjectBatch(projectId, now);
    }
}
async function runProjectBatch(projectId, now) {
    const points = await scrollPoints(config.qdrantUrl, config.collection, {
        must: [
            { key: "projectId", match: { value: projectId } },
            { key: "status", match: { value: "recent" } },
        ],
    }, 500);
    if (points.length === 0)
        return;
    const toPromote = [];
    const toExpire = [];
    for (const point of points) {
        const p = point.payload;
        const weight = p.weight ?? 0;
        const ingestedAt = p.ingestedAt ?? 0;
        if (weight >= config.promotionThreshold) {
            toPromote.push(point.id);
        }
        else if (ingestedAt + config.ttlMs < now && weight <= 0) {
            toExpire.push(point.id);
        }
    }
    if (toPromote.length > 0) {
        await setPayload(config.qdrantUrl, config.collection, toPromote, { status: "fixed" });
    }
    if (toExpire.length > 0) {
        await deletePoints(config.qdrantUrl, config.collection, toExpire);
    }
    const unchanged = points.length - toPromote.length - toExpire.length;
    console.log(`[digestor] batch: project=${projectId} scanned=${points.length} promoted=${toPromote.length} expired=${toExpire.length} unchanged=${unchanged}`);
}
//# sourceMappingURL=digestor.js.map