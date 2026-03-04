// ============================================================
// UpperLayer — public API (Engram v2)
// ============================================================
//
// Gateway 内蔵モジュール。Qdrant + @xenova/transformers で
// NodeSeed を即座に検索可能にする。
//
// [設計]
//   initUpperLayer()       — 起動時1回 (collection 確保 + embedding warm-up)
//   ingestNodes()          — ingest handler から直接呼出
//   searchNodes()          — recall handler から呼出 (hitCount++ 含む)
//   listNodes()            — scan handler から呼出
//   getNodeById()          — recall sense mode
//   getNodeCounts()        — status handler
import { randomUUID } from "node:crypto";
import { DEFAULT_UPPER_LAYER_CONFIG } from "./types.js";
import { configureEmbedding, embedText, embedTexts, isReady } from "./embedding.js";
import { ensureCollection, upsertPoints, searchPoints, scrollPoints, countPoints, getPointById, setPayload, checkQdrantHealth, } from "./qdrant-client.js";
let config = { ...DEFAULT_UPPER_LAYER_CONFIG };
let initialized = false;
// ---- Init ----
export async function initUpperLayer(partial) {
    config = { ...DEFAULT_UPPER_LAYER_CONFIG, ...partial };
    configureEmbedding(config.embeddingModel, config.embeddingDimension);
    const healthy = await checkQdrantHealth(config.qdrantUrl);
    if (!healthy) {
        console.warn(`[upper-layer] Qdrant unreachable at ${config.qdrantUrl} — UpperLayer disabled until available`);
        return;
    }
    await ensureCollection(config.qdrantUrl, config.collection, config.embeddingDimension);
    // Embedding warm-up — preload model so first query is instant
    await embedText("warm-up");
    initialized = true;
    console.log(`[upper-layer] initialized: collection=${config.collection} dim=${config.embeddingDimension}`);
}
// ---- Ingest ----
export async function ingestNodes(nodes, projectId, trigger = "session-end", sessionId = "unknown") {
    if (!initialized || nodes.length === 0)
        return { ingested: 0 };
    const now = Date.now();
    const texts = nodes.map((n) => n.summary || "");
    // Batch embed
    const vectors = await embedTexts(texts);
    // Build points
    const points = nodes.map((node, i) => ({
        id: randomUUID(),
        vector: vectors[i],
        payload: {
            summary: node.summary,
            tags: node.tags,
            content: node.content ?? "",
            projectId,
            source: "mcp-ingest",
            trigger,
            sessionId,
            status: "recent",
            hitCount: 0,
            weight: 0,
            ingestedAt: now,
            lastAccessedAt: now,
        },
    }));
    // Upsert
    await upsertPoints(config.qdrantUrl, config.collection, points);
    console.log(`[upper-layer] ingested: project=${projectId} nodes=${nodes.length}`);
    return { ingested: nodes.length };
}
// ---- Search ----
export async function searchNodes(options) {
    if (!initialized)
        return [];
    const { query, projectId, limit = 10 } = options;
    const queryVector = await embedText(query);
    const filter = projectId
        ? { must: [{ key: "projectId", match: { value: projectId } }] }
        : undefined;
    const hits = await searchPoints(config.qdrantUrl, config.collection, queryVector, filter, limit);
    // hitCount++ for all hits (fire-and-forget)
    if (hits.length > 0) {
        bumpHitCounts(hits);
    }
    return hits.map((hit) => ({
        id: hit.id,
        distance: 1 - hit.score,
        summary: hit.payload.summary,
        tags: hit.payload.tags,
        hitCount: (hit.payload.hitCount ?? 0) + 1, // reflect the bump
        weight: (hit.payload.weight ?? 0) + 1, // reflect the bump
        status: hit.payload.status ?? "recent",
        timestamp: hit.payload.ingestedAt,
        content: hit.payload.content || undefined,
    }));
}
export async function listNodes(projectId, limit, filters) {
    if (!initialized)
        return [];
    const must = [
        { key: "projectId", match: { value: projectId } },
    ];
    if (filters?.tag) {
        must.push({ key: "tags", match: { value: filters.tag } });
    }
    if (filters?.status) {
        must.push({ key: "status", match: { value: filters.status } });
    }
    const points = await scrollPoints(config.qdrantUrl, config.collection, { must }, limit, { key: "ingestedAt", direction: "desc" });
    return points.map((p) => ({
        id: p.id,
        summary: p.payload.summary,
        tags: p.payload.tags,
        hitCount: p.payload.hitCount ?? 0,
        weight: p.payload.weight ?? 0,
        status: p.payload.status ?? "recent",
    }));
}
// ---- Single node fetch (sense pattern) ----
export async function getNodeById(entryId) {
    if (!initialized)
        return null;
    const point = await getPointById(config.qdrantUrl, config.collection, entryId);
    if (!point)
        return null;
    // hitCount++ (fire-and-forget)
    bumpHitCounts([point]);
    return {
        id: point.id,
        distance: 0,
        summary: point.payload.summary,
        tags: point.payload.tags,
        hitCount: (point.payload.hitCount ?? 0) + 1,
        weight: (point.payload.weight ?? 0) + 1,
        status: point.payload.status ?? "recent",
        timestamp: point.payload.ingestedAt,
        content: point.payload.content || undefined,
    };
}
// ---- Hit count bump (fire-and-forget) ----
function bumpHitCounts(points) {
    const now = Date.now();
    for (const point of points) {
        setPayload(config.qdrantUrl, config.collection, [point.id], {
            hitCount: (point.payload.hitCount ?? 0) + 1,
            weight: (point.payload.weight ?? 0) + 1,
            lastAccessedAt: now,
        }).catch((err) => {
            console.warn(`[upper-layer] bumpHitCount failed (non-fatal): ${err.message}`);
        });
    }
}
// ---- Feedback (weight adjustment) ----
const WEIGHT_DELTAS = {
    outdated: -2,
    incorrect: -3,
    superseded: -2,
    merged: -1,
};
export async function applyFeedback(entryId, signal, _reason) {
    if (!initialized) {
        return { status: "error", entryId, signal };
    }
    const point = await getPointById(config.qdrantUrl, config.collection, entryId);
    if (!point) {
        return { status: "not-found", entryId, signal };
    }
    const delta = WEIGHT_DELTAS[signal] ?? -1;
    const currentWeight = point.payload.weight ?? 0;
    const newWeight = currentWeight + delta;
    // Demote fixed → recent on negative feedback so Digestor can eventually expire it
    const currentStatus = point.payload.status ?? "recent";
    const demote = currentStatus === "fixed";
    const patch = { weight: newWeight };
    if (demote) {
        patch.status = "recent";
    }
    await setPayload(config.qdrantUrl, config.collection, [entryId], patch);
    console.log(`[upper-layer] feedback: id=${entryId} signal=${signal} weight=${currentWeight}→${newWeight}${demote ? " (demoted to recent)" : ""}`);
    return { status: "applied", entryId, signal, newWeight };
}
// ---- Stats / Health ----
export async function checkUpperLayerHealth() {
    if (!initialized)
        return false;
    return checkQdrantHealth(config.qdrantUrl);
}
export function getUpperLayerStats() {
    return {
        initialized,
        embeddingReady: isReady(),
        collection: config.collection,
    };
}
export async function getNodeCounts() {
    if (!initialized)
        return { total: 0, recent: 0, fixed: 0 };
    const [total, fixed] = await Promise.all([
        countPoints(config.qdrantUrl, config.collection),
        countPoints(config.qdrantUrl, config.collection, {
            must: [{ key: "status", match: { value: "fixed" } }],
        }),
    ]);
    return { total, recent: total - fixed, fixed };
}
//# sourceMappingURL=index.js.map