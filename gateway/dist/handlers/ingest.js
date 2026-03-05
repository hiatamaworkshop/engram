import { validateIngest } from "../gate/gate.js";
import { autoGenerateTags } from "../gate/auto-tags.js";
import { ingestNodes } from "../upper-layer/index.js";
/**
 * POST /ingest — capsuleSeeds → validate → auto-tag → embed → Qdrant
 */
export async function handleIngest(body) {
    // ---- Normalize missing tags to empty array ----
    if (body?.capsuleSeeds) {
        for (const seed of body.capsuleSeeds) {
            if (!seed.tags || !Array.isArray(seed.tags)) {
                seed.tags = [];
            }
        }
    }
    // ---- Gate validation ----
    const gate = validateIngest(body);
    if (!gate.valid) {
        const reasons = gate.errors.map((e) => e.message).join(" ");
        console.log(`[gateway] ingest rejected: project=${body?.projectId ?? "?"} — ${reasons}`);
        return {
            status: "rejected",
            reason: reasons,
            projectId: body?.projectId,
        };
    }
    // ---- Auto-generate tags for seeds with empty tags ----
    for (const seed of body.capsuleSeeds) {
        if (seed.tags.length === 0) {
            seed.tags = autoGenerateTags(seed.summary, seed.content);
        }
    }
    // ---- Ingest to Qdrant ----
    const trigger = body.trigger ?? "session-end";
    const sessionId = body.sessionId ?? "unknown";
    const userId = body.userId;
    console.log(`[gateway] ingest -> qdrant: project=${body.projectId} trigger=${trigger} seeds=${body.capsuleSeeds.length}${userId ? ` user=${userId}` : ""}`);
    const { ingested } = await ingestNodes(body.capsuleSeeds, body.projectId, trigger, sessionId, userId);
    return {
        status: "accepted",
        reason: `${ingested} nodes ingested.`,
        projectId: body.projectId,
        nodesIngested: ingested,
    };
}
//# sourceMappingURL=ingest.js.map