import type { FeedbackRequest, FeedbackResponse, FeedbackSignal } from "../types.js";
import { applyFeedback } from "../upper-layer/index.js";

const VALID_SIGNALS: Set<string> = new Set(["outdated", "incorrect", "superseded", "merged"]);

/**
 * POST /feedback
 */
export async function handleFeedback(body: FeedbackRequest): Promise<FeedbackResponse> {
  if (!body.entryId) {
    return { status: "error", entryId: "", signal: "outdated" as FeedbackSignal };
  }

  if (!body.signal || !VALID_SIGNALS.has(body.signal)) {
    return { status: "error", entryId: body.entryId, signal: body.signal ?? ("unknown" as FeedbackSignal) };
  }

  return applyFeedback(body.entryId, body.signal, body.reason);
}
