import type { IngestRequest, IngestResponse } from "../types.js";
import { validateIngest } from "../gate/gate.js";
import { ingestNodes } from "../upper-layer/index.js";

/**
 * POST /ingest — capsuleSeeds → validate → embed → Qdrant
 */
export async function handleIngest(body: IngestRequest): Promise<IngestResponse> {
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

  // ---- Ingest to Qdrant ----
  const trigger = body.trigger ?? "session-end";
  const sessionId = body.sessionId ?? "unknown";
  console.log(`[gateway] ingest -> qdrant: project=${body.projectId} trigger=${trigger} seeds=${body.capsuleSeeds.length}`);

  const { ingested } = await ingestNodes(body.capsuleSeeds, body.projectId, trigger, sessionId);

  return {
    status: "accepted",
    reason: `${ingested} nodes ingested.`,
    projectId: body.projectId,
    nodesIngested: ingested,
  };
}
