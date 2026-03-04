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
import { scrollPoints, setPayload, deletePoints, } from "./upper-layer/qdrant-client.js";
export const DEFAULT_DIGESTOR_CONFIG = {
    intervalMs: 600_000, // 10 minutes
    promotionThreshold: 5,
    ttlSeconds: 21_600, // 6 hours
    idleThresholdMs: 1_800_000, // 30 minutes
    qdrantUrl: "http://localhost:6333",
    collection: "engram",
};
// ---- State ----
const activeProjects = new Map(); // projectId → lastActivityMs
let timer = null;
let config = { ...DEFAULT_DIGESTOR_CONFIG };
// ---- Public API ----
export function addActiveProject(projectId) {
    activeProjects.set(projectId, Date.now());
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
    console.log(`[digestor] started (interval=${config.intervalMs}ms, threshold=${config.promotionThreshold}, ttl=${config.ttlSeconds}s, idle=${config.idleThresholdMs}ms)`);
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
// ---- Batch processing ----
async function runBatch() {
    if (activeProjects.size === 0)
        return;
    const now = Date.now();
    for (const [projectId, lastActivity] of activeProjects) {
        if (now - lastActivity > config.idleThresholdMs) {
            console.log(`[digestor] skipping idle project: ${projectId} (idle ${Math.floor((now - lastActivity) / 60_000)}min)`);
            continue;
        }
        await runProjectBatch(projectId, now);
    }
}
async function runProjectBatch(projectId, _now) {
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
    const toTick = new Map(); // newTtl → pointIds
    for (const point of points) {
        const p = point.payload;
        const weight = p.weight ?? 0;
        const currentTtl = p.ttl ?? config.ttlSeconds; // init if missing (legacy nodes)
        if (weight >= config.promotionThreshold) {
            toPromote.push(point.id);
        }
        else {
            const newTtl = currentTtl - decrement;
            if (newTtl <= 0 && weight <= 0) {
                toExpire.push(point.id);
            }
            else {
                // Decrement ttl for surviving nodes
                const group = toTick.get(newTtl) ?? [];
                group.push(point.id);
                toTick.set(newTtl, group);
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
    // Tick down TTL (grouped by new value to minimize API calls)
    for (const [newTtl, ids] of toTick) {
        await setPayload(config.qdrantUrl, config.collection, ids, { ttl: newTtl });
    }
    const ticked = [...toTick.values()].reduce((n, ids) => n + ids.length, 0);
    console.log(`[digestor] batch: project=${projectId} scanned=${points.length} promoted=${toPromote.length} expired=${toExpire.length} ticked=${ticked}`);
}
//# sourceMappingURL=digestor.js.map