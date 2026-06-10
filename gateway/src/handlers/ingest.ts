import type { IngestRequest, IngestResponse } from "../types.js";
import { validateIngest } from "../gate/gate.js";
import { autoGenerateTags } from "../gate/auto-tags.js";
import { ingestNodes } from "../upper-layer/index.js";
import { determineSchemaHint } from "../schema-registry.js";

/**
 * POST /ingest — capsuleSeeds → validate → auto-tag → embed → Qdrant
 */
export async function handleIngest(body: IngestRequest): Promise<IngestResponse> {
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

  // Log DCP warnings (Phase 1: warn, don't reject)
  if (gate.warnings?.length) {
    for (const w of gate.warnings) {
      console.log(`[gateway] dcp warning: ${w.code} — ${w.message}`);
    }
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

  const { ingested, deduped } = await ingestNodes(body.capsuleSeeds, body.projectId, trigger, sessionId, userId);

  const dcpWarnings = gate.warnings?.map((w) => w.message);

  // Interactive Schema: determine hint based on push compliance
  const schemaHint = determineSchemaHint(body.capsuleSeeds) ?? undefined;

  const reasonParts = [`${ingested} nodes ingested.`];
  if (deduped > 0) reasonParts.push(`${deduped} merged into existing nodes (similarity ≥ 0.92).`);

  return {
    status: "accepted",
    reason: reasonParts.join(" "),
    projectId: body.projectId,
    nodesIngested: ingested,
    ...(deduped > 0 ? { merged: deduped } : {}),
    ...(dcpWarnings?.length ? { dcpWarnings } : {}),
    ...(schemaHint ? { schemaHint } : {}),
  };
}
