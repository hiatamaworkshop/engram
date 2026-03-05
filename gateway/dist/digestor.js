// ============================================================
// Engram — Digestor (project-scoped batch metabolism)
// ============================================================
//
// Processes ONLY the active project's recent nodes:
//   - weight >= promotionThreshold → promote to "fixed"
//   - ttl <= 0 && weight <= 0 → delete (expired)
//   - otherwise → decrement ttl by intervalMs/1000 and leave for next batch
//
// Inactive projects are never touched → natural hibernation.
// Idle projects (no API activity for idleThresholdMs) are skipped → soft hibernation.
// Any subsequent API call via touchProject() wakes them up.
import { scrollPoints, setPayload, deletePoints, getPointById, countPoints, } from "./upper-layer/qdrant-client.js";
export const DEFAULT_DIGESTOR_CONFIG = {
    intervalMs: 600_000, // 10 minutes
    promotionThreshold: 3,
    promotionHitCount: 5,
    decayPerBatch: 0.1,
    ttlSeconds: 21_600, // 6 hours
    idleThresholdMs: 1_800_000, // 30 minutes
    qdrantUrl: "http://localhost:6333",
    collection: "engram",
};
// ---- State ----
const activeProjects = new Map(); // projectId → lastActivityMs
let timer = null;
let config = { ...DEFAULT_DIGESTOR_CONFIG };
/** Pending hit/weight bumps — accumulated between batch ticks, flushed at batch start. */
const pendingBumps = new Map();
/** Cached node counts per project (+ "__global__" key for all). */
const countsCache = new Map();
/** Cached project listing. */
let projectListCache = null;
// ---- Public API ----
export function addActiveProject(projectId) {
    activeProjects.set(projectId, Date.now());
    console.log(`[digestor] project activated: ${projectId} (active: ${activeProjects.size})`);
}
export async function removeActiveProject(projectId) {
    // Run final batch before deactivation
    await runProjectBatch(projectId).catch((err) => {
        console.warn(`[digestor] final batch failed for ${projectId}: ${err.message}`);
    });
    activeProjects.delete(projectId);
    console.log(`[digestor] project deactivated: ${projectId} (active: ${activeProjects.size})`);
}
export function getActiveProjects() {
    return [...activeProjects.keys()];
}
/** Update last-activity timestamp. Auto-activates if project was not in the set. */
export function touchProject(projectId) {
    const wasIdle = activeProjects.has(projectId) &&
        (Date.now() - (activeProjects.get(projectId) ?? 0) > config.idleThresholdMs);
    activeProjects.set(projectId, Date.now());
    if (wasIdle) {
        console.log(`[digestor] project woke up: ${projectId}`);
    }
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
    console.log(`[digestor] started (interval=${config.intervalMs}ms, weight>=${config.promotionThreshold}&hits>=${config.promotionHitCount}, decay=${config.decayPerBatch}/batch, ttl=${config.ttlSeconds}s, idle=${config.idleThresholdMs}ms)`);
}
export function updateTtl(ttlSeconds) {
    config.ttlSeconds = ttlSeconds;
    console.log(`[digestor] ttl updated: ${ttlSeconds}s`);
}
export function getTtlSeconds() {
    return config.ttlSeconds;
}
export function stopDigestor() {
    if (timer) {
        clearInterval(timer);
        timer = null;
        console.log("[digestor] stopped");
    }
}
// ---- Bump queue (replaces fire-and-forget setPayload per recall) ----
/** Queue a hit/weight bump — throttled: weight only bumped once per batch window per node. */
export function queueBump(pointId, hitDelta, weightDelta) {
    const existing = pendingBumps.get(pointId);
    if (existing) {
        // hitCount always accumulates, but weight is throttled (first bump wins)
        existing.hitDelta += hitDelta;
    }
    else {
        pendingBumps.set(pointId, { hitDelta, weightDelta });
    }
}
// ---- Counts cache (replaces per-request countPoints) ----
/** Get cached counts. Returns null if cache is stale or missing. */
export function getCachedCounts(projectId) {
    const key = projectId ?? "__global__";
    const cached = countsCache.get(key);
    if (!cached)
        return null;
    // Stale after 2× batch interval
    if (Date.now() - cached.updatedAt > config.intervalMs * 2)
        return null;
    return { total: cached.total, recent: cached.recent, fixed: cached.fixed };
}
/** Get cached project listing. Returns null if stale or missing. */
export function getCachedProjectList() {
    if (!projectListCache)
        return null;
    if (Date.now() - projectListCache.updatedAt > config.intervalMs * 2)
        return null;
    return projectListCache.projects;
}
// ---- Batch processing ----
async function runBatch() {
    // Flush accumulated bumps first (even if no active projects)
    await flushPendingBumps();
    if (activeProjects.size === 0)
        return;
    const now = Date.now();
    for (const [projectId, lastActivity] of activeProjects) {
        if (now - lastActivity > config.idleThresholdMs) {
            console.log(`[digestor] skipping idle project: ${projectId} (idle ${Math.floor((now - lastActivity) / 60_000)}min)`);
            continue;
        }
        await runProjectBatch(projectId);
    }
    // Refresh global counts + project list after all batches
    await refreshGlobalCache();
}
/** Round to 2 decimal places to avoid floating-point drift. */
function round2(n) {
    return Math.round(n * 100) / 100;
}
async function runProjectBatch(projectId) {
    const points = await scrollPoints(config.qdrantUrl, config.collection, {
        must: [
            { key: "projectId", match: { value: projectId } },
            { key: "status", match: { value: "recent" } },
        ],
    }, 500);
    if (points.length === 0)
        return;
    const decrement = Math.floor(config.intervalMs / 1000); // seconds per batch tick
    const toPromote = [];
    const toExpire = [];
    // Surviving nodes: grouped by (newTtl, newWeight) to batch setPayload calls
    const toUpdate = new Map(); // "ttl:weight" → pointIds
    for (const point of points) {
        const p = point.payload;
        const weight = p.weight ?? 0;
        const hitCount = p.hitCount ?? 0;
        const currentTtl = p.ttl ?? config.ttlSeconds; // init if missing (legacy nodes)
        // Dual promotion: both weight AND hitCount must meet thresholds
        if (weight >= config.promotionThreshold && hitCount >= config.promotionHitCount) {
            toPromote.push(point.id);
        }
        else {
            const newTtl = currentTtl - decrement;
            const newWeight = round2(weight - config.decayPerBatch);
            if (newTtl <= 0 && newWeight <= 0) {
                toExpire.push(point.id);
            }
            else {
                // Decrement ttl + apply weight decay for surviving nodes
                const key = `${newTtl}:${newWeight}`;
                const group = toUpdate.get(key) ?? [];
                group.push(point.id);
                toUpdate.set(key, group);
            }
        }
    }
    // Promote
    if (toPromote.length > 0) {
        await setPayload(config.qdrantUrl, config.collection, toPromote, { status: "fixed" });
    }
    // Expire
    if (toExpire.length > 0) {
        await deletePoints(config.qdrantUrl, config.collection, toExpire);
    }
    // Tick down TTL + apply weight decay (grouped to minimize API calls)
    for (const [key, ids] of toUpdate) {
        const [ttlStr, weightStr] = key.split(":");
        await setPayload(config.qdrantUrl, config.collection, ids, { ttl: Number(ttlStr), weight: Number(weightStr) });
    }
    const updated = [...toUpdate.values()].reduce((n, ids) => n + ids.length, 0);
    console.log(`[digestor] batch: project=${projectId} scanned=${points.length} promoted=${toPromote.length} expired=${toExpire.length} updated=${updated}`);
    // Refresh per-project counts cache after batch
    try {
        const projectFilter = [{ key: "projectId", match: { value: projectId } }];
        const [total, fixed] = await Promise.all([
            countPoints(config.qdrantUrl, config.collection, { must: projectFilter }),
            countPoints(config.qdrantUrl, config.collection, {
                must: [...projectFilter, { key: "status", match: { value: "fixed" } }],
            }),
        ]);
        countsCache.set(projectId, { total, recent: total - fixed, fixed, updatedAt: Date.now() });
    }
    catch { /* non-fatal */ }
}
// ---- Flush pending bumps ----
async function flushPendingBumps() {
    if (pendingBumps.size === 0)
        return;
    const bumps = new Map(pendingBumps);
    pendingBumps.clear();
    let flushed = 0;
    for (const [pointId, { hitDelta, weightDelta }] of bumps) {
        try {
            const point = await getPointById(config.qdrantUrl, config.collection, pointId);
            if (!point)
                continue;
            await setPayload(config.qdrantUrl, config.collection, [pointId], {
                hitCount: (point.payload.hitCount ?? 0) + hitDelta,
                weight: round2((point.payload.weight ?? 0) + weightDelta),
            });
            flushed++;
        }
        catch (err) {
            console.warn(`[digestor] bump flush failed for ${pointId}: ${err.message}`);
        }
    }
    if (flushed > 0) {
        console.log(`[digestor] flushed ${flushed} pending bumps`);
    }
}
// ---- Refresh global counts + project list cache ----
async function refreshGlobalCache() {
    try {
        const [total, fixed] = await Promise.all([
            countPoints(config.qdrantUrl, config.collection, undefined),
            countPoints(config.qdrantUrl, config.collection, {
                must: [{ key: "status", match: { value: "fixed" } }],
            }),
        ]);
        countsCache.set("__global__", { total, recent: total - fixed, fixed, updatedAt: Date.now() });
    }
    catch { /* non-fatal */ }
    try {
        const points = await scrollPoints(config.qdrantUrl, config.collection, {}, 1000);
        const counts = new Map();
        for (const p of points) {
            const pid = p.payload.projectId;
            if (pid)
                counts.set(pid, (counts.get(pid) ?? 0) + 1);
        }
        projectListCache = {
            projects: Array.from(counts.entries())
                .map(([projectId, count]) => ({ projectId, count }))
                .sort((a, b) => b.count - a.count),
            updatedAt: Date.now(),
        };
    }
    catch { /* non-fatal */ }
}
//# sourceMappingURL=digestor.js.map