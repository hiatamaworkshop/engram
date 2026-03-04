import type { IngestRequest, IngestResponse } from "../types.js";
import { validateIngest } from "../gate/gate.js";
import { ingestNodes } from "../upper-layer/index.js";

/**
 * POST /ingest — capsuleSeeds → embed → Qdrant direct
 *
 * Claude session extracts NodeSeeds and sends them here.
 * No queue, no extractor — direct to UpperLayer.
 */
export async function handleIngest(body: IngestRequest): Promise<IngestResponse> {
  const meta = body.meta;

  // ---- Gate membrane ----
  const gate = validateIngest(body);

  if (!gate.valid) {
    const codes = gate.errors.map((e) => e.code).join(", ");
    const reasons = gate.errors.map((e) => e.message).join(" ");
    console.log(`[gateway] ingest rejected [${codes}]: project=${meta?.projectId ?? "?"} session=${meta?.sessionId ?? "?"}`);
    return {
      status: "rejected",
      reason: reasons,
      sessionId: meta?.sessionId,
      projectId: meta?.projectId,
    };
  }

  // ---- Validate capsuleSeeds ----
  const seeds = body.capsuleSeeds;
  if (!seeds || !Array.isArray(seeds) || seeds.length === 0) {
    return {
      status: "rejected",
      reason: "capsuleSeeds is required and must be a non-empty array of NodeSeed objects.",
      sessionId: meta?.sessionId,
      projectId: meta?.projectId,
    };
  }

  // ---- Ingest to Qdrant ----
  const trigger = body.trigger ?? "session-end";
  console.log(`[gateway] ingest → qdrant: project=${meta.projectId} session=${meta.sessionId} trigger=${trigger} seeds=${seeds.length}`);

  const { ingested } = await ingestNodes(seeds, meta.projectId, trigger);

  return {
    status: "accepted",
    reason: `${ingested} nodes ingested directly.`,
    sessionId: meta.sessionId,
    projectId: meta.projectId,
    nodesIngested: ingested,
  };
}
